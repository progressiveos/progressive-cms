// Dispatcher execution projections (owner Progressive-HQ task): a connector
// action that declares `executionProjection` receives fresh domain fields on
// the action context at delivery time. The persisted delivery payload stays
// exactly what the binding mapping produced (PII-free); a vanished aggregate
// fails permanently, not forever-retryable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Clock, createDbPool, type DbPool } from "@pcms/core";
import {
  type ActionExecutionContext,
  actionFailed,
  actionSucceeded,
  type ConnectorDefinition,
  type ConnectorRuntime,
  createConnectorRegistry,
  createDeliveryService,
  createIntegrationBindingService,
  createIntegrationDispatcher,
  createIntegrationInstanceService,
} from "@pcms/integrations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const LEAD_PROJECTION = {
  name: "Иван Иванов",
  email: "ivan@example.ru",
  phone: "+7 900 000-00-00",
  summary: "Нужен ангар",
};

const hqConnector: ConnectorDefinition = {
  connectorType: "hq-stub",
  title: "HQ stub",
  description: "test",
  configSchema: { type: "object", properties: {}, additionalProperties: true },
  secrets: [],
  actions: [
    {
      actionType: "intake_lead",
      description: "",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: { lead_id: { type: "string" } },
        required: ["lead_id"],
      },
      executionProjection: {
        aggregate: "lead",
        idFromPayload: "lead_id",
        fields: ["name", "email", "phone", "summary"],
      },
    },
  ],
  testable: true,
};

test("execution projection rides the context, never the persisted payload", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  const { loadMigrations, migrateDatabase } = await import("@pcms/core");
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const clock: Clock = { now: () => new Date("2026-09-25T12:00:00.000Z") };
  const registry = createConnectorRegistry();
  registry.register(hqConnector);
  const instances = createIntegrationInstanceService({ pool, clock, registry });
  const instance = await instances.create({ connectorType: "hq-stub", name: "hq", config: {} });
  const bindings = createIntegrationBindingService({ pool, clock, instances, registry });
  const deliveries = createDeliveryService({ pool, clock });

  const seen: (ActionExecutionContext | undefined)[] = [];
  const runtime: ConnectorRuntime = {
    async execute(_actionType, _payload, ctx) {
      seen.push(ctx);
      return actionSucceeded("hq-id-1");
    },
    async test() {
      return actionSucceeded();
    },
  };
  const dispatcher = createIntegrationDispatcher({
    clock,
    registry,
    runtimes: { get: () => runtime } as never,
    bindings,
    instances,
    deliveries,
    secretResolver: () => undefined,
    projectionSource: {
      async project() {
        return null;
      },
      async projectExecution({ aggregate, id, fields }) {
        assert.equal(aggregate, "lead");
        assert.equal(id, "lead-1");
        return Object.fromEntries(
          Object.entries(LEAD_PROJECTION).filter(([key]) => fields.includes(key)),
        );
      },
    },
  });

  await bindings.create({
    eventType: "LeadCreated",
    actions: [
      {
        instanceId: instance.id,
        actionType: "intake_lead",
        // Routing-safe mapping only: NO PII in the mapping.
        payloadMapping: { lead_id: { $event: "lead_id" } },
      },
    ],
  });
  await dispatcher.handleEvent({
    id: "018f0000-0000-7000-8000-0000000000bb",
    aggregate: "lead",
    aggregateId: "lead-1",
    eventType: "LeadCreated",
    payload: { lead_id: "lead-1", source_type: "FORM_SUBMISSION" },
  });
  const all = await deliveries.list();
  assert.equal(all.length, 1);
  // The PERSISTED payload is only the mapped event fields — no contact data.
  assert.deepEqual(all[0]?.payload, { lead_id: "lead-1" });

  await dispatcher.processDue(10);
  const ctx = seen[0];
  assert.ok(ctx, "runtime executed");
  assert.deepEqual(ctx.projection, LEAD_PROJECTION, "PII reached the connector via context");
  assert.ok(!JSON.stringify(all[0]).includes("ivan@example.ru"));

  const after = await deliveries.get(all[0]!.id);
  assert.equal(after?.delivery.status, "SUCCEEDED");
  assert.equal(after?.delivery.externalId, "hq-id-1");
});

test("a vanished aggregate fails the delivery permanently", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  const { loadMigrations, migrateDatabase } = await import("@pcms/core");
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const clock: Clock = { now: () => new Date("2026-09-25T12:00:00.000Z") };
  const registry = createConnectorRegistry();
  registry.register(hqConnector);
  const instances = createIntegrationInstanceService({ pool, clock, registry });
  const instance = await instances.create({ connectorType: "hq-stub", name: "hq", config: {} });
  const bindings = createIntegrationBindingService({ pool, clock, instances, registry });
  const deliveries = createDeliveryService({ pool, clock });

  let executions = 0;
  const runtime: ConnectorRuntime = {
    async execute() {
      executions += 1;
      return actionSucceeded();
    },
    async test() {
      return actionSucceeded();
    },
  };
  const dispatcher = createIntegrationDispatcher({
    clock,
    registry,
    runtimes: { get: () => runtime } as never,
    bindings,
    instances,
    deliveries,
    secretResolver: () => undefined,
    projectionSource: {
      async project() {
        return null;
      },
      async projectExecution() {
        return null; // lead deleted before delivery
      },
    },
  });

  await bindings.create({
    eventType: "LeadCreated",
    actions: [
      {
        instanceId: instance.id,
        actionType: "intake_lead",
        payloadMapping: { lead_id: { $event: "lead_id" } },
      },
    ],
  });
  await dispatcher.handleEvent({
    id: "018f0000-0000-7000-8000-0000000000cc",
    aggregate: "lead",
    aggregateId: "lead-gone",
    eventType: "LeadCreated",
    payload: { lead_id: "lead-gone" },
  });
  await dispatcher.processDue(10);
  assert.equal(executions, 0, "the runtime must not run without its projection");
  const all = await deliveries.list();
  assert.equal(all[0]?.status, "FAILED_PERMANENT");
  assert.equal(all[0]?.lastErrorCode, "INTEGRATION_PROJECTION_UNAVAILABLE");
});
