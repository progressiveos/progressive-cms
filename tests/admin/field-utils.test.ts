// PCMS-ADMIN-T002 — pure field helpers for the schema-driven editor.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyFieldValue,
  fieldLabel,
  fromDatetimeWire,
  integerIssues,
  moneyIssues,
  stableId,
  toDatetimeWire,
} from "../../apps/admin/src/screens/content/fields/field-utils.js";
import { FIELD_TYPES_V1 } from "../../apps/admin/src/screens/content/fields/registry-constants.js";

const STABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("stableId produces M02-compatible UUIDv7 stable ids", () => {
  for (let i = 0; i < 200; i += 1) {
    assert.match(stableId(), STABLE_ID_RE);
  }
  const [first, second] = [stableId(1_000), stableId(2_000)];
  assert.notEqual(first, second);
});

test("emptyFieldValue matches the wire shape of structured field types", () => {
  assert.deepEqual(emptyFieldValue("repeater"), []);
  assert.deepEqual(emptyFieldValue("media_list"), []);
  assert.equal(emptyFieldValue("boolean"), false);
  assert.deepEqual(emptyFieldValue("money"), { amount: "", currency: "" });
  assert.deepEqual(emptyFieldValue("rich_text"), {
    schema_version: 2,
    type: "document",
    content: [],
  });
  assert.deepEqual(emptyFieldValue("block_document"), { schema_version: 1, blocks: [] });
  assert.equal(emptyFieldValue("string"), "");
});

test("toDatetimeWire converts datetime-local values into the wire format", () => {
  const wire = toDatetimeWire("2026-09-20T14:30");
  assert.match(wire ?? "", /^\d{4}-\d{2}-\d{2}T14:30:00[+-]\d{2}:\d{2}$/);
  // wire values pass through untouched
  assert.equal(toDatetimeWire("2026-09-20T14:30:00Z"), "2026-09-20T14:30:00Z");
  assert.equal(toDatetimeWire("garbage"), null);
});

test("fromDatetimeWire strips seconds/zone for datetime-local editing", () => {
  assert.equal(fromDatetimeWire("2026-09-20T14:30:15Z"), "2026-09-20T14:30");
});

test("moneyIssues mirror the server contract (canonical decimal + ISO currency)", () => {
  assert.deepEqual(moneyIssues({ amount: "125000.00", currency: "RUB" }), []);
  assert.deepEqual(moneyIssues({ amount: "12,5", currency: "RUB" }).length, 1);
  assert.deepEqual(moneyIssues({ amount: "125000.00", currency: "rub" }).length, 1);
  assert.equal(moneyIssues(null).length > 0, true);
});

test("integerIssues respect schema bounds", () => {
  assert.deepEqual(integerIssues("7", { min: 1, max: 10 }), []);
  assert.deepEqual(integerIssues("11", { min: 1, max: 10 }), ["Maximum 10"]);
  assert.deepEqual(integerIssues("abc", {}), ["Enter an integer"]);
  assert.deepEqual(integerIssues("", {}), []);
});

test("field labels: semantic ids are translated, others humanized", () => {
  assert.equal(fieldLabel("title"), "Заголовок");
  assert.equal(fieldLabel("menu_title"), "Заголовок в меню");
  assert.equal(fieldLabel("custom_thing"), "Custom thing");
});

test("admin field registry constants match the M02 field registry size", () => {
  assert.equal(FIELD_TYPES_V1.length, 23);
  assert.equal(new Set(FIELD_TYPES_V1).size, 23);
});

// --- PCMS-ADMIN-T004: repeater identity helpers. ---
import {
  duplicateRepeaterItem,
  moveRepeaterItem,
  withItemIds,
} from "../../apps/admin/src/screens/content/fields/repeater-utils.js";

test("moveRepeaterItem preserves item identity (reorder never recreates)", () => {
  const a = { itemId: "a", v: 1 };
  const b = { itemId: "b", v: 2 };
  const c = { itemId: "c", v: 3 };
  const reordered = moveRepeaterItem([a, b, c], 0, 2);
  assert.deepEqual(reordered, [b, c, a]);
  // the exact same objects, not copies
  assert.ok(Object.values(reordered).includes(b));
});

test("duplicateRepeaterItem copies values but issues a new stable id", () => {
  const source = { itemId: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e70", title: "x" };
  const copy = duplicateRepeaterItem(source);
  assert.equal(copy.title, "x");
  assert.notEqual(copy.itemId, source.itemId);
  assert.match(String(copy.itemId), /^[0-9a-f-]{36}$/);
});

test("withItemIds backfills missing ids and keeps existing ones", () => {
  const existing = { itemId: "keep", v: 1 };
  const [first, second] = withItemIds([existing, { v: 2 }]);
  assert.equal(first?.itemId, "keep");
  assert.match(String(second?.itemId), /^[0-9a-f-]{36}$/);
});
