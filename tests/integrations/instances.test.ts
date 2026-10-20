// PCMS-INT-T002 — IntegrationInstance persistence: schema-validated config,
// secret-shaped config keys rejected, secret refs stored as names only,
// update/get/list round-trip. DB-backed (disposable database).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, fixedClock } from "@pcms/core";
import {
  type ConnectorDefinition,
  createConnectorRegistry,
  createIntegrationInstanceService,
  type IntegrationError,
} from "@pcms/integrations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CLOCK = fixedClock(new Date("2026-09-20T12:00:00.000Z"));

const connector: ConnectorDefinition = {
  connectorType: "stub",
  title: "Stub",
  description: "test",
  configSchema: {
    type: "object",
    additionalProperties: false,
    // `api_key` is deliberately declared so the secret-shaped-key guard (not
    // additionalProperties) is what rejects it — a connector contract must
    // never invite a raw secret into config JSON.
    properties: {
      url: { type: "string", format: "uri" },
      api_key: { type: "string", maxLength: 200 },
    },
    required: ["url"],
  },
  secrets: [{ name: "api_key", description: "key" }],
  actions: [{ actionType: "ping", description: "", payloadSchema: { type: "object" } }],
  testable: true,
};

async function fixture(t: { after: (fn: () => void) => void }) {
  if (!testDatabaseConfigured()) return null;
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  const { loadMigrations, migrateDatabase } = await import("@pcms/core");
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const registry = createConnectorRegistry();
  registry.register(connector);
  const instances = createIntegrationInstanceService({ pool, clock: CLOCK, registry });
  return { pool, instances };
}

test("instance create stores config + secret-ref names, never values", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const instance = await fx.instances.create({
    connectorType: "stub",
    name: "office-stub",
    config: { url: "https://internal.example" },
    secretRefs: { api_key: "STUB_API_KEY" },
  });
  assert.equal(instance.enabled, true);
  assert.equal(instance.secretRefs.api_key, "STUB_API_KEY");
  const raw = await fx.pool.query<{ config: unknown; secret_refs: unknown }>(
    "SELECT config, secret_refs FROM integration_instance WHERE id = $1",
    [instance.id],
  );
  assert.equal(JSON.stringify(raw.rows[0]?.secret_refs), '{"api_key":"STUB_API_KEY"}');
  const found = await fx.instances.get(instance.id);
  assert.equal(found?.name, "office-stub");
});

test("instance create rejects unknown connector, bad config, secret-shaped values", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await assert.rejects(
    fx.instances.create({ connectorType: "nope", name: "x", config: {} }),
    (error: IntegrationError) => error.code === "CONNECTOR_TYPE_UNKNOWN",
  );
  await assert.rejects(
    fx.instances.create({ connectorType: "stub", name: "x", config: { url: "not a uri" } }),
    (error: IntegrationError) => error.code === "INTEGRATION_CONFIG_INVALID",
  );
  await assert.rejects(
    fx.instances.create({
      connectorType: "stub",
      name: "x",
      config: { url: "https://ok.example", api_key: "raw-secret-value" },
    }),
    (error: IntegrationError) => error.code === "INTEGRATION_SECRET_REF_INVALID",
  );
  // Unknown property rejected by additionalProperties:false.
  await assert.rejects(
    fx.instances.create({ connectorType: "stub", name: "x", config: { nope: 1 } }),
    (error: IntegrationError) => error.code === "INTEGRATION_CONFIG_INVALID",
  );
});

test("instance update patches fields and revalidates config", async (t) => {
  const fx = await fixture(t);
  if (fx === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const instance = await fx.instances.create({
    connectorType: "stub",
    name: "before",
    config: { url: "https://a.example" },
  });
  const updated = await fx.instances.update(instance.id, {
    name: "after",
    enabled: false,
    config: { url: "https://b.example" },
  });
  assert.equal(updated.name, "after");
  assert.equal(updated.enabled, false);
  assert.deepEqual(updated.config, { url: "https://b.example" });
  await assert.rejects(
    fx.instances.update(instance.id, { config: { url: "bogus" } }),
    (error: IntegrationError) => error.code === "INTEGRATION_CONFIG_INVALID",
  );
  await assert.rejects(
    fx.instances.update("00000000-0000-0000-0000-000000000000", { enabled: true }),
    (error: IntegrationError) => error.code === "INTEGRATION_INSTANCE_NOT_FOUND",
  );
  const list = await fx.instances.list({ enabled: false });
  assert.deepEqual(
    list.map((item) => item.name),
    ["after"],
  );
});
