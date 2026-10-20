// PCMS-INT-T014 — contract-side acceptance on the M13 branch: the M12
// interaction events arrive as contract fixtures (parallel milestone; no
// @pcms/forms import anywhere). Flow proven end to end:
//   fixture event → binding → logical deliveries → fake connector calls.
// Owner brief §30 acceptance set:
//   1. FormSubmitted → binding → Telegram/Talk fake deliveries;
//   2. QuizCompleted(outcome=hot) → condition → two actions → two
//      logical deliveries (cold outcome delivers nothing);
//   3. LeadCreated → mapping/binding.
// The M12+M13 convergence test (real persisted interaction → real outbox
// event → M13 delivery) is a separate post-merge task owned by the
// integration owner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  INTERACTION_AGGREGATES,
  INTERACTION_EVENT_TYPES,
} from "@pcms/integrations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const START = new Date("2026-09-20T12:00:00.000Z");

function readFixture(name: string): {
  readonly id: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
} {
  const raw = JSON.parse(readFileSync(`fixtures/integrations/${name}`, "utf8")) as {
    id: string;
    aggregate: string;
    aggregate_id: string;
    event_type: string;
    payload: unknown;
  };
  return {
    id: raw.id,
    aggregate: raw.aggregate,
    aggregateId: raw.aggregate_id,
    eventType: raw.event_type,
    payload: raw.payload,
  };
}

/** Every fixture: envelope matches the M07 outbox shape; payloads are PII-free. */
test("M12 event contract fixtures are well-formed and PII-free", () => {
  const names = [
    "form-submitted",
    "quiz-completed-hot",
    "quiz-completed-cold",
    "quiz-started",
    "quiz-abandoned",
    "lead-created",
    "lead-status-changed",
  ];
  const seen = new Set<string>();
  for (const name of names) {
    const event = readFixture(`${name}.json`);
    assert.ok(/^[0-9a-f-]{36}$/.test(event.id));
    assert.equal(event.aggregate, INTERACTION_AGGREGATES[event.eventType as never]);
    assert.ok(INTERACTION_EVENT_TYPES.includes(event.eventType as never));
    seen.add(event.id);
    // Routing-safe metadata only: no emails, no phone-looking strings, no
    // free-text fields that could carry PII. Stable ids (uuid-shaped) are
    // stripped before the scan — ids are opaque, not personal data.
    const withoutIds = JSON.stringify(event.payload).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "",
    );
    assert.ok(!withoutIds.includes("@"), `${name}: payload carries an email-like value`);
    assert.ok(
      !/(\+?\d[\d\s()-]{7,})/.test(withoutIds),
      `${name}: payload carries a phone-like value`,
    );
  }
  assert.equal(seen.size, names.length, "fixture event ids must be unique");
});

const telegramConnector: ConnectorDefinition = {
  connectorType: "telegram",
  title: "Telegram",
  description: "fake",
  configSchema: { type: "object", properties: {}, additionalProperties: true },
  secrets: [{ name: "bot_token", description: "" }],
  actions: [
    {
      actionType: "send_message",
      description: "",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" }, chat_id: { type: "string" } },
        required: ["text"],
      },
    },
  ],
  testable: true,
};

const talkConnector: ConnectorDefinition = {
  connectorType: "nextcloud-talk",
  title: "Talk",
  description: "fake",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: { base_url: { type: "string" }, room_token: { type: "string" } },
    required: ["base_url", "room_token"],
  },
  secrets: [],
  actions: [
    {
      actionType: "post_message",
      description: "",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ],
  testable: true,
};

interface Harness {
  pool: DbPool;
  clock: Clock;
  dispatcher: ReturnType<typeof createIntegrationDispatcher>;
  bindings: ReturnType<typeof createIntegrationBindingService>;
  deliveries: ReturnType<typeof createDeliveryService>;
  sent: string[];
  script: ActionResult[];
  advance(ms: number): void;
  telegramInstanceId: string;
  talkInstanceId: string;
}

async function harness(t: { after: (fn: () => void) => void }): Promise<Harness | null> {
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
  const registry = createConnectorRegistry();
  registry.register(telegramConnector);
  registry.register(talkConnector);
  const instances = createIntegrationInstanceService({ pool, clock, registry });
  const telegram = await instances.create({
    connectorType: "telegram",
    name: "sales-telegram",
    config: { default_chat_id: "-100200", parse_mode: "HTML" },
    secretRefs: { bot_token: "TELEGRAM_BOT_TOKEN" },
  });
  const talk = await instances.create({
    connectorType: "nextcloud-talk",
    name: "sales-talk",
    config: { base_url: "https://cloud.internal.example", room_token: "room1" },
  });
  const bindings = createIntegrationBindingService({ pool, clock, instances, registry });
  const deliveries = createDeliveryService({ pool, clock });
  const sent: string[] = [];
  const script: ActionResult[] = [];
  const scripted = (okText: string): ConnectorRuntime => ({
    async execute(actionType, payload) {
      sent.push(`${okText}:${actionType}:${JSON.stringify(payload)}`);
      return script.shift() ?? actionSucceeded(`${okText}-1`);
    },
    async test() {
      return actionSucceeded();
    },
  });
  const dispatcher = createIntegrationDispatcher({
    clock,
    registry,
    runtimes: {
      get: (connectorType: string) =>
        connectorType === "telegram" ? scripted("tg") : scripted("talk"),
    } as never,
    bindings,
    instances,
    deliveries,
    secretResolver: (name) => (name === "TELEGRAM_BOT_TOKEN" ? "123:ABC" : undefined),
  });
  return {
    pool,
    clock,
    dispatcher,
    bindings,
    deliveries,
    sent,
    script,
    advance: (ms: number) => {
      mutable.current = new Date(mutable.current.getTime() + ms);
    },
    telegramInstanceId: telegram.id,
    talkInstanceId: talk.id,
  };
}

test("FormSubmitted fixture → binding → Telegram + Talk deliveries", async (t) => {
  const fx = await harness(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "FormSubmitted",
    sourceFilter: INTERACTION_AGGREGATES.FormSubmitted,
    conditions: [{ field: "form_definition_id", op: "eq", value: "callback-request" }],
    actions: [
      {
        instanceId: fx.telegramInstanceId,
        actionType: "send_message",
        payloadMapping: {
          text: { $literal: "New callback request: submission " },
          chat_id: { $literal: "-100200" },
        },
      },
      {
        instanceId: fx.talkInstanceId,
        actionType: "post_message",
        payloadMapping: { message: { $event: "submission_id" } },
      },
    ],
  });
  await fx.dispatcher.handleEvent(readFixture("form-submitted.json"));
  await fx.dispatcher.processDue(10);
  const all = await fx.deliveries.list();
  assert.equal(all.length, 2, "one logical delivery per action");
  assert.equal(all[0]?.eventType, "FormSubmitted");
  assert.equal(fx.sent.length, 2);
  assert.ok(fx.sent[0]?.startsWith("tg:send_message:"));
  assert.ok(fx.sent[1]?.startsWith("talk:post_message:"));
  // Replay of the same outbox event (at-least-once) changes nothing.
  await fx.dispatcher.handleEvent(readFixture("form-submitted.json"));
  await fx.dispatcher.processDue(10);
  assert.equal((await fx.deliveries.list()).length, 2);
  assert.equal(fx.sent.length, 2);
});

test("QuizCompleted hot outcome fans out to two connectors; cold delivers nothing", async (t) => {
  const fx = await harness(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "QuizCompleted",
    sourceFilter: INTERACTION_AGGREGATES.QuizCompleted,
    conditions: [{ field: "outcome_id", op: "eq", value: "hot" }],
    actions: [
      {
        instanceId: fx.telegramInstanceId,
        actionType: "send_message",
        payloadMapping: { text: { $event: "outcome_id" }, chat_id: { $literal: "-100200" } },
      },
      {
        instanceId: fx.talkInstanceId,
        actionType: "post_message",
        payloadMapping: { message: { $event: "quiz_run_id" } },
      },
    ],
    failurePolicy: { maxAttempts: 3, backoffBaseMs: 1000 },
  });
  // Cold run: condition false → no delivery rows at all.
  await fx.dispatcher.handleEvent(readFixture("quiz-completed-cold.json"));
  assert.equal((await fx.deliveries.list()).length, 0);
  // Hot run: exactly two logical deliveries.
  await fx.dispatcher.handleEvent(readFixture("quiz-completed-hot.json"));
  await fx.dispatcher.processDue(10);
  const all = await fx.deliveries.list();
  assert.equal(all.length, 2);
  const telegramDelivery = all.find((delivery) => delivery.actionType === "send_message");
  const talkDelivery = all.find((delivery) => delivery.actionType === "post_message");
  assert.deepEqual(telegramDelivery?.payload, { text: "hot", chat_id: "-100200" });
  assert.deepEqual(talkDelivery?.payload, { message: "018f1000-0000-7000-8000-0000000000cc" });
  assert.equal(fx.sent.length, 2);
});

test("hot outcome outage path: transient failure retries under the same delivery", async (t) => {
  const fx = await harness(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "QuizCompleted",
    conditions: [{ field: "outcome_id", op: "eq", value: "hot" }],
    actions: [
      {
        instanceId: fx.telegramInstanceId,
        actionType: "send_message",
        payloadMapping: { text: { $event: "outcome_id" }, chat_id: { $literal: "-100200" } },
      },
    ],
    failurePolicy: { maxAttempts: 3, backoffBaseMs: 1000 },
  });
  await fx.dispatcher.handleEvent(readFixture("quiz-completed-hot.json"));
  // Telegram down (429), then recovery.
  fx.script.push(
    actionFailed({
      retryable: true,
      providerErrorCode: "TELEGRAM_429",
      errorMessage: "Too Many Requests",
    }),
  );
  await fx.dispatcher.processDue(10);
  let all = await fx.deliveries.list();
  assert.equal(all[0]?.status, "FAILED_RETRYABLE");
  assert.equal(all[0]?.attemptCount, 1);
  fx.advance(1000);
  await fx.dispatcher.processDue(10);
  all = await fx.deliveries.list();
  assert.equal(all[0]?.status, "SUCCEEDED");
  const history = await fx.deliveries.get(all[0]!.id);
  assert.equal(history?.attempts.length, 2, "both attempts recorded under ONE logical delivery");
});

test("LeadCreated fixture → mapping/binding to Talk", async (t) => {
  const fx = await harness(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "LeadCreated",
    conditions: [{ field: "classification", op: "in", value: ["b2b", "enterprise"] }],
    actions: [
      {
        instanceId: fx.talkInstanceId,
        actionType: "post_message",
        payloadMapping: {
          message: { $literal: "New B2B lead " },
        },
      },
    ],
  });
  await fx.dispatcher.handleEvent(readFixture("lead-created.json"));
  await fx.dispatcher.processDue(10);
  const all = await fx.deliveries.list();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0]?.payload, { message: "New B2B lead " });
});
