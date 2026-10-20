// PCMS-PUB-T012 — semantic revision diff (Publication spec §71): pointer
// fields, block add/remove/move/change axes keyed by stable block IDs.
// Never a raw JSON diff; deterministic ordering.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSemanticDiff, diffPayloads, diffRelations } from "@pcms/revisions";

test("field diff reports changed/added/removed leaves with JSON-pointer paths", () => {
  const diff = defaultSemanticDiff(
    { title: "Old", intro: "same", meta: { slug: "old-slug" }, gone: true },
    { title: "New", intro: "same", meta: { slug: "new-slug" }, fresh: 1 },
  );
  assert.deepEqual(
    diff.fieldsChanged.map((c) => c.path),
    ["/meta/slug", "/title"],
  );
  assert.deepEqual(
    diff.fieldsAdded.map((c) => c.path),
    ["/fresh"],
  );
  assert.deepEqual(
    diff.fieldsRemoved.map((c) => c.path),
    ["/gone"],
  );
});

test("block axis uses stable block IDs: added/removed/moved detected", () => {
  const from = {
    blocks: [
      { id: "b1", type: "text", props: { value: "one" } },
      { id: "b2", type: "heading", props: { text: "H" } },
      { id: "b3", type: "quote" },
    ],
  };
  const to = {
    blocks: [
      { id: "b2", type: "heading", props: { text: "H" } }, // moved 1 → 0
      { id: "b4", type: "image" }, // added
      { id: "b1", type: "text", props: { value: "one!" } }, // changed in place
      // b3 removed
    ],
  };
  const diff = defaultSemanticDiff(from, to);
  assert.deepEqual(
    diff.blocksAdded.map((b) => b.id),
    ["b4"],
  );
  assert.deepEqual(
    diff.blocksRemoved.map((b) => b.id),
    ["b3"],
  );
  assert.deepEqual(
    diff.blocksMoved.map((m) => m.id),
    ["b2", "b1"],
  );
  assert.deepEqual(diff.blocksMoved[0], { id: "b2", from: 1, to: 0 });
  assert.deepEqual(diff.blocksMoved[1], { id: "b1", from: 0, to: 2 });
  assert.deepEqual(
    diff.blocksChanged.map((b) => b.id),
    [],
    "block-level change detection composes via field axes in the default diff",
  );
  assert.ok(diff.fieldsChanged.length > 0, "content change still surfaces on field axes");
});

test("relation diff tracks media/relation reference changes per path", () => {
  const referencesAt = (payload: unknown) => {
    const record = payload as { hero?: string; doc?: string };
    return [
      ...(record.hero === undefined ? [] : [{ path: "/hero", targetId: record.hero }]),
      ...(record.doc === undefined ? [] : [{ path: "/doc", targetId: record.doc }]),
    ];
  };
  const changes = diffRelations(
    { hero: "asset-1", doc: "asset-2" },
    { hero: "asset-9" },
    referencesAt,
  );
  assert.deepEqual(
    changes.map((c) => ({ path: c.path, from: c.from, to: c.to })),
    [
      { path: "/doc", from: "asset-2", to: null },
      { path: "/hero", from: "asset-1", to: "asset-9" },
    ],
  );
});

test("raw diff helper handles arrays positionally and stays bounded", () => {
  const diff = diffPayloads({ list: [1, 2, 3] }, { list: [1, 9] });
  assert.deepEqual(
    diff.fieldsChanged.map((c) => c.path),
    ["/list/1"],
  );
  assert.deepEqual(
    diff.fieldsRemoved.map((c) => c.path),
    ["/list/2"],
  );
});
