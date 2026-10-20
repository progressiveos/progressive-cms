// PCMS-INT-T003 — bounded condition model + IntegrationBinding persistence.
// Proves: only the 8 typed operators survive validation (no eval/JS/SQL),
// typed comparisons are numeric-only, payload mapping is declarative-only,
// and bindings persist with validated actions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, fixedClock } from "@pcms/core";
import {
  type ConnectorDefinition,
  createConnectorRegistry,
  createIntegrationBindingService,
  createIntegrationInstanceService,
  evaluateConditions,
  type IntegrationError,
  resolvePayloadMapping,
  validateConditions,
  validatePayloadMapping,
} from "@pcms/integrations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CLOCK = fixedClock(new Date("2026-09-20T12:00:00.000Z"));

const connector: ConnectorDefinition = {
  connectorType: "stub",
  title: "Stub",
  description: "test",
  configSchema: { type: "object", properties: {}, additionalProperties: true },
  secrets: [],
  actions: [{ actionType: "ping", description: "", payloadSchema: { type: "object" } }],
  testable: true,
};

test("conditions: the 8 typed operators evaluate; unknown operators rejected", () => {
  const data = {
    form_definition_id: "abc",
    score: 7,
    outcome_id: "hot",
    tags: ["a", "b"],
    nested: { deep: { value: true } },
  };
  const conditions = validateConditions([
    { field: "form_definition_id", op: "eq", value: "abc" },
    { field: "form_definition_id", op: "neq", value: "zzz" },
    { field: "outcome_id", op: "in", value: ["hot", "warm"] },
    { field: "score", op: "gte", value: 5 },
    { field: "score", op: "lt", value: 10 },
    { field: "missing", op: "exists", value: false },
    { field: "nested.deep.value", op: "exists", value: true },
  ]);
  assert.equal(evaluateConditions(conditions, data), true);
  assert.equal(evaluateConditions([{ field: "score", op: "gt", value: 7 }], data), false);
  assert.equal(evaluateConditions([{ field: "score", op: "lte", value: 7 }], data), true);
  // Typed ordered comparison refuses non-numbers instead of coercing.
  assert.equal(
    evaluateConditions([{ field: "form_definition_id", op: "gt", value: 1 }], data),
    false,
  );

  assert.throws(
    () => validateConditions([{ field: "x", op: "matches", value: ".*" }]),
    (error: IntegrationError) => error.code === "INTEGRATION_CONDITION_INVALID",
  );
  assert.throws(
    () => validateConditions([{ field: "x; DROP TABLE users", op: "eq", value: 1 }]),
    (error: IntegrationError) => error.code === "INTEGRATION_CONDITION_INVALID",
  );
  assert.throws(
    () => validateConditions([{ field: "x", op: "gt", value: "9" }]),
    (error: IntegrationError) => error.code === "INTEGRATION_CONDITION_INVALID",
  );
  assert.throws(
    () => validateConditions(new Array(17).fill({ field: "x", op: "eq", value: 1 })),
    (error: IntegrationError) => error.code === "INTEGRATION_CONDITION_INVALID",
  );
});

test("payload mapping: declarative sources only, bounded paths and literals", () => {
  const mapping = validatePayloadMapping({
    text: { $event: "submission_id" },
    footer: { $literal: "new request" },
    contact: { $project: "fields.contact_email" },
  });
  assert.deepEqual(
    resolvePayloadMapping(mapping, { submission_id: "s1" }, { fields: { contact_email: "a@b.c" } }),
    { text: "s1", footer: "new request", contact: "a@b.c" },
  );
  assert.throws(
    () => resolvePayloadMapping(validatePayloadMapping({ x: { $project: "a" } }), {}, null),
    (error: IntegrationError) => error.code === "INTEGRATION_PROJECTION_UNAVAILABLE",
  );
  assert.throws(
    () => validatePayloadMapping({ x: { $code: "process.exit()" } }),
    (error: IntegrationError) => error.code === "INTEGRATION_BINDING_INVALID",
  );
  assert.throws(
    () => validatePayloadMapping({ "a.b.c.d.e.f": { $literal: 1 } }),
    (error: IntegrationError) => error.code === "INTEGRATION_CONDITION_INVALID",
  );
});

async function fixture(t: { after: (fn: () => void) => void }) {
  if (!testDatabaseConfigured()) return null;
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  const { loadMigrations, migrateDatabase } = await import("@pcms/core");
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const registry = createConnectorRegistry();
  registry.register(connector);
  const instances = createIntegrationInstanceService({ pool, clock: CLOCK, registry });
  const instance = await instances.create({
    connectorType: "stub",
    name: "stub-1",
    config: {},
  });
  const bindings = createIntegrationBindingService({ pool, clock: CLOCK, instances, registry });
  return { bindings, instance };
}

test("binding create/list/update with validated actions", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const binding = await fx.bindings.create({
    eventType: "FormSubmitted",
    conditions: [{ field: "form_definition_id", op: "eq", value: "contact" }],
    actions: [
      {
        instanceId: fx.instance.id,
        actionType: "ping",
        payloadMapping: { text: { $event: "submission_id" } },
      },
    ],
    failurePolicy: { maxAttempts: 3, backoffBaseMs: 1000 },
  });
  assert.equal(binding.enabled, true);
  assert.deepEqual(binding.failurePolicy, { maxAttempts: 3, backoffBaseMs: 1000 });

  assert.equal((await fx.bindings.list({ eventType: "FormSubmitted" })).length, 1);

  const disabled = await fx.bindings.update(binding.id, { enabled: false });
  assert.equal(disabled.enabled, false);

  await assert.rejects(
    fx.bindings.create({
      eventType: "FormSubmitted",
      actions: [{ instanceId: fx.instance.id, actionType: "nope", payloadMapping: {} }],
    }),
    (error: IntegrationError) => error.code === "INTEGRATION_ACTION_UNKNOWN",
  );
  await assert.rejects(
    fx.bindings.create({
      eventType: "FormSubmitted",
      actions: [
        {
          instanceId: "00000000-0000-0000-0000-000000000000",
          actionType: "ping",
          payloadMapping: {},
        },
      ],
    }),
    (error: IntegrationError) => error.code === "INTEGRATION_INSTANCE_NOT_FOUND",
  );
});
