import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";
import { renderRichText } from "@pcms/themes";
import { registerRichTextAssets, withRichTextStyles } from "../../apps/web/src/richtext-assets.js";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const value = {
  type: "document",
  schema_version: 2,
  content: [
    {
      type: "table",
      caption: [{ type: "text", text: "Caption" }],
      content: [
        {
          type: "table_row",
          content: [
            { type: "table_cell", header: "column", content: [paragraph("Header")] },
            { type: "table_cell", content: [paragraph("Data")] },
          ],
        },
      ],
    },
    {
      type: "image",
      media_id: "01900000-0000-7000-8000-000000000001",
      alt: '"<alt>',
      caption: [{ type: "text", text: "Image caption" }],
    },
    { type: "code_block", code: "<script>alert(1)</script>", language: "js" },
    { type: "horizontal_rule" },
  ],
};
test("Core renders v2 semantic tables, explicit headers, media and escaped code without theme renderers", () => {
  const html = renderRichText(value, { imageSource: () => "/media/image.webp" }).html;
  assert.match(html, /<caption>Caption<\/caption>/);
  assert.match(html, /<th scope="col"><p>Header<\/p><\/th><td><p>Data<\/p><\/td>/);
  assert.match(html, /<figure[^>]*><img src="\/media\/image.webp"/);
  assert.match(html, /<figcaption>Image caption<\/figcaption>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.throws(() => renderRichText(value), { code: "THEME_RICHTEXT_MEDIA_UNAVAILABLE" });
  assert.throws(
    () =>
      renderRichText({
        type: "document",
        schema_version: 2,
        content: [{ type: "table", content: [] }],
      }),
    { code: "THEME_RICHTEXT_INVALID" },
  );
});
test("Core CSS is served with correct MIME and composed once for multiple fragments", async (t) => {
  const app = createApiFastify(() => "richtext-assets");
  t.after(() => app.close());
  registerRichTextAssets(app);
  const response = await app.inject({ url: "/core-assets/richtext-v2.css" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^text\/css/);
  assert.match(response.body, /overflow-x:auto/);
  const fragment = renderRichText({
    type: "document",
    schema_version: 2,
    content: [paragraph("A")],
  }).html;
  const html = withRichTextStyles(`<html><head></head><body>${fragment}${fragment}</body></html>`);
  assert.equal((html.match(/richtext-v2\.css/g) ?? []).length, 1);
  assert.match(html, /richtext-v2.css"><\/head>/);
  assert.equal(withRichTextStyles(html), html);
});
