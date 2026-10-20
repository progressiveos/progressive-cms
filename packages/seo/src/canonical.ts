// Canonical integration (PCMS-SEO-T003; SEO spec §9/§10/§52).
//
// Routing is the source of canonical URLs: this module never reads a Host
// header, request URL or forwarded header, and never normalizes paths — the
// composition layer injects a port backed by the Routing subsystem's
// canonical resolver (configured domain binding + active route). SEO only
// validates the explicit override and checks signal consistency.
import type { SeoDiagnostic } from "./diagnostics.js";
import type { SeoDocument } from "./document.js";

/**
 * Canonical URL port. Returns the absolute canonical URL for an entry from
 * the configured Domain Binding + active canonical route (M04), or null when
 * the entry has no route. An unknown/unconfigured host can never appear in a
 * resolved URL by construction of the routing side.
 */
export interface SeoCanonicalPort {
  /** Absolute canonical URL; `locale` selects the language version (multilingual). */
  readonly canonicalUrl: (entryId: string, locale?: string | null) => Promise<string | null>;
}

export type CanonicalProvenance = "canonical_override" | "canonical_route";

/**
 * Effective canonical: the explicit override wins when present, otherwise
 * the routing-resolved URL. Provenance is part of the result.
 */
export function resolveCanonical(
  document: SeoDocument | null,
  routeUrl: string | null,
): { readonly url: string | null; readonly source: CanonicalProvenance | null } {
  if (document?.canonical_override != null) {
    return { url: document.canonical_override, source: "canonical_override" };
  }
  return { url: routeUrl, source: routeUrl == null ? null : "canonical_route" };
}

export interface CanonicalOverrideContext {
  /** The routing-resolved canonical URL, used for host comparison. */
  readonly routeUrl: string | null;
  /**
   * Privileged policy switch (spec §9: external canonical needs explicit
   * permission). Default false — an external override is an error.
   */
  readonly allowExternalCanonical?: boolean;
}

function parseHttpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed;
}

/**
 * Override validation (spec §9): malformed URLs, non-http(s) schemes and —
 * unless explicitly permitted — unexpected external hosts are rejected.
 * Query strings/fragments are not page identity (§52): overrides carry a
 * clean URL only.
 */
export function validateCanonicalOverride(
  override: string,
  context: CanonicalOverrideContext,
): readonly SeoDiagnostic[] {
  const diagnostics: SeoDiagnostic[] = [];
  if (override.includes("?") || override.includes("#")) {
    diagnostics.push({
      code: "SEO_CANONICAL_INVALID",
      severity: "error",
      message: "canonical override must not carry a query string or fragment",
      path: "/canonical_override",
    });
    return diagnostics;
  }
  if (override.startsWith("/") && !override.startsWith("//")) {
    // Site-absolute path: routing policy owns its normalization; acceptable.
    // A leading "//" is protocol-relative — an implicit host change, rejected.
    return diagnostics;
  }
  const parsed = parseHttpUrl(override);
  if (parsed == null) {
    diagnostics.push({
      code: "SEO_CANONICAL_INVALID",
      severity: "error",
      message: "canonical override must be an absolute http(s) URL or a site-absolute path",
      path: "/canonical_override",
    });
    return diagnostics;
  }
  if (context.routeUrl != null) {
    const route = parseHttpUrl(context.routeUrl);
    if (route != null && parsed.host.toLowerCase() !== route.host.toLowerCase()) {
      const allowed = context.allowExternalCanonical === true;
      diagnostics.push({
        code: "SEO_CANONICAL_EXTERNAL",
        severity: allowed ? "warning" : "error",
        message: allowed
          ? "canonical override points at an external host (explicitly permitted)"
          : "canonical override points at an external host without explicit permission",
        path: "/canonical_override",
      });
    }
  }
  return diagnostics;
}

export interface SeoUrlSignals {
  /** Effective canonical URL. */
  readonly canonical: string | null;
  /** Open Graph og:url projection. */
  readonly og_url: string | null;
  /** Structured-data url / mainEntityOfPage. */
  readonly structured_data_url: string | null;
  /** Sitemap loc, when the page is sitemap-eligible. */
  readonly sitemap_loc?: string | null;
}

/**
 * Canonical consistency (spec §10): signals should agree. Any emitted signal
 * that disagrees with the canonical is an error-level mismatch.
 */
export function canonicalConsistencyIssues(signals: SeoUrlSignals): readonly SeoDiagnostic[] {
  const issues: SeoDiagnostic[] = [];
  const { canonical } = signals;
  const pairs: readonly [string, string | null | undefined, string][] = [
    ["og:url", signals.og_url, "/og:url"],
    ["structured-data url", signals.structured_data_url, "/structured_data"],
    ["sitemap loc", signals.sitemap_loc, "/sitemap"],
  ];
  for (const [label, value, path] of pairs) {
    if (value == null || canonical == null) continue;
    if (value !== canonical) {
      issues.push({
        code: "SEO_CANONICAL_MISMATCH",
        severity: "error",
        message: `${label} (${value}) does not match the canonical (${canonical})`,
        path,
      });
    }
  }
  return issues;
}
