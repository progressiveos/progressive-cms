// Site Routing Policy types and defaults (PCMS-NAV-T001; Navigation spec
// §24–§29/§45). Policy is per-site configuration owned by Routing: content
// never decides its own URL shape. Defaults implement the new-site baseline:
// lowercase, hyphen-separated, extensionless, trailing slash. Legacy sites
// (e.g. migrated MODX trees) declare `allowedExtensions: [".html"]` instead —
// preserving old URLs is policy, not an architectural hack (spec §26/§61).

export type SlugCyrillicPolicy = "transliterate" | "unicode-slug";

export interface SlugPolicy {
  /**
   * Cyrillic handling (spec §28): transliterate to ASCII or keep Unicode
   * letters. No single approach is hard-coded into the domain model.
   */
  readonly cyrillic: SlugCyrillicPolicy;
}

export interface RoutePathPolicy {
  /** Canonical content paths end with "/" (spec §25). Root "/" is exempt. */
  readonly trailingSlash: boolean;
  /** Content routes are lowercase; uppercase requests may 301 (spec §45). */
  readonly lowercase: boolean;
  /**
   * Path extensions a stored route may keep (spec §26). Empty = new-site
   * extensionless baseline; migrated sites allow e.g. [".html"].
   */
  readonly allowedExtensions: readonly string[];
  /** Reserved path prefixes content cannot claim (spec §29). */
  readonly reservedPrefixes: readonly string[];
  readonly slug: SlugPolicy;
}

/** Reserved Core/system namespaces (spec §29); deployment prefixes configurable. */
export const DEFAULT_RESERVED_PREFIXES = [
  "/admin/",
  "/api/",
  "/mcp/",
  "/assets/",
  "/health/",
  "/metrics/",
  "/preview/",
] as const;

/** New-site default policy (spec §24 baseline). */
export const DEFAULT_ROUTE_POLICY: RoutePathPolicy = {
  trailingSlash: true,
  lowercase: true,
  allowedExtensions: [],
  reservedPrefixes: [...DEFAULT_RESERVED_PREFIXES],
  slug: { cyrillic: "transliterate" },
};

/** Policy variant for legacy/migrated sites preserving `.html` (spec §26). */
export const LEGACY_HTML_ROUTE_POLICY: RoutePathPolicy = {
  ...DEFAULT_ROUTE_POLICY,
  allowedExtensions: [".html"],
};

/** Redirect graph safety thresholds (spec §33). */
export const DEFAULT_MAX_REDIRECT_CHAIN = 3;

/** Stored JSON shape of a site policy (sites.path_policy column). */
export function parsePathPolicy(json: unknown): RoutePathPolicy {
  const raw = (json ?? {}) as Partial<Record<keyof RoutePathPolicy, unknown>>;
  const slug = (raw.slug ?? {}) as Partial<SlugPolicy>;
  return {
    trailingSlash: raw.trailingSlash !== false,
    lowercase: raw.lowercase !== false,
    allowedExtensions: Array.isArray(raw.allowedExtensions)
      ? raw.allowedExtensions.filter((e): e is string => typeof e === "string")
      : [],
    reservedPrefixes: [...DEFAULT_RESERVED_PREFIXES],
    slug: { cyrillic: slug.cyrillic === "unicode-slug" ? "unicode-slug" : "transliterate" },
  };
}
