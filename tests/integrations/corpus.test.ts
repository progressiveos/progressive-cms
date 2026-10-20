// PCMS-INT-T018 — full reliability/security/reference corpus (owner
// brief §35). This file proves the COMPOSITION SEAMS end to end:
//   1. the real M07 outbox (writeOutboxEvent → OutboxService → consumer
//      dispatch table → M13 dispatcher) — the exact worker wiring;
//   2. email delivery through a binding with the injected mail transport;
//   3. generic webhook success and SSRF refusal through the dispatcher;
//   4. payment status sync (getPayment) reaching SUCCEEDED.
// Individual invariants (retry/backoff/dead-letter, duplicate inbound,
// refund privilege, SSRF bypass families) live in their task suites.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Clock, createDbPool, type DbPool, fixedClock, systemClock } from "@pcms/core";
import {
  type ActionResult,
  type ConnectorRuntime,
  createConnectorRegistry,
  createDeliveryService,
  createEmailConnectorRuntime,
  createIntegrationBindingService,
  createIntegrationDispatcher,
  createIntegrationInstanceService,
  createTalkConnectorRuntime,
  createTelegramConnectorRuntime,
  createWebhookConnectorRuntime,
  emailConnectorDefinition,
  type MailTransport,
  talkConnectorDefinition,
  telegramConnectorDefinition,
  webhookConnectorDefinition,
} from "@pcms/integrations";
import { createOutboxConsumer, createOutboxService, writeOutboxEvent } from "@pcms/publication";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const START = new Date("2026-09-20T12:00:00.000Z");

interface CorpusFixture {
  pool: DbPool;
  clock: Clock;
  dispatcher: ReturnType<typeof createIntegrationDispatcher>;
  bindings: ReturnType<typeof createIntegrationBindingService>;
  deliveries: ReturnType<typeof createDeliveryService>;
  sent: string[];
  script: ActionResult[];
  advance(ms: number): void;
  mail: MailTransport;
  mailOut: { to: string; subject?: string; text?: string }[];
  webhookInstanceId: string;
  emailInstanceId: string;
}

async function corpusFixture(t: {
  after: (fn: () => void) => void;
}): Promise<CorpusFixture | null> {
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
  for (const definition of [
    emailConnectorDefinition,
    telegramConnectorDefinition,
    talkConnectorDefinition,
    webhookConnectorDefinition,
  ]) {
    registry.register(definition);
  }
  const instances = createIntegrationInstanceService({ pool, clock, registry });
  const emailInstance = await instances.create({
    connectorType: "email",
    name: "office-email",
    config: { from: "cms@example.com" },
    secretRefs: { transport: "MAIL_KEY" },
  });
  const webhookInstance = await instances.create({
    connectorType: "webhook-http",
    name: "crm-webhook",
    config: { url: "https://crm.internal.example/hook", method: "POST" },
  });
  const bindings = createIntegrationBindingService({ pool, clock, instances, registry });
  const deliveries = createDeliveryService({ pool, clock });
  const mailOut: { to: string; subject?: string; text?: string }[] = [];
  const mail: MailTransport = {
    async send(message) {
      mailOut.push({
        to: message.to,
        ...(message.subject === undefined ? {} : { subject: message.subject }),
        ...(message.text === undefined ? {} : { text: message.text }),
      });
      return { messageId: `mail-${mailOut.length + 1}` };
    },
  };
  const sent: string[] = [];
  const script: ActionResult[] = [];
  const runtimes = {
    get: (connectorType: string): ConnectorRuntime | undefined => {
      if (connectorType === "email") return createEmailConnectorRuntime(mail);
      const scripted: ConnectorRuntime = {
        async execute(actionType, payload) {
          sent.push(`${connectorType}:${actionType}:${JSON.stringify(payload)}`);
          return script.shift() ?? { ok: true, retryable: false, externalId: `${connectorType}-1` };
        },
        async test() {
          return { ok: true, retryable: false };
        },
      };
      if (connectorType === "telegram")
        return createTelegramConnectorRuntime(async () => ({ status: 200, body: '{"ok":true}' }));
      if (connectorType === "nextcloud-talk")
        return createTalkConnectorRuntime(async () => ({
          status: 200,
          body: '{"ocs":{"meta":{"statuscode":200}}}',
        }));
      return undefined;
    },
  };
  // The webhook runtime rides the REAL guarded HTTP client with a scriptable
  // DNS resolver — production wiring, deterministic tests.
  const { createGuardedHttp } = await import("@pcms/integrations");
  const guardedHttp = createGuardedHttp({
    resolve: async (hostname) =>
      hostname === "crm.internal.example"
        ? [{ address: "10.0.0.44", family: 4 }] // private on purpose: SSRF corpus case
        : [{ address: "93.184.216.34", family: 4 }],
    // 127.0.0.1 is allowlisted so the success case can hit a real local
    // test server — nothing leaves the machine.
    allowedHosts: ["127.0.0.1"],
  });
  runtimes.get = (connectorType: string): ConnectorRuntime | undefined => {
    if (connectorType === "email") return createEmailConnectorRuntime(mail);
    if (connectorType === "webhook-http")
      return createWebhookConnectorRuntime(guardedHttp, guardedHttp.guard);
    const scripted: ConnectorRuntime = {
      async execute(actionType, payload) {
        sent.push(`${connectorType}:${actionType}:${JSON.stringify(payload)}`);
        return script.shift() ?? { ok: true, retryable: false, externalId: `${connectorType}-1` };
      },
      async test() {
        return { ok: true, retryable: false };
      },
    };
    if (connectorType === "telegram")
      return createTelegramConnectorRuntime(async () => ({
        status: 200,
        body: '{"ok":true,"result":{"message_id":7}}',
      }));
    if (connectorType === "nextcloud-talk")
      return createTalkConnectorRuntime(async () => ({
        status: 200,
        body: '{"ocs":{"meta":{"statuscode":200}}}',
      }));
    return undefined;
  };
  const dispatcher = createIntegrationDispatcher({
    clock,
    registry,
    runtimes: runtimes as never,
    bindings,
    instances,
    deliveries,
    secretResolver: (name) => (name === "MAIL_KEY" ? "mail-secret" : undefined),
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
    mail,
    mailOut,
    webhookInstanceId: webhookInstance.id,
    emailInstanceId: emailInstance.id,
  };
}

test("real M07 outbox seam: writeOutboxEvent → consumer → dispatcher → delivery", async (t) => {
  const fx = await corpusFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await fx.bindings.create({
    eventType: "FormSubmitted",
    actions: [
      {
        instanceId: fx.emailInstanceId,
        actionType: "send_message",
        payloadMapping: {
          to: { $literal: "sales@example.com" },
          subject: { $literal: "Новая заявка" },
          text: { $event: "submission_id" },
        },
      },
    ],
  });
  // Producer side: exactly what M12 Forms will write inside its transaction
  // (same M07 envelope the publication subsystem uses).
  await writeOutboxEvent(fx.pool, {
    aggregate: "form_submission",
    aggregateId: "sub-corpus-1",
    eventType: "FormSubmitted",
    payload: { submission_id: "sub-corpus-1", form_definition_id: "callback" },
  });
  // Consumer side: exactly what apps/worker wires for M13. The outbox
  // service runs on the real clock (available_at defaults to DB now()).
  const outbox = createOutboxService(fx.pool, { clock: systemClock });
  const consumer = createOutboxConsumer(
    outbox,
    {
      FormSubmitted: (event) =>
        fx.dispatcher.handleEvent({
          id: event.id,
          aggregate: event.aggregate,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          payload: event.payload,
        }),
    },
    { fallback: async () => {} },
  );
  await consumer.processBatch(10);
  await fx.dispatcher.processDue(10);
  const all = await fx.deliveries.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.status, "SUCCEEDED");
  assert.equal(fx.mailOut.length, 1);
  assert.equal(fx.mailOut[0]?.to, "sales@example.com");
  assert.equal(fx.mailOut[0]?.text, "sub-corpus-1");
  // The outbox event itself is DONE: an external outage cannot resurrect it,
  // the delivery history lives in its own tables.
  const stats = await outbox.stats();
  assert.equal(stats.done, 1);
});

test("generic webhook through the dispatcher: allowed host succeeds, private host is SSRF-refused", async (t) => {
  const fx = await corpusFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Real local receiver for the success leg (allowlisted loopback host).
  const { createServer } = await import("node:http");
  const receiver = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"accepted":true}');
  });
  await new Promise<void>((resolveServer) => receiver.listen(0, "127.0.0.1", resolveServer));
  t.after(() => receiver.close());
  const port = (receiver.address() as { port: number }).port;
  await fx.pool.query(`UPDATE integration_instance SET config = $2 WHERE id = $1`, [
    fx.webhookInstanceId,
    JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, method: "POST" }),
  ]);
  await fx.bindings.create({
    eventType: "LeadStatusChanged",
    actions: [
      {
        instanceId: fx.webhookInstanceId,
        actionType: "request",
        payloadMapping: { lead_id: { $event: "lead_id" }, status: { $event: "status" } },
      },
    ],
  });
  await fx.dispatcher.handleEvent({
    id: "018f1000-0000-7000-8000-000000000101",
    aggregate: "lead",
    aggregateId: "lead-1",
    eventType: "LeadStatusChanged",
    payload: { lead_id: "lead-1", previous_status: "NEW", status: "QUALIFIED" },
  });
  await fx.dispatcher.processDue(10);
  let all = await fx.deliveries.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.status, "SUCCEEDED", "allowlisted internal host delivers");

  // SSRF: repoint the SAME instance at a private-range URL (no allowlist).
  await fx.pool.query(`UPDATE integration_instance SET config = $2 WHERE id = $1`, [
    fx.webhookInstanceId,
    JSON.stringify({ url: "https://crm.internal.example/hook", method: "POST" }),
  ]);
  await fx.dispatcher.handleEvent({
    id: "018f1000-0000-7000-8000-000000000102",
    aggregate: "lead",
    aggregateId: "lead-2",
    eventType: "LeadStatusChanged",
    payload: { lead_id: "lead-2", previous_status: "NEW", status: "QUALIFIED" },
  });
  await fx.dispatcher.processDue(10);
  all = await fx.deliveries.list({ status: "FAILED_PERMANENT" });
  assert.equal(all.length, 1, "private-range target refused");
  const history = await fx.deliveries.get(all[0]!.id);
  assert.equal(history?.delivery.lastErrorCode, "INTEGRATION_URL_BLOCKED");
});

test("payment status sync reaches SUCCEEDED via provider getPayment", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const {
    FakePaymentProvider,
    PaymentProviderRegistry,
    createPaymentProviderInstanceService,
    createPaymentService,
  } = await import("@pcms/payments");
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  const { loadMigrations, migrateDatabase } = await import("@pcms/core");
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const provider = new FakePaymentProvider();
  const registry = new PaymentProviderRegistry();
  registry.register(provider);
  const instances = createPaymentProviderInstanceService({
    pool,
    clock: fixedClock(START),
    configSchemaFor: (providerType) => registry.get(providerType)?.configSchema,
  });
  const instance = await instances.create({
    providerType: "fake",
    name: "fake-sync",
    config: {},
    secretRefs: { signing: "FAKE_SIGNING_SECRET" },
  });
  const payments = createPaymentService({
    pool,
    clock: fixedClock(START),
    providers: registry,
    instances,
    secretResolver: (name) => (name === "FAKE_SIGNING_SECRET" ? "s" : undefined),
  });
  const { payment } = await payments.create({
    provider_instance_id: instance.id,
    subject_type: "quiz_run",
    subject_id: "qr-sync-1",
    amount: 250,
    currency: "RUB",
    idempotency_key: "quiz-sync-000001",
  });
  assert.equal(payment.status, "PENDING");
  // Provider settles asynchronously (user paid at the provider UI)…
  provider.settle(payment.externalPaymentId ?? "", "SUCCEEDED");
  // …and the CMS learns about it through status sync.
  const synced = await payments.sync(payment.id, { type: "SYSTEM", id: "worker" });
  assert.equal(synced.status, "SUCCEEDED");
  const events = await payments.listEvents(payment.id);
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["CREATED", "PROVIDER_PENDING", "SUCCEEDED"],
  );
});
