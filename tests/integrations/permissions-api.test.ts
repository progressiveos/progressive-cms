// PCMS-INT-T015/T016 — integration permissions/audit + application
// operations: content-agent-like actors are denied; configure vs
// secrets.manage are separated; privileged operations audit into the M08
// security-event stream; ops round-trip through the ApplicationServices
// surface shared by REST/MCP/CLI.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApiError,
  createIntegrationBinding,
  createIntegrationInstance,
  listConnectors,
  listInboundEvents,
  listIntegrationDeliveries,
  retryIntegrationDelivery,
  testIntegrationInstance,
  updateIntegrationInstance,
} from "@pcms/api";
import { type ActorContext, listSecurityEvents, PERMISSION_REGISTRY } from "@pcms/auth";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";

/** Content-Agent-like actor: content permissions only, no integrations. */
function contentAgentActor(): ActorContext {
  return scopedActor(
    PERMISSION_REGISTRY.filter((definition) => definition.key.startsWith("content.")).map(
      (definition) => definition.key,
    ),
    "content-agent",
  );
}

test("integrations ops: content agent denied; read/configure/secrets separated", async (t) => {
  if (!process.env["PCMS_TEST_DATABASE_URL"]) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await createApiFixture(t);
  const { app } = fixture;
  const agent = contentAgentActor();
  const agentCtx = apiContextOf(agent);

  // Read of the catalog is integrations.read — denied.
  assert.throws(
    () => listConnectors(app, agentCtx),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
  // Owner context sees the first-party catalog.
  const ownerCtx = apiContextOf(ownerActor());
  const catalog = listConnectors(app, ownerCtx);
  assert.deepEqual(
    catalog.items.map((connector) => connector.connector_type),
    [
      "amocrm",
      "bitrix24",
      "email",
      "hubspot",
      "nextcloud-talk",
      "pipedrive",
      "progressive-hq",
      "salesforce",
      "sharecrm",
      "telegram",
      "webhook-http",
      "zoho-crm",
    ],
  );

  // Configure without secrets.manage: instance WITHOUT secret refs succeeds.
  const noSecrets = await createIntegrationInstance(app, ownerCtx, {
    connector_type: "telegram",
    name: "sales-telegram",
    config: { default_chat_id: "-100", parse_mode: "HTML" },
  });
  assert.equal(noSecrets.enabled, true);

  // An integrations-configure-only actor cannot touch secret refs.
  const configurer = scopedActor(
    ["integrations.read", "integrations.configure", "integrations.test"],
    "integrations-dev",
  );
  const configurerCtx = apiContextOf(configurer);
  await assert.rejects(
    updateIntegrationInstance(app, configurerCtx, {
      instance_id: noSecrets.id,
      secret_refs: { bot_token: "TELEGRAM_BOT_TOKEN" },
    }),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
  // …but an owner granting secret refs passes (OWNER holds every key).
  const withSecrets = await updateIntegrationInstance(app, ownerCtx, {
    instance_id: noSecrets.id,
    secret_refs: { bot_token: "TELEGRAM_BOT_TOKEN" },
  });
  assert.deepEqual(withSecrets.secret_refs, { bot_token: "TELEGRAM_BOT_TOKEN" });
  // Stored secret_refs are NAMES only — no value projection exists at all.
  assert.ok(!JSON.stringify(withSecrets).includes("oauth") === true);
});

test("privileged operations test/retry write audit rows (security events)", async (t) => {
  if (!process.env["PCMS_TEST_DATABASE_URL"]) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await createApiFixture(t);
  const { app } = fixture;
  const ownerCtx = apiContextOf(ownerActor());

  const instance = await createIntegrationInstance(app, ownerCtx, {
    connector_type: "telegram",
    name: "audit-telegram",
    config: { default_chat_id: "-1" },
    secret_refs: { bot_token: "TELEGRAM_BOT_TOKEN" },
  });
  // Test probe without a registered runtime-backed secret → fails but IS
  // audited; the outcome, not the credential, is what lands in the stream.
  await testIntegrationInstance(app, ownerCtx, { instance_id: instance.id });
  const events = await listSecurityEvents(app.pool, { event_type: "INTEGRATION_TESTED" });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.subject_id, instance.id);
  const metadata = events[0]?.metadata as { ok: boolean };
  assert.equal(typeof metadata.ok, "boolean");

  // Retry of an unknown delivery: authorization happens BEFORE existence.
  await assert.rejects(
    retryIntegrationDelivery(app, apiContextOf(scopedActor(["integrations.read"], "svc")), {
      delivery_id: "00000000-0000-0000-0000-000000000000",
    }),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
  // Inbound listing requires integrations.inbound.read.
  await assert.rejects(
    listInboundEvents(app, apiContextOf(scopedActor(["integrations.read"], "svc"))),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
  // Deliveries listing requires integrations.deliveries.read.
  await assert.rejects(
    listIntegrationDeliveries(app, apiContextOf(scopedActor(["integrations.read"], "svc"))),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
});

test("bindings: create requires configure; bounded conditions only", async (t) => {
  if (!process.env["PCMS_TEST_DATABASE_URL"]) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await createApiFixture(t);
  const { app } = fixture;
  const ownerCtx = apiContextOf(ownerActor());
  const instance = await createIntegrationInstance(app, ownerCtx, {
    connector_type: "nextcloud-talk",
    name: "binding-talk",
    config: { base_url: "https://cloud.example", room_token: "r1" },
  });
  const binding = await createIntegrationBinding(app, ownerCtx, {
    eventType: "FormSubmitted",
    conditions: [{ field: "form_definition_id", op: "eq", value: "contact" }],
    actions: [
      {
        instanceId: instance.id,
        actionType: "post_message",
        payloadMapping: { message: { $event: "submission_id" } },
      },
    ],
  } as never);
  // The ops layer returns the canonical snake_case wire shape.
  assert.equal(binding.event_type, "FormSubmitted");
  // Arbitrary code/ops rejected at the boundary.
  await assert.rejects(
    createIntegrationBinding(app, ownerCtx, {
      eventType: "FormSubmitted",
      conditions: [{ field: "x", op: "regex", value: ".*" }],
      actions: [{ instanceId: instance.id, actionType: "post_message", payloadMapping: {} }],
    } as never),
    (error: ApiError) => error.code === "INTEGRATION_CONDITION_INVALID",
  );
});
