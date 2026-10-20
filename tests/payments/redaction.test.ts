// S7 acceptance: no credentials or sensitive payment data leak through the
// API surface — provider instance listings carry secret REFERENCES (names)
// only, refund intents carry no secrets, security-event metadata never
// includes credential values.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";

test("S7 redaction: provider instances and refunds never expose secret values", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const opsManifest = {
    id: "progressive.test-redact",
    name: "Test Redact",
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
          provider_id: "redact",
          title: "Redact",
          handler: "createRedactProvider",
        },
      ],
    },
    data_policy: "drop",
  } as unknown;
  const catalog = (await import("@pcms/extensions/internal")).createExtensionCatalog();
  catalog.register(
    (await import("@pcms/extensions/internal")).defineExtensionArtifact({
      manifest: opsManifest,
      module: {
        createRedactProvider: () => ({
          providerType: "redact",
          secretRequirements: ["api_secret"],
          configSchema: { type: "object", additionalProperties: true },
          capabilities: () => ({
            cancel: false,
            refund: true,
            providerIdempotency: true,
            statusSync: false,
          }),
          createPayment: async (input: { readonly idempotencyKey: string }) => ({
            externalId: `redact_${input.idempotencyKey}`,
          }),
          verifyCallback: () => {},
          parseCallback: () => ({
            providerEventId: null,
            externalPaymentId: null,
            idempotencyKey: null,
            outcome: "PENDING" as const,
          }),
        }),
      },
    }),
  );
  const fixture = await createApiFixture(t, {
    extensionCatalog: catalog,
    registerFakePaymentProvider: true,
    secrets: {
      require: () => "REDACT_HOST_SECRET",
      names: () => ["REDACT_HOST_SECRET"],
      get: (name: string) =>
        name === "REDACT_HOST_SECRET" ? "SUPER-SECRET-VALUE-NEVER-ECHO" : undefined,
    },
  });
  const api = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());

  await api.installExtension(fixture.app, ctx, { extension_id: "progressive.test-redact" });
  await api.enableExtension(fixture.app, ctx, { extension_id: "progressive.test-redact" });

  const created = await api.createProviderInstance(fixture.app, ctx, {
    provider_type: "redact",
    name: "redact-main",
    config: { mode: "live" },
    secret_refs: { api_secret: "REDACT_HOST_SECRET" },
  });
  const instanceId = created.instance.id;

  // 1. Listing/config carries the REFERENCE name, never the value.
  const listed = await api.listPaymentProviderInstances(fixture.app, ctx);
  const body = JSON.stringify(listed);
  assert.ok(body.includes("REDACT_HOST_SECRET"), "the reference name is visible");
  assert.ok(!body.includes("SUPER-SECRET-VALUE-NEVER-ECHO"), "the secret value must never appear");

  // 2. Refund intents never carry secrets.
  await fixture.app.payments.ensureComposed();
  const { payment } = await fixture.app.payments.service.create(
    {
      provider_instance_id: instanceId,
      subject_type: "lead",
      subject_id: "lead-redact",
      amount: 50,
      currency: "USD",
      idempotency_key: "order-redact-01",
    },
    { type: "OPERATOR", id: "op" },
  );
  // Drive the payment to SUCCEEDED (fake provider signed callback) so the
  // refund path is legal, then record the intent.
  const signedBody = JSON.stringify({
    event_id: "evt-redact",
    external_payment_id: payment.externalPaymentId,
    outcome: "SUCCEEDED",
  });
  const { createHmac } = await import("node:crypto");
  void createHmac; // fake provider's secret lives in the fixture registry
  await fixture.app.payments.service.processCallback({
    providerInstanceId: instanceId,
    parsed: {
      providerEventId: "evt-redact",
      externalPaymentId: payment.externalPaymentId,
      idempotencyKey: null,
      outcome: "SUCCEEDED",
    },
  });
  const { intentId } = await fixture.app.payments.service.refund(
    payment.id,
    { amount: 10, reason: "redaction probe" },
    { type: "OPERATOR", id: "op" },
  );
  const intents = JSON.stringify(await fixture.app.payments.service.listRefundIntents(payment.id));
  assert.ok(!intents.includes("SUPER-SECRET-VALUE-NEVER-ECHO"));

  // 3. Security-event metadata: audit carries ids/amounts, not secrets.
  const audit = JSON.stringify(
    await (await import("@pcms/auth")).listSecurityEvents(fixture.app.pool, {
      event_type: "PAYMENT_PROVIDER_INSTANCE_CREATED",
    }),
  );
  assert.ok(!audit.includes("SUPER-SECRET-VALUE-NEVER-ECHO"));
  void intentId;
});
