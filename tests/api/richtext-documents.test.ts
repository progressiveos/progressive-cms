import assert from "node:assert/strict";
import { test } from "node:test";
import { mapEntryRichText, validateRichTextBlockPolicy } from "@pcms/api";
import { createBlockRegistry, registerFirstPartyBlocksV1 } from "@pcms/blocks";
import { createContentTypeRegistry } from "@pcms/content";

const v1 = () => ({
  type: "document",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Kept" }] }],
});

test("new rich_text revisions reject hidden blocks while historical sealed revisions remain readable", () => {
  const blocks = { schema_version: 1, blocks: [{ type: "table" }] };
  assert.deepEqual(validateRichTextBlockPolicy("rich_text", blocks, "WORKING"), [
    {
      code: "RICH_TEXT_BLOCKS_NOT_RENDERED",
      path: "/blocks",
      message:
        "This Content Type uses bodyPolicy rich_text; BlockDocument content is not rendered. Import supported content into the RichText body before sealing.",
      severity: "error",
    },
  ]);
  assert.deepEqual(validateRichTextBlockPolicy("rich_text", blocks, "SEALED"), []);
  assert.deepEqual(
    validateRichTextBlockPolicy("rich_text", { schema_version: 1, blocks: [] }, "WORKING"),
    [],
  );
});

test("table@1 object cells require paragraph RichText and reject unsupported documents", () => {
  const blocks = {
    schema_version: 1,
    blocks: [
      {
        type: "table",
        schema_version: 1,
        props: { rows: [[{ type: "unexpected", value: "kept" }]] },
        children: [],
      },
    ],
  };
  assert.deepEqual(validateRichTextBlockPolicy("block_document", blocks, "WORKING"), [
    {
      code: "TABLE_RICH_TEXT_CELL_INVALID",
      path: "/blocks/0/props/rows/0/0",
      message: "Object table cells must contain a RichText document with paragraphs",
      severity: "error",
    },
  ]);
  const headingCell = {
    schema_version: 1,
    blocks: [
      {
        type: "table",
        schema_version: 1,
        props: {
          rows: [
            [{ type: "document", schema_version: 2, content: [{ type: "heading", level: 2 }] }],
          ],
        },
        children: [],
      },
    ],
  };
  assert.deepEqual(validateRichTextBlockPolicy("block_document", headingCell, "WORKING"), [
    {
      code: "TABLE_RICH_TEXT_CELL_INVALID",
      path: "/blocks/0/props/rows/0/0",
      message: "Object table cells must contain a RichText document with paragraphs",
      severity: "error",
    },
  ]);
  assert.deepEqual(
    validateRichTextBlockPolicy(
      "block_document",
      {
        schema_version: 1,
        blocks: [
          {
            type: "table",
            schema_version: 1,
            props: {
              rows: [[{ type: "document", content: [{ type: "paragraph", content: [] }] }]],
            },
            children: [],
          },
        ],
      },
      "WORKING",
    ),
    [],
  );
  assert.deepEqual(validateRichTextBlockPolicy("block_document", blocks, "SEALED"), []);
});

test("declared nested fields and typed block props are reached without touching unrelated JSON", () => {
  const types = createContentTypeRegistry();
  const blocks = createBlockRegistry();
  registerFirstPartyBlocksV1(blocks);
  const type = types.registerContentType({
    key: "article",
    version: 1,
    title: "Article",
    bodyPolicy: "block_document",
    fields: {
      body: { type: "rich_text" },
      nested: { type: "object", fields: { text: { type: "rich_text" } } },
      unrelated: { type: "string" },
    },
  } as never);
  const payload = {
    fields: { body: v1(), nested: { text: v1() }, unrelated: v1() },
    blocks: {
      schema_version: 1,
      blocks: [
        {
          id: "01900000-0000-7000-8000-000000000001",
          type: "text",
          schema_version: 1,
          props: { rich_text: v1() },
          children: [],
        },
        {
          id: "01900000-0000-7000-8000-000000000002",
          type: "table",
          schema_version: 1,
          props: { columns: [{ key: "a", title: "A" }], rows: [[v1()]] },
          children: [],
        },
      ],
    },
  };
  const paths: string[] = [];
  const before = JSON.stringify(payload);
  // What the caller does with each document is its own business; this asserts
  // the walk itself, which media discovery, seal validation and the Web
  // renderer all rely on.
  const visited = mapEntryRichText(payload, type, blocks, (document, path) => {
    paths.push(path);
    return { ...(document as Record<string, unknown>), marked: true };
  }) as typeof payload;
  assert.equal(JSON.stringify(payload), before, "the walk never mutates its input");
  assert.equal((visited.fields.body as Record<string, unknown>).marked, true);
  assert.equal((visited.fields.nested.text as Record<string, unknown>).marked, true);
  // A string field holding a document-shaped value is not declared rich_text.
  assert.equal("marked" in (visited.fields.unrelated as Record<string, unknown>), false);
  assert.deepEqual(paths, [
    "/fields/body",
    "/fields/nested/text",
    "/blocks/0/props/rich_text",
    "/blocks/1/props/rows/0/0",
  ]);
});
