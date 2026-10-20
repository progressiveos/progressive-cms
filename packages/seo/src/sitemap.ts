// Sitemap generation (PCMS-SEO-T018; SEO spec §15/§17/§53).
// Only public, published, canonical, indexable, HTTP-200 URLs are included.
// The publication state arrives through an input contract — M06 does not
// implement a publication state machine (M07 provides the authoritative
// provider; M06 tests use fixtures). Inputs list active canonical routes
// only, so redirect sources/410 routes structurally cannot appear.
import type { SeoDiagnostic } from "./diagnostics.js";
import { SeoError } from "./errors.js";
/**
 * Publication/indexability facts for one candidate. `public` is the M07
 * seam: today's providers answer from fixtures/composition; M07 will supply
 * the authoritative published state without changing this shape.
 */
export interface SitemapEligibility {
  readonly public: boolean;
  /** False when the route target cannot serve a 200 (gone/410 policy). */
  readonly http200: boolean;
}

export interface SitemapCandidate {
  readonly entryId: string;
  /** Canonical site-relative path (Routing normalization). */
  readonly path: string;
  /** Reciprocal language alternates (multilingual); empty otherwise. */
  readonly alternates?: readonly { readonly hreflang: string; readonly href: string }[];
  /** Public content modification time, ISO 8601 (Publication subsystem, §17). */
  readonly lastmod: string | null;
  /** Effective page indexing policy result (noindex pages are excluded, §15). */
  readonly noindex: boolean;
  readonly eligibility: SitemapEligibility;
}

export interface SitemapBuildInput {
  /** Absolute origin from the M04 primary domain binding — never a request Host. */
  readonly origin: string;
  readonly candidates: readonly SitemapCandidate[];
}

export interface SitemapUrlEntry {
  readonly loc: string;
  readonly lastmod: string | null;
  /** Reciprocal language alternates (multilingual §31); empty otherwise. */
  readonly alternates?: readonly { readonly hreflang: string; readonly href: string }[];
}

export interface SitemapBuildResult {
  /** Deterministic: sorted by path. */
  readonly urls: readonly SitemapUrlEntry[];
  /** Machine-readable exclusion report (code SEO_SITEMAP_INELIGIBLE). */
  readonly excluded: readonly { readonly entryId: string; readonly reason: string }[];
  readonly diagnostics: readonly SeoDiagnostic[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function assertSitemapOrigin(origin: string): void {
  if (!/^https?:\/\//i.test(origin) || origin.includes("?") || origin.includes("#")) {
    throw new SeoError(
      "SEO_SITEMAP_INPUT_INVALID",
      "sitemap origin must be an absolute http(s) origin",
      {
        details: { origin },
      },
    );
  }
}

function exclusionReason(candidate: SitemapCandidate): string | null {
  if (!candidate.eligibility.public) return "not_public";
  if (!candidate.eligibility.http200) return "not_http_200";
  if (candidate.noindex) return "noindex";
  if (
    !candidate.path.startsWith("/") ||
    candidate.path.includes("?") ||
    candidate.path.includes("#")
  ) {
    return "path_not_canonical";
  }
  return null;
}

/** Filters candidates to sitemap-eligible URLs with a full exclusion report. */
export function buildSitemapEntries(input: SitemapBuildInput): SitemapBuildResult {
  assertSitemapOrigin(input.origin);
  const origin = input.origin.replace(/\/$/, "");
  const urls: SitemapUrlEntry[] = [];
  const excluded: { entryId: string; reason: string }[] = [];
  const diagnostics: SeoDiagnostic[] = [];
  for (const candidate of input.candidates) {
    const reason = exclusionReason(candidate);
    if (reason != null) {
      excluded.push({ entryId: candidate.entryId, reason });
      diagnostics.push({
        code: "SEO_SITEMAP_INELIGIBLE",
        severity: "warning",
        message: `entry excluded from the sitemap: ${reason}`,
        path: "/sitemap",
        details: { entryId: candidate.entryId, reason },
      });
      continue;
    }
    if (candidate.lastmod != null && !ISO_DATE_RE.test(candidate.lastmod)) {
      diagnostics.push({
        code: "SEO_SITEMAP_INPUT_INVALID",
        severity: "error",
        message: "lastmod must be an ISO 8601 timestamp",
        path: "/sitemap",
        details: { entryId: candidate.entryId, lastmod: candidate.lastmod },
      });
      continue;
    }
    urls.push({
      loc: `${origin}${candidate.path}`,
      lastmod: candidate.lastmod,
      ...(candidate.alternates === undefined ? {} : { alternates: candidate.alternates }),
    });
  }
  urls.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
  excluded.sort((a, b) => (a.entryId < b.entryId ? -1 : 1));
  return { urls, excluded, diagnostics };
}

/** Conservative split limit — well under the 50,000-URL protocol ceiling (§16). */
export const MAX_URLS_PER_SITEMAP = 10_000;

export interface SitemapFile {
  /** Deterministic name, e.g. "sitemap-1.xml". */
  readonly name: string;
  readonly xml: string;
}

export interface SitemapFilesResult {
  /** Present only when the URL set was split into multiple files. */
  readonly indexXml: string | null;
  readonly files: readonly SitemapFile[];
}

/**
 * Deterministic split: entries keep their sorted order, chunked into files
 * of at most `maxUrls` each; a set that fits stays a single sitemap.xml.
 */
export function buildSitemapFiles(
  input: SitemapBuildInput,
  options?: { readonly maxUrlsPerSitemap?: number; readonly originForIndex?: string },
): SitemapFilesResult {
  const maxUrls = Math.max(1, Math.floor(options?.maxUrlsPerSitemap ?? MAX_URLS_PER_SITEMAP));
  const { urls } = buildSitemapEntries(input);
  if (urls.length <= maxUrls) {
    return { indexXml: null, files: [{ name: "sitemap.xml", xml: renderSitemapXml(urls) }] };
  }
  const chunks: SitemapUrlEntry[][] = [];
  for (let i = 0; i < urls.length; i += maxUrls) {
    chunks.push(urls.slice(i, i + maxUrls));
  }
  const files = chunks.map((chunk, i) => ({
    name: `sitemap-${i + 1}.xml`,
    xml: renderSitemapXml(chunk),
  }));
  const indexOrigin = (options?.originForIndex ?? input.origin).replace(/\/$/, "");
  const indexXml = renderSitemapIndexXml(
    files.map((f) => `${indexOrigin}/${f.name}`),
    urls.reduce<string | null>(
      (latest, u) =>
        u.lastmod != null && (latest == null || u.lastmod > latest) ? u.lastmod : latest,
      null,
    ),
  );
  return { indexXml, files };
}

/** Sitemap index XML (§16/§19): lists chunk files, optional shared lastmod. */
export function renderSitemapIndexXml(
  locations: readonly string[],
  lastmod?: string | null,
): string {
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  parts.push('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const loc of locations) {
    parts.push("  <sitemap>");
    parts.push(`    <loc>${escapeXml(loc)}</loc>`);
    if (lastmod != null) parts.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
    parts.push("  </sitemap>");
  }
  parts.push("</sitemapindex>");
  return parts.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Deterministic urlset XML (no changefreq/priority by default, §18). */
export function renderSitemapXml(urls: readonly SitemapUrlEntry[]): string {
  const hasAlternates = urls.some((url) => (url.alternates?.length ?? 0) > 0);
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  parts.push(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${
      hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ""
    }>`,
  );
  for (const url of urls) {
    parts.push("  <url>");
    parts.push(`    <loc>${escapeXml(url.loc)}</loc>`);
    for (const alternate of url.alternates ?? []) {
      parts.push(
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(alternate.href)}" />`,
      );
    }
    if (url.lastmod != null) parts.push(`    <lastmod>${escapeXml(url.lastmod)}</lastmod>`);
    parts.push("  </url>");
  }
  parts.push("</urlset>");
  return parts.join("\n");
}
