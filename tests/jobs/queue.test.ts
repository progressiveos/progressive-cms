// PCMS-PUB-T018/T019 — PostgreSQL job queue against real concurrency:
// multi-worker claim safety (SKIP LOCKED), retry classification, dead
// letters, idempotency keys, lease recovery, runner loop (Publication spec
// §62–§65).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, fixedClock, loadMigrations, migrateDatabase } from "@pcms/core";
import { createJobRunner, createJobsService, JobsError, type JobsService } from "@pcms/jobs";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function connectionInfoOf(db: TestDatabase) {
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

const CLOCK = fixedClock("2026-10-01T09:00:00Z");

async function withJobsFixture(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, jobs: JobsService) => Promise<void>,
  maxConnections = 8,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: maxConnections,
    connectionTimeoutMilliseconds: 5000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  // backoffBase 0 keeps retries claimable under the frozen test clock
  // ("backoff elapsed" is the state the retry tests exercise).
  await run(pool, createJobsService(pool, { clock: CLOCK, backoffBaseMilliseconds: 0 }));
}

test("claim safety: concurrent workers never execute the same job", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withJobsFixture(t, async (_pool, jobs) => {
    for (let i = 0; i < 12; i += 1) {
      await jobs.enqueue({ type: "test.work", payload: { n: i } });
    }
    // Four workers claim simultaneously; every job must land exactly once.
    const claims = await Promise.all(
      ["w1", "w2", "w3", "w4"].map((workerId) =>
        jobs.claim({ workerId, limit: 12, leaseMilliseconds: 60_000 }),
      ),
    );
    const ids = claims.flat().map((job) => job.id);
    assert.equal(new Set(ids).size, ids.length, "no job claimed twice");
    assert.equal(ids.length, 12, "every due job claimed exactly once across workers");
    const stats = await jobs.stats();
    assert.equal(stats.RUNNING, 12);
    assert.equal(stats.PENDING, 0);
  });
});

test("claim respects run_at: only due jobs are claimed, due ones first", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withJobsFixture(t, async (_pool, jobs) => {
    const later = new Date(CLOCK.now().getTime() + 3_600_000);
    await jobs.enqueue({ type: "test.late", payload: {}, runAt: later });
    const dueA = (await jobs.enqueue({ type: "test.due", payload: { order: 1 } })).job;
    const dueB = (await jobs.enqueue({ type: "test.due", payload: { order: 2 } })).job;
    const claimed = await jobs.claim({ workerId: "w1", limit: 10, leaseMilliseconds: 60_000 });
    assert.equal(claimed.length, 2);
    assert.deepEqual(
      claimed.map((j) => j.id),
      [dueA.id, dueB.id],
      "deterministic (run_at, id) order; future job untouched",
    );
    const stats = await jobs.stats();
    assert.equal(stats.PENDING, 1, "not-yet-due job stays pending");
  });
});

test("retry classification: transient retries, exhaustion dead-letters, permanent is immediate", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withJobsFixture(t, async (_pool, jobs) => {
    // Transient failure 1: requeued with error_kind transient.
    const job = (await jobs.enqueue({ type: "test.flaky", payload: {}, maxAttempts: 3 })).job;
    const [claimed] = await jobs.claim({ workerId: "w1", limit: 5, leaseMilliseconds: 60_000 });
    assert.equal(claimed?.id, job.id);
    assert.equal(claimed?.attempts, 1);
    await jobs.fail(job.id, "transient", new Error("dependency hiccup"));
    let record = await jobs.getJob(_pool, job.id);
    assert.equal(record?.state, "PENDING", "transient failure requeues");
    assert.equal(record?.errorKind, "transient");
    assert.match(record?.lastError ?? "", /hiccup/);

    // Claim + fail repeatedly until exhaustion (maxAttempts 3).
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const [again] = await jobs.claim({ workerId: "w1", limit: 5, leaseMilliseconds: 60_000 });
      assert.equal(again?.attempts, attempt);
      await jobs.fail(job.id, "transient", new Error("still broken"));
    }
    record = await jobs.getJob(_pool, job.id);
    assert.equal(record?.state, "DEAD", "exhausted transient failures go DEAD");
    const letters = await jobs.listDeadLetters();
    assert.equal(letters.length, 1);
    assert.equal(letters[0]!.id, job.id);

    // Operator retry resets the dead letter.
    await jobs.retryDeadLetter(job.id);
    assert.equal((await jobs.getJob(_pool, job.id))?.state, "PENDING");

    // Permanent failures never retry.
    const permanent = (await jobs.enqueue({ type: "test.invalid", payload: {} })).job;
    await jobs.claim({ workerId: "w1", limit: 5, leaseMilliseconds: 60_000 });
    await jobs.fail(permanent.id, "permanent", new Error("validation conflict"));
    record = await jobs.getJob(_pool, permanent.id);
    assert.equal(record?.state, "DEAD");
    assert.equal(record?.errorKind, "permanent");

    // Cancelled classification.
    const cancelled = (await jobs.enqueue({ type: "test.cancelled", payload: {} })).job;
    await jobs.claim({ workerId: "w1", limit: 5, leaseMilliseconds: 60_000 });
    await jobs.fail(cancelled.id, "cancelled", new Error("superseded"));
    assert.equal((await jobs.getJob(_pool, cancelled.id))?.state, "CANCELLED");
  });
});

test("idempotency keys: duplicate enqueue dedupes; completed keys refuse recreation", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withJobsFixture(t, async (_pool, jobs) => {
    const key = "plan-item-42:publish";
    const first = await jobs.enqueue({
      type: "publication.publish",
      payload: {},
      idempotencyKey: key,
    });
    assert.equal(first.duplicate, false);
    const second = await jobs.enqueue({
      type: "publication.publish",
      payload: {},
      idempotencyKey: key,
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.job.id, first.job.id, "same key returns the active job");

    await jobs.claim({ workerId: "w1", limit: 5, leaseMilliseconds: 60_000 });
    await jobs.complete(first.job.id);
    const stats = await jobs.stats();
    assert.equal(stats.SUCCEEDED, 1);
    await assert.rejects(
      () => jobs.enqueue({ type: "publication.publish", payload: {}, idempotencyKey: key }),
      (error: unknown) => {
        assert.ok(error instanceof JobsError);
        assert.equal(error.code, "JOB_ALREADY_COMPLETED");
        return true;
      },
    );

    // After CANCELLATION the key is free again (cancel + reschedule flow).
    const cancelKey = "plan-item-7:publish";
    const job = (
      await jobs.enqueue({ type: "publication.publish", payload: {}, idempotencyKey: cancelKey })
    ).job;
    await jobs.cancelPendingJob(job.id);
    const recreated = await jobs.enqueue({
      type: "publication.publish",
      payload: {},
      idempotencyKey: cancelKey,
    });
    assert.equal(recreated.duplicate, false);
  });
});

test("cancel-pending vs worker-claim race: exactly one side wins", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withJobsFixture(t, async (_pool, jobs) => {
    const job = (await jobs.enqueue({ type: "publication.publish", payload: {} })).job;
    const [claimed] = await jobs.claim({ workerId: "w1", limit: 5, leaseMilliseconds: 60_000 });
    const cancelled = await jobs.cancelPendingJob(job.id);
    assert.equal(cancelled, false, "cannot cancel a RUNNING job via the pending path");
    assert.equal(claimed?.id, job.id);
    await jobs.complete(job.id);
    assert.equal((await jobs.getJob(_pool, job.id))?.state, "SUCCEEDED");
  });
});

test("lease recovery: worker death requeues expired RUNNING jobs", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withJobsFixture(t, async (_pool, jobs) => {
    await jobs.enqueue({ type: "test.died", payload: {} });
    await jobs.claim({ workerId: "dead-worker", limit: 5, leaseMilliseconds: 60_000 });
    // Simulated later boot of another worker: lease of the dead one expired.
    const recovery = createJobsService(_pool, { clock: fixedClock("2026-10-01T09:10:00Z") });
    const recovered = await recovery.recoverExpiredLeases();
    assert.equal(recovered, 1);
    const claimed = await recovery.claim({
      workerId: "new-worker",
      limit: 5,
      leaseMilliseconds: 60_000,
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.claimedBy, "new-worker");
  });
});

test("runner: executes jobs, classifies handler outcomes, stops gracefully", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withJobsFixture(
    t,
    async (_pool, jobs) => {
      const outcomes: string[] = [];
      const done: { type: string; outcome: string }[] = [];
      const runner = createJobRunner(
        jobs,
        {
          "test.ok": async () => {
            outcomes.push("ok");
          },
          "test.transient": async () => "transient" as const,
          "test.permanent": async () => "permanent" as const,
          "test.throwing": async () => {
            throw new Error("boom");
          },
        },
        {
          clock: CLOCK,
          onJobDone: (info) => done.push({ type: info.type, outcome: info.outcome }),
        },
        {
          pollIntervalMilliseconds: 50,
          claimBatchMax: 10,
          leaseMilliseconds: 60_000,
          runImmediately: true,
        },
      );
      await jobs.enqueue({ type: "test.ok", payload: {}, idempotencyKey: "k-ok" });
      await jobs.enqueue({ type: "test.transient", payload: {}, maxAttempts: 1 });
      await jobs.enqueue({ type: "test.permanent", payload: {} });
      await jobs.enqueue({ type: "test.throwing", payload: {}, maxAttempts: 2 });
      await jobs.enqueue({ type: "test.unhandled", payload: {} });

      runner.start();
      // Deterministic drain: wait for all five to reach a terminal state.
      for (let i = 0; i < 100; i += 1) {
        const stats = await jobs.stats();
        const terminal = stats.SUCCEEDED + stats.DEAD + stats.CANCELLED;
        if (terminal >= 5) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(await runner.stop(5000), true, "drains in-flight work within the bound");

      const stats = await jobs.stats();
      assert.equal(stats.SUCCEEDED, 1);
      assert.equal(stats.DEAD, 4, "permanent + exhausted transient + throwing + unknown handler");
      assert.deepEqual(outcomes, ["ok"]);
      const dead = await jobs.listDeadLetters();
      assert.deepEqual(dead.map((j) => j.type).sort(), [
        "test.permanent",
        "test.throwing",
        "test.transient",
        "test.unhandled",
      ]);
      assert.ok(done.length >= 5);
    },
    6,
  );
});
