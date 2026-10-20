// Candidate theme preview context (PCMS-THEME-T021; Theme Contract spec §48).
//
// A candidate (not activated) theme renders preview pages from pure inputs:
// the candidate manifest + snapshot, theme settings, navigation assignments
// and the entry data. No activation state, no registry writes, no DB — the
// Preview subsystem (signed, time-limited URLs) arrives with its own
// milestone and will wrap this context. This proves preview-before-activate:
// the same entry can render against several candidate themes side by side.
import type { TemplateSnapshot } from "../engine/liquid.js";
import { type SafeHtml, safeHtml } from "../engine/safe-html.js";
import type { ThemeManifest } from "../manifest/schema.js";
import { buildImageModel, createMediaPresetRegistry, type ImageModel } from "../media/presets.js";
import {
  createNavigationPlacementRegistry,
  type NavigationAssignment,
  type NavigationPlacementRegistry,
} from "../navigation/placements.js";
import { buildNavigationScope } from "../navigation/render-navigation.js";
import {
  type BlockRendererRegistry,
  createBlockRendererRegistry,
} from "../render/block-renderer-registry.js";
import {
  createRenderService,
  type RenderContext,
  type RenderService,
} from "../render/render-service.js";
import {
  createTemplateRegistry,
  type TemplateContract,
  type TemplateRegistry,
} from "../render/template-registry.js";
import {
  applyTokenOverrides,
  resolveSettingsValues,
  type SettingsValues,
  tokenOverridesFromSettings,
} from "../settings/settings.js";
import { parseTokensSource, type TokenMap, tokensToCss } from "../tokens/tokens.js";
import type { HeadViewModel, MediaAssetViewModel } from "../view-models.js";

export interface PreviewEntryInput {
  readonly templateKey: string;
  readonly contentTypeKey: string;
  readonly contentTypeVersion: number;
  readonly title: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly blocks: Parameters<BlockRendererRegistry["renderBlockDocument"]>[0];
  /**
   * Media assets referenced by the entry's blocks, keyed by stable ID
   * (Media subsystem stand-in until M05 — fixture/app-provided).
   */
  readonly mediaMap?: Readonly<Record<string, MediaAssetViewModel>>;
  /** Trusted HTML for `rich_text` bodyPolicy content (PCMS-THEME-T010 bridge). */
  /** Pre-rendered trusted fragment (SafeHtml) or plain text (escaped). */
  readonly bodyHtml?: string | SafeHtml;
}

export interface PreviewSiteInput {
  readonly siteName: string;
  readonly navigationAssignments?: readonly NavigationAssignment[];
  readonly head?: HeadViewModel;
}

export interface ThemePreviewInput {
  readonly manifest: ThemeManifest;
  readonly snapshot: TemplateSnapshot;
  /** Raw (untrusted) settings values; validated against the schema. */
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly devMode?: boolean;
}

export interface ThemePreview {
  readonly themeId: string;
  readonly renderService: RenderService;
  readonly templates: TemplateRegistry;
  readonly blocks: BlockRendererRegistry;
  readonly placements: NavigationPlacementRegistry;
  /** Resolved settings (validated, defaults applied). */
  readonly settings: SettingsValues;
  /** Resolved per-preset image models per media ID (Theme spec §36). */
  buildMediaScope(
    mediaMap?: Readonly<Record<string, MediaAssetViewModel>>,
  ): Readonly<Record<string, MediaScopeEntry>>;
  /** Deterministic CSS custom properties incl. settings overrides. */
  tokensCss(tokenSources?: readonly { name: string; source: string }[]): string;
  /** Renders one entry fixture against the candidate theme. */
  renderEntry(
    entry: PreviewEntryInput,
    site?: PreviewSiteInput,
    context?: RenderContext,
  ): Promise<string>;
  checkAcceptance(
    entry: Pick<
      PreviewEntryInput,
      "templateKey" | "contentTypeKey" | "contentTypeVersion" | "fields"
    >,
  ): { readonly ok: true; readonly contract: TemplateContract } | { readonly ok: false };
}

export interface MediaScopeEntry {
  readonly alt: string;
  readonly width: number | null;
  readonly height: number | null;
  /** Preset-id → resolved image model (absent preset = null). */
  readonly presets: Readonly<Record<string, ImageModel | null>>;
}

export function createThemePreview(input: ThemePreviewInput): ThemePreview {
  const presetRegistry = createMediaPresetRegistry(input.manifest);
  const buildMediaScope = (
    mediaMap?: Readonly<Record<string, MediaAssetViewModel>>,
  ): Readonly<Record<string, MediaScopeEntry>> => {
    const scope: Record<string, MediaScopeEntry> = {};
    for (const [id, asset] of Object.entries(mediaMap ?? {})) {
      const presets: Record<string, ImageModel | null> = {};
      for (const preset of presetRegistry.listPresets()) {
        try {
          presets[preset.id] = buildImageModel(
            asset,
            preset.id,
            input.manifest.media_presets.find((m) => m.id === preset.id),
          );
        } catch {
          presets[preset.id] = null;
        }
      }
      scope[id] = { alt: asset.alt, width: asset.width, height: asset.height, presets };
    }
    return scope;
  };
  const renderService = createRenderService({
    manifest: input.manifest,
    snapshot: input.snapshot,
    ...(input.devMode === undefined ? {} : { devMode: input.devMode }),
  });
  const templates = createTemplateRegistry(input.manifest);
  const blocks = createBlockRendererRegistry(input.manifest, renderService);
  const placements = createNavigationPlacementRegistry(input.manifest);
  const resolved = resolveSettingsValues(input.manifest.settings_schema, input.settings ?? {});
  if (!resolved.ok) {
    const first = resolved.issues[0];
    throw new Error(`preview settings invalid: ${first?.code} ${first?.message}`);
  }
  const settings = resolved.values;
  const overrides = tokenOverridesFromSettings(input.manifest.settings_schema, settings);
  // Token sources live in the theme snapshot: tokens/*.json (Theme spec §5).
  const tokenSources = Object.keys(input.snapshot)
    .filter((name) => name.startsWith("tokens/") && name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, source: input.snapshot[name] ?? "" }));

  return {
    themeId: input.manifest.id,
    renderService,
    templates,
    blocks,
    placements,
    settings,
    buildMediaScope,
    tokensCss(sources = tokenSources) {
      let tokens: TokenMap = {};
      for (const source of sources) {
        const parsed = parseTokensSource(source.source);
        if (parsed.ok) tokens = { ...tokens, ...parsed.tokens };
      }
      return tokensToCss(applyTokenOverrides(tokens, overrides));
    },
    checkAcceptance(entry) {
      return templates.checkAcceptance({
        templateId: entry.templateKey,
        contentTypeKey: entry.contentTypeKey,
        contentTypeVersion: entry.contentTypeVersion,
        presentFields: Object.keys(entry.fields),
      });
    },
    async renderEntry(entry, site, context) {
      const acceptance = templates.checkAcceptance({
        templateId: entry.templateKey,
        contentTypeKey: entry.contentTypeKey,
        contentTypeVersion: entry.contentTypeVersion,
        presentFields: Object.keys(entry.fields),
      });
      if (!acceptance.ok) {
        const first = acceptance.issues[0];
        throw new Error(`preview render rejected: ${first?.code} ${first?.message}`);
      }
      const media = buildMediaScope(entry.mediaMap);
      const blocksHtml = await blocks.renderBlockDocument(entry.blocks, { media }, context);
      const nav = buildNavigationScope(placements, site?.navigationAssignments ?? []);
      const head = site?.head ?? {
        title: entry.title,
        core_meta: [],
        canonical: null,
        robots: null,
        json_ld: [],
        theme_slots: [],
      };
      return renderService.renderTemplate(
        entry.templateKey,
        {
          media,
          site: { site_name: site?.siteName ?? entry.title },
          entry: {
            id: "",
            content_type_key: entry.contentTypeKey,
            content_type_version: entry.contentTypeVersion,
            template_key: entry.templateKey,
            title: entry.title,
            fields: entry.fields,
            blocks: [],
          },
          blocks_html: blocksHtml,
          body_html: entry.bodyHtml ?? "",
          nav,
          head,
          tokens_css: this.tokensCss(),
          theme_settings: settings,
          request: { locale: null, path: "/preview" },
        },
        context,
      );
    },
  };
}
