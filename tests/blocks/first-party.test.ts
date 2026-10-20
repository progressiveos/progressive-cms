// PCMS-CONT-T014 — text/heading/image/quote/callout/list/table/code blocks.
// Acceptance: fixtures validate; no raw HTML/code execution (Content spec §36–§44).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BlockDocumentResult,
  createBlockRegistry,
  FIRST_PARTY_BLOCK_TYPES_V1,
  newBlockId,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import { newStableId } from "@pcms/core";

function firstPartyRegistry() {
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);
  return registry;
}

function issuesOf(result: BlockDocumentResult) {
  return result.ok ? [] : result.issues;
}

function block(type: string, props: Record<string, unknown>): Record<string, unknown> {
  return {
    id: newBlockId(),
    type,
    schema_version: 1,
    variant: null,
    props,
    children: [],
  };
}

const RICH = { schema_version: 2, type: "document", content: [{ type: "paragraph", content: [] }] };
const MEDIA = newStableId();

test("all eight mandatory v1 block types register and are discoverable", () => {
  const registry = firstPartyRegistry();
  assert.deepEqual(
    registry.listBlockTypeVersions().map((entry) => entry.typeId),
    [...FIRST_PARTY_BLOCK_TYPES_V1].sort(),
  );
});

test("canonical fixture with every block type validates", () => {
  const registry = firstPartyRegistry();
  const document = {
    schema_version: 1,
    blocks: [
      block("text", { rich_text: RICH }),
      block("heading", { level: 2, text: "Возможности", anchor: "features" }),
      block("image", {
        media_id: MEDIA,
        alt_override: "Схема процесса",
        caption: "Рис. 1",
        presentation_hint: "wide",
      }),
      block("quote", {
        rich_text: RICH,
        author: "И. Иванов",
        source: "CEO, example.com",
        source_url: "https://example.com/review",
      }),
      block("callout", { title: "Важно", body: RICH, kind: "warning", icon: MEDIA }),
      block("list", {
        items: [
          { title: "Аудит", text: RICH, icon: MEDIA },
          {
            title: "Внедрение",
            text: RICH,
            link: { type: "internal_entry", entry_id: newStableId() },
          },
        ],
      }),
      block("table", {
        caption: "Тарифы",
        columns: [
          { key: "name", title: "Название" },
          { key: "price", title: "Цена" },
        ],
        rows: [["Аудит", "от 100 000"], [{ rich_text: RICH }]],
      }),
      block("code", { language: "ts", code: "const x = 1;", filename: "index.ts" }),
    ],
  };
  const result = validateBlockDocument(document, registry);
  assert.equal(result.ok, true, JSON.stringify(issuesOf(result)));
  if (result.ok) assert.equal(result.value.blocks.length, 8);
});

test("heading: level bounds and empty text rejected; anchor optional", () => {
  const registry = firstPartyRegistry();
  const result = validateBlockDocument(
    { schema_version: 1, blocks: [block("heading", { level: 7, text: "x" })] },
    registry,
  );
  assert.ok(issuesOf(result).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
  assert.ok(
    issuesOf(
      validateBlockDocument(
        { schema_version: 1, blocks: [block("heading", { level: 2, text: "" })] },
        registry,
      ),
    ).length > 0,
  );
});

test("image: media_id must be a stable ID — URLs and paths are rejected by schema", () => {
  const registry = firstPartyRegistry();
  for (const badMedia of ["/uploads/a.jpg", "https://cdn.example.com/a.jpg", "img-123"]) {
    const result = validateBlockDocument(
      { schema_version: 1, blocks: [block("image", { media_id: badMedia })] },
      registry,
    );
    assert.ok(
      issuesOf(result).some((issue) => issue.code === "BLOCK_PROPS_INVALID"),
      `"${badMedia}" must be rejected`,
    );
  }
});

test("callout: kind restricted to the baseline intents", () => {
  const registry = firstPartyRegistry();
  const bad = validateBlockDocument(
    { schema_version: 1, blocks: [block("callout", { body: RICH, kind: "electric" })] },
    registry,
  );
  assert.ok(issuesOf(bad).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
  assert.equal(
    validateBlockDocument(
      { schema_version: 1, blocks: [block("callout", { body: RICH, kind: "accent" })] },
      registry,
    ).ok,
    true,
  );
});

test("list items require title or text; links are typed actions with stable IDs", () => {
  const registry = firstPartyRegistry();
  const empty = validateBlockDocument(
    { schema_version: 1, blocks: [block("list", { items: [{}] })] },
    registry,
  );
  assert.ok(issuesOf(empty).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));

  const badLink = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [block("list", { items: [{ title: "x", link: { type: "external_url" } }] })],
    },
    registry,
  );
  assert.ok(issuesOf(badLink).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));

  const goodLink = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        block("list", {
          items: [{ title: "x", link: { type: "external_url", url: "https://example.com" } }],
        }),
      ],
    },
    registry,
  );
  assert.equal(goodLink.ok, true, JSON.stringify(issuesOf(goodLink)));
});

test("code block content is inert data: stored verbatim, never executed", () => {
  const registry = firstPartyRegistry();
  const payload = "process.exit(1); <script>alert(1)</script>";
  const document = {
    schema_version: 1,
    blocks: [block("code", { code: payload, language: "js" })],
  };
  const result = validateBlockDocument(document, registry);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.blocks[0]?.props.code, payload, "code must survive untouched");
  }
});

test("unknown properties (layout/style JSON) are rejected on first-party blocks", () => {
  const registry = firstPartyRegistry();
  const sneaky = {
    schema_version: 1,
    blocks: [
      {
        id: newBlockId(),
        type: "text",
        schema_version: 1,
        variant: null,
        props: { rich_text: RICH },
        layout: { row: 1, column: "4/12" },
        children: [],
      },
    ],
  };
  assert.ok(
    issuesOf(validateBlockDocument(sneaky, registry)).some(
      (issue) => issue.code === "BLOCK_PROPERTY_UNKNOWN",
    ),
  );
});
