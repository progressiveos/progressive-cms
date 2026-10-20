// PCMS-OPS-T005 — versioned migration runner: zero→current, idempotency,
// per-migration transactions, checksum drift detection, naming enforcement.
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
  type Migration,
  migrateDatabase,
  migrationStatus,
} from "@pcms/core";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pcms-migrations-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, "utf8");
  return dir;
}

const NO_LOG = undefined;

test("empty database migrates zero → current with known version and is idempotent", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const dir = migrationsDir({
    "0001_create_a.sql": "CREATE TABLE a (id int primary key);\nINSERT INTO a VALUES (1);",
    "0002_add_b.sql": "CREATE TABLE b (label text);",
  });
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfo(db),
    max: 2,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
    rmSync(dir, { recursive: true, force: true });
  });
  const before = await migrationStatus(pool, loadMigrations(dir));
  assert.equal(before.current, null);
  assert.deepEqual(before.pending, ["0001_create_a", "0002_add_b"]);

  const first = await migrateDatabase(pool, loadMigrations(dir), NO_LOG);
  assert.deepEqual(first.applied, ["0001_create_a", "0002_add_b"]);
  assert.equal(first.current, "0002_add_b");

  const status = await migrationStatus(pool, loadMigrations(dir));
  assert.equal(status.current, "0002_add_b");
  assert.deepEqual(status.pending, []);
  assert.deepEqual(status.drifted, []);
  assert.equal(status.applied.length, 2);

  const again = await migrateDatabase(pool, loadMigrations(dir), NO_LOG);
  assert.deepEqual(again.applied, []);
  assert.equal(again.current, "0002_add_b");

  const rows = await pool.query<{ id: number }>("SELECT id FROM a");
  assert.deepEqual(rows.rows, [{ id: 1 }]);
});

test("a failing migration leaves no partial effects (transactional DDL)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const dir = migrationsDir({
    "0001_ok.sql": "CREATE TABLE ok_t (id int);",
    "0002_broken.sql": "CREATE TABLE partial_t (id int);\nTHIS IS NOT VALID SQL;",
  });
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfo(db),
    max: 2,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(migrateDatabase(pool, loadMigrations(dir), NO_LOG), /0002_broken/);
  const status = await migrationStatus(pool, loadMigrations(dir));
  assert.equal(status.current, "0001_ok");
  assert.deepEqual(status.pending, ["0002_broken"]);
  const partial = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('partial_t') IS NOT NULL AS exists",
  );
  assert.equal(
    partial.rows[0]?.exists,
    false,
    "first statement of broken file must be rolled back",
  );
  const okTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('ok_t') IS NOT NULL AS exists",
  );
  assert.equal(okTable.rows[0]?.exists, true);
});

test("checksum drift on an applied migration is detected and blocks migration", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const dir = mkdtempSync(join(tmpdir(), "pcms-migrations-"));
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfo(db),
    max: 2,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "0001_orig.sql"), "CREATE TABLE drift_t (id int);", "utf8");
  await migrateDatabase(pool, loadMigrations(dir), NO_LOG);

  writeFileSync(join(dir, "0001_orig.sql"), "CREATE TABLE drift_t (id int, extra text);", "utf8");
  const status = await migrationStatus(pool, loadMigrations(dir));
  assert.deepEqual(status.drifted, ["0001_orig"]);

  await assert.rejects(migrateDatabase(pool, loadMigrations(dir), NO_LOG), /checksum drift/);
});

test("migration files must follow NNNN_name.sql; loader is deterministic", () => {
  const bad = mkdtempSync(join(tmpdir(), "pcms-migrations-"));
  try {
    writeFileSync(join(bad, "not_numbered.sql"), "SELECT 1;", "utf8");
    assert.throws(() => loadMigrations(bad), /does not match/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
  const empty = mkdtempSync(join(tmpdir(), "pcms-migrations-"));
  try {
    assert.deepEqual(loadMigrations(empty), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const single = mkdtempSync(join(tmpdir(), "pcms-migrations-"));
  try {
    writeFileSync(join(single, "0001_a.sql"), "SELECT 1;", "utf8");
    const loaded = loadMigrations(single);
    assert.equal(loaded.length, 1);
    assert.match((loaded[0] as Migration).checksum, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(single, { recursive: true, force: true });
  }
});

test("missing migrations directory fails with a clear error", () => {
  assert.throws(
    () => loadMigrations(join(tmpdir(), "pcms-absent-migrations")),
    /cannot read migrations directory/,
  );
});

test("public baseline migration applies against a disposable database", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfo(db),
    max: 2,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  const migrations = loadMigrations(join(process.cwd(), "db", "migrations"));
  assert.deepEqual(
    migrations.map(({ name }) => name),
    [
      "0001_public_baseline",
      "0002_extension_search_path",
      "0003_theme_revisions",
      "0004_theme_revision_cleanup",
      "0005_interaction_privacy",
    ],
  );
  const result = await migrateDatabase(pool, migrations, NO_LOG);
  assert.deepEqual(
    result.applied,
    migrations.map((migration) => migration.name),
  );
  const baseline = await pool.query<{ value: string }>(
    "SELECT value FROM pcms_kernel_metadata WHERE key = 'schema_baseline'",
  );
  assert.equal(baseline.rows[0]?.value, "1");
  const bookkeeping = await pool.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
  assert.ok(bookkeeping.rows.every((row) => /^\d{4}_/.test(row.name)));
});
