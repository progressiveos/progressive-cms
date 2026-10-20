// related_content block (Content spec §54) — closes the mandatory v1 registry.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBlockRegistry,
  FIRST_PARTY_BLOCK_TYPES_V1,
  newBlockId,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import { newStableId } from "@pcms/core";

function block(props: Record<string, unknown>): unknown {
  return {
    schema_version: 1,
    blocks: [
      {
        id: newBlockId(),
        type: "related_content",
        schema_version: 1,
        variant: null,
        props,
        children: [],
      },
    ],
  };
}

test("related_content registers; the mandatory v1 registry is complete (17 types)", () => {
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);
  const listed = registry.listBlockTypeVersions().map((entry) => entry.typeId);
  assert.equal(listed.length, FIRST_PARTY_BLOCK_TYPES_V1.length);
  assert.ok(listed.includes("related_content"));
});

test("modes: manual needs entry_ids; collection needs collection_key; hybrid needs both", () => {
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);

  const manual = validateBlockDocument(
    block({ mode: "manual", entry_ids: [newStableId(), newStableId()], title: "Похожие кейсы" }),
    registry,
  );
  assert.equal(manual.ok, true, JSON.stringify(manual.ok ? [] : manual.issues));

  const collection = validateBlockDocument(
    block({ mode: "collection", collection_key: "featured-services", limit: 6 }),
    registry,
  );
  assert.equal(collection.ok, true);

  const hybrid = validateBlockDocument(
    block({ mode: "hybrid", entry_ids: [newStableId()], collection_key: "featured-services" }),
    registry,
  );
  assert.equal(hybrid.ok, true);

  // manual without entry_ids → rejected.
  const missing = validateBlockDocument(block({ mode: "manual" }), registry);
  assert.equal(missing.ok, false);
  // collection without collection_key → rejected.
  const noKey = validateBlockDocument(block({ mode: "collection" }), registry);
  assert.equal(noKey.ok, false);
});
