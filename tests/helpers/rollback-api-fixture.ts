// Existing test database, private schema and outer rollback: never CREATE DATABASE.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createApplicationServices } from "@pcms/api";
import type { DbClient, DbPool } from "@pcms/core";
import { loadMigrations } from "@pcms/core";
import { Client, Pool } from "pg";

export async function rollbackApiFixture(
  t: { after: (fn: () => Promise<void>) => void },
  input: Omit<Parameters<typeof createApplicationServices>[0], "pool">,
  options?: { transactionMode: "committed" },
) {
  if (options?.transactionMode === "committed") return committedApiFixture(t, input);
  const client = new Client({ connectionString: process.env.PCMS_TEST_DATABASE_URL });
  await client.connect();
  t.after(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });
  await client.query("BEGIN");
  const schema = `pcms_test_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET LOCAL search_path TO ${schema}, public`);
  const baseline = readFileSync("db/migrations/0001_public_baseline.sql", "utf8")
    .replaceAll("public.", `${schema}.`)
    .replaceAll(`${schema}.gin_trgm_ops`, "public.gin_trgm_ops");
  await client.query(baseline);
  for (const migration of loadMigrations("db/migrations").slice(1)) {
    await client.query(migration.sql.replaceAll("public.", `${schema}.`));
  }
  let pendingQuery: Promise<unknown> = Promise.resolve();
  const connection: DbClient = {
    async query(sql, params) {
      const next = pendingQuery.then(() => client.query(sql, params ? [...params] : []));
      pendingQuery = next.catch(() => {});
      const result = await next;
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
  let counter = 0;
  const pool: DbPool = {
    query: connection.query,
    async withClient(work) {
      return work(connection);
    },
    async withTransaction(work) {
      const savepoint = `savepoint_${++counter}`;
      await connection.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await work(connection);
        await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
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
  return { app: createApplicationServices({ ...input, pool }), pool };
}

/** Theme journals need real COMMIT and independent sessions; retain the default
 * outer rollback helper for every other caller. This owns only its schema. */
async function committedApiFixture(
  t: { after: (fn: () => Promise<void>) => void },
  input: Omit<Parameters<typeof createApplicationServices>[0], "pool">,
) {
  const schema = `pcms_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: process.env.PCMS_TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const driver = new Pool({
    connectionString: process.env.PCMS_TEST_DATABASE_URL,
    max: 6,
    options: `-c search_path=${schema},public`,
  });
  t.after(async () => {
    await driver.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const baseline = readFileSync("db/migrations/0001_public_baseline.sql", "utf8")
    .replaceAll("public.", `${schema}.`)
    .replaceAll(`${schema}.gin_trgm_ops`, "public.gin_trgm_ops");
  await admin.query("SELECT pg_advisory_lock(hashtext('pcms:test:bootstrap'))");
  try {
    await driver.query(baseline);
    for (const migration of loadMigrations("db/migrations").slice(1))
      await driver.query(migration.sql.replaceAll("public.", `${schema}.`));
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtext('pcms:test:bootstrap'))");
  }
  const pool: DbPool = {
    async query(sql, params) {
      const r = await driver.query(sql, params ? [...params] : []);
      return { rows: r.rows, rowCount: r.rowCount };
    },
    async withClient(work) {
      const client = await driver.connect();
      let discard: Error | boolean | undefined;
      try {
        return await work({
          async query(sql, params) {
            const r = await client.query(sql, params ? [...params] : []);
            return { rows: r.rows, rowCount: r.rowCount };
          },
          discard(reason) {
            discard = reason ?? true;
          },
        });
      } finally {
        client.release(discard);
      }
    },
    async withTransaction(work) {
      return this.withClient(async (client) => {
        await client.query("BEGIN");
        try {
          const value = await work(client);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    },
    async check() {
      return true;
    },
    stats() {
      return {
        totalCount: driver.totalCount,
        idleCount: driver.idleCount,
        waitingCount: driver.waitingCount,
      };
    },
    async end() {},
  };
  return { app: createApplicationServices({ ...input, pool }), pool };
}
