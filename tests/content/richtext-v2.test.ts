import assert from "node:assert/strict";
import { test } from "node:test";
import { collectRichTextMediaIds, validateRichText } from "@pcms/content";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const table = () => ({
  type: "table",
  content: Array.from({ length: 3 }, (_, row) => ({
    type: "table_row",
    content: Array.from({ length: 4 }, (_, column) => ({
      type: "table_cell",
      content: [paragraph(`${row}:${column}`)],
    })),
  })),
});
const document = (content: unknown[]) => ({ type: "document", schema_version: 2, content });
const invalid = (value: unknown, code: string) => {
  const result = validateRichText(value);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(
      result.issues.some((issue) => issue.code === code),
      JSON.stringify(result),
    );
};

test("v2 validates complete documents and explicit headers without inferring the first row", () => {
  const value = document([
    paragraph("before"),
    table(),
    paragraph("after"),
    { type: "code_block", code: "<script>x</script>", language: "js" },
    { type: "horizontal_rule" },
    {
      type: "image",
      media_id: "01900000-0000-7000-8000-000000000001",
      alt: "",
      caption: [{ type: "text", text: "caption" }],
    },
  ]);
  assert.deepEqual(validateRichText(value), { ok: true, value });
  assert.deepEqual(collectRichTextMediaIds(value), ["01900000-0000-7000-8000-000000000001"]);
  assert.equal(
    "header" in (value.content[1] as ReturnType<typeof table>).content[0]!.content[0]!,
    false,
  );
});

test("v2 rejects ragged tables, nested blocks, spans, unsafe images and unknown versions", () => {
  const ragged = table();
  ragged.content[1]!.content.pop();
  invalid(document([ragged]), "RICHTEXT_TABLE_RECTANGULAR");
  invalid(
    document([
      {
        type: "table",
        content: [{ type: "table_row", content: [{ type: "table_cell", content: [table()] }] }],
      },
    ]),
    "RICHTEXT_NODE_MISPLACED",
  );
  const merged = table();
  Object.assign(merged.content[0]!.content[0]!, { colspan: 2 });
  invalid(document([merged]), "RICHTEXT_PROPERTY_UNKNOWN");
  invalid(
    document([{ type: "image", src: "javascript:alert(1)", alt: "" }]),
    "RICHTEXT_SRC_REJECTED",
  );
  invalid(
    document([
      {
        type: "image",
        src: "/image.jpg",
        media_id: "01900000-0000-7000-8000-000000000001",
        alt: "",
      },
    ]),
    "RICHTEXT_IMAGE_SOURCE_CONFLICT",
  );
  invalid({ type: "document", schema_version: 3, content: [] }, "RICHTEXT_VERSION_UNSUPPORTED");
  // Retired v1: an unversioned document is rejected as missing the version,
  // not as an unknown node — a v1 payload can never reach the runtime.
  invalid({ type: "document", content: [table()] }, "RICHTEXT_VERSION_REQUIRED");
  invalid(
    { type: "document", schema_version: 1, content: [paragraph("x")] },
    "RICHTEXT_VERSION_UNSUPPORTED",
  );
});
