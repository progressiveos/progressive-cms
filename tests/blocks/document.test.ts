// PCMS-CONT-T013 — BlockDocument v1 + Block Registry.
// Acceptance: stable block IDs; bounded nesting; JSON schema
// (Content spec §29–§35, §70).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BlockTypeDescriptor,
  createBlockRegistry,
  MAX_BLOCK_NESTING_DEPTH,
  MAX_BLOCKS_PER_DOCUMENT,
  newBlockId,
  validateBlockDocument,
} from "@pcms/blocks";
import { isStableId } from "@pcms/core";

const TEXT_BLOCK: BlockTypeDescriptor = {
  typeId: "text",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      rich_text: { type: "object" },
    },
    required: ["rich_text"],
  },
  childrenPolicy: "none",
};

const SECTION_BLOCK: BlockTypeDescriptor = {
  typeId: "section",
  schemaVersion: 1,
  propsSchema: { type: "object", additionalProperties: false, properties: {} },
  childrenPolicy: "blocks",
  allowedVariants: ["wide", "narrow"],
};

const GALLERY_ONLY_SECTION: BlockTypeDescriptor = {
  typeId: "gallery_row",
  schemaVersion: 1,
  propsSchema: { type: "object", additionalProperties: false, properties: {} },
  childrenPolicy: ["gallery"],
};

const GALLERY_BLOCK: BlockTypeDescriptor = {
  typeId: "gallery",
  schemaVersion: 1,
  propsSchema: {
    type: "object",
    additionalProperties: false,
    properties: { images: { type: "array", items: { type: "string" } } },
  },
  childrenPolicy: "none",
};

function registryWith(...descriptors: BlockTypeDescriptor[]) {
  const registry = createBlockRegistry();
  for (const descriptor of descriptors) registry.registerBlockType(descriptor);
  return registry;
}

function issuesOf(result: ReturnType<typeof validateBlockDocument>) {
  return result.ok ? [] : result.issues;
}

test("block instances carry canonical stable IDs", () => {
  const id = newBlockId();
  assert.equal(isStableId(id), true);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const ids = new Set(Array.from({ length: 1000 }, () => newBlockId()));
  assert.equal(ids.size, 1000);
});

test("registry validates descriptors: id, version, duplicate, JSON schema must compile", () => {
  const registry = createBlockRegistry();
  assert.throws(
    () => registry.registerBlockType({ ...TEXT_BLOCK, typeId: "Bad-Type" }),
    (error: unknown) => (error as { code?: string }).code === "BLOCK_TYPE_ID_INVALID",
  );
  assert.throws(
    () => registry.registerBlockType({ ...TEXT_BLOCK, schemaVersion: 0 }),
    (error: unknown) => (error as { code?: string }).code === "BLOCK_TYPE_VERSION_INVALID",
  );
  registry.registerBlockType(TEXT_BLOCK);
  assert.throws(
    () => registry.registerBlockType(TEXT_BLOCK),
    (error: unknown) => (error as { code?: string }).code === "BLOCK_TYPE_EXISTS",
  );
  assert.throws(
    () =>
      registry.registerBlockType({
        ...TEXT_BLOCK,
        typeId: "broken",
        propsSchema: { type: "object", properties: { x: { type: "not_a_json_type" } } },
      }),
    (error: unknown) => (error as { code?: string }).code === "BLOCK_PROPS_SCHEMA_INVALID",
  );
});

test("registry discovery is deterministic", () => {
  const registry = registryWith(GALLERY_BLOCK, SECTION_BLOCK, TEXT_BLOCK);
  assert.deepEqual(registry.listBlockTypeVersions(), [
    { typeId: "gallery", versions: [1] },
    { typeId: "section", versions: [1] },
    { typeId: "text", versions: [1] },
  ]);
  assert.deepEqual(
    registry.listBlockTypes().map((entry) => entry.typeId),
    registry.listBlockTypes().map((entry) => entry.typeId),
  );
});

test("valid documents with nesting, variants and props validate; output is canonical", () => {
  const registry = registryWith(TEXT_BLOCK, SECTION_BLOCK, GALLERY_BLOCK);
  const document = {
    schema_version: 1,
    blocks: [
      {
        id: newBlockId(),
        type: "text",
        schema_version: 1,
        variant: null,
        props: { rich_text: { type: "doc" } },
        children: [],
      },
      {
        id: newBlockId(),
        type: "section",
        schema_version: 1,
        variant: "wide",
        props: {},
        children: [
          {
            id: newBlockId(),
            type: "gallery",
            schema_version: 1,
            variant: null,
            props: { images: ["a", "b"] },
            children: [],
          },
        ],
      },
    ],
  };
  const result = validateBlockDocument(document, registry);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));
  if (result.ok) {
    assert.equal(result.value.schemaVersion, 1);
    assert.equal(result.value.blocks[1]?.children[0]?.type, "gallery");
    assert.equal(result.value.blocks[1]?.variant, "wide");
  }
});

test("unknown type@version, bad ids, unknown properties and unsupported variants rejected", () => {
  const registry = registryWith(TEXT_BLOCK, SECTION_BLOCK);
  const id = newBlockId();

  const unknownType = {
    schema_version: 1,
    blocks: [{ id, type: "mystery", schema_version: 1, variant: null, props: {}, children: [] }],
  };
  assert.deepEqual(
    issuesOf(validateBlockDocument(unknownType, registry)).map((issue) => issue.code),
    ["BLOCK_TYPE_UNKNOWN"],
  );

  const badId = {
    schema_version: 1,
    blocks: [
      {
        id: "blk_not_an_id",
        type: "text",
        schema_version: 1,
        variant: null,
        props: { rich_text: {} },
        children: [],
      },
    ],
  };
  const badIdResult = validateBlockDocument(badId, registry);
  assert.equal(badIdResult.ok, false);
  assert.ok(issuesOf(badIdResult).some((issue) => issue.code === "BLOCK_ID_INVALID"));

  const styleJson = {
    schema_version: 1,
    blocks: [
      {
        id,
        type: "text",
        schema_version: 1,
        variant: null,
        props: { rich_text: {} },
        style: "color:red",
        children: [],
      },
    ],
  };
  const styleResult = validateBlockDocument(styleJson, registry);
  assert.ok(issuesOf(styleResult).some((issue) => issue.code === "BLOCK_PROPERTY_UNKNOWN"));

  const badVariant = {
    schema_version: 1,
    blocks: [
      { id, type: "section", schema_version: 1, variant: "electric-blue", props: {}, children: [] },
    ],
  };
  assert.ok(
    issuesOf(validateBlockDocument(badVariant, registry)).some(
      (issue) => issue.code === "BLOCK_VARIANT_UNSUPPORTED",
    ),
  );
});

test("props are validated against the registered JSON Schema", () => {
  const registry = registryWith(TEXT_BLOCK);
  const missing = {
    schema_version: 1,
    blocks: [
      { id: newBlockId(), type: "text", schema_version: 1, variant: null, props: {}, children: [] },
    ],
  };
  const result = validateBlockDocument(missing, registry);
  assert.ok(issuesOf(result).some((issue) => issue.code === "BLOCK_PROPS_INVALID"));
});

test("children policies: none forbids children; restricted allowlist filters types", () => {
  const registry = registryWith(TEXT_BLOCK, GALLERY_BLOCK, GALLERY_ONLY_SECTION);
  const withChild = {
    schema_version: 1,
    blocks: [
      {
        id: newBlockId(),
        type: "text",
        schema_version: 1,
        variant: null,
        props: { rich_text: {} },
        children: [
          {
            id: newBlockId(),
            type: "gallery",
            schema_version: 1,
            variant: null,
            props: {},
            children: [],
          },
        ],
      },
    ],
  };
  assert.ok(
    issuesOf(validateBlockDocument(withChild, registry)).some(
      (issue) => issue.code === "BLOCK_CHILDREN_FORBIDDEN",
    ),
  );

  const wrongChild = {
    schema_version: 1,
    blocks: [
      {
        id: newBlockId(),
        type: "gallery_row",
        schema_version: 1,
        variant: null,
        props: {},
        children: [
          {
            id: newBlockId(),
            type: "text",
            schema_version: 1,
            variant: null,
            props: { rich_text: {} },
            children: [],
          },
        ],
      },
    ],
  };
  assert.ok(
    issuesOf(validateBlockDocument(wrongChild, registry)).some(
      (issue) => issue.code === "BLOCK_CHILD_TYPE_REJECTED",
    ),
  );
});

test("bounded documents: nesting depth and block count are hard limits", () => {
  const registry = registryWith(TEXT_BLOCK, SECTION_BLOCK);
  // Depth bomb via section nesting.
  let inner: Record<string, unknown> = leaf();
  for (let i = 0; i < MAX_BLOCK_NESTING_DEPTH + 5; i++) {
    inner = {
      id: newBlockId(),
      type: "section",
      schema_version: 1,
      variant: null,
      props: {},
      children: [inner],
    };
  }
  const deepDoc = { schema_version: 1, blocks: [inner] };
  assert.ok(
    issuesOf(validateBlockDocument(deepDoc, registry)).some(
      (issue) => issue.code === "BLOCK_NESTING_TOO_DEEP",
    ),
  );

  // Size bomb: one block over the limit.
  const many = Array.from({ length: MAX_BLOCKS_PER_DOCUMENT + 1 }, () => leaf());
  const sizeDoc = { schema_version: 1, blocks: many };
  assert.ok(
    issuesOf(validateBlockDocument(sizeDoc, registry)).some(
      (issue) => issue.code === "BLOCK_DOCUMENT_TOO_LARGE",
    ),
  );

  function leaf(): Record<string, unknown> {
    return {
      id: newBlockId(),
      type: "text",
      schema_version: 1,
      variant: null,
      props: { rich_text: {} },
      children: [],
    };
  }
});

test("wrong document schema_version is rejected explicitly", () => {
  const registry = registryWith(TEXT_BLOCK);
  const result = validateBlockDocument({ schema_version: 2, blocks: [] }, registry);
  assert.deepEqual(
    issuesOf(result).map((issue) => issue.code),
    ["BLOCK_DOCUMENT_VERSION_UNKNOWN"],
  );
});
