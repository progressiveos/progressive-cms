/**
 * HTML escaping — the single canonical implementation. Transports render
 * untrusted strings in text and double-quoted attribute contexts; every
 * renderer must escape through this function (or a hardened template engine)
 * instead of keeping private copies.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const ESCAPE_RE = /[&<>"']/g;

/** HTML-escapes a string for text content and double-quoted attribute contexts. */
export function escapeHtmlString(text: string): string {
  return text.replace(ESCAPE_RE, (ch) => ESCAPES[ch] ?? ch);
}

/**
 * System-owned document slot injection (ADR-0016): inserts `fragment` right
 * after the OPENING tag `tagName` (`head`/`body`) of an HTML document.
 *
 * Deliberately NOT `html.replace("<head>", …)`: the match is the real
 * opening tag with any case, attributes and whitespace (`<HEAD>`,
 * `<body class="x" data-y>`, `<head\n  lang="ru">`), only the FIRST
 * occurrence wins, tag-in-attribute values are never matched (the pattern
 * requires the tag-name-delimiting `>`), and documents without the target
 * opening tag are returned unchanged — a broken theme degrades to "no
 * system slot", never to corrupted HTML.
 */
export function injectAfterOpeningTag(
  html: string,
  tagName: "head" | "body",
  fragment: string,
): string {
  if (fragment === "") return html;
  const openTag = new RegExp(`<${tagName}(?=[\\s>])([^>]*)>`, "i");
  const match = openTag.exec(html);
  if (match === null) return html;
  const at = match.index + match[0].length;
  return `${html.slice(0, at)}${fragment}${html.slice(at)}`;
}
