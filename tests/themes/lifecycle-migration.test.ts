import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { type DbClient, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { Client } from "pg";

test("0003/0004 upgrade baseline+0002 preserving the old theme and repeat migration is a no-op", {
  skip: !process.env.PCMS_TEST_DATABASE_URL,
}, async (t) => {
  const client = new Client({ connectionString: process.env.PCMS_TEST_DATABASE_URL });
  await client.connect();
  const schema = `pcms_test_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });
  await client.query(`SET search_path TO ${schema}, public`);
  const db: DbClient = {
    async query(sql, params) {
      const result = await client.query(sql, params ? [...params] : []);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
  const pool: DbPool = {
    query: db.query,
    async withClient(work) {
      return work(db);
    },
    async withTransaction(work) {
      await db.query("BEGIN");
      try {
        const result = await work(db);
        await db.query("COMMIT");
        return result;
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    },
    async check() {
      return true;
    },
    stats() {
      return { totalCount: 1, idleCount: 0, waitingCount: 0 };
    },
    async end() {},
  };
  const migrations = loadMigrations("db/migrations").map((migration) => ({
    ...migration,
    sql: migration.sql
      .replaceAll("public.", `${schema}.`)
      .replaceAll(`${schema}.gin_trgm_ops`, "public.gin_trgm_ops"),
  }));
  await migrateDatabase(pool, migrations.slice(0, 2), undefined);
  await db.query(
    "INSERT INTO admin_theme_state(site_key,theme_key,theme_version,settings,settings_generation) VALUES('default','old-theme','1.2.3','{\"footer\":\"retained\"}',9)",
  );
  assert.deepEqual((await migrateDatabase(pool, migrations, undefined)).applied, [
    "0003_theme_revisions",
    "0004_theme_revision_cleanup",
    "0005_interaction_privacy",
  ]);
  const state = (
    await db.query(
      "SELECT theme_key,theme_version,settings,settings_generation,active_revision_id,theme_generation,pending_operation_id FROM admin_theme_state",
    )
  ).rows[0];
  assert.deepEqual(state, {
    theme_key: "old-theme",
    theme_version: "1.2.3",
    settings: { footer: "retained" },
    settings_generation: 9,
    active_revision_id: null,
    theme_generation: "0",
    pending_operation_id: null,
  });
  assert.deepEqual((await migrateDatabase(pool, migrations, undefined)).applied, []);
});
