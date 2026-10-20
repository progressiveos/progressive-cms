// PCMS-PUB-T020–T025 — PublicationPlan compiler, timezone/DST, per-entry
// scheduling, the 35/3/12h batch fixture, scheduled executor idempotency,
// cancel/reschedule/publish-now and failure policies (Publication spec
// §22–§36), against real PostgreSQL.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  fixedClock,
  loadMigrations,
  migrateDatabase,
  newStableId,
  type StableId,
} from "@pcms/core";
import { createJobsService, type JobsService } from "@pcms/jobs";
import {
  type ChangeSetService,
  createChangeSetService,
  createPublicationJobHandlers,
  createPublicationPlanService,
  createPublicationService,
  type PublicationPlanService,
  type PublicationService,
} from "@pcms/publication";
import { createRevisionStore, createVersionedEntityRegistry } from "@pcms/revisions";
import { revisionReaderFromStore } from "../helpers/publication-composition.js";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const CLOCK = fixedClock("2026-01-15T09:00:00Z");
const ACTOR = { actorClass: "human", actorId: "editor-1" } as const;

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

interface Fixture {
  readonly pool: DbPool;
  readonly jobs: JobsService;
  readonly changesets: ChangeSetService;
  readonly publications: PublicationService;
  readonly plans: PublicationPlanService;
  readonly handlers: ReturnType<typeof createPublicationJobHandlers>;
  readonly store: ReturnType<typeof createRevisionStore>;
}

async function withPlanFixture(
  t: { after: (fn: () => void) => void },
  run: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 8,
    connectionTimeoutMilliseconds: 5000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const store = createRevisionStore(pool, {
    registry: createVersionedEntityRegistry(
      ["entry", "global_content", "theme_settings", "navigation"].map((entityType) => ({
        entityType,
        description: entityType,
        validateForSeal: () => [],
      })),
    ),
    clock: CLOCK,
  });
  const revisions = revisionReaderFromStore(store);
  const publications = createPublicationService(pool, { clock: CLOCK, revisions });
  const changesets = createChangeSetService(pool, { clock: CLOCK, revisions, publications });
  const jobs = createJobsService(pool, { clock: CLOCK, backoffBaseMilliseconds: 0 });
  const plans = createPublicationPlanService(pool, {
    clock: CLOCK,
    changesets,
    publications,
    jobs,
  });
  const handlers = createPublicationJobHandlers({
    pool,
    clock: CLOCK,
    publications,
    changesets,
    siteKey: "default",
  });
  await run({ pool, jobs, changesets, publications, plans, handlers, store });
}

/** Drives the executor deterministically: claims due jobs and runs them. */
async function drainJobs(fx: Fixture, maxRounds = 4): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = await fx.jobs.claim({
      workerId: "executor-test",
      limit: 100,
      leaseMilliseconds: 60_000,
    });
    if (claimed.length === 0) return;
    for (const job of claimed) {
      const handler = fx.handlers[job.type as "publication.publish" | "publication.unpublish"];
      if (handler === undefined) continue;
      await handler(job.payload as never, { job: { id: job.id as string }, attempt: job.attempts });
    }
  }
}

test("35-item batch 3 per 12h compiles to deterministic persisted timestamps", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPlanFixture(t, async (fx) => {
    const changeset = await fx.changesets.createChangeset({ title: "batch release", actor: ACTOR });
    for (let i = 0; i < 35; i += 1) {
      const entityId = newStableId();
      const revisionId = await sealDirect(fx, entityId);
      await fx.changesets.addItem(changeset.id, {
        entityType: "entry",
        entityId,
        intent: "PUBLISH",
        targetRevisionId: revisionId,
        expectedGeneration: 0,
      });
    }
    const plan = await fx.plans.createPlan({
      changesetId: changeset.id,
      timezone: "Europe/Berlin",
      actor: ACTOR,
    });

    const startAt = new Date("2026-10-01T07:00:00Z");
    const preview = await fx.plans.previewPlan(plan.id, {
      startAt,
      batchSize: 3,
      interval: { unit: "hours", value: 12 },
    });
    assert.equal(preview.length, 35);
    // Batches: 12 total (11×3 + 2). Batch k starts at 07:00Z + 12h×k.
    const expectedBatchStart = (k: number) => new Date(startAt.getTime() + k * 12 * 3_600_000);
    assert.deepEqual(preview[0]?.publishAt, expectedBatchStart(0));
    assert.deepEqual(preview[2]?.publishAt, expectedBatchStart(0));
    assert.deepEqual(preview[3]?.publishAt, expectedBatchStart(1));
    assert.deepEqual(preview[33]?.publishAt, expectedBatchStart(11));
    assert.deepEqual(preview[34]?.publishAt, expectedBatchStart(11));

    // Preview is a dry run: nothing persisted yet.
    assert.equal((await fx.plans.getPlan(plan.id)).status, "DRAFT");

    // Compilation persists exactly the previewed timestamps.
    const compiled = await fx.plans.compilePlan(plan.id, {
      startAt,
      batchSize: 3,
      interval: { unit: "hours", value: 12 },
    });
    assert.deepEqual(
      compiled.map((entry) => entry.publishAt?.getTime()),
      preview.map((entry) => entry.publishAt?.getTime()),
      "compile matches preview deterministically",
    );
    assert.equal((await fx.plans.getPlan(plan.id)).status, "COMPILED");
    assert.equal((await fx.changesets.getChangeset(changeset.id)).state, "PARTIALLY_SCHEDULED");

    const items = await fx.plans.listPlanItems(plan.id);
    assert.equal(items.filter((item) => item.state === "SCHEDULED").length, 35);
    const jobStats = await fx.jobs.stats();
    assert.equal(jobStats.PENDING, 35, "one idempotent publish job per item");
  });
});

test("plans preserve ChangeSet position with colliding UUIDv7 prefixes and share preview/compile mapping", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPlanFixture(t, async (fx) => {
    const changesetId = await seedChangeset(fx, 3);
    const deliberatelyReverseSortedIds = [
      "01900000-0000-7000-8000-000000000003",
      "01900000-0000-7000-8000-000000000002",
      "01900000-0000-7000-8000-000000000001",
    ];
    await fx.pool.query(
      `UPDATE changeset_items SET id = CASE position
         WHEN 0 THEN $2::uuid WHEN 1 THEN $3::uuid WHEN 2 THEN $4::uuid END
       WHERE changeset_id = $1`,
      [changesetId, ...deliberatelyReverseSortedIds],
    );
    const changesetItems = await fx.changesets.listItems(changesetId);
    assert.deepEqual(
      changesetItems.map((item) => item.id),
      deliberatelyReverseSortedIds,
      "fixture UUID order is deliberately opposite to editorial position",
    );

    const plan = await fx.plans.createPlan({
      changesetId,
      timezone: "UTC",
      actor: ACTOR,
    });
    const dailySpec = {
      startLocal: { date: "2026-02-01", time: "10:00" },
      batchSize: 1,
      interval: { unit: "days" as const, value: 1 },
    };
    const preview = await fx.plans.previewPlan(plan.id, dailySpec);
    assert.deepEqual(
      preview.map((item) => item.changesetItemId),
      deliberatelyReverseSortedIds,
    );
    assert.deepEqual(
      preview.map((item) => item.publishAt?.toISOString()),
      ["2026-02-01T10:00:00.000Z", "2026-02-02T10:00:00.000Z", "2026-02-03T10:00:00.000Z"],
    );
    const compiled = await fx.plans.compilePlan(plan.id, dailySpec);
    assert.deepEqual(
      compiled.map((item) => [item.changesetItemId, item.publishAt?.getTime()]),
      preview.map((item) => [item.changesetItemId, item.publishAt?.getTime()]),
    );

    const batchedPlan = await fx.plans.createPlan({
      changesetId,
      timezone: "UTC",
      actor: ACTOR,
    });
    const batchedPreview = await fx.plans.previewPlan(batchedPlan.id, {
      ...dailySpec,
      batchSize: 2,
    });
    assert.deepEqual(
      batchedPreview.map((item) => item.publishAt?.toISOString()),
      ["2026-02-01T10:00:00.000Z", "2026-02-01T10:00:00.000Z", "2026-02-02T10:00:00.000Z"],
    );
    assert.equal((await fx.plans.getPlan(batchedPlan.id)).status, "DRAFT");

    const firstChangesetItem = changesetItems[0];
    assert.ok(firstChangesetItem);
    const validOverride = {
      changesetItemId: firstChangesetItem.id,
      publishAt: new Date("2026-02-01T10:00:00Z"),
    };
    await assert.rejects(
      () =>
        fx.plans.previewPlan(batchedPlan.id, dailySpec, [
          { ...validOverride, changesetItemId: newStableId() },
        ]),
      (error: unknown) => (error as { code?: string }).code === "PLAN_INVALID",
    );
    await assert.rejects(
      () => fx.plans.previewPlan(batchedPlan.id, dailySpec, [validOverride, validOverride]),
      (error: unknown) => (error as { code?: string }).code === "PLAN_INVALID",
    );
    await assert.rejects(
      () =>
        fx.plans.previewPlan(batchedPlan.id, dailySpec, [
          { ...validOverride, publishAt: new Date(Number.NaN) },
        ]),
      (error: unknown) => (error as { code?: string }).code === "PLAN_INVALID",
    );
    await assert.rejects(
      () =>
        fx.plans.previewPlan(batchedPlan.id, dailySpec, [
          { ...validOverride, publishAt: new Date("2026-01-01T10:00:00Z") },
        ]),
      (error: unknown) => (error as { code?: string }).code === "SCHEDULE_IN_PAST",
    );
    assert.equal((await fx.jobs.stats()).PENDING, 3, "preview does not create jobs");
  });
});

test("day-based local schedules preserve wall-clock across DST (Berlin spring, NY fall)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPlanFixture(t, async (fx) => {
    // Berlin spring forward: 2026-03-29, 02:00→03:00 local.
    const plan = await fx.plans.createPlan({
      changesetId: await seedChangeset(fx, 2),
      timezone: "Europe/Berlin",
      actor: ACTOR,
    });
    const entries = await fx.plans.compilePlan(plan.id, {
      startLocal: { date: "2026-03-28", time: "09:00" },
      batchSize: 1,
      interval: { unit: "days", value: 1 },
    });
    // 2026-03-28 09:00 CET = 08:00Z; 2026-03-29 09:00 CEST = 07:00Z.
    assert.deepEqual(entries[0]?.publishAt, new Date("2026-03-28T08:00:00Z"));
    assert.deepEqual(entries[1]?.publishAt, new Date("2026-03-29T07:00:00Z"));

    // New York fall back: 2026-11-01, 02:00→01:00 local.
    const plan2 = await fx.plans.createPlan({
      changesetId: await seedChangeset(fx, 2),
      timezone: "America/New_York",
      actor: ACTOR,
    });
    const entries2 = await fx.plans.compilePlan(plan2.id, {
      startLocal: { date: "2026-10-31", time: "09:00" },
      batchSize: 1,
      interval: { unit: "days", value: 1 },
    });
    // EDT (UTC-4) 09:00 = 13:00Z; EST (UTC-5) 09:00 = 14:00Z.
    assert.deepEqual(entries2[0]?.publishAt, new Date("2026-10-31T13:00:00Z"));
    assert.deepEqual(entries2[1]?.publishAt, new Date("2026-11-01T14:00:00Z"));

    // Nonexistent spring-forward wall time resolves after the transition.
    const plan3 = await fx.plans.createPlan({
      changesetId: await seedChangeset(fx, 1),
      timezone: "Europe/Berlin",
      actor: ACTOR,
    });
    const entries3 = await fx.plans.compilePlan(plan3.id, {
      startLocal: { date: "2026-03-29", time: "02:30" },
      batchSize: 1,
      interval: { unit: "days", value: 1 },
    });
    const instant = entries3[0]!.publishAt;
    assert.ok(instant !== null, "compiled entry carries a publishAt instant");
    const wall = (await import("@pcms/publication")).instantToZonedWallClock(
      instant,
      "Europe/Berlin",
    );
    assert.ok(
      wall.hour >= 3,
      `02:30 local resolves past the transition (got ${wall.hour}:${wall.minute})`,
    );
  });
});

test("per-entry scheduling: explicit publish_at/unpublish_at overrides persist as UTC", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPlanFixture(t, async (fx) => {
    const changesetId = await seedChangeset(fx, 2);
    const items = await fx.changesets.listItems(changesetId);
    const plan = await fx.plans.createPlan({
      changesetId,
      timezone: "Europe/Berlin",
      actor: ACTOR,
    });
    const publishAt = new Date("2026-10-05T08:00:00Z");
    const unpublishAt = new Date("2026-11-05T08:00:00Z");
    await fx.plans.compilePlan(
      plan.id,
      {
        startAt: new Date("2026-10-01T07:00:00Z"),
        batchSize: 10,
        interval: { unit: "hours", value: 1 },
      },
      [{ changesetItemId: items[0]!.id, publishAt, unpublishAt }],
    );
    const planItems = await fx.plans.listPlanItems(plan.id);
    const overridden = planItems.find((item) => item.changesetItemId === items[0]!.id);
    assert.deepEqual(overridden?.publishAt, publishAt);
    assert.deepEqual(overridden?.unpublishAt, unpublishAt);
    assert.deepEqual(overridden?.unpublishJobId !== null, true, "unpublish job scheduled");
    assert.equal((await fx.jobs.stats()).PENDING, 3, "2 publish + 1 unpublish");
  });
});

test("executor: scheduled publish executes once; retries and re-dispatch never duplicate", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPlanFixture(t, async (fx) => {
    const { plan, entityId, revisionId } = await seedScheduledItem(fx);
    // Advance past run_at by claiming with the fixed clock (run_at <= now).
    await drainJobs(fx);
    const publication = await fx.publications.getPublication(fx.pool, "entry", entityId);
    assert.equal(publication?.state, "PUBLISHED");
    assert.deepEqual(publication?.currentRevisionId, revisionId);
    const items = await fx.plans.listPlanItems(plan.id);
    assert.equal(items[0]?.state, "PUBLISHED");
    assert.equal((await fx.plans.getPlan(plan.id)).status, "COMPLETED");
    const events = await fx.publications.listPublicationEvents(fx.pool, "entry", entityId);
    assert.equal(events.filter((e) => e.eventType === "PUBLISH_FIRST").length, 1);

    // Re-running the drain executes nothing further.
    await drainJobs(fx);
    const eventsAfter = await fx.publications.listPublicationEvents(fx.pool, "entry", entityId);
    assert.equal(eventsAfter.length, events.length, "no duplicate publication events");
  });
});

test("cancel before execution: job runs into CANCELLED item and skips publication", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPlanFixture(t, async (fx) => {
    const { plan, entityId } = await seedScheduledItem(fx);
    const items = await fx.plans.listPlanItems(plan.id);
    await fx.plans.cancelItem(plan.id, items[0]!.id, ACTOR);
    await drainJobs(fx);
    assert.equal(await fx.publications.getPublication(fx.pool, "entry", entityId), null);
  });
});

test("reschedule atomically replaces the pending job; publish-now publishes exactly once", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPlanFixture(t, async (fx) => {
    const { plan, entityId, revisionId } = await seedScheduledItem(fx);
    const items = await fx.plans.listPlanItems(plan.id);
    const newTime = new Date("2026-09-20T12:00:00Z");
    const rescheduled = await fx.plans.rescheduleItem(plan.id, items[0]!.id, newTime);
    assert.deepEqual(rescheduled.publishAt, newTime);
    const jobStats = await fx.jobs.stats();
    assert.ok(jobStats.PENDING <= 1, "no duplicate pending jobs after reschedule");

    // Publish now: cancels the pending schedule, publishes immediately.
    await fx.plans.publishNow(plan.id, items[0]!.id, ACTOR);
    const publication = await fx.publications.getPublication(fx.pool, "entry", entityId);
    assert.equal(publication?.state, "PUBLISHED");
    assert.deepEqual(publication?.currentRevisionId, revisionId);
    assert.equal((await fx.jobs.stats()).PENDING, 0, "pending schedule cancelled");
    // Executing any leftovers publishes nothing twice.
    await drainJobs(fx);
    const events = await fx.publications.listPublicationEvents(fx.pool, "entry", entityId);
    assert.equal(events.filter((e) => e.eventType === "PUBLISH_FIRST").length, 1);
  });
});

test("failure policies: drift fails the item; pause_plan parks the rest", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPlanFixture(t, async (fx) => {
    // Plan of 3 items; after compile, drift item 0 by publishing it directly.
    const changesetId = await seedChangeset(fx, 3);
    const items = await fx.changesets.listItems(changesetId);
    const plan = await fx.plans.createPlan({
      changesetId,
      timezone: "UTC",
      failurePolicy: "pause_plan",
      actor: ACTOR,
    });
    await fx.plans.compilePlan(plan.id, {
      startAt: new Date("2026-01-15T09:00:00Z"),
      batchSize: 3,
      interval: { unit: "hours", value: 1 },
    });
    const first = items[0]!;
    // Drift: target revision changes between compile and execution —
    // publish a DIFFERENT revision directly so the job's CAS baseline moves.
    const working = await fx.store.createWorkingRevision({
      entityType: first.entityType,
      entityId: first.entityId,
      payload: { drifted: true },
      schemaVersion: "1",
      actor: { actorClass: "system", actorId: "fixture", origin: "system" },
    });
    const drifted = await fx.store.sealRevision({ revisionId: working.id });

    // Simulate drift: publish the entity directly ahead of the job with a
    // fresh generation (the scheduled job's compile-time CAS baseline is 0).
    await fx.publications.publish({
      entityType: first.entityType,
      entityId: first.entityId,
      targetRevisionId: drifted.id,
      expectedGeneration: 0,
      actor: ACTOR,
    });

    await drainJobs(fx);
    const planItems = await fx.plans.listPlanItems(plan.id);
    const driftedItem = planItems.find((item) => item.changesetItemId === first.id)!;
    assert.equal(driftedItem.state, "FAILED", "drifted item fails permanent");
    assert.ok(
      planItems
        .filter((item) => item.id !== driftedItem.id)
        .every((item) => item.state === "PAUSED"),
      "pause_plan parks every remaining scheduled item",
    );
    assert.equal((await fx.plans.getPlan(plan.id)).status, "PAUSED");
  });
});

// -- helpers -----------------------------------------------------------------

async function sealDirect(fx: Fixture, entityId: StableId): Promise<StableId> {
  const store = fx.store;
  const working = await store.createWorkingRevision({
    entityType: "entry",
    entityId,
    payload: { seeded: true },
    schemaVersion: "1",
    actor: { actorClass: "system", actorId: "fixture", origin: "system" },
  });
  return (await store.sealRevision({ revisionId: working.id })).id;
}

async function seedChangeset(fx: Fixture, itemCount: number): Promise<StableId> {
  const changeset = await fx.changesets.createChangeset({ title: "plan fixture", actor: ACTOR });
  for (let i = 0; i < itemCount; i += 1) {
    const entityId = newStableId();
    const revisionId = await sealDirect(fx, entityId);
    await fx.changesets.addItem(changeset.id, {
      entityType: "entry",
      entityId,
      intent: "PUBLISH",
      targetRevisionId: revisionId,
      expectedGeneration: 0,
    });
  }
  return changeset.id;
}

async function seedScheduledItem(fx: Fixture): Promise<{
  plan: Awaited<ReturnType<PublicationPlanService["createPlan"]>>;
  entityId: StableId;
  revisionId: StableId;
}> {
  const changesetId = await seedChangeset(fx, 1);
  const items = await fx.changesets.listItems(changesetId);
  const plan = await fx.plans.createPlan({
    changesetId,
    timezone: "UTC",
    actor: ACTOR,
  });
  await fx.plans.compilePlan(plan.id, {
    startAt: new Date("2026-01-15T09:00:00Z"),
    batchSize: 1,
    interval: { unit: "hours", value: 1 },
  });
  const first = items[0];
  assert.ok(first, "changeset has an item");
  assert.ok(first.entityId, "changeset item carries entityId");
  // targetRevisionId is nullable on the record; scheduled plans in this
  // fixture always seal the revision before compiling.
  assert.ok(first.targetRevisionId, "changeset item carries a sealed revision");
  return {
    plan,
    entityId: first.entityId,
    revisionId: first.targetRevisionId,
  };
}
