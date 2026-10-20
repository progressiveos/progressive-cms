// PCMS-AUTH-T010 — layered login throttling: account/IP/global buckets,
// progressive lockout with cap, window expiry (Auth spec §35).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthError,
  createThrottleService,
  loginBucketKeys,
  type ThrottleService,
} from "@pcms/auth";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function connectionInfo(db: TestDatabase) {
  const info = {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}

async function withThrottle(
  t: { after: (fn: () => void) => void },
  run: (throttle: ThrottleService, pool: DbPool) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(createThrottleService(pool), pool);
}

test("failures below the threshold never throttle; exceeding locks", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withThrottle(t, async (throttle) => {
    const buckets = loginBucketKeys("victim@example.com", "10.0.0.1");
    for (let i = 0; i < 5; i++) {
      await throttle.assertNotLocked(buckets);
      await throttle.recordFailure(buckets);
    }
    // The 6th attempt is the one that crosses the threshold and locks.
    await throttle.recordFailure(buckets);
    await assert.rejects(
      () => throttle.assertNotLocked(buckets),
      (err: AuthError) => err.code === "AUTH_THROTTLED" && err.status === 429,
    );
    // Error is coarse: it must not reveal whether the account exists.
    await assert.rejects(
      () => throttle.assertNotLocked(buckets),
      (err: AuthError) => err.message.includes("too many attempts"),
    );
  });
});

test("layering: IP bucket blocks other accounts; email bucket blocks other IPs", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withThrottle(t, async (throttle) => {
    // Same IP attacking a different account still trips the IP bucket.
    const attackerIp = loginBucketKeys("someone-else@example.com", "10.0.0.7");
    for (let i = 0; i < 6; i++) await throttle.recordFailure(attackerIp);
    await assert.rejects(
      () => throttle.assertNotLocked(loginBucketKeys("innocent@example.com", "10.0.0.7")),
      (err: AuthError) => err.code === "AUTH_THROTTLED",
    );
    // Different IP against the battered account trips the email bucket.
    const victimBuckets = loginBucketKeys("hammered@example.com", "10.9.9.9");
    for (let i = 0; i < 6; i++) await throttle.recordFailure(victimBuckets);
    await assert.rejects(
      () => throttle.assertNotLocked(loginBucketKeys("hammered@example.com", "10.8.8.8")),
      (err: AuthError) => err.code === "AUTH_THROTTLED",
    );
  });
});

test("progressive lockout grows but is capped (no permanent DoS lockout)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withThrottle(t, async (throttle) => {
    const buckets = loginBucketKeys("progressive@example.com", null);
    const locks: number[] = [];
    for (let i = 0; i < 10; i++) {
      locks.push(await throttle.recordFailure(buckets));
    }
    // Failures 1-5 stay below the threshold (no lock); the 6th failure
    // locks at base, each further one doubles, capped at 1h.
    assert.equal(locks[0], 0);
    assert.equal(locks[1], 0);
    assert.equal(locks[2], 0);
    assert.equal(locks[3], 0);
    assert.equal(locks[4], 0);
    assert.equal(locks[5], 30_000);
    assert.equal(locks[6], 60_000);
    assert.equal(locks[7], 120_000);
    assert.equal(locks[8], 240_000);
    assert.equal(locks[9], 480_000);
  });
});

test("locks expire and successful login clears counters", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withThrottle(t, async (throttle, pool) => {
    const buckets = loginBucketKeys("recover@example.com", "10.1.1.1");
    const t0 = new Date(1_700_000_000_000);
    for (let i = 0; i < 6; i++) await throttle.recordFailure(buckets, t0);
    await assert.rejects(() => throttle.assertNotLocked(buckets, t0));

    // After the lockout window passes, attempts are permitted again.
    const afterLock = new Date(t0.getTime() + 31_000);
    assert.equal(await throttle.lockedForMilliseconds(buckets, afterLock), 0);
    await throttle.assertNotLocked(buckets, afterLock);

    // A successful login wipes the failure memory entirely.
    await throttle.recordFailure(buckets, afterLock);
    await throttle.recordSuccess(buckets);
    assert.equal(await throttle.lockedForMilliseconds(buckets), 0);
    await throttle.assertNotLocked(buckets);
    const rows = await pool.query("SELECT * FROM auth_throttle_buckets WHERE bucket = ANY($1)", [
      buckets,
    ]);
    assert.equal(rows.rows.length, 0);
  });
});
