// Tilda connector (site-migration extension). Tilda has no DB to export —
// two source modes, both ending in the same shared core:
//   1. sitemap crawl (no Tilda account needed): fetch /sitemap.xml, pull
//      every page's rendered HTML, take the #allrecords content container;
//   2. export zip (paid plans): operator downloads it from Tilda admin,
//      unpacks, passes --dir; each *.html file is one page.
// Tilda pages are div-heavy "t-records"; turndown flattens them into
// markdown — the result is honest content, not pixel-perfect layout. Layout
// fidelity (screenshots → theme mapping) is a separate phase.
import {
  buildMigrationWorkspace,
  defaultNormalize,
  type MigrationWorkspace,
  type SourcePage,
} from "./common.js";

/** Extract a plan-ready page from rendered Tilda HTML. */
export function tildaHtmlToPage(
  url: string,
  html: string,
): SourcePage | { readonly skipped: true; readonly reason: string } {
  const titleMatch = /<title>([^<]*)<\/title>/i.exec(html);
  const title = (titleMatch?.[1] ?? url ?? url).trim();
  // Tilda wraps page content in #allrecords; fall back to <body>.
  // Greedy to </body>: t-records nest arbitrarily deep; scripts/styles are
  // stripped later by the shared converter.
  const allRecords = /<div[^>]*id="allrecords"[^>]*>([\s\S]*)<\/body>/i.exec(html);
  let content = allRecords?.[1] ?? "";
  if (content.trim() === "") {
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    content = body?.[1] ?? "";
  }
  if (content.replace(/<[^>]*>/g, "").trim() === "") {
    return { skipped: true, reason: `no text content: ${url}` };
  }
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return { skipped: true, reason: `bad url: ${url}` };
  }
  const normalized = defaultNormalize(path);
  if (normalized === null) return { skipped: true, reason: `query url: ${url}` };
  return {
    id: path,
    engine: "tilda",
    uri: normalized,
    title,
    html: content,
    deleted: false,
  };
}

/** sitemap.xml → page URLs (locs ending in / or .html, not assets). */
export function sitemapLocs(sitemapXml: string): string[] {
  const locs: string[] = [];
  for (const match of sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const loc = match[1] ?? "";
    if (loc === "" || /\.(xml|css|js|jpe?g|png|gif|webp|pdf|svg|zip)$/i.test(loc)) continue;
    locs.push(loc);
  }
  return locs;
}

/** Directory mode: one workspace from unpacked Tilda export HTML files. */
export function buildWorkspaceFromTildaPages(
  pages: readonly { readonly url: string; readonly html: string }[],
  siteUrl: string,
): MigrationWorkspace {
  const sourcePages: SourcePage[] = [];
  const skipReasons: string[] = [];
  for (const page of pages) {
    const mapped = tildaHtmlToPage(page.url, page.html);
    if ("skipped" in mapped) {
      skipReasons.push(mapped.reason);
      continue;
    }
    sourcePages.push(mapped);
  }
  const workspace = buildMigrationWorkspace({ pages: sourcePages, siteUrl });
  return {
    ...workspace,
    warnings: [
      ...workspace.warnings,
      ...skipReasons.map((reason) => ({ code: "SKIPPED_CLASS" as const, detail: reason })),
    ],
  };
}

/** Path normalizer passthrough for the CLI (Tilda paths are already clean). */
export const tildaNormalize = defaultNormalize;
