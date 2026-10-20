// PCMS-CONT-T008 — money/date/datetime/enum exact serialization.
// Acceptance: decimal/date/time fixtures pass (Content spec §17–§20).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentError,
  defineDateSchema,
  defineDatetimeSchema,
  defineDecimalSchema,
  defineEnumSchema,
  defineIntegerSchema,
  defineMoneySchema,
  defineObjectSchema,
  validateStructuredValue,
} from "@pcms/content";

function codes(result: ReturnType<typeof validateStructuredValue>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

test("money fixtures: canonical decimal string + ISO-4217 currency", () => {
  const schema = defineMoneySchema();
  // Spec §18 fixture.
  assert.deepEqual(validateStructuredValue(schema, { amount: "125000.00", currency: "RUB" }), {
    ok: true,
    value: { amount: "125000.00", currency: "RUB" },
  });
  assert.deepEqual(validateStructuredValue(schema, { amount: "0", currency: "USD" }).ok, true);
  assert.deepEqual(
    validateStructuredValue(schema, { amount: "-499.90", currency: "EUR" }).ok,
    true,
  );

  // Floats are never exact money.
  assert.deepEqual(codes(validateStructuredValue(schema, { amount: 125000.0, currency: "RUB" })), [
    "MONEY_NOT_EXACT",
  ]);
  // Non-canonical decimal spellings.
  assert.deepEqual(
    codes(validateStructuredValue(schema, { amount: "125000,00", currency: "RUB" })),
    ["MONEY_AMOUNT_MALFORMED"],
  );
  assert.deepEqual(codes(validateStructuredValue(schema, { amount: "1.25e5", currency: "RUB" })), [
    "MONEY_AMOUNT_MALFORMED",
  ]);
  assert.deepEqual(codes(validateStructuredValue(schema, { amount: "0125.50", currency: "RUB" })), [
    "MONEY_AMOUNT_MALFORMED",
  ]);
  // Currency must be ISO-4217 alpha-3 shaped. Semantic validation against the
  // live ISO table is deliberately not this layer's job — any alpha-3 key is
  // accepted so new currencies never need a code change.
  assert.deepEqual(codes(validateStructuredValue(schema, { amount: "10.00", currency: "rub" })), [
    "MONEY_CURRENCY_INVALID",
  ]);
  assert.deepEqual(codes(validateStructuredValue(schema, { amount: "10.00", currency: "RUBS" })), [
    "MONEY_CURRENCY_INVALID",
  ]);
  // Round-trip: accepted value unchanged.
  const value = { amount: "125000.00", currency: "RUB" };
  const round = validateStructuredValue(schema, JSON.parse(JSON.stringify(value)));
  assert.deepEqual(round, { ok: true, value });
});

test("decimal fixtures: canonical strings, bounds, precision and scale", () => {
  const schema = defineDecimalSchema({ min: "0", max: "100.5", precision: 6, scale: 2 });
  assert.deepEqual(validateStructuredValue(schema, "99.99").ok, true);
  assert.deepEqual(validateStructuredValue(schema, "100.50").ok, true);
  assert.deepEqual(codes(validateStructuredValue(schema, 12.5)), ["DECIMAL_NOT_EXACT"]);
  assert.deepEqual(codes(validateStructuredValue(schema, "100.51")), ["DECIMAL_OUT_OF_RANGE"]);
  assert.deepEqual(codes(validateStructuredValue(schema, "-0.01")), ["DECIMAL_OUT_OF_RANGE"]);
  // A value violating precision also reports range (checks compose); assert membership.
  const precisionResult = codes(validateStructuredValue(schema, "123456.7"));
  assert.ok(precisionResult.includes("DECIMAL_PRECISION_EXCEEDED"));
  assert.deepEqual(codes(validateStructuredValue(schema, "1.234")), ["DECIMAL_SCALE_EXCEEDED"]);

  assert.throws(
    () => defineDecimalSchema({ precision: 0 }),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_INVALID",
  );
  assert.throws(
    () => defineDecimalSchema({ precision: 4, scale: 5 }),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_INVALID",
  );
});

test("integer fixtures: JSON integers only, bounded", () => {
  const schema = defineIntegerSchema({ min: 0, max: 10 });
  assert.deepEqual(validateStructuredValue(schema, 0).ok, true);
  assert.deepEqual(validateStructuredValue(schema, 10).ok, true);
  assert.deepEqual(codes(validateStructuredValue(schema, 11)), ["INTEGER_OUT_OF_RANGE"]);
  assert.deepEqual(codes(validateStructuredValue(schema, 1.5)), ["INTEGER_MALFORMED"]);
  assert.deepEqual(codes(validateStructuredValue(schema, "5")), ["INTEGER_MALFORMED"]);
  assert.deepEqual(
    codes(validateStructuredValue(schema, Number.MAX_SAFE_INTEGER + 1))[0],
    "INTEGER_MALFORMED",
  );
});

test("date fixtures: calendar dates without timezone, real-day validation", () => {
  const schema = defineDateSchema();
  assert.deepEqual(validateStructuredValue(schema, "2026-09-18"), {
    ok: true,
    value: "2026-09-18",
  });
  assert.deepEqual(validateStructuredValue(schema, "2024-02-29").ok, true); // leap year
  assert.deepEqual(codes(validateStructuredValue(schema, "2026-02-30")), ["DATE_NON_EXISTENT"]);
  assert.deepEqual(codes(validateStructuredValue(schema, "2026-13-01")), ["DATE_NON_EXISTENT"]);
  assert.deepEqual(codes(validateStructuredValue(schema, "2026-09-18T00:00:00Z")), [
    "DATE_MALFORMED",
  ]);
  assert.deepEqual(codes(validateStructuredValue(schema, "18.09.2026")), ["DATE_MALFORMED"]);
});

test("datetime fixtures: ISO-8601 with explicit timezone semantics", () => {
  const schema = defineDatetimeSchema();
  assert.deepEqual(validateStructuredValue(schema, "2026-09-18T12:34:56Z"), {
    ok: true,
    value: "2026-09-18T12:34:56Z",
  });
  assert.deepEqual(validateStructuredValue(schema, "2026-09-18T15:34:56+03:00").ok, true);
  assert.deepEqual(validateStructuredValue(schema, "2026-09-18T12:34:56.123456Z").ok, true);
  assert.deepEqual(codes(validateStructuredValue(schema, "2026-09-18T12:34:56")), [
    "DATETIME_MALFORMED",
  ]);
  assert.deepEqual(codes(validateStructuredValue(schema, "2026-09-18 12:34:56Z")), [
    "DATETIME_MALFORMED",
  ]);
  assert.deepEqual(codes(validateStructuredValue(schema, "2026-02-30T12:00:00Z")), [
    "DATETIME_NON_EXISTENT",
  ]);
  assert.deepEqual(codes(validateStructuredValue(schema, "2026-09-18T25:00:00Z")), [
    "DATETIME_NON_EXISTENT",
  ]);
  assert.deepEqual(codes(validateStructuredValue(schema, "2026-09-18T12:34:56+99:00")), [
    "DATETIME_NON_EXISTENT",
  ]);
});

test("enum fixtures: stable machine keys only, localized labels rejected", () => {
  const schema = defineEnumSchema(["draft", "in_review", "final"]);
  assert.deepEqual(validateStructuredValue(schema, "draft"), { ok: true, value: "draft" });
  assert.deepEqual(codes(validateStructuredValue(schema, "Черновик")), ["ENUM_VALUE_INVALID"]);
  assert.deepEqual(codes(validateStructuredValue(schema, "DRAFT")), ["ENUM_VALUE_INVALID"]);
  assert.deepEqual(codes(validateStructuredValue(schema, "published")), ["ENUM_VALUE_INVALID"]);
  // Null: optional semantics, not a value.
  assert.deepEqual(validateStructuredValue(schema, null).ok, true);

  assert.throws(
    () => defineEnumSchema([]),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_INVALID",
  );
  assert.throws(
    () => defineEnumSchema(["good", "Bad Key"]),
    (error: unknown) => error instanceof ContentError && error.code === "SCHEMA_INVALID",
  );
});

test("exact scalars compose inside object/repeater schemas with pointed paths", () => {
  const schema = defineObjectSchema({
    price: defineMoneySchema({ required: true }),
    started: { id: "started", type: "date" },
    status: defineEnumSchema(["planned", "done"]),
    rating: { id: "rating", type: "integer", max: 5 },
  });
  assert.deepEqual(
    validateStructuredValue(schema, {
      price: { amount: "5000.00", currency: "RUB" },
      started: "2026-09-01",
      status: "planned",
      rating: 5,
    }).ok,
    true,
  );
  const result = validateStructuredValue(schema, {
    price: { amount: "5000.00", currency: "RUB" },
    started: "2026-09-31",
    status: "planned",
    rating: 6,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok ? [] : result.issues.map((issue) => [issue.path, issue.code]), [
    ["/started", "DATE_NON_EXISTENT"],
    ["/rating", "INTEGER_OUT_OF_RANGE"],
  ]);
});
