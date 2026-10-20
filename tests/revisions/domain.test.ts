// PCMS-PUB-T001 — generic VersionedEntity/Revision domain interfaces:
// canonical hashing determinism and the controlled entity-adapter registry.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJsonString,
  createVersionedEntityRegistry,
  hashCanonicalPayload,
  RevisionError,
  type VersionedEntityAdapter,
} from "@pcms/revisions";

test("canonical JSON is independent of key insertion order and formatting", () => {
  const a = { title: "x", meta: { b: 1, a: [2, { z: null, y: true }] } };
  const b = { meta: { a: [2, { y: true, z: null }], b: 1 }, title: "x" };
  assert.equal(canonicalJsonString(a), canonicalJsonString(b));
  assert.equal(hashCanonicalPayload(a), hashCanonicalPayload(b));
  // whitespace-only differences cannot exist (no whitespace is emitted)
  assert.ok(!canonicalJsonString(a).includes(" "));
});

test("canonical hashing distinguishes semantic differences", () => {
  assert.notEqual(hashCanonicalPayload({ a: 1 }), hashCanonicalPayload({ a: 2 }));
  assert.notEqual(hashCanonicalPayload({ a: 1 }), hashCanonicalPayload({ a: "1" }));
  assert.notEqual(hashCanonicalPayload([1, 2]), hashCanonicalPayload([2, 1]));
});

test("canonical hashing rejects non-deterministic payload values", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  for (const bad of [cyclic, { n: NaN }, { big: 1n }, { f: () => 1 }]) {
    assert.throws(
      () => hashCanonicalPayload(bad),
      (error: unknown) => {
        assert.ok(error instanceof RevisionError);
        assert.equal(error.code, "REVISION_PAYLOAD_NOT_SERIALIZABLE");
        return true;
      },
    );
  }
});

test("canonical hashing is stable across runs (no process randomness)", () => {
  const payload = { title: "Статья", blocks: [{ type: "text", props: { html: "<b>x</b>" } }] };
  assert.equal(hashCanonicalPayload(payload), hashCanonicalPayload(structuredClone(payload)));
});

function adapter(entityType: string): VersionedEntityAdapter {
  return {
    entityType,
    description: `${entityType} test adapter`,
    validateForSeal: () => [],
  };
}

test("entity registry is deterministic, conflict-guarded and fails closed", () => {
  const registry = createVersionedEntityRegistry([adapter("entry"), adapter("global_content")]);
  assert.deepEqual(
    registry.list().map((a) => a.entityType),
    ["entry", "global_content"],
  );
  assert.deepEqual(
    registry.describe().map((d) => d.entityType),
    ["entry", "global_content"],
  );
  assert.equal(registry.has("entry"), true);

  assert.throws(
    () => createVersionedEntityRegistry([adapter("entry"), adapter("entry")]),
    (error: unknown) => {
      assert.ok(error instanceof RevisionError);
      assert.equal(error.code, "REVISION_ENTITY_CONFLICT");
      return true;
    },
  );

  assert.throws(
    () => registry.get("theme_settings"),
    (error: unknown) => {
      assert.ok(error instanceof RevisionError);
      assert.equal(error.code, "REVISION_ENTITY_UNKNOWN");
      return true;
    },
  );
});
