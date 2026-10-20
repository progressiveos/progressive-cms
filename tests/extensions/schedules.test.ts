// D06 — Periodic extension jobs.
//
// Layers:
//  - unit: interval gating and disabled/on-demand rules against a recording
//    sink;
//  - integration: the REAL JobsService + PostgreSQL. These are the tests that
//    matter, because the schedule guarantees are database guarantees:
//      * a second interval produces a NEW execution (the shipped defect: one
//        constant key stopped the schedule after its first success);
//      * a task running longer than several intervals is never restarted;
//      * two schedulers at an interval boundary cannot both enqueue;
//      * a restarted scheduler keeps scheduling.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { createExtensionCatalog, type DeployedExtensionArtifact } from "@pcms/extensions/internal";
import { createJobsService, type JobsService } from "@pcms/jobs";
import { createExtensionScheduleService } from "../../packages/api/src/extension-schedules.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

function artifact(
  id: string,
  jobs: readonly {
    job_id: string;
    handler: string;
    payload_version: number;
    accepts_payload_versions?: readonly number[];
    interval_seconds?: number;
  }[],
  module: Record<string, unknown> = {},
): DeployedExtensionArtifact {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      extension_contract: "2.0",
      cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
      requires: [],
      provides: [],
      permissions: [],
      config_schema: undefined,
      migrations: undefined,
      data_policy: "retain",
      entrypoint: { type: "module" },
      registrations: {
        blocks: [],
        field_types: [],
        routes: [],
        event_subscriptions: [],
        validators: [],
        providers: [],
        operations: [],
        http_routes: [],
        views: [],
        sitemap_sources: [],
        search_sources: [],
        media_usage_sources: [],
        jobs,
        obligations: [],
      },
    } as never,
    module,
    migrationsDir: "/tmp/none",
    extensionsDir: "/tmp/none",
    contentSha256: "0".repeat(64),
  };
}

interface RecurringCall {
  readonly type: string;
  readonly idempotencyKey?: string | undefined;
  readonly runAt?: Date | undefined;
  readonly origin?: string | undefined;
}

interface Sink {
  readonly calls: RecurringCall[];
  outcome: "enqueued" | "active" | "already_completed" | "busy";
}

async function setup(artifacts: DeployedExtensionArtifact[], clockNow: () => Date, sink: Sink) {
  const catalog = createExtensionCatalog();
  for (const artifact of artifacts) catalog.register(artifact);
  const enabledIds = async () => catalog.list().map((a) => a.manifest.id);
  const service = createExtensionScheduleService({
    jobs: {
      enqueueRecurring: async (input) => {
        if (sink.outcome === "enqueued") {
          sink.calls.push({
            type: input.type,
            idempotencyKey: input.idempotencyKey,
            runAt: input.runAt,
            origin: input.origin,
          });
        }
        return { outcome: sink.outcome, job: { id: "job" } as never };
      },
    },
    catalog,
    enabledIds,
    clock: { now: clockNow },
  });
  return { service, catalog };
}

const sweepArtifact = (intervalSeconds: number) =>
  artifact(
    "com.example.sweep",
    [
      {
        job_id: "expiry_sweep",
        handler: "run",
        payload_version: 1,
        interval_seconds: intervalSeconds,
      },
    ],
    { run: async () => {} },
  );

test("D06: enqueueDue enqueues each scheduled job once per interval window", async () => {
  const clock = { now: () => new Date("2026-10-18T10:00:00.000Z") };
  const sink: Sink = { calls: [], outcome: "enqueued" };
  const { service } = await setup([sweepArtifact(300)], clock.now, sink);

  const first = await service.enqueueDue();
  assert.equal(first.enqueued, 1);
  assert.equal(first.skipped, 0);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0]!.type, "com.example.sweep/expiry_sweep");
  assert.match(
    sink.calls[0]!.idempotencyKey ?? "",
    /^extschedule:com\.example\.sweep\/expiry_sweep:\d+$/,
  );
  assert.equal(sink.calls[0]!.origin, "extension-schedule:com.example.sweep/expiry_sweep");
});

test("D06: enqueueDue skips within the interval", async () => {
  const clock = { now: () => new Date("2026-10-18T10:00:00.000Z") };
  const sink: Sink = { calls: [], outcome: "enqueued" };
  const { service } = await setup([sweepArtifact(300)], clock.now, sink);
  await service.enqueueDue();
  const second = await service.enqueueDue();
  assert.equal(second.enqueued, 0);
  assert.equal(sink.calls.length, 1);
});

test("D06: enqueueDue uses a NEW bucket key after the interval", async () => {
  let now = new Date("2026-10-18T10:00:00.000Z").getTime();
  const clock = { now: () => new Date(now) };
  const sink: Sink = { calls: [], outcome: "enqueued" };
  const { service } = await setup([sweepArtifact(60)], clock.now, sink);

  await service.enqueueDue();
  now += 59_000;
  await service.enqueueDue();
  assert.equal(sink.calls.length, 1, "still inside the interval");

  now += 2_000;
  const third = await service.enqueueDue();
  assert.equal(third.enqueued, 1);
  assert.notEqual(
    sink.calls[0]!.idempotencyKey,
    sink.calls[1]!.idempotencyKey,
    "a new interval must use a new idempotency key",
  );
});

test("D06: disabled extensions are never scheduled", async () => {
  const clock = { now: () => new Date("2026-10-18T10:00:00.000Z") };
  const sink: Sink = { calls: [], outcome: "enqueued" };
  const catalog = createExtensionCatalog();
  catalog.register(sweepArtifact(60));
  const service = createExtensionScheduleService({
    jobs: {
      enqueueRecurring: async (input) => {
        sink.calls.push({ type: input.type, idempotencyKey: input.idempotencyKey });
        return { outcome: "enqueued", job: { id: "x" } as never };
      },
    },
    catalog,
    enabledIds: async () => ["com.example.other"],
    clock: { now: clock.now },
  });
  const result = await service.enqueueDue();
  assert.equal(result.enqueued, 0);
  assert.equal(sink.calls.length, 0);
});

test("D06: jobs without interval_seconds are never auto-enqueued", async () => {
  const clock = { now: () => new Date("2026-10-18T10:00:00.000Z") };
  const sink: Sink = { calls: [], outcome: "enqueued" };
  const { service } = await setup(
    [artifact("com.example.ondemand", [{ job_id: "work", handler: "run", payload_version: 1 }])],
    clock.now,
    sink,
  );
  const result = await service.enqueueDue();
  assert.equal(result.enqueued, 0);
  assert.equal(sink.calls.length, 0);
});

test("D06: a busy/active queue outcome is reported as skipped, not enqueued", async () => {
  const clock = { now: () => new Date("2026-10-18T10:00:00.000Z") };
  for (const outcome of ["active", "already_completed", "busy"] as const) {
    const sink: Sink = { calls: [], outcome };
    const { service } = await setup([sweepArtifact(60)], clock.now, sink);
    const result = await service.enqueueDue();
    assert.equal(result.enqueued, 0, outcome);
    assert.equal(result.skipped, 1, outcome);
  }
});

// ---------------------------------------------------------------- real DB ---

interface RealFixture {
  readonly pool: DbPool;
  readonly jobs: JobsService;
  readonly clock: { now: () => Date; advance: (ms: number) => void; set: (d: Date) => void };
}

async function realSetup(
  t: import("node:test").TestContext,
  intervalSeconds: number,
): Promise<RealFixture> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 6 });
  t.after(() => void pool.end());
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  let now = new Date("2026-10-18T10:00:00.000Z").getTime();
  const clock = {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
    set: (d: Date) => {
      now = d.getTime();
    },
  };
  const jobs = createJobsService(pool, { clock: { now: clock.now } });
  // The interval is read from the manifest, so re-register per fixture.
  createExtensionCatalog();
  void intervalSeconds;
  return { pool, jobs, clock };
}

function scheduler(jobs: JobsService, clock: { now: () => Date }, intervalSeconds: number) {
  const catalog = createExtensionCatalog();
  catalog.register(sweepArtifact(intervalSeconds));
  return createExtensionScheduleService({
    jobs: { enqueueRecurring: (input) => jobs.enqueueRecurring(input) },
    catalog,
    enabledIds: async () => ["com.example.sweep"],
    clock: { now: clock.now },
  });
}

/** Claims every pending job and leaves it RUNNING (a long-running task). */
async function claimAll(pool: DbPool, jobs: JobsService, workerId: string): Promise<string[]> {
  const claimed = await jobs.claim({ workerId, limit: 50, leaseMilliseconds: 3_600_000 });
  return claimed.map((job) => job.id as string);
}

async function completeIds(jobs: JobsService, ids: readonly string[]): Promise<void> {
  for (const id of ids) await jobs.complete(id as never);
}

async function runCount(pool: DbPool): Promise<number> {
  const rows = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM jobs WHERE type = 'com.example.sweep/expiry_sweep'",
  );
  return Number(rows.rows[0]?.n ?? "0");
}

test("D06 (real queue): two consecutive intervals both EXECUTE", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, jobs, clock } = await realSetup(t, 60);
  const service = scheduler(jobs, clock, 60);

  assert.equal((await service.enqueueDue()).enqueued, 1);
  await completeIds(jobs, await claimAll(pool, jobs, "w1"));

  clock.advance(61_000);
  const second = await service.enqueueDue();
  assert.equal(second.enqueued, 1, "the schedule must not stop after its first success");
  await completeIds(jobs, await claimAll(pool, jobs, "w1"));

  const done = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM jobs WHERE state = 'SUCCEEDED'",
  );
  assert.equal(Number(done.rows[0]?.n), 2, "two distinct successful executions");
});

test("D06 (real queue): a run longer than three intervals is never restarted", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, jobs, clock } = await realSetup(t, 60);
  const service = scheduler(jobs, clock, 60);

  // Start a run and leave it RUNNING for three whole windows.
  assert.equal((await service.enqueueDue()).enqueued, 1);
  const slow = await claimAll(pool, jobs, "slow-worker");

  for (let window = 1; window <= 3; window += 1) {
    clock.advance(61_000);
    const result = await service.enqueueDue();
    assert.equal(result.enqueued, 0, `window ${window}: a long run must not be doubled`);
    assert.equal(result.skipped, 1);
  }
  assert.equal(await runCount(pool), 1, "exactly one run exists for the whole slow period");

  // Once it actually finishes, the next window schedules again.
  await completeIds(jobs, slow);
  clock.advance(61_000);
  assert.equal((await service.enqueueDue()).enqueued, 1);
  assert.equal(await runCount(pool), 2);
});

test("D06 (real queue): two schedulers at an interval boundary cannot both enqueue", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, jobs, clock } = await realSetup(t, 60);

  // Both schedulers observe the SAME instant straddling a window boundary, so
  // without the shared advisory lock they would insert two different buckets.
  const boundary = new Date("2026-10-18T10:01:00.000Z");
  const workerA = scheduler(jobs, { now: () => new Date(boundary.getTime() - 1) }, 60);
  const workerB = scheduler(jobs, { now: () => new Date(boundary.getTime() + 1) }, 60);

  const [a, b] = await Promise.all([workerA.enqueueDue(), workerB.enqueueDue()]);
  const enqueued = a.enqueued + b.enqueued;
  assert.equal(enqueued, 1, "exactly one of the two schedulers wins");
  assert.equal(a.skipped + b.skipped, 1, "the loser reports the task as already active");
  assert.equal(await runCount(pool), 1, "no duplicate run at the boundary");
});

test("D06 (real queue): a competing scheduler holding the lock makes this one report busy", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, jobs, clock } = await realSetup(t, 60);
  // Deterministic: another session holds exactly the lock enqueueRecurring
  // takes, so a scheduler that omitted the lock would still insert a run.
  const outcome = await pool.withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "pcms:schedule:com.example.sweep/expiry_sweep",
    ]);
    return jobs.enqueueRecurring({
      type: "com.example.sweep/expiry_sweep",
      payload: null,
      idempotencyKey: `extschedule:com.example.sweep/expiry_sweep:${Math.floor(
        clock.now().getTime() / 60_000,
      )}`,
    });
  });
  assert.equal(
    (outcome as { outcome: string }).outcome,
    "busy",
    "check and insert must be serialized by an advisory lock",
  );
  const rows = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM jobs WHERE type = 'com.example.sweep/expiry_sweep'",
  );
  assert.equal(
    Number(rows.rows[0]?.n),
    0,
    "no run inserted while another scheduler holds the lock",
  );
});

test("D06 (real queue): a restarted scheduler keeps scheduling", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, jobs, clock } = await realSetup(t, 60);
  const first = scheduler(jobs, clock, 60);
  await first.enqueueDue();
  await completeIds(jobs, await claimAll(pool, jobs, "w1"));

  const restarted = scheduler(jobs, clock, 60); // fresh in-memory state
  clock.advance(61_000);
  assert.equal((await restarted.enqueueDue()).enqueued, 1);
  await completeIds(jobs, await claimAll(pool, jobs, "w2"));
});

test("D06 (real queue): repeated enqueueDue in the same window creates no duplicate", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool, jobs, clock } = await realSetup(t, 300);
  const service = scheduler(jobs, clock, 300);
  assert.equal((await service.enqueueDue()).enqueued, 1);
  assert.equal((await service.enqueueDue()).enqueued, 0);
  assert.equal(await runCount(pool), 1);
});

test("D06 regression: restart after success in the same window does not abort later schedules", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool } = await rollbackApiFixture(t, {});
  const clock = { now: () => new Date("2026-10-18T10:00:00.000Z") };
  const jobs = createJobsService(pool, { clock });
  assert.equal((await scheduler(jobs, clock, 60).enqueueDue()).enqueued, 1);
  const [firstId] = await claimAll(pool, jobs, "before-restart");
  assert.ok(firstId);
  await completeIds(jobs, [firstId]);

  const catalog = createExtensionCatalog();
  catalog.register(sweepArtifact(60));
  catalog.register(
    artifact("com.example.z-next", [
      { job_id: "next", handler: "run", payload_version: 1, interval_seconds: 60 },
    ]),
  );
  const restarted = createExtensionScheduleService({
    jobs,
    catalog,
    enabledIds: async () => ["com.example.sweep", "com.example.z-next"],
    clock,
  });
  assert.deepEqual(await restarted.enqueueDue(), { enqueued: 1, skipped: 1 });
  assert.equal(await runCount(pool), 1, "the completed window is not duplicated");
  assert.equal((await jobs.getJob(pool, firstId as never))?.state, "SUCCEEDED");
  const later = await jobs.claim({
    workerId: "after-restart",
    limit: 10,
    leaseMilliseconds: 60_000,
  });
  assert.deepEqual(
    later.map((job) => job.type),
    ["com.example.z-next/next"],
  );
  await completeIds(
    jobs,
    later.map((job) => job.id),
  );
});

test("D06 regression: recurring enqueue propagates other database errors and rolls back", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const { pool } = await rollbackApiFixture(t, {});
  const jobs = createJobsService(pool, { clock: { now: () => new Date() } });
  const input = {
    type: "com.example.sweep/expiry_sweep",
    payload: null,
    idempotencyKey: "review:rollback",
  };
  await assert.rejects(() => jobs.enqueueRecurring({ ...input, payloadVersion: 1.5 }), {
    code: "22P02",
  });
  assert.equal(await runCount(pool), 0);
  assert.equal((await jobs.enqueueRecurring({ ...input, payloadVersion: 1 })).outcome, "enqueued");
});
