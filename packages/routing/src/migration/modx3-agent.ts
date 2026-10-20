// MODX migration agent export → full PCMS migration workspace (the "2 URL"
// pipeline): the MODX-side agent (agent/modx3/pcms-agent.php) is pulled once,
// this module turns its export into
//   - the URL plan (redirects.csv / canonical.csv — §33/§61),
//   - a .pcpub workspace (publication.yaml + content/*.pcmd + assets/) with
//     route.path = the preserved MODX URI, HTML → markdown via turndown,
//   - a MIGX sidecar (raw TV JSON for phase-2 block mapping).
// Images referenced by content are emitted into assets/ by the caller (the
// CLI downloads them); PCMD references them as bundle:assets/….
import TurndownService from "turndown";
import type { PlanWarning, RedirectPlanRow } from "./modx3.js";
import { normalizePath } from "./modx3.js";

export interface AgentResource {
  readonly id: number;
  readonly parent: number;
  readonly template: number;
  readonly content_type: number;
  readonly class_key: string;
  readonly context_key: string;
  readonly alias: string;
  readonly uri: string;
  readonly uri_override: number;
  readonly pagetitle: string;
  readonly longtitle: string;
  readonly introtext: string;
  readonly content: string;
  readonly menutitle: string;
  readonly menuindex: number;
  readonly published: number;
  readonly deleted: number;
  readonly isfolder: number;
  readonly tvs: readonly { id: number; name: string; type: string; value: string }[];
}

export interface AgentInfo {
  readonly modx_version: string | null;
  readonly settings: {
    readonly site_url: string;
    readonly friendly_urls: boolean;
    readonly use_alias_path: boolean;
    readonly container_suffix: string;
    readonly site_start: number;
  };
  readonly extras: Readonly<Record<string, unknown>>;
}

export interface AgentExport {
  readonly info: AgentInfo;
  readonly tvs: readonly { id: number; name: string; type: string; caption: string }[];
  readonly resources: readonly AgentResource[];
  readonly seosuiteRedirects: readonly Record<string, unknown>[];
  readonly mediaSources: readonly {
    readonly id: number;
    readonly name: string;
    readonly base_url: string;
  }[];
}

export interface MigrationDocument {
  readonly externalId: string;
  readonly modxId: number;
  readonly title: string;
  readonly routePath: string;
  readonly markdown: string;
  readonly imageUrls: readonly string[];
  readonly published: boolean;
}

export interface MigrationWorkspacePlan {
  readonly redirects: readonly RedirectPlanRow[];
  readonly canonical: readonly { id: number; old_uri: string; canonical_path: string }[];
  readonly documents: readonly MigrationDocument[];
  readonly migxSidecar: readonly {
    readonly modx_id: number;
    readonly uri: string;
    readonly tvs: readonly { name: string; type: string; value: string }[];
  }[];
  readonly warnings: readonly PlanWarning[];
  readonly summary: {
    readonly resources: number;
    readonly documents: number;
    readonly deleted410: number;
    readonly preserved: number;
    readonly seosuiteRedirects: number;
    readonly images: number;
    readonly migxResources: number;
  };
}

const IMAGE_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi;

function extractImageUrls(html: string, siteUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(IMAGE_SRC_RE)) {
    const src = (match[2] ?? match[3] ?? "").trim();
    if (src === "" || src.startsWith("data:")) continue;
    try {
      urls.add(new URL(src, siteUrl).toString());
    } catch {
      // Unresolvable src — leave to the manifest as-is (reviewable).
      urls.add(src);
    }
  }
  return [...urls];
}

function stripImages(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<p>(\s|&nbsp;)*<\/p>/gi, "")
    .trim();
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
(turndown as unknown as { remove: (tags: string) => TurndownService }).remove(
  "script style form iframe object embed noscript",
);

function htmlToMarkdown(html: string): string {
  const markdown = turndown.turndown(html).trim();
  return markdown;
}

/** One .pcpub content document for a MODX resource. assetPrefix names the
 * bundle asset files (sanitized, unique per document). */
export function resourceToPcmd(document: MigrationDocument, assetPrefix: string): string {
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

function extOf(url: string): string {
  const path = new URL(url, "https://placeholder.invalid").pathname;
  const match = /\.[a-z0-9]{2,5}$/i.exec(path);
  return match === null ? ".bin" : match[0].toLowerCase();
}

/**
 * Builds the whole migration workspace plan from the agent export. Pure (no
 * I/O): the caller fetches export chunks and writes files.
 */
export function buildWorkspaceFromAgentExport(exportData: AgentExport): MigrationWorkspacePlan {
  const warnings: PlanWarning[] = [];
  if (!exportData.info.settings.friendly_urls) {
    warnings.push({
      code: "QUERY_URI",
      detail: "source has friendly_urls OFF — URIs are query URLs; enable FURLs in MODX first",
    });
  }
  const siteUrl = exportData.info.settings.site_url || "https://modx-source.invalid/";
  const slugSeen = new Set<string>();
  const documents: MigrationDocument[] = [];
  const canonical: { id: number; old_uri: string; canonical_path: string }[] = [];
  const redirects: RedirectPlanRow[] = [];
  const migxSidecar: {
    modx_id: number;
    uri: string;
    tvs: { name: string; type: string; value: string }[];
  }[] = [];
  let images = 0;
  let migxResources = 0;

  for (const resource of exportData.resources) {
    if (resource.class_key !== "modDocument") continue;
    const oldPath = normalizePath(resource.uri);
    if (oldPath === null) {
      warnings.push({
        code: "QUERY_URI",
        detail: `resource ${resource.id} (${resource.pagetitle}): uri="${resource.uri}"`,
      });
      continue;
    }
    if (slugSeen.has(oldPath)) {
      warnings.push({ code: "DUPLICATE_URI", detail: `${oldPath}: resource ${resource.id}` });
      continue;
    }
    slugSeen.add(oldPath);

    if (resource.deleted === 1) {
      redirects.push({
        source: oldPath,
        target: null,
        status_code: 410,
        reason: "modx: resource deleted",
      });
      continue;
    }

    const hasMigx = resource.tvs.some((tv) => tv.type === "migx");
    if (hasMigx) {
      migxResources += 1;
      migxSidecar.push({
        modx_id: resource.id,
        uri: oldPath,
        tvs: resource.tvs.filter((tv) => tv.type === "migx"),
      });
    }

    const html = `${resource.content}\n${resource.introtext}`.trim();
    const imageUrls = extractImageUrls(html, siteUrl);
    images += imageUrls.length;
    const markdown = htmlToMarkdown(stripImages(html));
    const document: MigrationDocument = {
      externalId: `modx-${resource.id}`,
      modxId: resource.id,
      title: resource.longtitle !== "" ? resource.longtitle : resource.pagetitle,
      routePath: oldPath,
      markdown,
      imageUrls,
      published: resource.published === 1,
    };
    documents.push(document);
    canonical.push({ id: resource.id, old_uri: oldPath, canonical_path: oldPath });
  }

  for (const row of exportData.seosuiteRedirects) {
    const source = typeof row["old_url"] === "string" ? normalizePath(row["old_url"]) : null;
    const target = typeof row["new_url"] === "string" ? normalizePath(row["new_url"]) : null;
    if (source === null || source === "/" || slugSeen.has(source)) continue;
    redirects.push({
      source,
      target,
      status_code: 301,
      reason: "modx seosuite history",
    });
  }

  return {
    redirects,
    canonical,
    documents,
    migxSidecar,
    warnings,
    summary: {
      resources: exportData.resources.length,
      documents: documents.length,
      deleted410: redirects.filter((row) => row.status_code === 410).length,
      preserved: canonical.length,
      seosuiteRedirects: exportData.seosuiteRedirects.length,
      images,
      migxResources,
    },
  };
}
