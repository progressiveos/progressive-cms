import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRichText } from "@pcms/content";
import {
  editorToRichText,
  richTextToEditor,
} from "../../apps/admin/src/screens/content/fields/richtext-adapter.js";

test("editor private JSON round-trips canonical v2 nodes and preserves the unmodified source", () => {
  const value = {
    type: "document",
    schema_version: 2,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Intro", marks: ["strong"] },
          {
            type: "link",
            href: "/a",
            content: [{ type: "text", text: "link", marks: ["emphasis"] }],
          },
        ],
      },
      {
        type: "table",
        caption: [{ type: "text", text: "Table" }],
        content: [
          {
            type: "table_row",
            content: [
              { type: "table_cell", header: "row", content: [{ type: "paragraph", content: [] }] },
            ],
          },
        ],
      },
      {
        type: "image",
        media_id: "01900000-0000-7000-8000-000000000001",
        alt: "image",
        caption: [{ type: "text", text: "Image" }],
      },
      { type: "code_block", code: "const x = 1", language: "js" },
      { type: "horizontal_rule" },
    ],
  };
  const before = JSON.stringify(value);
  const editor = richTextToEditor(value);
  assert.equal(editor.type, "doc");
  assert.deepEqual(editorToRichText(editor), value);
  assert.equal(JSON.stringify(value), before);
});
test("v1 documents are refused on read with a migration hint, never silently opened", () => {
  const value = {
    type: "document",
    content: [{ type: "image", src: "/image.jpg", alt: "old", title: "Title" }],
  };
  assert.throws(() => richTextToEditor(value), /not RichText v2/);
  // The editor does produce v2: an explicit empty document carries the version.
  assert.deepEqual(editorToRichText({ type: "doc", content: [{ type: "paragraph" }] }), {
    type: "document",
    schema_version: 2,
    content: [{ type: "paragraph", content: [] }],
  });
  assert.throws(
    () =>
      editorToRichText({
        type: "doc",
        content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [] }],
      }),
    /Merged cells/,
  );
});

test("empty text leaves from the editor are dropped, not persisted as bare marks", () => {
  // Tiptap briefly materializes `{text: "", marks: [...]}`; the AST forbids
  // empty text nodes, so the adapter must not emit one.
  const result = editorToRichText({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "", marks: [{ type: "bold" }] },
          { type: "text", text: "kept" },
          { type: "text", text: "" },
        ],
      },
    ],
  });
  const paragraph = (result.content as Record<string, unknown>[])[0];
  assert.deepEqual(paragraph?.content, [{ type: "text", text: "kept" }]);
  assert.equal(validateRichText(result).ok, true);
});
