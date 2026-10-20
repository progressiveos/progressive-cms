// PCMS-INT-T005 — Outbox consumer/action dispatcher: event → binding →
// logical deliveries; outage cannot lose the event; replay is idempotent.
// PCMS-INT-T006 — retry/backoff/dead-letter semantics + manual retry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Clock, createDbPool, type DbPool, fixedClock } from "@pcms/core";
import {
  type ActionResult,
  actionFailed,
  actionSucceeded,
  type ConnectorDefinition,
  type ConnectorRuntime,
  createConnectorRegistry,
  createDeliveryService,
  createIntegrationBindingService,
  createIntegrationDispatcher,
  createIntegrationInstanceService,
  type DeliveryService,
  type IntegrationBindingService,
} from "@pcms/integrations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const START = new Date("2026-09-20T12:00:00.000Z");

const connector: ConnectorDefinition = {
  connectorType: "stub",
  title: "Stub",
  description: "test",
  configSchema: { type: "object", properties: {}, additionalProperties: true },
  secrets: [],
  actions: [
    {
      actionType: "ping",
      description: "",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
  testable: true,
};

/** Mutable scripted runtime: pops one outcome per execute() call. */
function scriptedRuntime(script: ActionResult[], log: string[]): ConnectorRuntime {
  return {
    async execute(actionType, _payload, ctx) {
      log.push(`${ctx.instance.name}:${actionType}`);
      return script.shift() ?? actionFailed({ retryable: false, providerErrorCode: "EXHAUSTED" });
    },
    async test() {
      return actionSucceeded();
    },
  };
}

interface Fixture {
  pool: DbPool;
  clock: Clock;
  dispatcher: ReturnType<typeof createIntegrationDispatcher>;
  bindings: IntegrationBindingService;
  instances: ReturnType<typeof createIntegrationInstanceService>;
  deliveries: DeliveryService;
  log: string[];
  script: ActionResult[];
  instanceId: string;
  advance(ms: number): void;
}

async function fixture(
  t: { after: (fn: () => void) => void },
  options?: {
    readonly projection?: { readonly fields: Record<string, unknown> };
  },
): Promise<Fixture | null> {
  if (!testDatabaseConfigured()) return null;
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  const { loadMigrations, migrateDatabase } = await import("@pcms/core");
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const mutable = { current: new Date(START.getTime()) };
  const clock: Clock = { now: () => new Date(mutable.current.getTime()) };
  const advance = (ms: number) => {
    mutable.current = new Date(mutable.current.getTime() + ms);
  };
  const registry = createConnectorRegistry();
  registry.register(connector);
  const instances = createIntegrationInstanceService({ pool, clock, registry });
  const instance = await instances.create({ connectorType: "stub", name: "one", config: {} });
  const bindings = createIntegrationBindingService({ pool, clock, instances, registry });
  const deliveries = createDeliveryService({ pool, clock });
  const log: string[] = [];
  const script: ActionResult[] = [];
  const dispatcher = createIntegrationDispatcher({
    clock,
    registry,
    runtimes: {
      get: () => scriptedRuntime(script, log),
    } as never,
    bindings,
    instances,
    deliveries,
    secretResolver: (name) => (name === "K" ? "v" : undefined),
    ...(options?.projection === undefined
      ? {}
      : {
          projectionSource: {
            async project(request) {
              return Object.fromEntries(
                request.fields.map((field) => [field, options.projection?.fields[field]]),
              );
            },
          },
        }),
  });
  return {
    pool,
    clock,
    dispatcher,
    bindings,
    instances,
    deliveries,
    log,
    script,
    instanceId: instance.id,
    advance,
  };
}

const FORM_EVENT = {
  id: "018f0000-0000-7000-8000-0000000000aa",
  aggregate: "form_submission",
  aggregateId: "sub-1",
  eventType: "FormSubmitted",
  payload: { submission_id: "sub-1", form_definition_id: "contact", score: 5 },
};

test("body revision pins at materialization from the instance flag; old rows stay 1", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Default instance has no flag → legacy revision.
  await fx.bindings.create({
    eventType: "FormSubmitted",
    actions: [
      {
        instanceId: fx.instanceId,
        actionType: "ping",
        payloadMapping: { text: { $literal: "legacy" } },
      },
    ],
  });
  await fx.dispatcher.handleEvent(FORM_EVENT);
  const rows = await fx.deliveries.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.bodyRevision, 1, "flag off → revision 1 (legacy bytes)");

  // A second instance with the attribution flag on materializes revision 2.
  const flagged = await fx.instances.create({
    connectorType: "stub",
    name: "flagged",
    config: { send_attribution: true },
  });
  await fx.bindings.create({
    eventType: "FormSubmitted",
    actions: [
      {
        instanceId: flagged.id,
        actionType: "ping",
        payloadMapping: { text: { $literal: "with-attr" } },
      },
    ],
  });
  await fx.dispatcher.handleEvent(FORM_EVENT);
  const flaggedRows = (await fx.deliveries.list()).filter((row) => row.bodyRevision === 2);
  assert.equal(flaggedRows.length, 1, "flag on → revision 2 frozen at materialization");
  assert.notEqual(flaggedRows[0]?.id, rows[0]?.id);
});

test("event materializes one delivery per action; replay creates no duplicates", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "FormSubmitted",
    actions: [
      {
        instanceId: fx.instanceId,
        actionType: "ping",
        payloadMapping: { text: { $event: "submission_id" } },
      },
    ],
  });
  await fx.dispatcher.handleEvent(FORM_EVENT);
  await fx.dispatcher.handleEvent(FORM_EVENT); // at-least-once replay
  const all = await fx.deliveries.list();
  assert.equal(all.length, 1, "replay must not create a second logical delivery");
  assert.deepEqual(all[0]?.payload, { text: "sub-1" });
  fx.script.push(actionSucceeded());
  await fx.dispatcher.processDue(10);
  const after = await fx.deliveries.get(all[0]!.id);
  assert.equal(after?.delivery.status, "SUCCEEDED");
  assert.deepEqual(fx.log, ["one:ping"]);
});

test("outage → retryable failures → success: the accepted event survives", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "FormSubmitted",
    actions: [
      {
        instanceId: fx.instanceId,
        actionType: "ping",
        payloadMapping: { text: { $literal: "x" } },
      },
    ],
    failurePolicy: { maxAttempts: 3, backoffBaseMs: 1000 },
  });
  await fx.dispatcher.handleEvent(FORM_EVENT);

  // Connector is "down": two transient timeouts…
  fx.script.push(
    actionFailed({
      retryable: true,
      providerErrorCode: "TIMEOUT",
      errorMessage: "connect timeout",
    }),
  );
  fx.script.push(
    actionFailed({
      retryable: true,
      providerErrorCode: "TIMEOUT",
      errorMessage: "connect timeout",
    }),
  );
  await fx.dispatcher.processDue(10);
  fx.advance(1000);
  await fx.dispatcher.processDue(10);
  let all = await fx.deliveries.list();
  assert.equal(all[0]?.status, "FAILED_RETRYABLE");
  assert.equal(all[0]?.attemptCount, 2);
  let history = await fx.deliveries.get(all[0]!.id);
  assert.equal(history?.attempts.length, 2);

  // …then recovery. The business event was never lost.
  fx.script.push(actionSucceeded("tg-77"));
  fx.advance(2000);
  await fx.dispatcher.processDue(10);
  all = await fx.deliveries.list();
  assert.equal(all[0]?.status, "SUCCEEDED");
  history = await fx.deliveries.get(all[0]!.id);
  assert.equal(history?.attempts.length, 3);
  assert.equal(history?.delivery.externalId, "tg-77");
});

test("permanent failure dead-letters; manual retry succeeds; conditions filter", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "FormSubmitted",
    conditions: [
      { field: "form_definition_id", op: "eq", value: "contact" },
      { field: "score", op: "gte", value: 10 },
    ],
    actions: [
      {
        instanceId: fx.instanceId,
        actionType: "ping",
        payloadMapping: { text: { $literal: "x" } },
      },
    ],
  });
  // Score 5 → no delivery at all.
  await fx.dispatcher.handleEvent(FORM_EVENT);
  assert.equal((await fx.deliveries.list()).length, 0);
  // Score 12 → delivery; a 4xx dead-letters immediately (no retry loop).
  await fx.dispatcher.handleEvent({ ...FORM_EVENT, payload: { ...FORM_EVENT.payload, score: 12 } });
  fx.script.push(
    actionFailed({ retryable: false, providerErrorCode: "HTTP_404", errorMessage: "no such chat" }),
  );
  await fx.dispatcher.processDue(10);
  let all = await fx.deliveries.list({ status: "FAILED_PERMANENT" });
  assert.equal(all.length, 1);
  // Manual retry with a working transport → success, history complete.
  fx.script.push(actionSucceeded());
  fx.advance(1000);
  await fx.dispatcher.retryDelivery(all[0]!.id);
  all = await fx.deliveries.list();
  assert.equal(all[0]?.status, "SUCCEEDED");
  const history = await fx.deliveries.get(all[0]!.id);
  assert.equal(history?.attempts.length, 2);
});

test("$project mapping uses the injected projection source", async (t) => {
  const fx = await fixture(t, { projection: { fields: { contact_email: "a@b.c" } } });
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "FormSubmitted",
    actions: [
      {
        instanceId: fx.instanceId,
        actionType: "ping",
        payloadMapping: { text: { $project: "contact_email" } },
      },
    ],
  });
  await fx.dispatcher.handleEvent(FORM_EVENT);
  const all = await fx.deliveries.list();
  assert.deepEqual(all[0]?.payload, { text: "a@b.c" });
});

test("testInstance probes safely without persisting secrets", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  fx.script.push(actionSucceeded());
  const ok = await fx.dispatcher.testInstance(fx.instanceId);
  assert.deepEqual(ok, { ok: true });
  const missing = await fx.dispatcher
    .testInstance("00000000-0000-0000-0000-000000000000")
    .catch((error: Error & { code?: string }) => error.code);
  assert.equal(missing, "INTEGRATION_INSTANCE_NOT_FOUND");
});
