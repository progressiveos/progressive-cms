// PCMS-CONT-T024 — machine-readable discovery services.
// Acceptance: list/get schemas usable without source-code knowledge
// (Content spec §73).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBlockDiscovery,
  createBlockRegistry,
  registerFirstPartyBlocksV1,
} from "@pcms/blocks";
import {
  createContentDiscovery,
  createContentTypeRegistry,
  createFieldRegistry,
} from "@pcms/content";

const contentTypes = createContentTypeRegistry();
contentTypes.registerContentType({
  key: "service",
  version: 1,
  title: "Услуга",
  description: "Услуга компании",
  bodyPolicy: "block_document",
  fields: {
    title: { id: "title", type: "string", required: true, filterable: true, sortable: true },
    featured: { id: "featured", type: "boolean", filterable: true },
  },
});
contentTypes.registerContentType({
  key: "service",
  version: 2,
  title: "Услуга",
  fields: {
    title: { id: "title", type: "string", required: true },
    duration: { id: "duration", type: "integer" },
  },
});

const discovery = createContentDiscovery({
  contentTypes,
  fields: createFieldRegistry(),
});

test("list_content_types returns deterministic versioned summaries", () => {
  const listed = discovery.listContentTypes();
  assert.deepEqual(listed, [
    { key: "service", version: 1, title: "Услуга", bodyPolicy: "block_document" },
    { key: "service", version: 2, title: "Услуга", bodyPolicy: "none" },
  ]);
  assert.equal(
    JSON.stringify(discovery.listContentTypes()),
    JSON.stringify(discovery.listContentTypes()),
  );
});

test("get_content_type_schema returns field descriptors with hints per version", () => {
  const v1 = discovery.getContentTypeSchema("service", 1);
  assert.equal(v1?.version, 1);
  assert.equal(v1?.fields.title?.type, "string");
  assert.equal(v1?.fields.title?.required, true);
  assert.equal(v1?.fields.title?.filterable, true);
  assert.equal(v1?.fields.featured?.type, "boolean");

  const v2 = discovery.getContentTypeSchema("service", 2);
  assert.equal(v2?.fields.duration?.type, "integer");
  assert.equal(v2?.fields.featured, undefined);
  assert.equal(discovery.getContentTypeSchema("service", 3), null);
  assert.equal(discovery.getLatestContentTypeSchema("service")?.version, 2);
});

test("list_field_types and collection capabilities are machine-readable", () => {
  const fieldTypes = discovery.listFieldTypes();
  assert.equal(fieldTypes.length, 23);
  assert.deepEqual([...fieldTypes], [...fieldTypes].sort());

  const capabilities = discovery.getCollectionCapabilities();
  assert.deepEqual([...capabilities.ops], ["eq", "neq", "in", "contains", "gte", "lte", "exists"]);
  assert.deepEqual([...capabilities.contextRefs].sort(), [
    "current_entry.content_type",
    "current_entry.id",
    "current_locale",
  ]);
  assert.equal(capabilities.maxLimit, 100);
});

test("block discovery: list/get schemas without source-code knowledge", () => {
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);
  const blocks = createBlockDiscovery(registry);

  const listed = blocks.listBlockTypes();
  assert.ok(listed.find((entry) => entry.typeId === "cta")?.versions.includes(1));

  const cta = blocks.getBlockSchema("cta", 1);
  assert.equal(cta?.childrenPolicy, "none");
  assert.deepEqual(cta?.allowedVariants, []);
  // The props JSON Schema is exposed verbatim — a machine can validate a
  // payload without reading source code.
  assert.ok(cta !== null, "cta@1 must be discoverable");
  assert.deepEqual((cta.propsSchema as { required: string[] }).required, [
    "title",
    "primary_action",
  ]);
  assert.equal(blocks.getBlockSchema("missing", 1), null);
  assert.equal(JSON.stringify(blocks.listBlockTypes()), JSON.stringify(blocks.listBlockTypes()));
});
