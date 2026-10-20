// Source-agnostic migration core (site-migration extension): HTML → markdown
// → PCMD documents, image extraction, URL-plan assembly. Engine connectors
// (modx3, wordpress, bitrix, tilda) map their source records onto
// SourcePage[] and call buildMigrationWorkspace — everything below is
// engine-neutral.
import TurndownService from "turndown";
import type { PlanWarning, RedirectPlanRow } from "./modx3.js";

export interface SourcePage {
  /** Engine-native numeric or string id; becomes external_id "…-<id>". */
  readonly id: string | number;
  /** Engine prefix for external_id (e.g. "modx", "wp", "bitrix", "tilda"). */
  readonly engine: string;
  /** Old public URI (path, leading slash added by normalizeUri). */
  readonly uri: string;
  readonly title: string;
  /** Main content HTML (already the page body the engine serves). */
  readonly html: string;
  readonly deleted: boolean;
  /** Non-page records (weblinks, symlinks, system pages) — counted, skipped. */
  readonly skip?: { readonly classKey: string };
}

export interface MigrationDocument {
  readonly externalId: string;
  readonly sourceId: string | number;
  readonly engine: string;
  readonly title: string;
  readonly routePath: string;
  readonly markdown: string;
  readonly imageUrls: readonly string[];
  readonly published: boolean;
}

export interface MigrationRedirect {
  readonly source: string;
  readonly target: string | null;
  readonly status_code: 301 | 410;
  readonly reason: string;
}

export interface MigrationWorkspace {
  readonly redirects: readonly MigrationRedirect[];
  readonly canonical: readonly {
    readonly id: string;
    readonly old_uri: string;
    readonly canonical_path: string;
  }[];
  readonly documents: readonly MigrationDocument[];
  readonly warnings: readonly PlanWarning[];
  readonly skipped: readonly { readonly classKey: string; readonly count: number }[];
}

export interface BuildWorkspaceInput {
  readonly pages: readonly SourcePage[];
  /** Absolute base for resolving relative image src (e.g. site_url). */
  readonly siteUrl: string;
  /** Extra redirects (engine plugin history, operator map): old → new paths. */
  readonly extraRedirects?: readonly { source: string; target: string | null }[];
  /** URIs already claimed by documents — extra redirects onto them are kept,
   * onto unknown targets still fine; onto themselves are dropped. */
  readonly normalize?: (uri: string) => string | null;
}

/** MODX-compatible default normalizer: home "" → "/", add trailing slash
 * when the path has neither slash-suffix nor extension. */
export function defaultNormalize(uri: string): string | null {
  if (uri === "") return "/";
  if (uri.includes("?") || uri.includes("index.php")) return null;
  const path = uri.startsWith("/") ? uri : `/${uri}`;
  if (!path.endsWith("/") && !/\.[a-z0-9]{2,5}$/i.test(path)) return `${path}/`;
  return path;
}

const IMAGE_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi;
const IMG_TAG_RE = /<img\b[^>]*>/gi;

export function extractImageUrls(html: string, siteUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(IMAGE_SRC_RE)) {
    const src = (match[2] ?? match[3] ?? "").trim();
    if (src === "" || src.startsWith("data:")) continue;
    try {
      urls.add(new URL(src, siteUrl).toString());
    } catch {
      urls.add(src);
    }
  }
  return [...urls];
}

export function stripImages(html: string): string {
  return html
    .replace(IMG_TAG_RE, "")
    .replace(/<p>(\s|&nbsp;)*<\/p>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .trim();
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
(turndown as unknown as { remove: (tags: string) => TurndownService }).remove(
  "script style form iframe object embed noscript input button select",
);

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

function extOf(url: string): string {
  try {
    const path = new URL(url, "https://placeholder.invalid").pathname;
    const match = /\.[a-z0-9]{2,5}$/i.exec(path);
    return match === null ? ".bin" : match[0].toLowerCase();
  } catch {
    return ".bin";
  }
}

/** One .pcpub content document. assetPrefix names the bundle asset files. */
export function documentToPcmd(document: MigrationDocument, assetPrefix: string): string {
  const frontmatter = [
    "---",
    "pcmd_version: 1",
    "operation: create",
    `external_id: ${document.externalId}`,
    "content_type: page",
    "fields:",
    `  title: ${JSON.stringify(document.title)}`,
    "route:",
    `  path: ${JSON.stringify(document.routePath)}`,
    "---",
  ].join("\n");
  const blocks: string[] = [];
  if (document.markdown !== "") {
    const indented = document.markdown
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    blocks.push(`:::block text@1\nrich_text: |\n${indented}\n:::`);
  }
  document.imageUrls.forEach((url, index) => {
    blocks.push(
      `:::block image@${index + 2}\nmedia_id: ${JSON.stringify(`bundle:assets/${assetPrefix}-${index + 1}${extOf(url)}`)}\nalt_override: ${JSON.stringify(document.title)}\n:::`,
    );
  });
  return `${frontmatter}\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Engine-neutral workspace builder: dedupe URIs, 410 deleted, preserve
 * survivors as §61 canonical documents, merge extra redirects.
 */
export function buildMigrationWorkspace(input: BuildWorkspaceInput): MigrationWorkspace {
  const normalize = input.normalize ?? defaultNormalize;
  const warnings: PlanWarning[] = [];
  const documents: MigrationDocument[] = [];
  const canonical: { id: string; old_uri: string; canonical_path: string }[] = [];
  const redirects: MigrationRedirect[] = [];
  const seen = new Set<string>();
  const skipped = new Map<string, number>();

  for (const page of input.pages) {
    if (page.skip !== undefined) {
      skipped.set(page.skip.classKey, (skipped.get(page.skip.classKey) ?? 0) + 1);
      continue;
    }
    const oldPath = normalize(page.uri);
    if (oldPath === null) {
      warnings.push({
        code: "QUERY_URI",
        detail: `resource ${page.id} (${page.title}): uri="${page.uri}"`,
      });
      continue;
    }
    if (seen.has(oldPath)) {
      warnings.push({ code: "DUPLICATE_URI", detail: `${oldPath}: resource ${page.id}` });
      continue;
    }
    seen.add(oldPath);

    if (page.deleted) {
      redirects.push({
        source: oldPath,
        target: null,
        status_code: 410,
        reason: `${page.engine}: resource deleted`,
      });
      continue;
    }

    const imageUrls = extractImageUrls(page.html, input.siteUrl);
    documents.push({
      externalId: `${page.engine}-${page.id}`,
      sourceId: page.id,
      engine: page.engine,
      title: page.title,
      routePath: oldPath,
      markdown: htmlToMarkdown(stripImages(page.html)),
      imageUrls,
      published: true,
    });
    canonical.push({ id: String(page.id), old_uri: oldPath, canonical_path: oldPath });
  }

  for (const extra of input.extraRedirects ?? []) {
    const source = normalize(extra.source);
    if (source === null || source === "/" || seen.has(source)) continue;
    redirects.push({
      source,
      target: extra.target === null ? null : normalize(extra.target),
      status_code: 301,
      reason: "source engine redirect history",
    });
  }

  return {
    redirects,
    canonical,
    documents,
    warnings,
    skipped: [...skipped.entries()].map(([classKey, count]) => ({ classKey, count })),
  };
}

/** redirects.csv serialization (shared with the modx3 CSV connector). */
export function redirectsToCsv(rows: readonly MigrationRedirect[]): string {
  const quote = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = ["source,target,status_code,reason"];
  for (const row of rows) {
    lines.push(
      [
        quote(row.source),
        row.target === null ? "" : quote(row.target),
        String(row.status_code),
        quote(row.reason),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
