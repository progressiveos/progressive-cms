// PCMS-CONT-T005 — Field Registry v1 primitives.
// Acceptance: every declared field type registered and discoverable
// (Content spec §13/§73).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentError,
  createFieldRegistry,
  FIELD_TYPES_V1,
  type FieldTypeName,
} from "@pcms/content";

test("every declared v1 field type is registered and discoverable", () => {
  const registry = createFieldRegistry();
  for (const name of FIELD_TYPES_V1) {
    assert.equal(registry.hasFieldType(name), true, `type ${name} must be registered`);
    assert.equal(registry.getFieldType(name)?.name, name);
  }
  const listed = registry.listFieldTypes().map((descriptor) => descriptor.name);
  for (const name of FIELD_TYPES_V1) assert.ok(listed.includes(name as FieldTypeName));
  // Discovery list is exactly the v1 set on a fresh registry.
  assert.deepEqual([...listed].sort(), [...FIELD_TYPES_V1].sort());
  assert.equal(listed.length, FIELD_TYPES_V1.length);
});

test("discovery order is deterministic (sorted, stable across calls)", () => {
  const registry = createFieldRegistry();
  const first = registry.listFieldTypes().map((d) => d.name);
  const second = registry.listFieldTypes().map((d) => d.name);
  assert.deepEqual(first, second);
  assert.deepEqual(first, [...first].sort());
});

test("new field types enter only through the controlled registration point", () => {
  const registry = createFieldRegistry();
  registry.registerFieldType({
    name: "color_hex",
    description: "Hex color string (#RRGGBB)",
  });
  assert.equal(registry.hasFieldType("color_hex"), true);
  assert.equal(registry.getFieldType("color_hex")?.description, "Hex color string (#RRGGBB)");
});

test("registration rejects duplicates and invalid names with stable codes", () => {
  const registry = createFieldRegistry();
  assert.throws(
    () => registry.registerFieldType({ name: "money" }),
    (error: unknown) => error instanceof ContentError && error.code === "FIELD_TYPE_EXISTS",
  );
  for (const bad of ["Money", "1type", "has-dash", "has space", "", "a".repeat(65)]) {
    assert.throws(
      () => registry.registerFieldType({ name: bad }),
      (error: unknown) => error instanceof ContentError && error.code === "FIELD_TYPE_INVALID",
      `name "${bad}" must be rejected`,
    );
  }
});

test("registries are independent; built-in set is never mutated by extensions", () => {
  const a = createFieldRegistry();
  const b = createFieldRegistry();
  a.registerFieldType({ name: "integration_test_only" });
  assert.equal(a.hasFieldType("integration_test_only"), true);
  assert.equal(b.hasFieldType("integration_test_only"), false);
  assert.equal(b.listFieldTypes().length, FIELD_TYPES_V1.length);
  assert.equal(
    createFieldRegistry().hasFieldType("integration_test_only"),
    false,
    "fresh registry stays clean",
  );
});

test("descriptors returned by discovery are frozen copies", () => {
  const registry = createFieldRegistry();
  const descriptor = registry.getFieldType("money");
  assert.throws(() => {
    (descriptor as { name: string }).name = "hacked";
  });
  assert.equal(registry.getFieldType("money")?.name, "money");
  assert.equal(registry.getFieldType("missing_type"), null);
});
