// PCMS-OPS-T109 — durable worker heartbeat: singleton upsert, snapshot
// reads, freshness semantics and honest absence on pre-M15 databases.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  systemClock,
} from "@pcms/core";
import {
  createWorkerHeartbeatWriter,
  heartbeatAgeMilliseconds,
  heartbeatIsFresh,
  readWorkerHeartbeat,
  WORKER_HEARTBEAT_FRESH_WINDOW_MS,
} from "@pcms/operations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

async function createPool(t: import("node:test").TestContext): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  // Fresh install to the current head (the heartbeat table ships in 1500).
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

test("heartbeat: beat upserts the singleton and the snapshot reads back", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await createPool(t);
  const writer = createWorkerHeartbeatWriter(pool, systemClock, { intervalMs: null });
  t.after(() => writer.stop());

  await writer.beat();
  const first = await readWorkerHeartbeat(pool);
  assert.ok(first !== null);
  assert.equal(first.loopCount, 1);

  await writer.beat();
  const second = await readWorkerHeartbeat(pool);
  assert.ok(second !== null);
  assert.equal(second.loopCount, 2);
  // Same boot, same row: a beat updates, never duplicates.
  assert.equal(second.bootId, first.bootId);

  const age = heartbeatAgeMilliseconds(second, systemClock);
  assert.ok(age <= WORKER_HEARTBEAT_FRESH_WINDOW_MS);
  assert.equal(heartbeatIsFresh(second, systemClock), true);
});

test("heartbeat: a stale beat reports not-fresh for doctor/monitoring", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await createPool(t);
  const writer = createWorkerHeartbeatWriter(pool, systemClock, { intervalMs: null });
  t.after(() => writer.stop());
  await writer.beat();
  const snapshot = await readWorkerHeartbeat(pool);
  assert.ok(snapshot !== null);
  const laterClock = { now: () => new Date(Date.now() + WORKER_HEARTBEAT_FRESH_WINDOW_MS + 5_000) };
  assert.equal(heartbeatIsFresh(snapshot, laterClock), false);
  assert.ok(heartbeatAgeMilliseconds(snapshot, laterClock) > WORKER_HEARTBEAT_FRESH_WINDOW_MS);
});

test("heartbeat: absent table reads as null (pre-M15 database, honest absence)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await createPool(t);
  await pool.query("DROP TABLE IF EXISTS pcms_worker_heartbeat");
  assert.equal(await readWorkerHeartbeat(pool), null);
});
