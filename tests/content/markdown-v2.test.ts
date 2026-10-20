import assert from "node:assert/strict";
import { test } from "node:test";
import { ContentError, markdownToRichText, richTextToMarkdown } from "@pcms/content";

function parse(markdown: string) {
  const result = markdownToRichText(markdown);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? (result.value as Record<string, unknown>) : {};
}
test("GFM table cells, escaped pipes, empty cells and marks survive canonical round-trip", () => {
  const value = parse(
    "Before\n\n| A | B |\n| --- | --- |\n| **bold** [link](/a) | escaped \\| pipe |\n| | last |\n\nAfter\n\n```js\n<script>literal</script>\n```\n\n---",
  );
  assert.equal(value.schema_version, 2);
  assert.equal((value.content as { type: string }[])[1]!.type, "table");
  assert.deepEqual(parse(richTextToMarkdown(value)), value);
});
test("GFM import rejects excess cells, HTML, task state and unsupported alignment atomically", () => {
  for (const input of [
    "| A |\n| --- |\n| one | excess |",
    "hello\n\n<script>x</script>",
    "- [x] checked",
    "| A |\n| :--- |\n| one |",
    "~~deleted~~",
  ]) {
    const result = markdownToRichText(input);
    assert.equal(result.ok, false, input);
    assert.equal("value" in result, false);
  }
});
test("strict GFM export reports JSON path and canonical export guidance", () => {
  const table = parse("| A |\n| --- |\n| one |");
  const cases = [
    { type: "image", media_id: "01900000-0000-7000-8000-000000000001", alt: "image" },
    {
      type: "table",
      caption: [{ type: "text", text: "Caption" }],
      content: (table.content as Record<string, unknown>[])[0]!.content,
    },
    {
      type: "table",
      content: [
        {
          type: "table_row",
          content: [{ type: "table_cell", content: [{ type: "paragraph", content: [] }] }],
        },
      ],
    },
  ];
  for (const node of cases)
    assert.throws(
      () => richTextToMarkdown({ type: "document", schema_version: 2, content: [node] }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.code, "MARKDOWN_UNREPRESENTABLE");
        const detail = error.details[0] as {
          path: string;
          reason: string;
          canonical_export: string;
        };
        assert.match(detail.path, /^\/content\/0\//);
        assert.ok(detail.reason);
        assert.match(detail.canonical_export, /REST\/MCP/);
        return true;
      },
    );
});
