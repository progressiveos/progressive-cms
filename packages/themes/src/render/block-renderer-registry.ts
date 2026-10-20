// Block renderer registry: manifest `type@schemaVersion` → renderer template
// (PCMS-THEME-T008; Theme Contract spec §17/§19).
//
// Every supported block type maps to a template file declared in the theme
// manifest. A theme never generic-renders unknown blocks without an explicit
// policy (§18): missing renderers and unsupported variants are surfaced as
// diagnostics (preview) / validation errors (production) — PCMS-THEME-T009
// builds the reporting layer on `checkBlockSupport`/`renderBlockDocument`.
//
// Children (when a registered type allows them) render depth-first and are
// passed to the parent template as a trusted `children` SafeHtml fragment —
// child HTML was produced by this same registry, so it is as trusted as its
// parent (Theme spec §20).

import { isSafeHtml, type SafeHtml, safeHtml } from "../engine/safe-html.js";
import { ThemeError } from "../errors.js";
import type { ThemeManifest, ThemeManifestBlockRenderer } from "../manifest/schema.js";
import type { BlockNodeViewModel } from "../view-models.js";
import type { RenderContext, RenderService } from "./render-service.js";
import { renderRichTextInProps } from "./richtext-renderer.js";

/** Structural mirror of Blocks `MAX_BLOCKS_PER_DOCUMENT` (defense in depth). */
const MAX_RENDERED_BLOCKS = 500;

/** Typed Action value marker (Content spec §47): props objects carrying one
 * of these `type` discriminators get a `resolved` href attached at render
 * time when the composer supplies an action resolver. */
const ACTION_TYPES = new Set([
  "internal_entry",
  "external_url",
  "anchor",
  "form",
  "phone",
  "email",
  "media_download",
  "none",
]);

/** Resolved action href injected into block props (2026-10-01: themes
 * rendered internal_entry actions as `href="#"` because entry→URL mapping
 * is engine knowledge). `external` asks for rel=noopener/target handling. */
export interface ResolvedActionHref {
  readonly href: string;
  readonly external?: boolean;
}

export interface BlockRendererDescriptor {
  /** `type@schemaVersion`, e.g. `text@1`. */
  readonly key: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly file: string;
  /** Supported variants; null = only unvarianted blocks are supported. */
  readonly variants: readonly string[] | null;
}

export interface BlockSupportIssue {
  readonly code: "THEME_BLOCK_RENDERER_NOT_FOUND" | "THEME_BLOCK_VARIANT_UNSUPPORTED";
  readonly blockId: string;
  readonly message: string;
}

export interface BlockRenderScope {
  readonly block: {
    readonly id: string;
    readonly type: string;
    readonly schema_version: number;
    readonly variant: string | null;
    readonly props: Readonly<Record<string, unknown>>;
  };
  /** Rendered child blocks (trusted fragment produced by this registry). */
  readonly children: SafeHtml;
}

export interface BlockRendererRegistry {
  listRenderers(): readonly BlockRendererDescriptor[];
  resolveRenderer(type: string, schemaVersion: number): BlockRendererDescriptor | null;
  /** Structural support check — the PCMS-THEME-T009 diagnostics source. */
  checkBlockSupport(block: BlockNodeViewModel): BlockSupportIssue | null;
  renderBlockWithChildren(
    block: BlockNodeViewModel,
    children: SafeHtml,
    scope?: Readonly<Record<string, unknown>>,
    context?: RenderContext,
    budget?: { count: number },
  ): Promise<string>;
  renderBlock(
    block: BlockNodeViewModel,
    scope?: Readonly<Record<string, unknown>>,
    context?: RenderContext,
  ): Promise<string>;
  renderBlockDocument(
    blocks: readonly BlockNodeViewModel[],
    scope?: Readonly<Record<string, unknown>>,
    context?: RenderContext,
  ): Promise<SafeHtml>;
}

function toDescriptor(entry: ThemeManifestBlockRenderer): BlockRendererDescriptor {
  const atIndex = entry.block.lastIndexOf("@");
  const type = entry.block.slice(0, atIndex);
  const version = Number.parseInt(entry.block.slice(atIndex + 1), 10);
  return {
    key: entry.block,
    type,
    schemaVersion: version,
    file: entry.file,
    variants: entry.variants ?? null,
  };
}

export function createBlockRendererRegistry(
  manifest: ThemeManifest,
  render: Pick<RenderService, "renderComponent">,
  actions?: {
    /** Engine-backed typed-action resolution (internal_entry needs route
     * lookup; forms/media may resolve to null — themes then drop the link
     * instead of rendering `href="#"`). */
    readonly resolveAction?: (
      action: Readonly<Record<string, unknown>>,
    ) => Promise<ResolvedActionHref | null>;
  },
): BlockRendererRegistry {
  const byKey = new Map(manifest.block_renderers.map((r) => [r.block, toDescriptor(r)]));
  /** Per-render block budget (a new budget starts at every top-level call). */
  interface Budget {
    count: number;
  }
  const budgetStack: Budget[] = [];

  function supportIssue(block: BlockNodeViewModel): BlockSupportIssue | null {
    const renderer = byKey.get(`${block.type}@${block.schemaVersion}`);
    if (renderer === undefined) {
      return {
        code: "THEME_BLOCK_RENDERER_NOT_FOUND",
        blockId: block.id,
        message: `no renderer for block ${block.type}@${block.schemaVersion}`,
      };
    }
    if (
      block.variant !== null &&
      (renderer.variants === null || !renderer.variants.includes(block.variant))
    ) {
      return {
        code: "THEME_BLOCK_VARIANT_UNSUPPORTED",
        blockId: block.id,
        message: `variant "${block.variant}" is not supported for ${renderer.key}`,
      };
    }
    return null;
  }

  return {
    listRenderers() {
      return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
    },
    resolveRenderer(type, schemaVersion) {
      return byKey.get(`${type}@${schemaVersion}`) ?? null;
    },
    checkBlockSupport(block) {
      return supportIssue(block);
    },
    /**
     * Renders one already-supported block whose children are already rendered
     * (trusted fragment). `renderBlock` is this + automatic child rendering;
     * the diagnostics preview (PCMS-THEME-T009) uses it to substitute
     * placeholders for unsupported descendants.
     */
    async renderBlockWithChildren(
      block,
      children,
      scope = {},
      context = {},
      budget = { count: 0 },
    ): Promise<string> {
      const renderer = byKey.get(`${block.type}@${block.schemaVersion}`);
      if (renderer === undefined) {
        throw new ThemeError(
          "THEME_BLOCK_RENDERER_NOT_FOUND",
          `no renderer for block ${block.type}@${block.schemaVersion}`,
          { details: { blockId: block.id, blockType: block.type, ...context } },
        );
      }
      const issue = supportIssue(block);
      if (issue !== null) {
        throw new ThemeError(issue.code, issue.message, {
          details: { blockId: block.id, blockType: block.type, variant: block.variant, ...context },
        });
      }
      budget.count += 1;
      if (budget.count > MAX_RENDERED_BLOCKS) {
        throw new ThemeError(
          "THEME_RENDER_BLOCK_LIMIT",
          `more than ${MAX_RENDERED_BLOCKS} blocks per render`,
          { details: { blockId: block.id, ...context } },
        );
      }
      // RichText ASTs inside props become trusted HTML fragments here — the
      // only path raw-ish content takes on its way into templates (Theme
      // spec §21; PCMS-THEME-T010). Typed Actions in props get `resolved`
      // hrefs injected (entry_id→route is engine knowledge, §47).
      const blockScope: Record<string, unknown> = {
        ...scope,
        block: {
          id: block.id,
          type: block.type,
          schema_version: block.schemaVersion,
          variant: block.variant,
          props: await withResolvedActions(
            renderRichTextInProps(block.props, {
              imageSource: (id) => {
                const sources = scope.richtext_image_sources as Record<string, string> | undefined;
                return sources?.[id] ?? null;
              },
            }),
            actions?.resolveAction,
          ),
        },
        children,
      };
      // The page scope carries related_cards keyed by block id (the site
      // composer resolves each manual/hybrid list per block); the block
      // contract exposes THIS block's card array so templates iterate it
      // directly (Content spec §54).
      if (block.type === "related_content") {
        const record = scope.related_cards as Record<string, readonly unknown[]> | undefined;
        blockScope.related_cards = record?.[block.id] ?? [];
      }
      return render.renderComponent(renderer.file, blockScope, { ...context, blockId: block.id });
    },
    async renderBlock(block, scope = {}, context = {}) {
      const childrenHtml = await this.renderBlockDocument(block.children, scope, context);
      return this.renderBlockWithChildren(block, childrenHtml, scope, context);
    },
    async renderBlockDocument(blocks, scope = {}, context = {}) {
      const budget = { count: 0 };
      const parts: string[] = [];
      for (const block of blocks) {
        parts.push(
          await this.renderBlockWithChildren(
            block,
            await this.renderBlockDocument(block.children, scope, context),
            scope,
            context,
            budget,
          ),
        );
      }
      return safeHtml(parts.join("\n"));
    },
  };
}

/** Recursively attaches `resolved` to typed Action objects in props (§47):
 * depth-first over nested records and arrays, preserving key order. Without
 * a resolver props pass through untouched (old compositions keep working). */
async function withResolvedActions(
  props: Readonly<Record<string, unknown>>,
  resolve:
    | ((action: Readonly<Record<string, unknown>>) => Promise<ResolvedActionHref | null>)
    | undefined,
): Promise<Record<string, unknown>> {
  if (resolve === undefined) return { ...props };
  // PLAIN records only: SafeHtml instances (produced by renderRichTextInProps
  // upstream) must pass through untouched — cloning one into a plain object
  // turns the template output back into `{"html":…}` JSON (0.1.129 regression
  // on every rich-text prop).
  const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };
  const walk = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => walk(item)));
    }
    if (isSafeHtml(value)) return value;
    if (!isPlainRecord(value)) return value;
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) clone[key] = await walk(entry);
    if (ACTION_TYPES.has(String(clone.type))) {
      clone.resolved = await resolve(clone).catch(() => null);
    }
    return clone;
  };
  return (await walk(props)) as Record<string, unknown>;
}
