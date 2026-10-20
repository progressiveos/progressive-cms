// Site-wide SEO checks (PCMS-SEO-T006; SEO spec §5/§7/§57).
// Duplicate titles/descriptions across a site are warning-level diagnostics:
// advisory heuristics, never hard blocks (spec §58, policy configurable).
import type { SeoDiagnostic } from "./diagnostics.js";
import type { ResolvedSeoMetadata } from "./fallback.js";

export interface SeoResolvedPage {
  readonly entryId: string;
  readonly resolved: ResolvedSeoMetadata;
  /** Only pages actually competing in search indexes are compared (§5). */
  readonly indexable: boolean;
}

function duplicates(
  pages: readonly SeoResolvedPage[],
  field: "title" | "description",
  code: "SEO_DUPLICATE_TITLE" | "SEO_DUPLICATE_DESCRIPTION",
): SeoDiagnostic[] {
  const seen = new Map<string, string[]>();
  for (const page of pages) {
    if (!page.indexable) continue;
    const value = page.resolved[field].value;
    if (value == null) continue;
    const owners = seen.get(value) ?? [];
    owners.push(page.entryId);
    seen.set(value, owners);
  }
  // Deterministic: ordered by value, owners sorted by entry id.
  const issues: SeoDiagnostic[] = [];
  for (const [_value, owners] of [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (owners.length < 2) continue;
    issues.push({
      code,
      severity: "warning",
      message: `${owners.length} indexable pages share the same ${field}`,
      path: `/${field}`,
      details: { owners: [...owners].sort() },
    });
  }
  return issues;
}

/** Duplicate title/description detection across indexable pages (§5/§7). */
export function duplicateContentIssues(
  pages: readonly SeoResolvedPage[],
): readonly SeoDiagnostic[] {
  return [
    ...duplicates(pages, "title", "SEO_DUPLICATE_TITLE"),
    ...duplicates(pages, "description", "SEO_DUPLICATE_DESCRIPTION"),
  ];
}

export interface SiteSitemapEntry {
  readonly entryId: string;
  readonly loc: string;
}

export interface SiteSeoAuditInput {
  readonly pages: readonly SeoResolvedPage[];
  /** Effective canonical per entry (override or routing route). */
  readonly canonicalByEntry: ReadonlyMap<string, string>;
  /** URLs the generated sitemap lists (entry id + loc). */
  readonly sitemapUrls: readonly SiteSitemapEntry[];
}

/**
 * Site-wide audit (PCMS-SEO-T026; spec §57/§58): duplicate meta, noindex
 * pages leaking into the sitemap, canonical/sitemap disagreement. Internal
 * links/orphan detection needs a crawl graph that M06 does not have as input
 * — it lands with the public rendering pipeline (M07/M09).
 */
export function validateSiteSeo(input: SiteSeoAuditInput): readonly SeoDiagnostic[] {
  const issues: SeoDiagnostic[] = [...duplicateContentIssues(input.pages)];

  const indexabilityByEntry = new Map(input.pages.map((p) => [p.entryId, p]));
  for (const entry of input.sitemapUrls) {
    const page = indexabilityByEntry.get(entry.entryId);
    if (page != null && !page.indexable) {
      issues.push({
        code: "SEO_NOINDEX_IN_SITEMAP",
        severity: "error",
        message: "a noindex page is listed in the sitemap",
        path: "/sitemap",
        details: { entryId: entry.entryId, loc: entry.loc },
      });
      continue;
    }
    const canonical = input.canonicalByEntry.get(entry.entryId);
    if (canonical != null && canonical !== entry.loc) {
      issues.push({
        code: "SEO_CANONICAL_MISMATCH",
        severity: "error",
        message: `sitemap loc (${entry.loc}) does not match the canonical (${canonical})`,
        path: "/sitemap",
        details: { entryId: entry.entryId },
      });
    }
  }

  issues.sort((a, b) => {
    const order: Record<string, number> = { error: 0, warning: 1, recommendation: 2 };
    const bySeverity = (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.message < b.message ? -1 : 1;
  });
  return issues;
}
