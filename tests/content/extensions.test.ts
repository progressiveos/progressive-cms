// PCMS-CONT-T023 — unknown extension namespace preservation.
// Acceptance: read/edit/write round-trip preserves unknown extension payload
// (Content spec §68).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createContentTypeRegistry,
  defineObjectSchema,
  EXTENSIONS_KEY,
  extensionIssues,
  extractExtensions,
  type LoadedContentType,
  MAX_EXTENSIONS_BYTES,
  mergeExtensions,
  validateContentPayload,
  validateStructuredValue,
} from "@pcms/content";

const SERVICE: LoadedContentType = createContentTypeRegistry().registerContentType({
  key: "service",
  version: 1,
  title: "Услуга",
  fields: {
    title: { id: "title", type: "string", required: true },
    price: { id: "price", type: "money" },
  },
});

const STORED = {
  title: "Аудит",
  price: { amount: "100000.00", currency: "RUB" },
  extensions: {
    "vendor.crm": { crm_id: "CRM-42", synced_at: "2026-09-18T00:00:00Z" },
    "shop.legacy_stock": { warehouse: "main", count: 7 },
  },
};

test("round-trip: edit of owned fields preserves unknown extension namespaces", () => {
  // An editor writes an updated payload WITHOUT the extension envelope —
  // the merge must carry the stored extensions through.
  const updated = { title: "Аудит (обновлён)", price: { amount: "120000.00", currency: "RUB" } };
  const merged = mergeExtensions(STORED, updated) as Record<string, unknown>;
  assert.deepEqual(merged[EXTENSIONS_KEY], STORED[EXTENSIONS_KEY]);
  assert.equal(merged.title, "Аудит (обновлён)");

  // A writer that explicitly supplies a namespace overrides only that one.
  const explicit = mergeExtensions(STORED, {
    title: "Аудит",
    extensions: { "vendor.crm": { crm_id: "CRM-99" } },
  });
  const explicitExtensions = extractExtensions(explicit);
  assert.deepEqual(explicitExtensions["vendor.crm"], { crm_id: "CRM-99" });
  assert.deepEqual(explicitExtensions["shop.legacy_stock"], { warehouse: "main", count: 7 });
});

test("extensions envelope does not trip typed-field validation", () => {
  const { [EXTENSIONS_KEY]: _extensions, ...fieldsOnly } = STORED;
  void _extensions;
  // Without the envelope handling the strict schema would flag unknown keys.
  const result = validateContentPayload(SERVICE, STORED, "publish");
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  // The envelope is not part of the field schema, so a fields-only payload
  // still validates identically.
  assert.deepEqual(validateContentPayload(SERVICE, fieldsOnly, "publish").ok, true);
});

test("extension namespaces and sizes are validated with stable codes", () => {
  assert.deepEqual(
    extensionIssues({ extensions: { "Bad Namespace!": {} } }).map((issue) => issue.code),
    ["EXTENSION_NAMESPACE_INVALID"],
  );
  assert.deepEqual(
    extensionIssues({ extensions: "not-an-object" }).map((issue) => issue.code),
    ["EXTENSION_MALFORMED"],
  );

  const huge = { extensions: { "vendor.big": { blob: "x".repeat(MAX_EXTENSIONS_BYTES + 1) } } };
  assert.deepEqual(
    extensionIssues(huge).map((issue) => issue.code),
    ["EXTENSION_TOO_LARGE"],
  );

  assert.equal(extensionIssues({ title: "без extensions" }).length, 0);
  assert.deepEqual(extractExtensions(STORED)["vendor.crm"], {
    crm_id: "CRM-42",
    synced_at: "2026-09-18T00:00:00Z",
  });

  // The structural field validator still rejects unknown FIELD keys —
  // extensions are only legal inside the envelope.
  const strict = defineObjectSchema({ title: { id: "title", type: "string" } });
  assert.equal(validateStructuredValue(strict, { title: "x", vendor_crm: 1 }).ok, false);

  assert.equal(
    validateContentPayload(SERVICE, huge, "draft").ok,
    false,
    "oversized extensions must fail validation",
  );
});
