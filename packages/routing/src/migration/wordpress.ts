// WordPress connector (site-migration extension): maps the native WP REST
// payload (no agent plugin needed — WP 5.6+ Application Passwords + core
// REST) onto the shared migration core. Public pages become §61 documents,
// trash becomes 410, drafts/private are skipped with a warning; media
// library is emitted as an inventory manifest.
import {
  buildMigrationWorkspace,
  defaultNormalize,
  type MigrationWorkspace,
  type SourcePage,
} from "./common.js";

export interface WpPage {
  readonly id: number;
  readonly link: string;
  readonly status: string;
  readonly type: string;
  readonly title: { readonly rendered: string };
  readonly content: { readonly rendered: string };
}

export interface WpMediaItem {
  readonly id: number;
  readonly source_url: string;
  readonly mime_type: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#039;": "'",
  "&#8211;": "–",
  "&#8212;": "—",
  "&nbsp;": " ",
  "&laquo;": "«",
  "&raquo;": "»",
};

function decodeEntities(text: string): string {
  let result = text;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    result = result.replaceAll(entity, char);
  }
  return result.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** WP REST link (absolute URL) → site path via the shared normalizer. */
export function wpLinkToPath(link: string): string | null {
  try {
    const url = new URL(link);
    if (url.search !== "") return null;
    return defaultNormalize(url.pathname);
  } catch {
    return null;
  }
}

export function buildWorkspaceFromWpRest(
  pages: readonly WpPage[],
  options: { readonly includeDrafts?: boolean } = {},
): MigrationWorkspace & {
  readonly mediaManifest: readonly WpMediaItem[];
  readonly drafts: number;
} {
  const siteUrl =
    pages
      .find((page) => page.link.startsWith("http"))
      ?.link.split("/")
      .slice(0, 3)
      .join("/") ?? "";
  const sourcePages: SourcePage[] = [];
  let drafts = 0;
  for (const page of pages) {
    if (page.status === "trash") {
      sourcePages.push({
        id: page.id,
        engine: "wp",
        uri: wpLinkToPath(page.link) ?? `/wp-${page.id}`,
        title: decodeEntities(page.title.rendered),
        html: page.content.rendered,
        deleted: true,
      });
      continue;
    }
    if (page.status !== "publish") {
      if (options.includeDrafts === true) {
        sourcePages.push({
          id: page.id,
          engine: "wp",
          uri: wpLinkToPath(page.link) ?? `/wp-${page.id}`,
          title: decodeEntities(page.title.rendered),
          html: page.content.rendered,
          deleted: false,
        });
      } else {
        drafts += 1;
      }
      continue;
    }
    sourcePages.push({
      id: page.id,
      engine: "wp",
      uri: wpLinkToPath(page.link) ?? `/wp-${page.id}`,
      title: decodeEntities(page.title.rendered),
      html: page.content.rendered,
      deleted: false,
    });
  }
  const workspace = buildMigrationWorkspace({ pages: sourcePages, siteUrl });
  return { ...workspace, mediaManifest: [], drafts };
}

export function mediaInventoryCsv(items: readonly WpMediaItem[]): string {
  const quote = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = ["wp_id,source_url,mime_type"];
  for (const item of items) {
    lines.push([String(item.id), quote(item.source_url), quote(item.mime_type)].join(","));
  }
  return `${lines.join("\n")}\n`;
}
