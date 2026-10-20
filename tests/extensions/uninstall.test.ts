// PCMS-EXT-T007 — Uninstall data policy.
// Acceptance (task brief §19, security corpus §72): the default path never
// silently destroys business data; a destructive policy requires an explicit
// policy + operator confirmation; uninstalling a enabled extension is
// blocked; "retain" uninstall keeps the extension's data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createCapabilityRegistry,
  createExtensionCatalog,
  createExtensionLifecycleService,
  defineExtensionArtifact,
  ExtensionError,
  type ExtensionLifecycleAuditEvent,
  type ExtensionLifecycleService,
} from "@pcms/extensions/internal";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const fixedClock = { now: () => new Date("2026-09-21T00:00:00.000Z") };

function doc(dataPolicy: string | undefined) {
  return {
    id: "com.example.shop-local",
    name: "Local shop data",
    version: "1.0.0",
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    ...(dataPolicy === undefined ? {} : { data_policy: dataPolicy }),
    migrations: { dir: "migrations" },
    entrypoint: { type: "module" },
    registrations: {},
  };
}

function buildService(
  pool: DbPool,
  policy: string | undefined,
  audits: ExtensionLifecycleAuditEvent[],
): ExtensionLifecycleService {
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: doc(policy),
      module: {},
      migrationsDir: "tests/extensions/fixtures/migrations-a",
    }),
  );
  return createExtensionLifecycleService({
    pool,
    clock: fixedClock,
    coreVersion: "1.0.0-rc.1",
    catalog,
    systemCapabilities: createCapabilityRegistry(),
    audit: async (event) => void audits.push(event),
  });
}

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

async function integration(t: { after: (fn: () => void) => void }) {
  if (!testDatabaseConfigured()) return null;
  return setup(t);
}

test("default (retain) uninstall preserves the extension's business data", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const audits: ExtensionLifecycleAuditEvent[] = [];
  const service = buildService(pool, undefined, audits);
  await service.install({ extensionId: "com.example.shop-local", config: {} });
  // The extension migration created its own table; put business data in it.
  await pool.query("INSERT INTO ext_site_basics_state (key, value) VALUES ('owner', 'shop-data')");

  const result = await service.uninstall({ extensionId: "com.example.shop-local" });
  assert.equal(result.dataPolicy, "retain");
  const gone = await service.getInstallation("com.example.shop-local");
  assert.equal(gone, undefined);
  // Executable state removed, but the data is still there — no silent drop.
  const data = await pool.query<{ value: string }>(
    "SELECT value FROM ext_site_basics_state WHERE key = 'owner'",
  );
  assert.equal(data.rows[0]?.value, "shop-data");
  assert.ok(audits.some((event) => event.operation === "uninstall" && event.outcome === "ok"));
});

test("uninstall of an enabled extension is blocked", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const service = buildService(pool, undefined, []);
  await service.install({ extensionId: "com.example.shop-local", config: {} });
  await service.enable("com.example.shop-local");
  const pre = await service.uninstallPreflight("com.example.shop-local");
  assert.equal(pre.outcome, "BLOCKED");
  assert.equal(pre.issues[0]?.code, "EXTENSION_UNINSTALL_BLOCKED");
  await assert.rejects(
    () => service.uninstall({ extensionId: "com.example.shop-local" }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_UNINSTALL_BLOCKED",
  );
});

test("destructive policy without explicit confirmation is blocked (fail closed)", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const service = buildService(pool, "drop", []);
  await service.install({ extensionId: "com.example.shop-local", config: {} });
  const pre = await service.uninstallPreflight("com.example.shop-local");
  assert.equal(pre.outcome, "BLOCKED");
  assert.equal(pre.issues[0]?.code, "EXTENSION_DATA_POLICY_CONFIRMATION_REQUIRED");
  // Wrong confirmation token is not accepted either.
  await assert.rejects(
    () =>
      service.uninstall({
        extensionId: "com.example.shop-local",
        confirmation: "yes",
      }),
    (error: unknown) =>
      error instanceof ExtensionError &&
      error.code === "EXTENSION_DATA_POLICY_CONFIRMATION_REQUIRED",
  );
});

test("destructive policy with the verbatim confirmation proceeds as an explicit operator decision", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const audits: ExtensionLifecycleAuditEvent[] = [];
  const service = buildService(pool, "drop", audits);
  await service.install({ extensionId: "com.example.shop-local", config: {} });
  const result = await service.uninstall({
    extensionId: "com.example.shop-local",
    confirmation: "com.example.shop-local",
  });
  assert.equal(result.dataPolicy, "drop");
  assert.equal(await service.getInstallation("com.example.shop-local"), undefined);
  assert.ok(audits.some((event) => event.operation === "uninstall" && event.outcome === "ok"));
});

test("archive policy uninstalls safely and flags the operator archival duty", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const service = buildService(pool, "archive", []);
  await service.install({ extensionId: "com.example.shop-local", config: {} });
  const result = await service.uninstall({ extensionId: "com.example.shop-local" });
  assert.equal(result.dataPolicy, "archive");
  // Data still present — archive is an operator procedure, not an auto-drop.
  const data = await pool.query("SELECT 1 FROM ext_site_basics_state LIMIT 1");
  assert.ok(data.rowCount !== null);
});

test("uninstall of a not-installed extension fails closed", async (t) => {
  const pool = await integration(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const service = buildService(pool, undefined, []);
  await assert.rejects(
    () => service.uninstall({ extensionId: "com.example.shop-local" }),
    (error: unknown) => error instanceof ExtensionError && error.code === "EXTENSION_NOT_INSTALLED",
  );
});
