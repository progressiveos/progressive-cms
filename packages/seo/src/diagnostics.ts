// Stable SEO diagnostic codes (PCMS-SEO-T002/T022; SEO spec §57/§58).
// Diagnostics are machine-readable validation/report findings with a stable
// code and severity — advisory heuristics never block publication (§58:
// policy configurable). Frozen alongside the error codes in
// fixtures/seo/error-code-contract.json (append-only).
export type SeoSeverity = "error" | "warning" | "recommendation";

export interface SeoDiagnostic {
  readonly code: string;
  readonly severity: SeoSeverity;
  readonly message: string;
  /** Dotted path of the offending value, e.g. "/seo_title". */
  readonly path?: string;
  /** Machine-readable context (entry ids, urls, limits). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * The complete set of SEO diagnostic codes. Append-only across minor
 * releases (SEO spec §74).
 */
export const SEO_DIAGNOSTIC_CODES = [
  "SEO_TITLE_MISSING",
  "SEO_DESCRIPTION_MISSING",
  "SEO_SOCIAL_IMAGE_MISSING",
  "SEO_CANONICAL_MISSING",
  "SEO_CANONICAL_INVALID",
  "SEO_CANONICAL_EXTERNAL",
  "SEO_CANONICAL_MISMATCH",
  "SEO_ROBOTS_CONFLICT",
  "SEO_DUPLICATE_TITLE",
  "SEO_DUPLICATE_DESCRIPTION",
  "SEO_SOCIAL_IMAGE_INVALID",
  "SEO_FAVICON_MISSING",
  "SEO_FAVICON_TOO_SMALL",
  "SEO_LOCAL_BUSINESS_NOT_SELECTED",
  "SEO_STRUCTURED_DATA_CONFLICT",
  "SEO_TITLE_LENGTH",
  "SEO_DESCRIPTION_LENGTH",
  "SEO_NOINDEX_IN_SITEMAP",
  // OG publication contract (§4): the og-image gate emits these from the
  // validation report (appended when the gap was caught by the discovery
  // corpus — codes were already public, append-only §74).
  "OG_IMAGE_MISSING",
  "OG_DERIVATIVE_FAILED",
] as const;
export type SeoDiagnosticCode = (typeof SEO_DIAGNOSTIC_CODES)[number];
