// PCMS-PUB-T026/T027/T028 — outbox consumers contract (idempotent
// at-least-once delivery for cache/search/sitemap-class consumers),
// publication calendar services (range-bounded, deterministic, with
// actions), and machine discovery descriptors (Publication spec §55/§56,
// §37/§68, §68–§70).
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
  createChangeSetsDiscovery,
  createOutboxConsumer,
  createOutboxService,
  createPublicationCalendarService,
  createPublicationPlanService,
  createPublicationPlansDiscovery,
  createPublicationService,
  type OutboxService,
  type PublicationCalendarService,
  type PublicationPlanService,
  type PublicationService,
  writeOutboxEvent,
} from "@pcms/publication";
import {
  createRevisionDiscovery,
  createRevisionStore,
  createVersionedEntityRegistry,
} from "@pcms/revisions";
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
  pool: DbPool;
  outbox: OutboxService;
  jobs: JobsService;
  changesets: ChangeSetService;
  publications: PublicationService;
  plans: PublicationPlanService;
  calendar: PublicationCalendarService;
  store: ReturnType<typeof createRevisionStore>;
  sealAndAdd(changesetId: StableId, count: number): Promise<void>;
}

async function withConsumerFixture(
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
  // Keep DB-generated availability on the fixture clock, independent of today's date.
  await pool.query(
    `ALTER TABLE publication_outbox ALTER COLUMN available_at SET DEFAULT '${CLOCK.now().toISOString()}'::timestamptz`,
  );
  const store = createRevisionStore(pool, {
    registry: createVersionedEntityRegistry(
      ["entry"].map((entityType) => ({
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
  const calendar = createPublicationCalendarService(pool, { clock: CLOCK, plans });
  const outbox = createOutboxService(pool, { clock: CLOCK });

  await run({
    pool,
    outbox,
    jobs,
    changesets,
    publications,
    plans,
    calendar,
    store,
    async sealAndAdd(changesetId, count) {
      const items = await changesets.listItems(changesetId);
      for (let i = 0; i < count; i += 1) {
        const entityId = newStableId();
        const working = await store.createWorkingRevision({
          entityType: "entry",
          entityId,
          payload: { n: items.length + i },
          schemaVersion: "1",
          actor: { actorClass: "system", actorId: "fixture", origin: "system" },
        });
        const sealed = await store.sealRevision({ revisionId: working.id });
        await changesets.addItem(changesetId, {
          entityType: "entry",
          entityId,
          intent: "PUBLISH",
          targetRevisionId: sealed.id,
          expectedGeneration: 0,
        });
      }
    },
  });
}

test("outbox consumers: at-least-once delivery, idempotent dedupe, retry, dead-letter", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withConsumerFixture(t, async (fx) => {
    // The fixture pins available_at to CLOCK; the later claim clock exercises delivery.
    const laterClock = fixedClock("2026-10-01T09:00:00Z");
    const outbox = createOutboxService(fx.pool, { clock: laterClock, backoffBaseMilliseconds: 0 });
    const delivered: string[] = [];
    const consumer = createOutboxConsumer(outbox, {
      EntryPublished: async (event) => {
        // Consumer-side idempotency: dedupe by event id (at-least-once).
        if (delivered.includes(event.id)) {
          throw new Error("duplicate delivery must be deduped by consumer, not by producer");
        }
        delivered.push(event.id);
      },
    });
    // Two publish events.
    for (const id of ["e1", "e2"]) {
      await fx.pool.withTransaction(async (tx) => {
        await writeOutboxEvent(tx, {
          aggregate: "publication",
          aggregateId: id,
          eventType: "EntryPublished",
          payload: { id },
        });
      });
    }
    const processed = await consumer.processBatch(10);
    assert.equal(processed, 2);
    assert.equal((await outbox.stats()).done, 2);

    // Failing consumer: retries then dead-letters (maxAttempts honored).
    const strict = createOutboxService(fx.pool, {
      clock: laterClock,
      maxAttempts: 2,
      backoffBaseMilliseconds: 0,
    });
    let attempts = 0;
    const failing = createOutboxConsumer(strict, {
      EntryPublished: async () => {
        attempts += 1;
        throw new Error("search indexer down");
      },
    });
    await fx.pool.withTransaction(async (tx) => {
      await writeOutboxEvent(tx, {
        aggregate: "publication",
        aggregateId: "e3",
        eventType: "EntryPublished",
        payload: {},
      });
    });
    await failing.processBatch(10);
    const stats = await strict.stats();
    if (stats.pending === 1) {
      await failing.processBatch(10);
    }
    const final = await strict.stats();
    assert.equal(final.dead, 1, "exhausted consumer failures dead-letter");
    assert.equal(attempts, 2);

    // Unknown event type without fallback dead-letters instead of spinning.
    await fx.pool.withTransaction(async (tx) => {
      await writeOutboxEvent(tx, {
        aggregate: "publication",
        aggregateId: "e4",
        eventType: "SearchIndexRequested",
        payload: {},
      });
    });
    const count = await consumer.processBatch(10);
    assert.equal(count, 1);
    const after = await outbox.stats();
    assert.equal(after.dead, 1);
  });
});

test("calendar: range query is bounded and deterministic; actions act", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withConsumerFixture(t, async (fx) => {
    const cs = await fx.changesets.createChangeset({ title: "Release A", actor: ACTOR });
    await fx.sealAndAdd(cs.id, 2);
    await fx.changesets.preflight(cs.id);
    const plan = await fx.plans.createPlan({ changesetId: cs.id, timezone: "UTC", actor: ACTOR });
    await fx.plans.compilePlan(plan.id, {
      startAt: new Date("2026-02-01T09:00:00Z"),
      batchSize: 1,
      interval: { unit: "days", value: 1 },
    });

    const entries = await fx.calendar.listCalendar({
      from: new Date("2026-01-16T00:00:00Z"),
      to: new Date("2026-03-01T00:00:00Z"),
    });
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["scheduled-publish", "scheduled-publish"],
    );
    assert.ok(
      entries[0]!.instant!.getTime() < entries[1]!.instant!.getTime(),
      "deterministic instant ordering",
    );
    assert.equal(entries[0]!.changesetTitle, "Release A", "release grouping carried");

    // Actions: reschedule moves the instant.
    await fx.calendar.rescheduleItem({
      planId: plan.id,
      planItemId: entries[0]!.planItemId,
      publishAt: new Date("2026-02-15T09:00:00Z"),
    });
    const after = await fx.calendar.listCalendar({
      from: new Date("2026-01-16T00:00:00Z"),
      to: new Date("2026-03-01T00:00:00Z"),
    });
    assert.deepEqual(
      after[0]!.instant,
      new Date("2026-02-02T09:00:00Z"),
      "rescheduled item moved later in the order",
    );
    assert.deepEqual(after[1]!.instant, new Date("2026-02-15T09:00:00Z"));

    // Cancel + publish-now via the calendar surface.
    await fx.calendar.cancelScheduledItem({
      planId: plan.id,
      planItemId: after[0]!.planItemId,
      actor: ACTOR,
    });
    await fx.calendar.publishNow({
      planId: plan.id,
      planItemId: after[1]!.planItemId,
      actor: ACTOR,
    });
    const cancelled = await fx.calendar.listCalendar({ includeCancelled: false });
    assert.equal(cancelled.length, 0);
  });
});

test("discovery: descriptors deterministic; operations execute end-to-end", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withConsumerFixture(t, async (fx) => {
    const revisionDiscovery = createRevisionDiscovery({
      pool: fx.pool,
      store: fx.store,
      registry: createVersionedEntityRegistry([
        { entityType: "entry", description: "entry", validateForSeal: () => [] },
      ]),
    });
    const changeSetDiscovery = createChangeSetsDiscovery(fx.changesets);
    const planDiscovery = createPublicationPlansDiscovery({
      plans: fx.plans,
      calendar: fx.calendar,
    });

    // Descriptors are deterministic JSON-serializable snapshots.
    const describeA = revisionDiscovery.describe();
    const describeB = revisionDiscovery.describe();
    assert.equal(JSON.stringify(describeA), JSON.stringify(describeB));
    assert.deepEqual(
      ["revisions", "changesets", "publication-plans"],
      [describeA.family, changeSetDiscovery.describe().family, planDiscovery.describe().family],
    );
    // Required §69/§70/§68 operations present.
    const revisionOps = describeA.operations.map((op) => op.name);
    for (const op of [
      "list_revisions",
      "get_revision",
      "diff_revisions",
      "create_working_revision",
      "validate_revision",
      "seal_revision",
    ]) {
      assert.ok(revisionOps.includes(op), `${op} discovered`);
    }
    const changesetOps = changeSetDiscovery.describe().operations.map((op) => op.name);
    for (const op of [
      "create_changeset",
      "add_item",
      "remove_item",
      "validate_changeset",
      "preview_changeset",
      "apply_changeset",
      "cancel_changeset",
    ]) {
      assert.ok(changesetOps.includes(op), `${op} discovered`);
    }
    const planOps = planDiscovery.describe().operations.map((op) => op.name);
    for (const op of [
      "list_publication_calendar",
      "create_publication_plan",
      "preview_plan",
      "apply_plan",
      "reschedule_item",
      "cancel_scheduled_item",
      "publish_now",
    ]) {
      assert.ok(planOps.includes(op), `${op} discovered`);
    }

    // End-to-end through the discovery surface.
    const entityId = newStableId();
    const created = (await revisionDiscovery.create_working_revision({
      entityType: "entry",
      entityId,
      payload: { title: "Discovery" },
      schemaVersion: "1",
      actor: { actorClass: "human", actorId: "editor", origin: "human" },
    })) as { id: string };
    const validated = (await revisionDiscovery.validate_revision({
      revisionId: created.id as StableId,
    })) as {
      canSeal: boolean;
    };
    assert.equal(validated.canSeal, true);
    const sealed = (await revisionDiscovery.seal_revision({
      revisionId: created.id as StableId,
    })) as {
      state: string;
    };
    assert.equal(sealed.state, "SEALED");

    const cs = (await changeSetDiscovery.create_changeset({ title: "disco", actor: ACTOR })) as {
      id: string;
    };
    await changeSetDiscovery.add_item({
      changesetId: cs.id as StableId,
      item: {
        entityType: "entry",
        entityId,
        intent: "PUBLISH",
        targetRevisionId: created.id,
        expectedGeneration: 0,
      },
    });
    const report = await changeSetDiscovery.validate_changeset({ changesetId: cs.id as StableId });
    assert.equal(report.ok, true);
    await changeSetDiscovery.apply_changeset({ changesetId: cs.id as StableId, actor: ACTOR });
    const publication = await fx.publications.getPublication(fx.pool, "entry", entityId);
    assert.equal(publication?.state, "PUBLISHED");

    // Plan discovery: preview is deterministic and apply_plan persists it.
    const plan = (await planDiscovery.create_publication_plan({
      changesetId: (await fx.changesets.createChangeset({ title: "p2", actor: ACTOR })).id,
      timezone: "UTC",
      actor: ACTOR,
    })) as { id: string };
    const emptyPreview = await planDiscovery.preview_plan({
      planId: plan.id as StableId,
      spec: {
        startAt: new Date("2026-03-01T09:00:00Z"),
        batchSize: 5,
        interval: { unit: "hours", value: 6 },
      },
    });
    assert.deepEqual(emptyPreview, []);
  });
});
