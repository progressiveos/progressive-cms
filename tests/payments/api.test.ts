// PCMS-PAY-T008 — payment API operations: scopes enforced (read/create/
// cancel/refund/events separated), refund audited, callback receiver
// verifies + dedupes before touching state, capabilities surfaced.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApiError,
  type ApplicationServices,
  cancelPayment,
  createPayment,
  getPayment,
  getPaymentProviderCapabilities,
  listPaymentEvents,
  listPaymentProviders,
  refundPayment,
} from "@pcms/api";
import { listSecurityEvents, PERMISSION_REGISTRY } from "@pcms/auth";
import { createExtensionCatalog, defineExtensionArtifact } from "@pcms/extensions/internal";
import { FakePaymentProvider, type PaymentProvider } from "@pcms/payments";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";

const TEST_SECRETS = {
  get: (name: string) => (name === "FAKE_SIGNING_SECRET" ? "signing-secret" : undefined),
  require: (name: string) => {
    const value = name === "FAKE_SIGNING_SECRET" ? "signing-secret" : undefined;
    if (value === undefined) throw new Error(`secret ${name} missing`);
    return value;
  },
  names: () => ["FAKE_SIGNING_SECRET"],
};

function extPaymentModule(providerType: string): Record<string, unknown> {
  return {
    createTestPaymentProvider: () =>
      Object.assign(new FakePaymentProvider(), { providerType }) as PaymentProvider,
  };
}

async function paymentsAppFixtureWithExtensions(t: { after: (fn: () => void) => void }) {
  if (!process.env.PCMS_TEST_DATABASE_URL) return null;
  const catalog = createExtensionCatalog();
  for (const [id, slug, providerType] of [
    ["progressive-payments.test-a", "test-a", "extpay-a"],
    ["progressive-payments.test-b", "test-b", "extpay-b"],
  ] as const) {
    catalog.register(
      defineExtensionArtifact({
        manifest: {
          id,
          name: `Payments ${slug}`,
          version: "1.0.0",
          extension_contract: "2.0",
          cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
          entrypoint: { type: "module" },
          permissions: [],
          requires: [],
          provides: [],
          registrations: {
            providers: [
              {
                registry: "payment_provider",
                provider_id: slug,
                title: slug,
                handler: "createTestPaymentProvider",
              },
            ],
          },
          data_policy: "retain",
        },
        module: extPaymentModule(providerType),
      }),
    );
  }
  const fixture = await createApiFixture(t, {
    registerFakePaymentProvider: true,
    secrets: TEST_SECRETS,
    extensionCatalog: catalog,
  });
  return { app: fixture.app, ownerCtx: apiContextOf(ownerActor()) };
}

async function paymentsAppFixture(t: { after: (fn: () => void) => void }) {
  if (!process.env.PCMS_TEST_DATABASE_URL) return null;
  const fixture = await createApiFixture(t, {
    registerFakePaymentProvider: true,
    secrets: TEST_SECRETS,
  });
  const { app } = fixture;
  // Boot composition is async (S5/R3): settle it before the fixture's
  // provider-instance setup touches the registry.
  await app.payments.ensureComposed();
  const ownerCtx = apiContextOf(ownerActor());
  const instance = await app.payments.instances.create({
    providerType: "fake",
    name: "fake-main",
    config: {},
    secretRefs: { signing: "FAKE_SIGNING_SECRET" },
  });
  // Composition-level secret resolver comes from input.secrets — tests inject
  // one through createApiFixture? Not wired there, so resolve via app config:
  // the fake provider only needs the signing secret for CALLBACK verification,
  // not for create. Keep instance.secretRefs naming FAKE_SIGNING_SECRET.
  return {
    app,
    ownerCtx,
    instanceId: instance.id,
    provider: app.payments.registry.get("fake") as FakePaymentProvider,
  };
}

test("S5/R3: payment providers compose from trusted extension packages; disable revokes immediately", async (t) => {
  const fx = await paymentsAppFixtureWithExtensions(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, ownerCtx } = fx;
  const api = await import("@pcms/api");

  await api.installExtension(app, ownerCtx, { extension_id: "progressive-payments.test-a" });
  await api.enableExtension(app, ownerCtx, { extension_id: "progressive-payments.test-a" });
  // Composition is revision-gated: every op entry recomposes on change.
  const enabled = await listPaymentProviders(app, ownerCtx);
  assert.deepEqual(enabled.items.map((p) => p.provider_type).sort(), ["extpay-a", "fake"]);

  // Disable (R3): the next operation entry recomposes — the provider type
  // reports PAYMENT_PROVIDER_UNKNOWN, the fake (injected) stays.
  await api.disableExtension(app, ownerCtx, { extension_id: "progressive-payments.test-a" });
  const disabled = await listPaymentProviders(app, ownerCtx);
  assert.deepEqual(disabled.items.map((p) => p.provider_type).sort(), ["fake"]);
  await assert.rejects(
    () => getPaymentProviderCapabilities(app, ownerCtx, { provider_type: "extpay-a" }),
    (error: unknown) => (error as { code?: string }).code === "PAYMENT_PROVIDER_UNKNOWN",
  );

  // Enabling the other package swaps the composition (same registry object).
  await api.installExtension(app, ownerCtx, { extension_id: "progressive-payments.test-b" });
  await api.enableExtension(app, ownerCtx, { extension_id: "progressive-payments.test-b" });
  const swapped = await listPaymentProviders(app, ownerCtx);
  assert.deepEqual(swapped.items.map((p) => p.provider_type).sort(), ["extpay-b", "fake"]);
});

test("payment ops: provider catalog + capabilities + create/get round trip", async (t) => {
  const fx = await paymentsAppFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, ownerCtx } = fx;
  const catalog = await listPaymentProviders(app, ownerCtx);
  // S5 (ADR-0017): core ships NO vendor adapters — the catalog holds only
  // composition-injected providers (the sandbox fake here). Concrete
  // providers arrive as trusted extension packages (covered by the
  // extension-composed catalog test below).
  assert.deepEqual(catalog.items.map((provider) => provider.provider_type).sort(), ["fake"]);
  const capabilities = await getPaymentProviderCapabilities(app, ownerCtx, {
    provider_type: "fake",
  });
  assert.equal(capabilities.capabilities.refund, true);

  const created = await createPayment(app, ownerCtx, {
    provider_instance_id: fx.instanceId,
    subject_type: "lead",
    subject_id: "lead-1",
    amount: 5000,
    currency: "RUB",
    idempotency_key: "lead-pay-000001",
  });
  assert.ok(created?.status === "PENDING");
  const fetched = await getPayment(app, ownerCtx, { payment_id: created.id });
  assert.equal(fetched?.id, created.id);
});

test("payment scopes: read-only actor cannot create; content agent cannot read", async (t) => {
  const fx = await paymentsAppFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = fx;
  const reader = apiContextOf(scopedActor(["payments.read"], "pay-reader"));
  await assert.rejects(
    createPayment(app, reader, {
      provider_instance_id: fx.instanceId,
      subject_type: "lead",
      subject_id: "l1",
      amount: 10,
      currency: "EUR",
      idempotency_key: "denied-key-1",
    }),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
  const contentAgent = apiContextOf(
    scopedActor(
      PERMISSION_REGISTRY.filter((definition) => definition.key.startsWith("content.")).map(
        (definition) => definition.key,
      ),
      "content-agent-2",
    ),
  );
  await assert.rejects(
    listPaymentProviders(app, contentAgent),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
  await assert.rejects(
    cancelPayment(app, reader, { payment_id: "00000000-0000-0000-0000-000000000000" }),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
});

test("refund requires payments.refund; events require payments.events.read; refund audited", async (t) => {
  const fx = await paymentsAppFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, ownerCtx, instanceId, provider } = fx;
  const created = await createPayment(app, ownerCtx, {
    provider_instance_id: instanceId,
    subject_type: "quiz_run",
    subject_id: "qr-1",
    amount: 700,
    currency: "RUB",
    idempotency_key: "quiz-pay-000001",
  });
  assert.ok(created?.external_payment_id, "payment carries an external id");
  // Settle via a SIGNED provider callback through the composition pipeline.
  const signed = (provider as FakePaymentProvider).signedCallbackBody(
    {
      event_id: "evt-cb-1",
      external_payment_id: created.external_payment_id,
      outcome: "SUCCEEDED",
    },
    "signing-secret",
  );
  const callbackResult = await receiveCallbackForTest(
    app,
    instanceId,
    signed.headers,
    signed.rawBody,
  );
  assert.deepEqual(callbackResult, {
    received: true,
    duplicate: false,
    applied: true,
    event_id: callbackResult.event_id,
  });

  // Refund permission: an events-only reader is denied.
  const eventsReader = apiContextOf(
    scopedActor(["payments.read", "payments.events.read"], "events-reader"),
  );
  await assert.rejects(
    refundPayment(app, eventsReader, { payment_id: created.id, amount: 100 }),
    (error: ApiError) => error.code === "AUTH_PERMISSION_DENIED",
  );
  // S7: the owner refund returns a DURABLE INTENT (recorded, not executed);
  // the worker executor applies it. Refund is audited at request time.
  const refundResult = await refundPayment(app, ownerCtx, {
    payment_id: created!.id,
    reason: "pilot refund",
  });
  assert.ok(typeof refundResult?.refund_intent_id === "string");
  const intentId = refundResult.refund_intent_id;
  // Worker-side execution (same call the payments.refund.execute job makes):
  await app.payments.service.executeRefundIntent(intentId);
  const refunded = await getPayment(app, ownerCtx, { payment_id: created!.id });
  assert.equal(refunded?.status, "REFUNDED");
  const audit = await listSecurityEvents(app.pool, { event_type: "PAYMENT_REFUND" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.subject_id, created!.id);
  // Timeline readable with payments.events.read.
  const events = await listPaymentEvents(app, eventsReader, { payment_id: created!.id });
  assert.deepEqual(
    events.items.map((event) => event.event_type),
    ["CREATED", "PROVIDER_PENDING", "SUCCEEDED", "REFUND_REQUESTED", "REFUNDED"],
  );
});

test("duplicate signed callback is acknowledged without re-applying state", async (t) => {
  const fx = await paymentsAppFixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, ownerCtx, instanceId, provider } = fx;
  const created = await createPayment(app, ownerCtx, {
    provider_instance_id: instanceId,
    subject_type: "order",
    subject_id: "ord-9",
    amount: 300,
    currency: "RUB",
    idempotency_key: "order-pay-000009",
  });
  const signed = (provider as FakePaymentProvider).signedCallbackBody(
    {
      event_id: "evt-dup-1",
      external_payment_id: created!.external_payment_id as string,
      outcome: "SUCCEEDED",
    },
    "signing-secret",
  );
  const first = await receiveCallbackForTest(app, instanceId, signed.headers, signed.rawBody);
  assert.equal(first.applied, true);
  const second = await receiveCallbackForTest(app, instanceId, signed.headers, signed.rawBody);
  assert.equal(second.duplicate, true);
  const timeline = await listPaymentEvents(app, ownerCtx, { payment_id: created!.id });
  assert.equal(timeline.items.filter((event) => event.event_type === "SUCCEEDED").length, 1);

  // A forged callback signature never reaches state and leaves no event.
  await assert.rejects(
    receiveCallbackForTest(
      app,
      instanceId,
      { ...signed.headers, "x-fake-signature": "forged" },
      JSON.stringify({
        event_id: "evt-forge",
        external_payment_id: created?.external_payment_id,
        outcome: "FAILED",
      }),
    ),
    (error: Error & { code?: string }) => error.code === "INTEGRATION_INBOUND_INVALID",
  );
  const still = await getPayment(app, ownerCtx, { payment_id: created!.id });
  assert.equal(still?.status, "SUCCEEDED");
});

/** Mirrors the HTTP callback route handler (transport-thin composition). */
async function receiveCallbackForTest(
  app: ApplicationServices,
  providerInstanceId: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<{ received: boolean; duplicate: boolean; applied: boolean; event_id: string }> {
  const outcome = await app.integrations.inbound.receive({
    sourceType: "payment_provider",
    sourceId: providerInstanceId,
    contractKey: `payment_provider:fake`,
    headers,
    rawBody,
  });
  if (outcome.duplicate) {
    return { received: true, duplicate: true, applied: false, event_id: outcome.record.id };
  }
  if (outcome.record.status === "FAILED" || outcome.normalized === null) {
    return { received: true, duplicate: false, applied: false, event_id: outcome.record.id };
  }
  const parsed = outcome.normalized as Parameters<
    ApplicationServices["payments"]["service"]["processCallback"]
  >[0]["parsed"];
  const applied = await app.payments.service.processCallback({
    providerInstanceId,
    parsed,
    inboundEventId: outcome.record.id,
  });
  await app.integrations.inbound.markProcessed(outcome.record.id);
  return {
    received: true,
    duplicate: false,
    applied: applied.applied,
    event_id: outcome.record.id,
  };
}
