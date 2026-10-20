// Theme registry + contract/capability compatibility resolver
// (PCMS-THEME-T003; Theme Contract spec §8–§10, §47).
//
// The registry holds validated manifests per (theme id, exact version) and
// resolves the best version for a requested range. Compatibility checking
// answers, before activation: does the theme's declared Theme Contract range
// cover this CMS build's contract version, and are all declared capability
// requirements present at sufficient versions?
import { ThemeError } from "../errors.js";
import type { ThemeManifest } from "./schema.js";
import { type ParsedVersion, parseVersion, satisfiesVersion } from "./semver.js";

/** Theme Contract version this CMS build implements (spec §9). */
export const THEME_CONTRACT_VERSION = "1.0.0";
/** Range of Theme Contract versions accepted by this CMS build. */
export const SUPPORTED_THEME_CONTRACT_RANGE = "^1.0";

/** Capability versions provided by this CMS build (spec §10 examples). */
export type CapabilityProvider = Readonly<Record<string, string>>;

export interface CompatibilityInput {
  /** Capability versions the CMS/site can provide, e.g. { "blocks.gallery": "1" }. */
  readonly capabilities?: CapabilityProvider;
  /** CMS build version to check `cms_compatibility` against (when declared). */
  readonly cmsVersion?: string;
}

export interface CompatibilityIssue {
  readonly code:
    | "THEME_CONTRACT_UNSUPPORTED"
    | "THEME_CMS_INCOMPATIBLE"
    | "THEME_CAPABILITY_MISSING";
  readonly message: string;
}

export type CompatibilityResult =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly issues: readonly CompatibilityIssue[] };

export interface ThemeRegistry {
  /** Registers one validated manifest; (id, version) must be unique. */
  registerTheme(manifest: ThemeManifest): void;
  /** All registered manifests, deterministic by (id, version). */
  listThemes(): readonly ThemeManifest[];
  /** Exact-version lookup. */
  getTheme(id: string, version: string): ThemeManifest | null;
  /**
   * Highest registered version of `id` whose exact version satisfies `range`
   * (Theme spec §8: patches/minors resolve upward within the range).
   */
  resolveTheme(id: string, range: string): ThemeManifest | null;
  /** Contract/capability compatibility of one manifest against this build. */
  checkCompatibility(manifest: ThemeManifest, input?: CompatibilityInput): CompatibilityResult;
}

function versionKey(manifest: ThemeManifest): string {
  return `${manifest.id}@${manifest.version}`;
}

export function createThemeRegistry(input?: { contractVersion?: string }): ThemeRegistry {
  const contractVersion = input?.contractVersion ?? THEME_CONTRACT_VERSION;
  const byKey = new Map<string, ThemeManifest>();

  const registry: ThemeRegistry = {
    registerTheme(manifest) {
      if (parseVersion(manifest.version) === null) {
        throw new ThemeError("THEME_VERSION_INVALID", `invalid theme version: ${manifest.version}`);
      }
      const key = versionKey(manifest);
      if (byKey.has(key)) {
        throw new ThemeError("THEME_ALREADY_REGISTERED", `theme already registered: ${key}`);
      }
      byKey.set(key, manifest);
    },
    listThemes() {
      return [...byKey.values()].sort(
        (a, b) =>
          a.id.localeCompare(b.id) ||
          compareParsed(parseVersion(a.version), parseVersion(b.version)),
      );
    },
    getTheme(id, version) {
      return byKey.get(`${id}@${version}`) ?? null;
    },
    resolveTheme(id, range) {
      const candidates = [...byKey.values()]
        .filter((m) => m.id === id && satisfiesVersion(m.version, range))
        .sort((a, b) => compareParsed(parseVersion(a.version), parseVersion(b.version)));
      return candidates.at(-1) ?? null;
    },
    checkCompatibility(manifest, compatInput) {
      const issues: CompatibilityIssue[] = [];
      // The theme's declared contract range must accept this build's version.
      if (!satisfiesVersion(contractVersion, manifest.theme_contract)) {
        issues.push({
          code: "THEME_CONTRACT_UNSUPPORTED",
          message: `theme requires Theme Contract ${manifest.theme_contract}, CMS provides ${contractVersion}`,
        });
      }
      if (manifest.cms_compatibility !== undefined) {
        const cms = compatInput?.cmsVersion;
        if (cms === undefined || !satisfiesVersion(cms, manifest.cms_compatibility)) {
          issues.push({
            code: "THEME_CMS_INCOMPATIBLE",
            message: `theme requires CMS ${manifest.cms_compatibility}, site reports ${cms ?? "unknown"}`,
          });
        }
      }
      for (const [capability, range] of Object.entries(manifest.requires ?? {})) {
        const provided = compatInput?.capabilities?.[capability];
        if (provided === undefined || !satisfiesVersion(provided, range)) {
          issues.push({
            code: "THEME_CAPABILITY_MISSING",
            message: `capability ${capability} ${range} not satisfied${provided === undefined ? "" : ` (got ${provided})`}`,
          });
        }
      }
      return issues.length === 0 ? { compatible: true } : { compatible: false, issues };
    },
  };
  return registry;
}

function compareParsed(a: ParsedVersion | null, b: ParsedVersion | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}
