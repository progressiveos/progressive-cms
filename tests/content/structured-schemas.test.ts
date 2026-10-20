// PCMS-CONT-T006 — Object/List/Repeater field schemas with stable item IDs.
// Acceptance: schema/round-trip/reorder tests (Content spec §23–§26).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentError,
  defineListSchema,
  defineObjectSchema,
  defineRepeaterSchema,
  type FieldSchema,
  MAX_REPEATER_ITEMS,
  newRepeaterItemId,
  validateStructuredValue,
} from "@pcms/content";

const ICON: FieldSchema = { id: "icon", type: "media" };

test("object schema: explicit fields, unknown keys rejected, required enforced", () => {
  const schema = defineObjectSchema({
    title: { id: "title", type: "string", required: true },
    icon: ICON,
  });
  const good = validateStructuredValue(schema, { title: "Привет", icon: null });
  assert.equal(good.ok, true);

  const missing = validateStructuredValue(schema, {});
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.ok ? [] : missing.issues.map((i) => i.code), ["REQUIRED_MISSING"]);

  const extra = validateStructuredValue(schema, { title: "x", surprise: 1 });
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.ok ? [] : extra.issues.map((i) => i.path), ["/surprise"]);
  assert.deepEqual(extra.ok ? [] : extra.issues.map((i) => i.code), ["UNKNOWN_FIELD"]);
});

test("repeater round-trip: JSON serialization preserves items and stable ids exactly", () => {
  const schema = defineRepeaterSchema({
    title: { id: "title", type: "string", required: true },
    text: { id: "text", type: "text" },
  });
  const value = [
    { itemId: newRepeaterItemId(), title: "Этап 1", text: "первый" },
    { itemId: newRepeaterItemId(), title: "Этап 2", text: null },
  ];
  const serialized = JSON.parse(JSON.stringify(value)) as unknown;
  const result = validateStructuredValue(schema, serialized);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, value);
});

test("reorder keeps stable item ids; validation never reassigns identity", () => {
  const schema = defineRepeaterSchema({
    title: { id: "title", type: "string", required: true },
  });
  const first = { itemId: newRepeaterItemId(), title: "A" };
  const second = { itemId: newRepeaterItemId(), title: "B" };
  const reordered = [second, first];
  const result = validateStructuredValue(schema, reordered);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, reordered);
  assert.deepEqual(
    (result.ok ? (result.value as typeof reordered) : []).map((item) => item.itemId),
    [second.itemId, first.itemId],
  );
});

test("every repeater item requires a stable itemId", () => {
  const schema = defineRepeaterSchema({ title: { id: "title", type: "string" } });
  const result = validateStructuredValue(schema, [{ title: "no id" }]);
  assert.equal(result.ok, false);
  const issue = (result.ok ? [] : result.issues)[0];
  assert.equal(issue?.code, "REPEATER_ITEM_ID_REQUIRED");
  assert.equal(issue?.path, "/0/itemId");
});

test("repeater limits: min/max per schema and global hard limit", () => {
  const schema = defineRepeaterSchema(
    { title: { id: "title", type: "string" } },
    { minItems: 2, maxItems: 3 },
  );
  assert.deepEqual(
    validateStructuredValue(schema, [{ itemId: newRepeaterItemId(), title: "one" }]).ok,
    false,
  );
  assert.deepEqual(
    validateStructuredValue(schema, [
      { itemId: newRepeaterItemId(), title: "1" },
      { itemId: newRepeaterItemId(), title: "2" },
      { itemId: newRepeaterItemId(), title: "3" },
    ]).ok,
    true,
  );
  assert.equal(MAX_REPEATER_ITEMS >= 1000, true);

  const unbounded = defineRepeaterSchema({ title: { id: "title", type: "string" } });
  const tooMany = Array.from({ length: MAX_REPEATER_ITEMS + 1 }, () => ({
    itemId: newRepeaterItemId(),
    title: "x",
  }));
  const result = validateStructuredValue(unbounded, tooMany);
  assert.equal(result.ok, false);
  assert.equal((result.ok ? [] : result.issues)[0]?.code, "REPEATER_ITEM_LIMIT");
});

test("uniqueBy rejects duplicate item values with a pointed issue", () => {
  const schema = defineRepeaterSchema({ key: { id: "key", type: "string" } }, { uniqueBy: "key" });
  const result = validateStructuredValue(schema, [
    { itemId: newRepeaterItemId(), key: "same" },
    { itemId: newRepeaterItemId(), key: "same" },
  ]);
  assert.equal(result.ok, false);
  const issue = (result.ok ? [] : result.issues)[0];
  assert.equal(issue?.code, "REPEATER_DUPLICATE_UNIQUE_BY");
  assert.equal(issue?.path, "/1/key");
});

test("list holds ordered values; list-of-list is rejected by design", () => {
  const schema = defineListSchema({ id: "tag", type: "string" });
  const result = validateStructuredValue(schema, ["a", "b", "c"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value : null, ["a", "b", "c"]);

  assert.throws(
    () => defineListSchema({ id: "nested", type: "list", item: { id: "x", type: "string" } }),
    (error: unknown) => error instanceof ContentError && error.code === "LIST_ITEM_NESTING",
  );
});

test("schema definition is validated: reserved ids, bad shapes, unregistered types", () => {
  assert.throws(
    () => defineRepeaterSchema({ itemId: { id: "itemId", type: "string" } }),
    (error: unknown) => error instanceof ContentError && error.code === "FIELD_ID_RESERVED",
  );
  assert.throws(
    () => defineObjectSchema({ "Bad-Key": { id: "Bad-Key", type: "string" } }),
    (error: unknown) => error instanceof ContentError && error.code === "FIELD_ID_INVALID",
  );
  assert.throws(
    () => defineObjectSchema({ ghost: { id: "ghost", type: "not_a_type" as "string" } }),
    (error: unknown) => error instanceof ContentError && error.code === "FIELD_TYPE_UNREGISTERED",
  );
  assert.throws(
    () => defineRepeaterSchema({ k: { id: "k", type: "string" } }, { uniqueBy: "missing" }),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_INVALID",
  );
});

test("pathological nesting depth is bounded (SCHEMA_TOO_DEEP)", () => {
  let schema: FieldSchema = { id: "leaf", type: "string" };
  for (let i = 0; i < 40; i++) {
    schema = { id: `obj_${i}`, type: "object", fields: { inner: schema } };
  }
  assert.throws(
    () => defineObjectSchema({ deep: schema }),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_TOO_DEEP",
  );
});

test("issues point at exact JSON-pointer locations", () => {
  const schema = defineObjectSchema({
    features: defineRepeaterSchema({ title: { id: "title", type: "string", required: true } }),
  });
  const result = validateStructuredValue(schema, {
    features: [{ itemId: newRepeaterItemId(), title: "ok" }, { itemId: newRepeaterItemId() }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.issues.map((i) => i.path), ["/features/1/title"]);
});
