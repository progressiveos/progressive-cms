// RichText trusted renderer bridge (PCMS-THEME-T010; Theme Contract spec §21).
//
// Themes never parse Markdown per request and never trust raw HTML: this
// bridge is the single path from the RichText AST v2 (16 node types / 3 marks,
// the only supported version) to trusted HTML. It escapes all text,
// allowlists every emitted tag/attribute, validates link schemes (defense in
// depth — the Content validator already rejects bad hrefs) and is bounded like
// the AST itself. A malformed or unknown node is a hard error: there is no
// lenient read path for retired v1 documents.
import { escapeHtmlString, type SafeHtml, safeHtml } from "../engine/safe-html.js";
import { ThemeError } from "../errors.js";
import type { RichTextNodeViewModel } from "../view-models.js";

/** Mirrors Content RICHTEXT_MAX_NODES / RICHTEXT_MAX_DEPTH (defense in depth). */
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;

/** Link href policy: identical to the Content subsystem allowlist. */
const HREF_ALLOWED_RE = /^(https:\/\/|http:\/\/|mailto:|\/|#)/i;
/** Blocked URL schemes (mirrors the Content subsystem allowlist). */
const HREF_BLOCKED_RE = /(javascript|data|vbscript):/i;
const NODE_TYPES: ReadonlySet<string> = new Set([
  "document",
  "paragraph",
  "heading",
  "bullet_list",
  "ordered_list",
  "list_item",
  "blockquote",
  "image",
  "text",
  "hard_break",
  "link",
  "table",
  "table_row",
  "table_cell",
  "code_block",
  "horizontal_rule",
]);

export interface RichTextRenderOptions {
  readonly imageSource?: (mediaId: string) => string | null;
}

interface Budget {
  nodes: number;
  options: RichTextRenderOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childrenOf(node: Record<string, unknown>): RichTextNodeViewModel[] {
  const content = node.content;
  return Array.isArray(content) ? (content as RichTextNodeViewModel[]) : [];
}

function clampLevel(level: unknown): number {
  const n = typeof level === "number" && Number.isFinite(level) ? Math.round(level) : 2;
  return Math.min(6, Math.max(1, n));
}

function renderMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks)) return text;
  let html = text;
  for (const mark of marks) {
    const type = isRecord(mark) ? mark.type : mark;
    switch (type) {
      case "code":
        html = `<code>${html}</code>`;
        break;
      case "strong":
        html = `<strong>${html}</strong>`;
        break;
      case "emphasis":
        html = `<em>${html}</em>`;
        break;
      default:
        break; // unknown marks are dropped, never passthrough
    }
  }
  return html;
}

function renderLinkHref(node: Record<string, unknown>): string | null {
  const href = node.href;
  if (typeof href !== "string") return null;
  if (!HREF_ALLOWED_RE.test(href) || HREF_BLOCKED_RE.test(href)) return null;
  return href;
}

function renderNode(node: RichTextNodeViewModel, depth: number, budget: Budget): string {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) {
    throw new ThemeError("THEME_RICHTEXT_TOO_LARGE", `RichText exceeds ${MAX_NODES} nodes`);
  }
  if (depth > MAX_DEPTH) {
    throw new ThemeError("THEME_RICHTEXT_TOO_DEEP", `RichText exceeds depth ${MAX_DEPTH}`);
  }
  if (!isRecord(node) || typeof node.type !== "string" || !NODE_TYPES.has(node.type)) {
    throw new ThemeError("THEME_RICHTEXT_INVALID", "Unknown or malformed RichText v2 node");
  }
  const children = (): string =>
    childrenOf(node)
      .map((child) => renderNode(child, depth + 1, budget))
      .join("");
  switch (node.type) {
    case "document":
      return `<div class="pcms-richtext-document">${children()}</div>`;
    case "paragraph":
      return `<p>${children()}</p>`;
    case "heading":
      return `<h${clampLevel(node.level)}>${children()}</h${clampLevel(node.level)}>`;
    case "bullet_list":
      return `<ul>${children()}</ul>`;
    case "ordered_list": {
      const start =
        Number.isSafeInteger(node.start) && (node.start as number) > 0
          ? ` start="${node.start}"`
          : "";
      return `<ol${start}>${children()}</ol>`;
    }
    case "horizontal_rule":
      return "<hr>";
    case "code_block": {
      if (typeof node.code !== "string")
        throw new ThemeError("THEME_RICHTEXT_INVALID", "Missing code text");
      const language =
        typeof node.language === "string" && /^[a-zA-Z0-9_+-]{1,50}$/.test(node.language)
          ? ` class="language-${node.language}"`
          : "";
      return `<pre><code${language}>${escapeHtmlString(node.code)}</code></pre>`;
    }
    case "table": {
      const rows = childrenOf(node);
      const width = rows[0] ? childrenOf(rows[0]).length : 0;
      if (
        rows.length < 1 ||
        rows.length > 2000 ||
        width < 1 ||
        width > 50 ||
        rows.length * width > 10_000 ||
        rows.some((row) => row.type !== "table_row" || childrenOf(row).length !== width)
      )
        throw new ThemeError("THEME_RICHTEXT_INVALID", "Table must be bounded and rectangular");
      const caption = Array.isArray(node.caption)
        ? `<caption>${(node.caption as RichTextNodeViewModel[]).map((child) => renderNode(child, depth + 1, budget)).join("")}</caption>`
        : "";
      return `<div class="pcms-richtext-table" role="region" tabindex="0" aria-label="Table"><table>${caption}<tbody>${children()}</tbody></table></div>`;
    }
    case "table_row":
      if (childrenOf(node).some((child) => child.type !== "table_cell"))
        throw new ThemeError("THEME_RICHTEXT_INVALID", "Invalid row children");
      return `<tr>${children()}</tr>`;
    case "table_cell": {
      if (
        childrenOf(node).length === 0 ||
        childrenOf(node).some((child) => child.type !== "paragraph") ||
        (node.header !== undefined && node.header !== "row" && node.header !== "column")
      )
        throw new ThemeError("THEME_RICHTEXT_INVALID", "Invalid table cell");
      const header = node.header === "row" ? "row" : node.header === "column" ? "col" : null;
      return header ? `<th scope="${header}">${children()}</th>` : `<td>${children()}</td>`;
    }
    case "list_item":
      return `<li>${children()}</li>`;
    case "blockquote":
      return `<blockquote>${children()}</blockquote>`;
    case "image": {
      // Same scheme allowlist as links; non-conforming src renders nothing
      // (the AST validator already rejects them at seal time — this is the
      // belt for pre-existing documents).
      const src =
        typeof node.media_id === "string"
          ? (budget.options.imageSource?.(node.media_id) ?? "")
          : typeof node.src === "string"
            ? node.src
            : "";
      if (typeof node.media_id === "string" && src === "")
        throw new ThemeError(
          "THEME_RICHTEXT_MEDIA_UNAVAILABLE",
          "RichText image reference is unavailable",
        );
      if (src.length === 0 || HREF_BLOCKED_RE.test(src) || !HREF_ALLOWED_RE.test(src)) return "";
      const alt = escapeHtmlString(typeof node.alt === "string" ? node.alt : "");
      const title =
        typeof node.title === "string" && node.title.length > 0
          ? ` title="${escapeHtmlString(node.title)}"`
          : "";
      const image = `<img src="${escapeHtmlString(src)}" alt="${alt}"${title}>`;
      const caption = Array.isArray(node.caption)
        ? `<figcaption>${(node.caption as RichTextNodeViewModel[]).map((child) => renderNode(child, depth + 1, budget)).join("")}</figcaption>`
        : "";
      return `<figure class="pcms-richtext-image">${image}${caption}</figure>`;
    }
    case "hard_break":
      return "<br>";
    case "link": {
      const href = renderLinkHref(node);
      const inner = children();
      return href === null ? inner : `<a href="${escapeHtmlString(href)}">${inner}</a>`;
    }
    case "text": {
      const text = typeof node.text === "string" ? node.text : "";
      return renderMarks(escapeHtmlString(text), node.marks);
    }
  }
  return "";
}

/**
 * Renders a RichText AST into a trusted HTML fragment. All text is escaped;
 * emitted tags come only from the allowlist above; blocked or missing link
 * hrefs render the link text without an anchor.
 *
 * The document root must declare `schema_version: 2` — the same requirement the
 * Content validator enforces — so a retired v1 payload fails loudly at render
 * instead of being rendered from a shape that no longer has a contract.
 */
export function renderRichText(ast: unknown, options: RichTextRenderOptions = {}): SafeHtml {
  if (ast === null || ast === undefined) return safeHtml("");
  if (!isRecord(ast) || ast.schema_version !== 2) {
    throw new ThemeError(
      "THEME_RICHTEXT_INVALID",
      "RichText rendering requires a v2 document (schema_version: 2)",
    );
  }
  return safeHtml(
    renderNode(ast as RichTextNodeViewModel, 0, {
      nodes: 0,
      options,
    }),
  );
}

/**
 * True when a block-props value looks like a RichText document node
 * (`{ type: "document", content: [...] }`). Used to auto-render RichText
 * fields inside block props into trusted fragments (PCMS-THEME-T008 scope
 * preparation) without trusting arbitrary shapes.
 */
export function isRichTextDocument(value: unknown): value is RichTextNodeViewModel {
  return (
    isRecord(value) &&
    value.type === "document" &&
    Array.isArray(value.content) &&
    value.content.every((child) => isRecord(child) && typeof child.type === "string")
  );
}

/** Deeply replaces RichText document nodes in props with trusted HTML fragments. */
export function renderRichTextInProps(
  props: Readonly<Record<string, unknown>>,
  options: RichTextRenderOptions = {},
): Record<string, unknown> {
  const transform = (value: unknown): unknown => {
    if (isRichTextDocument(value)) return renderRichText(value, options);
    if (Array.isArray(value)) return value.map(transform);
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v)]));
    }
    return value;
  };
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, transform(v)]));
}
