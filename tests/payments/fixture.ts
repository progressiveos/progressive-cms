// Shared payments-service fixture: disposable DB + fake provider wired.
import { createDbPool, type DbPool } from "@pcms/core";
import {
  createPaymentProviderInstanceService,
  createPaymentService,
  FakePaymentProvider,
  PaymentProviderRegistry,
  type PaymentService,
} from "@pcms/payments";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

export const CLOCK = { now: () => new Date("2026-09-20T12:00:00.000Z") };
export const ACTOR = { type: "OPERATOR", id: "payments-owner" };

export async function paymentsFixture(t: { after: (fn: () => void) => void }) {
  if (!testDatabaseConfigured()) return null;
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(async () => {
    await pool.end();
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
  const instance = await instances.create({
    providerType: "fake",
    name: "fake-main",
    config: {},
    secretRefs: { signing: "FAKE_SIGNING_SECRET" },
  });
  const payments: PaymentService = createPaymentService({
    pool,
    clock: CLOCK,
    providers: registry,
    instances,
    secretResolver: (name) => (name === "FAKE_SIGNING_SECRET" ? "signing-secret" : undefined),
  });
  const CREATE = {
    provider_instance_id: instance.id,
    subject_type: "form_submission",
    subject_id: "018f2000-0000-7000-8000-00000000aa01",
    amount: 1200,
    currency: "RUB",
    idempotency_key: "order-2026-000001",
  };
  return { pool, provider, registry, instances, payments, instanceId: instance.id, CREATE };
}

// Re-export for compile-only imports in corpus tests.
export type { DbPool };
