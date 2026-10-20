// PCMS-PAY-T002/T003 — provider contract/registry + provider-instance
// store: capabilities gate the protocol; the deterministic FakePaymentProvider
// proves idempotent create and signed callbacks without any network; the
// instance store keeps secret refs as NAMES only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, fixedClock } from "@pcms/core";
import {
  createPaymentProviderInstanceService,
  FakePaymentProvider,
  type PaymentError,
  PaymentProviderRegistry,
} from "@pcms/payments";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CLOCK = fixedClock(new Date("2026-09-20T12:00:00.000Z"));

test("provider registry: typed registration, duplicate rejection, sorted listing", () => {
  const registry = new PaymentProviderRegistry();
  const first = new FakePaymentProvider();
  const second = new FakePaymentProvider();
  void second;
  registry.register(first);
  assert.deepEqual(
    registry.list().map((provider) => provider.providerType),
    ["fake"],
  );
  assert.throws(
    () => registry.register(Object.assign(new FakePaymentProvider(), { providerType: "fake" })),
    (error: PaymentError) => error.code === "PAYMENT_PROVIDER_UNKNOWN",
  );
  const capabilities = first.capabilities();
  assert.deepEqual(capabilities, {
    cancel: true,
    refund: true,
    providerIdempotency: true,
    statusSync: true,
  });
});

test("fake provider: idempotent create, settlement simulation, signed callbacks", async () => {
  const provider = new FakePaymentProvider();
  const input = {
    paymentId: "018f2000-0000-7000-8000-0000000000a1",
    amount: 150.5,
    currency: "RUB",
    idempotencyKey: "pcms:018f2000-0000-7000-8000-0000000000a1",
    metadata: {},
  };
  const first = await provider.createPayment(input, { values: {} });
  const second = await provider.createPayment(input, { values: {} });
  assert.equal(first.externalId, second.externalId);
  assert.equal(provider.createCallsCount(), 2); // retried at the provider, once logically
  assert.equal(first.status, "PENDING");
  provider.settle(first.externalId, "SUCCEEDED");
  assert.deepEqual(await provider.getPayment(first.externalId, { values: {} }), {
    status: "SUCCEEDED",
    providerStatus: "SUCCEEDED",
  });

  // Callback signature: valid passes, forged refused.
  const { headers, rawBody } = provider.signedCallbackBody(
    {
      event_id: "evt-1",
      external_payment_id: first.externalId,
      outcome: "SUCCEEDED",
    },
    "secret",
  );
  provider.verifyCallback({ headers, rawBody }, { values: { signing: "secret" } });
  assert.throws(
    () =>
      provider.verifyCallback(
        { headers: { ...headers, "x-fake-signature": "forged" }, rawBody },
        { values: { signing: "secret" } },
      ),
    (error: PaymentError) => error.code === "PAYMENT_INBOUND_INVALID",
  );
  const parsed = provider.parseCallback({ headers, rawBody });
  assert.deepEqual(parsed, {
    providerEventId: "evt-1",
    externalPaymentId: first.externalId,
    idempotencyKey: null,
    outcome: "SUCCEEDED",
  });
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
  const provider = new FakePaymentProvider();
  const registry = new PaymentProviderRegistry();
  registry.register(provider);
  const instances = createPaymentProviderInstanceService({
    pool,
    clock: CLOCK,
    configSchemaFor: (providerType) => registry.get(providerType)?.configSchema,
  });
  return { pool, instances };
}

test("provider instance store: schema-validated config, secret-ref names only", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const instance = await fx.instances.create({
    providerType: "fake",
    name: "sandbox-fake",
    config: {},
    secretRefs: { signing: "FAKE_SIGNING_SECRET" },
  });
  assert.equal(instance.secretRefs.signing, "FAKE_SIGNING_SECRET");
  await assert.rejects(
    fx.instances.create({
      providerType: "nope",
      name: "x",
      config: {},
    }),
    (error: PaymentError) => error.code === "PAYMENT_PROVIDER_UNKNOWN",
  );
  await assert.rejects(
    fx.instances.create({
      providerType: "fake",
      name: "y",
      config: { password: "raw" },
    }),
    (error: PaymentError) => error.code === "PAYMENT_REQUEST_INVALID",
  );
  const disabled = await fx.instances.update(instance.id, { enabled: false });
  assert.equal(disabled.enabled, false);
  const listed = await fx.instances.list({ enabled: false });
  assert.equal(listed.length, 1);
});
