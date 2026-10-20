// PCMS-OPS-T004 — bounded pool + real transactions against disposable
// PostgreSQL databases: connect, commit, rollback, error path, boundedness,
// readiness probe behavior.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DbConnectionInfo } from "@pcms/core";
import { createDbPool, type DbPool } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function connectionInfo(db: TestDatabase, port = db.connection.port): DbConnectionInfo {
  const info: DbConnectionInfo = {
    host: db.connection.host,
    port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable",
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}

async function withTestPool(
  t: { after: (fn: () => void) => void },
  overrides: Partial<Parameters<typeof createDbPool>[0]> = {},
  run: (pool: DbPool, db: TestDatabase) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfo(db),
    max: 5,
    connectionTimeoutMilliseconds: 3000,
    ...overrides,
  });
  t.after(() => {
    void pool.end();
  });
  await run(pool, db);
}

test("pool connects and executes parameterized queries", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTestPool(t, {}, async (pool) => {
    const result = await pool.query<{ one: number }>("SELECT $1::int AS one", [1]);
    assert.equal(result.rows[0]?.one, 1);
    assert.equal(result.rowCount, 1);
  });
});

test("transaction commits on success", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTestPool(t, {}, async (pool) => {
    await pool.query("CREATE TABLE tx_commit_t (id int primary key, label text)");
    const inserted = await pool.withTransaction(async (tx) => {
      await tx.query("INSERT INTO tx_commit_t (id, label) VALUES ($1, $2)", [1, "committed"]);
      return "work-done";
    });
    assert.equal(inserted, "work-done");
    const rows = await pool.query<{ id: number }>("SELECT id FROM tx_commit_t");
    assert.deepEqual(rows.rows, [{ id: 1 }]);
  });
});

test("transaction rolls back and rethrows the original error", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTestPool(t, {}, async (pool) => {
    await pool.query("CREATE TABLE tx_rollback_t (id int primary key)");
    await pool.query("INSERT INTO tx_rollback_t (id) VALUES (1)");
    const boom = new Error("application failure mid-transaction");
    await assert.rejects(
      pool.withTransaction(async (tx) => {
        await tx.query("INSERT INTO tx_rollback_t (id) VALUES (2)");
        throw boom;
      }),
      (error: unknown) => error === boom,
    );
    const rows = await pool.query<{ id: number }>("SELECT id FROM tx_rollback_t ORDER BY id");
    assert.deepEqual(rows.rows, [{ id: 1 }], "uncommitted insert must be rolled back");
  });
});

test("pool stays usable after a failed transaction; PG error codes surface", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTestPool(t, {}, async (pool) => {
    await pool.query("CREATE TABLE tx_codes_t (id int primary key)");
    await pool.query("INSERT INTO tx_codes_t (id) VALUES (7)");
    await assert.rejects(
      pool.withTransaction(async (tx) => {
        await tx.query("INSERT INTO tx_codes_t (id) VALUES (8)");
        await tx.query("INSERT INTO tx_codes_t (id) VALUES (7)"); // duplicate → 23505
      }),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
    // failed transaction rolled back the first insert as well
    const rows = await pool.query<{ id: number }>("SELECT id FROM tx_codes_t");
    assert.deepEqual(rows.rows, [{ id: 7 }]);
    // pool healthy afterwards
    const ok = await pool.query("SELECT 1 AS ok");
    assert.equal(ok.rows[0]?.ok, 1);
  });
});

test("isolation level is applied to the transaction", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTestPool(t, {}, async (pool) => {
    const level = await pool.withTransaction(
      async (tx) => {
        const rows = await tx.query<{ level: string }>(
          "SELECT current_setting('transaction_isolation') AS level",
        );
        return rows.rows[0]?.level;
      },
      { isolation: "serializable" },
    );
    assert.equal(level, "serializable");
  });
});

test("pool is bounded: exceeding max times out instead of opening more connections", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTestPool(t, { max: 1, connectionTimeoutMilliseconds: 250 }, async (pool) => {
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      releaseHeld = resolveHeld;
    });
    const hold = pool.withClient(async () => {
      await held;
    });

    // give the first acquire a moment to take the single slot
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
    const statsWhileHeld = pool.stats();
    assert.equal(statsWhileHeld.totalCount, 1);
    assert.equal(statsWhileHeld.idleCount, 0);

    await assert.rejects(pool.query("SELECT 1"), (error: unknown) => {
      const message = String((error as Error).message);
      return /timeout|exhausted|waiting/i.test(message);
    });
    releaseHeld();
    await hold;
    // after release the pool serves queries again
    const ok = await pool.query("SELECT 1 AS ok");
    assert.equal(ok.rows[0]?.ok, 1);
  });
});

test("check() reports availability honestly (live true, dead false)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withTestPool(t, {}, async (pool, db) => {
    assert.equal(await pool.check(1000), true);

    const dead = createDbPool({
      connectionInfo: connectionInfo(db, 1), // nothing listens on port 1
      max: 1,
      connectionTimeoutMilliseconds: 300,
    });
    t.after(() => {
      void dead.end();
    });
    assert.equal(await dead.check(1000), false);
  });
});
