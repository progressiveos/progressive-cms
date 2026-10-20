// PCMS-OPS-T131 — runtime secret store resolution precedence at dispatch:
// Admin-managed runtime values win per requirement; env/file secret refs
// remain the bootstrap source for everything the store does not hold; an
// instance with neither fails secure with INTEGRATION_SECRET_MISSING.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Clock, type DbPool, fixedClock } from "@pcms/core";
import {
  type ConnectorDefinition,
  createConnectorRegistry,
  createDeliveryService,
  createIntegrationBindingService,
  createIntegrationDispatcher,
  createIntegrationInstanceService,
  loadInstanceRuntimeSecrets,
  resolveSecrets,
  setInstanceRuntimeSecret,
} from "@pcms/integrations";
import { connectionInfoOf } from "../helpers/api-composition.js";
import { createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const DEFINITION: ConnectorDefinition = {
  connectorType: "secretstub",
  title: "Secret stub",
  description: "",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  secrets: [{ name: "bot_token", description: "" }],
  actions: [
    {
      actionType: "ping",
      description: "",
      payloadSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  ],
  testable: true,
};

test("resolveSecrets: preResolved requirements skip env refs; missing otherwise fail", () => {
  const instance = {
    id: "i1" as never,
    connectorType: "secretstub",
    name: "one",
    enabled: true,
    config: {},
    secretRefs: {},
    siteKey: null,
    environment: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const resolver = () => "env-value";
  // Runtime overlay covers the requirement → env ref not needed.
  const covered = resolveSecrets(instance, DEFINITION, resolver, { bot_token: "runtime-value" });
  assert.equal(covered.bot_token, "runtime-value");
  // Without the overlay, the instance has no ref → fail-secure.
  assert.throws(
    () => resolveSecrets(instance, DEFINITION, resolver),
    (error: { readonly code?: string }) => error?.code === "INTEGRATION_SECRET_MISSING",
  );
});

test("dispatcher: runtime store value wins over the env/file ref; env ref used otherwise", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool: DbPool = (await import("@pcms/core")).createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 2,
  });
  t.after(() => {
    void pool.end();
  });
  const { loadMigrations, migrateDatabase } = await import("@pcms/core");
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const clock: Clock = fixedClock(new Date("2026-09-24T12:00:00.000Z"));
  const registry = createConnectorRegistry();
  registry.register(DEFINITION);
  const instances = createIntegrationInstanceService({ pool, clock, registry });
  const withRuntime = await instances.create({
    connectorType: "secretstub",
    name: "with-runtime",
    config: {},
    secretRefs: { bot_token: "ENV_NAME" },
  });
  const withEnvOnly = await instances.create({
    connectorType: "secretstub",
    name: "with-env",
    config: {},
    secretRefs: { bot_token: "ENV_NAME" },
  });
  await setInstanceRuntimeSecret(
    pool,
    {
      encrypt: (plaintext) => Buffer.from(`enc:${plaintext}`, "utf8"),
      decrypt: (blob) => blob.toString("utf8").replace(/^enc:/, ""),
    },
    {
      instanceId: withRuntime.id,
      key: "bot_token",
      value: "runtime-value",
      actor: "test",
    },
  );

  const seen: Record<string, string>[] = [];
  const dispatcher = createIntegrationDispatcher({
    clock,
    registry,
    runtimes: {
      get: () => ({
        async execute(
          _actionType: string,
          _payload: Readonly<Record<string, unknown>>,
          ctx: { secrets: Record<string, string> },
        ) {
          seen.push({ ...ctx.secrets });
          return { ok: true, retryable: false };
        },
        async test(ctx: { secrets: Record<string, string> }) {
          seen.push({ ...ctx.secrets });
          return { ok: true, retryable: false };
        },
      }),
    } as never,
    bindings: createIntegrationBindingService({ pool, clock, instances, registry }),
    instances,
    deliveries: createDeliveryService({ pool, clock }),
    secretResolver: (name) => (name === "ENV_NAME" ? "env-value" : undefined),
    runtimeSecretSource: (instanceId) => loadInstanceRuntimeSecrets(pool, undefined, instanceId),
  });
  // A production composition passes the decrypting box; here the source is
  // wrapped explicitly to prove precedence, so re-wrap with the box:
  const box = {
    encrypt: (plaintext: string) => Buffer.from(`enc:${plaintext}`, "utf8"),
    decrypt: (blob: Buffer) => blob.toString("utf8").replace(/^enc:/, ""),
  };
  const dispatcherWithBox = createIntegrationDispatcher({
    clock,
    registry,
    runtimes: {
      get: () => ({
        async execute(
          _actionType: string,
          _payload: Readonly<Record<string, unknown>>,
          ctx: { secrets: Record<string, string> },
        ) {
          seen.push({ ...ctx.secrets });
          return { ok: true, retryable: false };
        },
        async test(ctx: { secrets: Record<string, string> }) {
          seen.push({ ...ctx.secrets });
          return { ok: true, retryable: false };
        },
      }),
    } as never,
    bindings: createIntegrationBindingService({ pool, clock, instances, registry }),
    instances,
    deliveries: createDeliveryService({ pool, clock }),
    secretResolver: (name) => (name === "ENV_NAME" ? "env-value" : undefined),
    runtimeSecretSource: (instanceId) => loadInstanceRuntimeSecrets(pool, box, instanceId),
  });

  await dispatcherWithBox.testInstance(withRuntime.id);
  await dispatcherWithBox.testInstance(withEnvOnly.id);
  assert.deepEqual(seen, [
    { bot_token: "runtime-value" }, // runtime store wins
    { bot_token: "env-value" }, // env/file ref fallback
  ]);
  void dispatcher;
});
