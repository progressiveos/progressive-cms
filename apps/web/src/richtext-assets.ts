import type { FastifyInstance } from "fastify";

export const RICHTEXT_STYLESHEET = "/core-assets/richtext-v2.css";
const CSS = `.pcms-richtext-document{min-width:0;overflow-wrap:anywhere}.pcms-richtext-table{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}.pcms-richtext-table table{border-collapse:collapse;min-width:100%}.pcms-richtext-table :where(td,th){padding:.5em;border:1px solid currentColor;vertical-align:top}.pcms-richtext-table :where(p){margin:0}.pcms-richtext-image{max-width:100%;margin-inline:0}.pcms-richtext-image img{max-width:100%;height:auto}.pcms-richtext-document pre{max-width:100%;overflow-x:auto}`;

/** Core owns the fallback even when a compatible theme does not use head_html. */
export function withRichTextStyles(html: string): string {
  if (
    !html.includes('class="pcms-richtext-document"') ||
    html.includes(`href="${RICHTEXT_STYLESHEET}"`)
  )
    return html;
  const link = `<link rel="stylesheet" href="${RICHTEXT_STYLESHEET}">`;
  return /<\/head\s*>/i.test(html)
    ? html.replace(/<\/head\s*>/i, `${link}</head>`)
    : `${link}${html}`;
}

export function registerRichTextAssets(fastify: FastifyInstance): void {
  fastify.get(RICHTEXT_STYLESHEET, async (_request, reply) =>
    reply
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", "public, max-age=3600")
      .header("x-content-type-options", "nosniff")
      .send(CSS),
  );
}
