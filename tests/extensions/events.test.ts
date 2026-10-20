// PCMS-EXT-T008 — Event subscription contract.
// Acceptance (task brief §21/§74): a real M07 outbox event flows through the
// SAME fanout to the M13-style consumer AND the enabled extension consumer;
// a redelivered event does not repeat the extension side effect; a disabled
// extension consumes nothing; after re-enable future events are consumed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  systemClock,
} from "@pcms/core";
import {
  createExtensionEventConsumer,
  EVENT_CONSUMPTIONS_TABLE,
  type ExtensionEventSubscriptionSpec,
  mergeOutboxHandlers,
} from "@pcms/extensions/internal";
import { createOutboxConsumer, createOutboxService, writeOutboxEvent } from "@pcms/publication";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

function extensionConsumptions(pool: DbPool, extensionId: string): Promise<number> {
  return pool
    .query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${EVENT_CONSUMPTIONS_TABLE} WHERE extension_id = $1`,
      [extensionId],
    )
    .then((result) => Number(result.rows[0]?.count ?? "0"));
}

test("one outbox event reaches M13 and the enabled extension; duplicates are idempotent", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const outbox = createOutboxService(pool, { clock: systemClock });

  // M13 dispatcher simulation: the real dispatcher is idempotent (it keeps
  // a deliveries ledger keyed by the outbox event id), mirrored here.
  const m13Seen = new Set<string>();
  const m13Deliveries: string[] = [];
  const extensionDeliveries: string[] = [];
  const subscriptions: ExtensionEventSubscriptionSpec[] = [
    {
      extensionId: "com.example.listener",
      subscriptionId: "on-entry-published",
      eventType: "EntryPublished",
      handler: async (event) => {
        extensionDeliveries.push(`${event.id}:${event.eventType}`);
      },
    },
  ];
  const consumer = createExtensionEventConsumer({ pool, clock: systemClock, subscriptions });

  // Worker composition: one claimed event is offered to every family —
  // the M13 dispatcher family first, the extension consumer family second.
  const handlers = mergeOutboxHandlers([
    {
      EntryPublished: async (event) => {
        if (m13Seen.has(event.id)) return;
        m13Seen.add(event.id);
        m13Deliveries.push(event.id);
      },
    },
    { EntryPublished: (event) => consumer.handle(event) },
  ]);
  const outboxConsumer = createOutboxConsumer(outbox, handlers);

  await writeOutboxEvent(pool, {
    aggregate: "entry",
    aggregateId: "entry-1",
    eventType: "EntryPublished",
    payload: { title: "hello" },
  });
  const delivered = await outboxConsumer.processBatch(10);
  assert.equal(delivered, 1);
  assert.equal(m13Deliveries.length, 1, "M13 consumer received the event");
  assert.equal(extensionDeliveries.length, 1, "enabled extension received the event");
  assert.equal(await extensionConsumptions(pool, "com.example.listener"), 1);

  // Redelivery (duplicate) of the same event: neither consumer repeats its
  // side effect — the extension claim is the idempotency gate.
  const event = {
    id: m13Deliveries[0] ?? "",
    aggregate: "entry",
    aggregateId: "entry-1",
    eventType: "EntryPublished",
    payload: { title: "hello" },
  };
  await handlers.EntryPublished?.(event);
  await handlers.EntryPublished?.(event);
  assert.equal(m13Deliveries.length, 1);
  assert.equal(extensionDeliveries.length, 1);
  assert.equal(await extensionConsumptions(pool, "com.example.listener"), 1);
});

test("disabled extension has no subscription and consumes nothing; re-enable consumes future events", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);

  const sideEffects: string[] = [];
  const makeSubscription = (): ExtensionEventSubscriptionSpec => ({
    extensionId: "com.example.loud",
    subscriptionId: "on-media-uploaded",
    eventType: "MediaUploaded",
    handler: async (event) => {
      sideEffects.push(event.id);
    },
  });

  // DISABLED: the extension is not in the composed subscription set at all.
  const whileDisabled = createExtensionEventConsumer({
    pool,
    clock: systemClock,
    subscriptions: [],
  });
  await writeOutboxEvent(pool, {
    aggregate: "media",
    aggregateId: "media-1",
    eventType: "MediaUploaded",
    payload: {},
  });
  await whileDisabled.handle({
    id: "00000000-0000-7000-8000-000000000001",
    aggregate: "media",
    aggregateId: "media-1",
    eventType: "MediaUploaded",
    payload: {},
  });
  assert.deepEqual(sideEffects, []);
  assert.equal(await extensionConsumptions(pool, "com.example.loud"), 0);

  // ENABLED: future events are consumed.
  const afterEnable = createExtensionEventConsumer({
    pool,
    clock: systemClock,
    subscriptions: [makeSubscription()],
  });
  await afterEnable.handle({
    id: "00000000-0000-7000-8000-000000000002",
    aggregate: "media",
    aggregateId: "media-2",
    eventType: "MediaUploaded",
    payload: {},
  });
  assert.equal(sideEffects.length, 1);
  assert.equal(await extensionConsumptions(pool, "com.example.loud"), 1);
});

test("a failing handler releases its claim so the outbox retry can re-process", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  let attempts = 0;
  const flaky = createExtensionEventConsumer({
    pool,
    clock: systemClock,
    subscriptions: [
      {
        extensionId: "com.example.flaky",
        subscriptionId: "on-entry-published",
        eventType: "EntryPublished",
        handler: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient provider outage");
        },
      },
    ],
  });
  const event = {
    id: "00000000-0000-7000-8000-000000000003",
    aggregate: "entry",
    aggregateId: "entry-9",
    eventType: "EntryPublished",
    payload: {},
  };
  await assert.rejects(() => flaky.handle(event));
  assert.equal(await extensionConsumptions(pool, "com.example.flaky"), 0, "claim released");
  // Retry succeeds and records the consumption.
  await flaky.handle(event);
  assert.equal(attempts, 2);
  assert.equal(await extensionConsumptions(pool, "com.example.flaky"), 1);
});

test("multiple extensions observing the same event each consume exactly once", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const calls: string[] = [];
  const consumer = createExtensionEventConsumer({
    pool,
    clock: systemClock,
    subscriptions: [
      {
        extensionId: "com.example.one",
        subscriptionId: "watch",
        eventType: "EntryPublished",
        handler: async () => void calls.push("one"),
      },
      {
        extensionId: "com.example.two",
        subscriptionId: "watch",
        eventType: "EntryPublished",
        handler: async () => void calls.push("two"),
      },
    ],
  });
  const event = {
    id: "00000000-0000-7000-8000-000000000004",
    aggregate: "entry",
    aggregateId: "entry-2",
    eventType: "EntryPublished",
    payload: {},
  };
  await consumer.handle(event);
  await consumer.handle(event); // redelivery
  assert.deepEqual(calls.sort(), ["one", "two"]);
  assert.equal(await extensionConsumptions(pool, "com.example.one"), 1);
  assert.equal(await extensionConsumptions(pool, "com.example.two"), 1);
});
