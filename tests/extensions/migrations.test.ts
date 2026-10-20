// PCMS-EXT-T005 — Extension migration ownership.
// Acceptance (Master Plan M14): clean install, multiple extensions, checksum
// drift rejected, a failed migration is not marked applied, and the core
// ledger stays untouched by extension migrations.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  MIGRATIONS_TABLE,
  migrateDatabase,
} from "@pcms/core";
import {
  applyAllExtensionMigrations,
  applyExtensionMigrations,
  EXTENSION_MIGRATIONS_TABLE,
  ExtensionError,
  extensionMigrationStatus,
} from "@pcms/extensions/internal";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

test("clean install: both migrations apply in order and rerun is a no-op", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const migrations = loadMigrations("tests/extensions/fixtures/migrations-a");
  const first = await applyExtensionMigrations(pool, {
    extensionId: "com.example.site-basics",
    extensionVersion: "1.0.0",
    migrations,
  });
  assert.deepEqual(first.applied, ["0001_create_state", "0002_expand_state"]);
  const status = await extensionMigrationStatus(pool, "com.example.site-basics", migrations);
  assert.deepEqual(
    status.applied.map((entry) => entry.name),
    ["0001_create_state", "0002_expand_state"],
  );
  assert.deepEqual(status.pending, []);
  assert.deepEqual(status.drifted, []);
  // Rerun applies nothing.
  const rerun = await applyExtensionMigrations(pool, {
    extensionId: "com.example.site-basics",
    extensionVersion: "1.0.1",
    migrations,
  });
  assert.deepEqual(rerun.applied, []);
});

test("multiple extensions keep independent namespaces in deterministic order", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const results = await applyAllExtensionMigrations(pool, [
    {
      extensionId: "com.example.zebra",
      extensionVersion: "0.1.0",
      migrations: loadMigrations("tests/extensions/fixtures/migrations-b"),
    },
    {
      extensionId: "com.example.site-basics",
      extensionVersion: "1.0.0",
      migrations: loadMigrations("tests/extensions/fixtures/migrations-a"),
    },
  ]);
  assert.deepEqual([...results.keys()], ["com.example.site-basics", "com.example.zebra"]);
  const ledger = await pool.query<{ extension_id: string; name: string }>(
    `SELECT extension_id, name FROM ${EXTENSION_MIGRATIONS_TABLE} ORDER BY extension_id, name`,
  );
  assert.deepEqual(
    ledger.rows.map((row) => `${row.extension_id}/${row.name}`),
    [
      "com.example.site-basics/0001_create_state",
      "com.example.site-basics/0002_expand_state",
      "com.example.zebra/0001_own_table",
    ],
  );
});

test("checksum drift is rejected", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const dir = mkdtempSync(join(tmpdir(), "pcms-ext-mig-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "0001_state.sql");
  writeFileSync(file, "CREATE TABLE ext_drift_state (id int);\n");
  await applyExtensionMigrations(pool, {
    extensionId: "com.example.drift",
    extensionVersion: "1.0.0",
    migrations: loadMigrations(dir),
  });
  // Same name, different content — drift.
  writeFileSync(file, "CREATE TABLE ext_drift_state (id int, extra text);\n");
  await assert.rejects(
    () =>
      applyExtensionMigrations(pool, {
        extensionId: "com.example.drift",
        extensionVersion: "1.0.0",
        migrations: loadMigrations(dir),
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_MIGRATION_DRIFT",
  );
});

test("a failed migration is not marked applied and the core ledger is untouched", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const dir = mkdtempSync(join(tmpdir(), "pcms-ext-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE ext_fail_state (id int);\n");
  writeFileSync(join(dir, "0002_broken.sql"), "THIS IS NOT VALID SQL;\n");
  const coreBefore = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${MIGRATIONS_TABLE}`,
  );
  await assert.rejects(
    () =>
      applyExtensionMigrations(pool, {
        extensionId: "com.example.fail",
        extensionVersion: "1.0.0",
        migrations: loadMigrations(dir),
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_MIGRATION_FAILED",
  );
  const rows = await pool.query<{ name: string }>(
    `SELECT name FROM ${EXTENSION_MIGRATIONS_TABLE} WHERE extension_id = 'com.example.fail' ORDER BY name`,
  );
  // 0001 committed, the failed 0002 left nothing behind.
  assert.deepEqual(
    rows.rows.map((row) => row.name),
    ["0001_ok"],
  );
  const coreAfter = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${MIGRATIONS_TABLE}`,
  );
  assert.equal(coreAfter.rows[0]?.count, coreBefore.rows[0]?.count);
});

test("status surfaces drift without executing anything", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const dir = mkdtempSync(join(tmpdir(), "pcms-ext-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "0001_probe.sql");
  writeFileSync(file, "SELECT 1;\n");
  await applyExtensionMigrations(pool, {
    extensionId: "com.example.status",
    extensionVersion: "2.0.0",
    migrations: loadMigrations(dir),
  });
  writeFileSync(file, "SELECT 2;\n");
  const status = await extensionMigrationStatus(pool, "com.example.status", loadMigrations(dir));
  assert.deepEqual(status.drifted, ["0001_probe"]);
  assert.equal(status.applied[0]?.extensionVersion, "2.0.0");
});
