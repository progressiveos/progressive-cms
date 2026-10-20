// Theme Contract discovery hooks (PCMS-THEME-T026; Theme Contract spec §73).
//
// Machine-readable, deterministic inspection surface for the Theme Developer
// Agent (and any tooling): an agent inspects the declared contract instead of
// guessing it from source files. All methods return plain JSON-able data with
// stable ordering; nothing here mutates state or activates a theme.
// Transport shapes (API/MCP) are defined in their own specs (M09) and will
// wrap this service.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { THEME_CONTRACT_VERSION } from "../manifest/registry.js";
import { parseThemeManifest, type ThemeManifest } from "../manifest/schema.js";
import { parseTokensSource } from "../tokens/tokens.js";
import { type ThemeValidationReport, validateThemeDir } from "../validate/theme-validate.js";

export interface ThemeDiscovery {
  getThemeContractVersion(): string;
  getThemeId(): string;
  getManifest(): ThemeManifest;
  /** Deterministic JSON snapshot of the whole declared contract. */
  describeTheme(): Record<string, unknown>;
  listTemplates(): readonly {
    id: string;
    file: string;
    accepts_content_types: readonly string[];
    editor_selectable: boolean;
  }[];
  listComponents(): readonly { id: string; file: string }[];
  listBlockRenderers(): readonly {
    block: string;
    file: string;
    variants: readonly string[] | null;
  }[];
  listNavigationPlacements(): readonly {
    id: string;
    label: string;
    description: string | null;
    max_depth: number;
    supported_item_types: readonly string[];
    fallback: string | null;
  }[];
  listMediaPresets(): readonly { id: string; width: number; height: number | null }[];
  getThemeSettingsSchema(): readonly unknown[];
  /** Public vs implementation token names (spec §70). */
  describeTokens(): {
    readonly public: readonly string[];
    readonly implementation: readonly string[];
  };
  /** Full validation report (machine-readable). */
  validate(): ThemeValidationReport;
}

export function createThemeDiscovery(
  themeDir: string,
  options?: { readonly cmsVersion?: string },
): ThemeDiscovery {
  // Boot behavior preserved: an invalid manifest still fails composition.
  const manifestPath = join(themeDir, "theme.json");
  const manifestResult = parseThemeManifest(readFileSync(manifestPath, "utf8"));
  if (!manifestResult.ok) {
    const first = manifestResult.issues[0];
    throw new Error(`invalid theme manifest: ${first?.code} ${first?.message}`);
  }
  // The manifest is a fingerprint-checked cache, not a boot snapshot: the
  // site render already rebuilds its stack when theme.json changes on disk
  // (in-place theme package updates must not need a restart), while every
  // API consumer of this discovery kept the boot-time catalog and rejected
  // templates the live site was already rendering (2026-10-04 report:
  // template-pick API refused news-index while the site rendered 2.10.0).
  // Same policy as the render stack: a failed re-read (half-written deploy)
  // keeps serving the last good manifest.
  const manifestFingerprint = (): string | null => {
    try {
      const stat = statSync(manifestPath);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
      return null;
    }
  };
  let cached: { readonly fingerprint: string | null; readonly manifest: ThemeManifest } = {
    fingerprint: manifestFingerprint(),
    manifest: manifestResult.value,
  };
  const currentManifest = (): ThemeManifest => {
    const fingerprint = manifestFingerprint();
    if (fingerprint !== null && fingerprint !== cached.fingerprint) {
      try {
        const parsed = parseThemeManifest(readFileSync(manifestPath, "utf8"));
        if (parsed.ok) {
          cached = { fingerprint, manifest: parsed.value };
        }
      } catch {
        // Unreadable mid-deploy state — keep the last good manifest.
      }
    }
    return cached.manifest;
  };
  const cmsVersion = options?.cmsVersion;

  const tokens = (): { public: string[]; implementation: string[] } => {
    const tokensDir = join(themeDir, "tokens");
    const pub: string[] = [];
    const impl: string[] = [];
    if (existsSync(tokensDir)) {
      for (const file of readdirSync(tokensDir)
        .filter((f) => f.endsWith(".json"))
        .sort()) {
        const parsed = parseTokensSource(readFileSync(join(tokensDir, file), "utf8"));
        if (!parsed.ok) continue;
        for (const [key, token] of Object.entries(parsed.tokens)) {
          (token.public ? pub : impl).push(key);
        }
      }
    }
    return { public: pub.sort(), implementation: impl.sort() };
  };

  return {
    getThemeContractVersion: () => THEME_CONTRACT_VERSION,
    getThemeId: () => currentManifest().id,
    getManifest: () => currentManifest(),
    describeTheme() {
      return {
        theme_contract_version: THEME_CONTRACT_VERSION,
        manifest: currentManifest(),
        templates: this.listTemplates(),
        components: this.listComponents(),
        block_renderers: this.listBlockRenderers(),
        navigation_placements: this.listNavigationPlacements(),
        media_presets: this.listMediaPresets(),
        settings_schema: this.getThemeSettingsSchema(),
        tokens: tokens(),
        validation: this.validate(),
      };
    },
    listTemplates: () =>
      [...currentManifest().templates]
        .map((t) => ({
          id: t.id,
          file: t.file,
          accepts_content_types: t.accepts_content_types,
          editor_selectable: t.editor_selectable ?? true,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    listComponents: () =>
      [...currentManifest().components]
        .map((c) => ({ id: c.id, file: c.file }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    listBlockRenderers: () =>
      [...currentManifest().block_renderers]
        .map((r) => ({ block: r.block, file: r.file, variants: r.variants ?? null }))
        .sort((a, b) => a.block.localeCompare(b.block)),
    listNavigationPlacements: () =>
      [...currentManifest().navigation_placements]
        .map((p) => ({
          id: p.id,
          label: p.label ?? p.id,
          description: p.description ?? null,
          max_depth: p.max_depth,
          supported_item_types: p.supported_item_types,
          fallback: p.fallback ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    listMediaPresets: () =>
      [...currentManifest().media_presets]
        .map((p) => ({ id: p.id, width: p.width, height: p.height ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    getThemeSettingsSchema: () =>
      [...currentManifest().settings_schema].sort((a, b) => a.key.localeCompare(b.key)),
    describeTokens: tokens,
    // The CMS build version rides along so manifest `cms_compatibility`
    // checks report the real site version — without it the embedded
    // validation said "site reports unknown" while bootstrap reported the
    // actual version (2026-10-04 site-developer report, p-cms.com).
    validate: () =>
      cmsVersion === undefined
        ? validateThemeDir(themeDir)
        : validateThemeDir(themeDir, { cmsVersion }),
  };
}
