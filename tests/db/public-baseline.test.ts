import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, loadMigrations, migrateDatabase, migrationStatus } from "@pcms/core";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

test("public baseline backup restores and accepts the next candidate migration", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");

  const source = await createTestDatabase(t);
  const restored = await createTestDatabase(t);
  const sourcePool = createDbPool({ connectionInfo: connectionInfo(source), max: 2 });
  const restoredPool = createDbPool({ connectionInfo: connectionInfo(restored), max: 2 });
  const temp = mkdtempSync(join(tmpdir(), "pcms-public-baseline-"));
  const migrationDir = join(temp, "migrations");
  const dumpPath = join(temp, "baseline.dump");
  t.after(() => {
    void sourcePool.end();
    void restoredPool.end();
    rmSync(temp, { recursive: true, force: true });
  });

  const migrationSource = join(process.cwd(), "db", "migrations", "0001_public_baseline.sql");
  const baselineSql = readFileSync(migrationSource, "utf8");
  const migrations = loadMigrations(join(process.cwd(), "db", "migrations"));
  assert.deepEqual(
    migrations.map(({ name }) => name),
    ["0001_public_baseline"],
  );
  await migrateDatabase(sourcePool, migrations, undefined);

  const sourceRoles = await sourcePool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM auth_roles",
  );
  assert.equal(sourceRoles.rows[0]?.count, "5");
  const relationship = await sourcePool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'publication_plan_items'::regclass
         AND conname = 'publication_plan_items_changeset_item_id_fkey'
     ) AS exists`,
  );
  assert.equal(relationship.rows[0]?.exists, true);

  const conn = source.connection;
  const env =
    conn.password === undefined ? process.env : { ...process.env, PGPASSWORD: conn.password };
  const connectionArgs = ["-h", conn.host, "-p", String(conn.port), "-U", conn.user];
  execFileSync(
    "pg_dump",
    [
      ...connectionArgs,
      "--no-owner",
      "--no-privileges",
      "--format=plain",
      "--file",
      dumpPath,
      "--dbname",
      conn.database,
    ],
    { env },
  );
  const restoreSql = readFileSync(dumpPath, "utf8")
    .replace(/^SET [^\n]*;\n/gm, "")
    .replace(/^SELECT pg_catalog\.set_config\('search_path', '', false\);\n/gm, "")
    .replace(/^\\(?:un)?restrict [^\n]*\n/gm, "");
  writeFileSync(dumpPath, restoreSql);
  execFileSync(
    "psql",
    [
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      ...connectionArgs,
      "-d",
      restored.connection.database,
      "-f",
      dumpPath,
    ],
    { env },
  );

  mkdirSync(migrationDir);
  writeFileSync(join(migrationDir, "0001_public_baseline.sql"), baselineSql);
  writeFileSync(
    join(migrationDir, "0002_rc_candidate_probe.sql"),
    "CREATE TABLE rc_candidate_probe (id integer PRIMARY KEY); INSERT INTO rc_candidate_probe VALUES (1);",
  );
  const restoredMigrations = loadMigrations(migrationDir);
  assert.deepEqual((await migrationStatus(restoredPool, restoredMigrations)).pending, [
    "0002_rc_candidate_probe",
  ]);
  const upgraded = await migrateDatabase(restoredPool, restoredMigrations, undefined);
  assert.deepEqual(upgraded.applied, ["0002_rc_candidate_probe"]);
  assert.equal(upgraded.current, "0002_rc_candidate_probe");

  const restoredRoles = await restoredPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM auth_roles",
  );
  assert.equal(restoredRoles.rows[0]?.count, "5");
  const probe = await restoredPool.query<{ id: number }>("SELECT id FROM rc_candidate_probe");
  assert.deepEqual(probe.rows, [{ id: 1 }]);
  const finalStatus = await migrationStatus(restoredPool, restoredMigrations);
  assert.deepEqual(finalStatus.pending, []);
  assert.deepEqual(finalStatus.drifted, []);
});
