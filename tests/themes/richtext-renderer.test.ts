// RichText trusted renderer bridge tests (PCMS-THEME-T010) — XSS and raw
// HTML must not survive; semantic tags are preserved; v2-only is enforced.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRichText, renderRichTextInProps } from "@pcms/themes";

/** Every fixture is a v2 document: the renderer accepts nothing else. */
const v2 = (content: unknown[]) => ({ schema_version: 2, type: "document", content });

test("a document without schema_version 2 is refused at render", () => {
  assert.throws(
    () => renderRichText({ type: "document", content: [{ type: "text", text: "x" }] }),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_RICHTEXT_INVALID",
  );
  assert.throws(() => renderRichText({ schema_version: 1, type: "document", content: [] }));
});

test("text nodes escape; marks become semantic tags", () => {
  assert.equal(
    renderRichText(v2([{ type: "text", text: "a<b & c" }])).html,
    '<div class="pcms-richtext-document">a&lt;b &amp; c</div>',
  );
  assert.equal(
    renderRichText(
      v2([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " and " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " and ", marks: [] },
            { type: "text", text: "em", marks: [{ type: "emphasis" }] },
          ],
        },
      ]),
    ).html,
    '<div class="pcms-richtext-document"><p><strong>bold</strong> and <code>code</code> and <em>em</em></p></div>',
  );
});

test("document structure: headings, lists, quotes, hard breaks", () => {
  const html = renderRichText(
    v2([
      { type: "heading", level: 2, content: [{ type: "text", text: "Title" }] },
      {
        type: "bullet_list",
        content: [
          {
            type: "list_item",
            content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
          },
          {
            type: "list_item",
            content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
          },
        ],
      },
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: "quote" }] }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "line1" },
          { type: "hard_break" },
          { type: "text", text: "line2" },
        ],
      },
    ]),
  ).html;
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<ul><li><p>one<\/p><\/li><li><p>two<\/p><\/li><\/ul>/);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.match(html, /line1<br>line2/);
});

test("links: safe schemes render anchors, hostile schemes are stripped", () => {
  const doc = (href: string) =>
    v2([
      {
        type: "paragraph",
        content: [{ type: "link", href, content: [{ type: "text", text: "x" }] }],
      },
    ]);
  assert.equal(
    renderRichText(doc("https://example.com/a?b=1")).html,
    '<div class="pcms-richtext-document"><p><a href="https://example.com/a?b=1">x</a></p></div>',
  );
  assert.equal(
    renderRichText(doc("http://example.com")).html,
    '<div class="pcms-richtext-document"><p><a href="http://example.com">x</a></p></div>',
  );
  assert.equal(
    renderRichText(doc("mailto:a@b.c")).html,
    '<div class="pcms-richtext-document"><p><a href="mailto:a@b.c">x</a></p></div>',
  );
  assert.equal(
    renderRichText(doc("/relative/path")).html,
    '<div class="pcms-richtext-document"><p><a href="/relative/path">x</a></p></div>',
  );
  assert.equal(
    renderRichText(doc("#anchor")).html,
    '<div class="pcms-richtext-document"><p><a href="#anchor">x</a></p></div>',
  );
  // Blocked: link text survives, the anchor/href does not.
  assert.equal(
    renderRichText(doc("javascript:alert(1)")).html,
    '<div class="pcms-richtext-document"><p>x</p></div>',
  );
  assert.equal(
    renderRichText(doc("data:text/html,<script>")).html,
    '<div class="pcms-richtext-document"><p>x</p></div>',
  );
  assert.equal(
    renderRichText(doc("vbscript:x")).html,
    '<div class="pcms-richtext-document"><p>x</p></div>',
  );
});

test("hostile text and attributes never reach the output", () => {
  const html = renderRichText(
    v2([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "<img src=x onerror=alert(1)>" },
          {
            type: "link",
            href: "/ok",
            style: "position:fixed",
            onclick: "evil()",
            content: [{ type: "text", text: '"quoted"' }],
          },
        ],
      },
    ]),
  ).html;
  // The hostile tag survives only as inert escaped text.
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /style=/);
  assert.doesNotMatch(html, /onclick/);
  assert.match(html, /&quot;quoted&quot;/);
});

test("unknown node types are refused, never dropped or passed through", () => {
  // A v1-era lenient read silently returned "" for these; v2 fails loudly.
  for (const node of [
    { type: "iframe", src: "https://evil.example" },
    { type: "html", text: "<script>x</script>" },
  ])
    assert.throws(
      () => renderRichText(v2([node])),
      (err: unknown) =>
        err instanceof Error && "code" in err && err.code === "THEME_RICHTEXT_INVALID",
      `node ${node.type} must be refused`,
    );
  // Unknown MARKS are dropped (they cannot change structure), text survives.
  const html = renderRichText(
    v2([{ type: "text", text: "kept", marks: [{ type: "blink" }] }]),
  ).html;
  assert.doesNotMatch(html, /blink/);
  assert.match(html, /kept/);
});

test("oversized and too-deep ASTs are bounded", () => {
  const deep: Record<string, unknown> = { type: "text", text: "x" };
  let node: Record<string, unknown> = deep;
  for (let i = 0; i < 40; i += 1) node = { type: "paragraph", content: [node] };
  assert.throws(
    () => renderRichText(v2([node])),
    (err: unknown) =>
      err instanceof Error &&
      "code" in err &&
      (err.code === "THEME_RICHTEXT_TOO_DEEP" || err.code === "THEME_RICHTEXT_TOO_LARGE"),
  );

  const wide = v2(Array.from({ length: 10_001 }, () => ({ type: "text", text: "x" })));
  assert.throws(
    () => renderRichText(wide),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_RICHTEXT_TOO_LARGE",
  );
});

test("empty/null input renders empty trusted fragment", () => {
  assert.equal(renderRichText(null).html, "");
  assert.equal(renderRichText(undefined).html, "");
});

test("renderRichTextInProps turns nested RichText ASTs into trusted fragments", () => {
  const props = renderRichTextInProps({
    title: "plain",
    rich_text: v2([{ type: "paragraph", content: [{ type: "text", text: "Hi <b>" }] }]),
    items: [
      {
        text: v2([{ type: "paragraph", content: [{ type: "text", text: "item" }] }]),
      },
    ],
  });
  assert.equal(props.title, "plain");
  const richText = props.rich_text as { html: string };
  assert.equal(richText.html, '<div class="pcms-richtext-document"><p>Hi &lt;b&gt;</p></div>');
  const items = props.items as { text: { html: string } }[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text.html, '<div class="pcms-richtext-document"><p>item</p></div>');
});
