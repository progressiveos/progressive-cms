// Template loader/render service (PCMS-THEME-T005; Theme Contract spec §4/§13/
// §57/§58). The application layer loads declared theme files into an
// in-memory snapshot (templates never touch the filesystem themselves) and
// renders named templates through the hardened LiquidJS engine (ADR-0006).
//
// Renderer diagnostics (§58) carry template ID, source file and stable code;
// stack traces and engine causes are attached only in dev mode — public
// production responses never see them.
import { readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { createThemeEngine, type TemplateSnapshot } from "../engine/liquid.js";
import { ThemeError } from "../errors.js";
import type { ThemeManifest } from "../manifest/schema.js";

export interface SnapshotLoadResult {
  readonly snapshot: TemplateSnapshot;
  /** Declared files that do not exist on disk (theme validation errors). */
  readonly missing: readonly string[];
}

/**
 * Reads the given theme-relative files (templates, components, block
 * renderers) into memory. Paths stay inside `themeDir`; anything escaping it
 * is reported missing rather than read.
 */
export function loadTemplateSnapshot(
  themeDir: string,
  files: readonly string[],
): SnapshotLoadResult {
  const snapshot: Record<string, string> = {};
  const missing: string[] = [];
  for (const file of files) {
    const normalized = normalize(file);
    if (
      normalized.startsWith("..") ||
      normalize(join(themeDir, normalized)).startsWith(`..${sep}`)
    ) {
      missing.push(file);
      continue;
    }
    try {
      snapshot[normalized] = readFileSync(join(themeDir, normalized), "utf8");
    } catch {
      missing.push(file);
    }
  }
  return { snapshot, missing };
}

export interface RenderContext {
  /** Entry being rendered (diagnostics only, §58). */
  readonly entryId?: string;
  /** Block/component instance being rendered (diagnostics only). */
  readonly blockId?: string;
  readonly componentId?: string;
}

export interface RenderService {
  /** Renders a manifest-declared template by its logical ID (spec §13). */
  renderTemplate(
    templateId: string,
    scope: Readonly<Record<string, unknown>>,
    context?: RenderContext,
  ): Promise<string>;
  /** Renders a declared component template file directly (PCMS-THEME-T007). */
  renderComponent(
    componentFile: string,
    scope: Readonly<Record<string, unknown>>,
    context?: RenderContext,
  ): Promise<string>;
  hasTemplate(templateId: string): boolean;
  hasComponentFile(file: string): boolean;
}

export interface RenderServiceOptions {
  readonly manifest: ThemeManifest;
  readonly snapshot: TemplateSnapshot;
  /** Dev mode: attach engine causes/stacks to renderer errors (§57). */
  readonly devMode?: boolean;
  readonly renderTimeBudgetMs?: number;
}

export function createRenderService(options: RenderServiceOptions): RenderService {
  const { manifest, snapshot } = options;
  const engine = createThemeEngine({
    templates: snapshot,
    ...(options.renderTimeBudgetMs === undefined
      ? {}
      : { renderTimeBudgetMs: options.renderTimeBudgetMs }),
  });
  const templateFiles = new Map(manifest.templates.map((t) => [t.id, t.file]));
  const componentFiles = new Set(manifest.components.map((c) => c.file));

  async function renderFile(
    file: string,
    scope: Readonly<Record<string, unknown>>,
    errorContext: RenderContext,
    kind: "template" | "component",
    logicalId?: string,
  ): Promise<string> {
    if (!(file in snapshot)) {
      throw new ThemeError(
        "THEME_TEMPLATE_NOT_FOUND",
        `${kind} source not found in theme snapshot: ${file}`,
        {
          details: { file, kind, ...errorContext, ...(logicalId ? { id: logicalId } : {}) },
        },
      );
    }
    try {
      return await engine.renderFile(file, { ...scope });
    } catch (cause) {
      const details = {
        file,
        kind,
        ...(logicalId ? { id: logicalId } : {}),
        ...errorContext,
      };
      if (options.devMode) {
        throw new ThemeError("THEME_TEMPLATE_RENDER_FAILED", `render failed for ${file}`, {
          cause,
          details,
        });
      }
      const message =
        cause instanceof Error ? (cause.message.split("\n")[0] ?? "render error") : "render error";
      throw new ThemeError("THEME_TEMPLATE_RENDER_FAILED", message, { details });
    }
  }

  return {
    async renderTemplate(templateId, scope, context = {}) {
      const file = templateFiles.get(templateId);
      if (file === undefined) {
        throw new ThemeError("THEME_TEMPLATE_NOT_FOUND", `unknown template: ${templateId}`, {
          details: { id: templateId, kind: "template", ...context },
        });
      }
      return renderFile(file, scope, context, "template", templateId);
    },
    async renderComponent(componentFile, scope, context = {}) {
      return renderFile(componentFile, scope, context, "component");
    },
    hasTemplate(templateId) {
      return templateFiles.has(templateId);
    },
    hasComponentFile(file) {
      return componentFiles.has(file);
    },
  };
}
