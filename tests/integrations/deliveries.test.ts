// PCMS-INT-T004 — Delivery + Attempt persistence: idempotent
// materialization (one event×binding×action = ONE logical delivery), full
// attempt history, bounded backoff, manual retry/cancel state rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, fixedClock } from "@pcms/core";
import {
  backoffDelay,
  type ConnectorDefinition,
  createConnectorRegistry,
  createDeliveryService,
  createIntegrationBindingService,
  createIntegrationInstanceService,
  type DeliveryService,
} from "@pcms/integrations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CLOCK = fixedClock(new Date("2026-09-20T12:00:00.000Z"));
const EVENT_ID = "018f0000-0000-7000-8000-000000000001";

const connector: ConnectorDefinition = {
  connectorType: "stub",
  title: "Stub",
  description: "test",
  configSchema: { type: "object", properties: {}, additionalProperties: true },
  secrets: [],
  actions: [{ actionType: "ping", description: "", payloadSchema: { type: "object" } }],
  testable: true,
};

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
  const instance = await instances.create({ connectorType: "stub", name: "stub-1", config: {} });
  const bindings = createIntegrationBindingService({ pool, clock: CLOCK, instances, registry });
  const binding = await bindings.create({
    eventType: "FormSubmitted",
    actions: [{ instanceId: instance.id, actionType: "ping", payloadMapping: {} }],
  });
  const deliveries: DeliveryService = createDeliveryService({ pool, clock: CLOCK });
  return { pool, deliveries, instanceId: instance.id, bindingId: binding.id };
}

test("delivery materialization is idempotent per event×binding×action", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const identity = { outboxEventId: EVENT_ID, bindingId: fx.bindingId, actionIndex: 0 };
  const first = await fx.deliveries.materialize({
    identity,
    eventType: "FormSubmitted",
    instanceId: fx.instanceId,
    actionType: "ping",
    payload: { text: "hello" },
    maxAttempts: 3,
  });
  assert.equal(first.created, true);
  const replay = await fx.deliveries.materialize({
    identity,
    eventType: "FormSubmitted",
    instanceId: fx.instanceId,
    actionType: "ping",
    payload: { text: "hello" },
    maxAttempts: 3,
  });
  assert.equal(replay.created, false);
  assert.equal(replay.delivery.id, first.delivery.id);
  const all = await fx.deliveries.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.status, "PENDING");
});

test("attempt recording: success closes; retryable failures back off then exhaust", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { delivery } = await fx.deliveries.materialize({
    identity: { outboxEventId: EVENT_ID, bindingId: fx.bindingId, actionIndex: 0 },
    eventType: "FormSubmitted",
    instanceId: fx.instanceId,
    actionType: "ping",
    payload: {},
    maxAttempts: 3,
  });

  const ok = await fx.deliveries.recordAttempt(delivery, {
    ok: true,
    retryable: false,
    backoffBaseMs: 1000,
    externalId: "ext-1",
  });
  assert.equal(ok.status, "SUCCEEDED");
  assert.equal(ok.attemptCount, 1);
  assert.equal(ok.externalId, "ext-1");
  const closed = await fx.deliveries.get(delivery.id);
  assert.equal(closed?.attempts.length, 1);
  assert.equal(closed?.attempts[0]?.result, "SUCCEEDED");

  // Retryable exhaustion: attempts 1..2 back off, attempt 3 → permanent.
  const retryable = await fx.deliveries.materialize({
    identity: { outboxEventId: EVENT_ID, bindingId: fx.bindingId, actionIndex: 1 },
    eventType: "FormSubmitted",
    instanceId: fx.instanceId,
    actionType: "ping",
    payload: {},
    maxAttempts: 3,
  });
  let current = retryable.delivery;
  for (const attempt of [1, 2, 3]) {
    current = await fx.deliveries.recordAttempt(current, {
      ok: false,
      retryable: true,
      backoffBaseMs: 1000,
      providerErrorCode: "TELEGRAM_5XX",
      errorMessage: "provider unavailable",
    });
    assert.equal(current.attemptCount, attempt);
    assert.equal(current.status, attempt < 3 ? "FAILED_RETRYABLE" : "FAILED_PERMANENT");
  }
  assert.equal(current.lastErrorCode, "TELEGRAM_5XX");
  const history = await fx.deliveries.get(current.id);
  assert.equal(history?.attempts.length, 3);
  // Bounded exponential backoff between the attempts.
  assert.deepEqual(
    [1, 2, 3].map((n) => backoffDelay(1000, n)),
    [1000, 2000, 4000],
  );
  // Permanent errors never schedule a next attempt.
  assert.equal(current.nextAttemptAt, null);
});

test("manual retry re-arms failed deliveries; cancel respects state rules", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { delivery } = await fx.deliveries.materialize({
    identity: { outboxEventId: EVENT_ID, bindingId: fx.bindingId, actionIndex: 0 },
    eventType: "FormSubmitted",
    instanceId: fx.instanceId,
    actionType: "ping",
    payload: {},
    maxAttempts: 1,
  });
  const failed = await fx.deliveries.recordAttempt(delivery, {
    ok: false,
    retryable: false,
    backoffBaseMs: 1000,
    providerErrorCode: "BAD_REQUEST",
  });
  assert.equal(failed.status, "FAILED_PERMANENT");
  const rearmed = await fx.deliveries.retry(delivery.id);
  assert.equal(rearmed.status, "PENDING");
  // Succeeding on the manual attempt keeps history complete.
  const done = await fx.deliveries.recordAttempt(rearmed, {
    ok: true,
    retryable: false,
    backoffBaseMs: 1000,
  });
  assert.equal(done.status, "SUCCEEDED");
  assert.equal(done.attemptCount, 2);
  await assert.rejects(
    fx.deliveries.retry(delivery.id),
    (error: Error & { code?: string }) => error.code === "INTEGRATION_DELIVERY_STATE",
  );

  const { delivery: second } = await fx.deliveries.materialize({
    identity: { outboxEventId: EVENT_ID, bindingId: fx.bindingId, actionIndex: 2 },
    eventType: "FormSubmitted",
    instanceId: fx.instanceId,
    actionType: "ping",
    payload: {},
    maxAttempts: 1,
  });
  const cancelled = await fx.deliveries.cancel(second.id);
  assert.equal(cancelled.status, "CANCELLED");
  await assert.rejects(
    fx.deliveries.cancel(second.id),
    (error: Error & { code?: string }) => error.code === "INTEGRATION_DELIVERY_STATE",
  );
});

test("claimDue leases pending work and skips disabled instances", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Instance disabled → not claimable (paused, not failed).
  await fx.pool.query(`UPDATE integration_instance SET enabled = false WHERE id = $1`, [
    fx.instanceId,
  ]);
  await fx.deliveries.materialize({
    identity: { outboxEventId: EVENT_ID, bindingId: fx.bindingId, actionIndex: 0 },
    eventType: "FormSubmitted",
    instanceId: fx.instanceId,
    actionType: "ping",
    payload: {},
    maxAttempts: 3,
  });
  assert.equal((await fx.deliveries.claimDue(10)).length, 0);
  await fx.pool.query(`UPDATE integration_instance SET enabled = true WHERE id = $1`, [
    fx.instanceId,
  ]);
  const claimed = await fx.deliveries.claimDue(10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.status, "PROCESSING");
  // No double claim while the lease is fresh.
  assert.equal((await fx.deliveries.claimDue(10)).length, 0);
  const stats = await fx.deliveries.stats();
  assert.equal(stats.PROCESSING, 1);
});
