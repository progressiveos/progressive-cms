// PCMS-PUB-T005/T006/T007/T008/T009 — publication pointer, append-only
// events, CAS publish/rollback/unpublish and the transactional Outbox,
// against real PostgreSQL (Publication spec §8–§14, §55/§56).
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Clock,
  createDbPool,
  type DbPool,
  fixedClock,
  loadMigrations,
  migrateDatabase,
  newStableId,
  type StableId,
} from "@pcms/core";
import {
  createOutboxService,
  createPublicationService,
  type OutboxService,
  type PublicationActor,
  PublicationError,
  type PublicationService,
  type RevisionReaderPort,
  type SealedRevisionRef,
  writeOutboxEvent,
} from "@pcms/publication";
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

const CLOCK = fixedClock("2026-10-01T09:00:00.000Z");
const ACTOR: PublicationActor = { actorClass: "human", actorId: "editor-1" };

/** Composition stand-in for the revisions subsystem port. */
function fakeRevisions(clock: Clock): {
  port: RevisionReaderPort;
  seal(entityId: StableId, hash?: string): SealedRevisionRef;
} {
  const sealed = new Map<string, SealedRevisionRef>();
  return {
    port: {
      async getSealedRevision(_executor, entityType, entityId, revisionId) {
        const found = sealed.get(revisionId);
        if (found === undefined) return null;
        if (found.entityType !== entityType || found.entityId !== entityId) return null;
        return found;
      },
    },
    seal(entityId, hash) {
      const ref: SealedRevisionRef = {
        revisionId: newStableId(),
        entityType: "entry",
        entityId,
        payloadHash: hash ?? `hash-${sealed.size}`,
        schemaVersion: "1",
        locale: "default",
        payload: { title: "sealed" },
        mediaVersions: null,
        sidecar: null,
        sealedAt: clock.now(),
      };
      sealed.set(ref.revisionId, ref);
      return ref;
    },
  };
}

type RevisionFixture = ReturnType<typeof fakeRevisions>;

async function withPublicationFixture(
  t: { after: (fn: () => void) => void },
  run: (
    pool: DbPool,
    publication: PublicationService,
    outbox: OutboxService,
    revs: RevisionFixture,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfo(db),
    max: 8,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  // Keep DB-generated availability on the fixture clock, independent of today's date.
  await pool.query(
    `ALTER TABLE publication_outbox ALTER COLUMN available_at SET DEFAULT '${CLOCK.now().toISOString()}'::timestamptz`,
  );
  const revs = fakeRevisions(CLOCK);
  const publication = createPublicationService(pool, { clock: CLOCK, revisions: revs.port });
  const outbox = createOutboxService(pool, { clock: CLOCK });
  await run(pool, publication, outbox, revs);
}

function expectPublicationError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PublicationError, `expected PublicationError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("first publish creates pointer with PUBLISH_FIRST, dates and outbox event", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, publication, outbox, revs) => {
    const entityId = newStableId();
    const rev = revs.seal(entityId);
    const result = await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev.revisionId,
      expectedGeneration: 0,
      actor: ACTOR,
    });
    assert.equal(result.publication.state, "PUBLISHED");
    assert.equal(result.publication.generation, 1);
    assert.deepEqual(result.publication.firstPublishedAt, CLOCK.now());
    assert.deepEqual(result.publication.modifiedAt, CLOCK.now());
    assert.equal(result.event.eventType, "PUBLISH_FIRST");
    assert.deepEqual(result.event.toRevisionId, rev.revisionId);
    assert.deepEqual(result.event.fromRevisionId, null);

    const events = await publication.listPublicationEvents(pool, "entry", entityId);
    assert.equal(events.length, 1);
    const outboxStats = await outbox.stats();
    assert.equal(outboxStats.pending, 1, "outbox event written atomically with the pointer");
    const claimed = await outbox.claimBatch(10);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.eventType, "EntryPublished");
  });
});

test("publish requires a sealed target (REVISION_NOT_SEALED)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (_pool, publication) => {
    await assert.rejects(
      () =>
        publication.publish({
          entityType: "entry",
          entityId: newStableId(),
          targetRevisionId: newStableId(),
          expectedGeneration: 0,
          actor: ACTOR,
        }),
      expectPublicationError("REVISION_NOT_SEALED"),
    );
  });
});

test("publish CAS: concurrent lost update gets PUBLICATION_CONFLICT, no silent overwrite", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, publication, outbox, revs) => {
    const entityId = newStableId();
    const revA = revs.seal(entityId, "hash-A");
    await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: revA.revisionId,
      expectedGeneration: 0,
      actor: ACTOR,
    });

    const revB = revs.seal(entityId, "hash-B");
    const revC = revs.seal(entityId, "hash-C");
    // A and B both read generation 1; exactly one may move it to 2.
    const attemptA = publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: revB.revisionId,
      expectedGeneration: 1,
      actor: { actorClass: "service_account", actorId: "agent-A" },
    });
    await sleep(20); // let A take the row lock first
    const attemptB = publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: revC.revisionId,
      expectedGeneration: 1,
      actor: { actorClass: "service_account", actorId: "agent-B" },
    });
    const results = await Promise.allSettled([attemptA, attemptB]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one publish wins");
    assert.equal(rejected.length, 1);
    const loser = (rejected[0] as PromiseRejectedResult).reason as PublicationError;
    assert.equal(loser.code, "PUBLICATION_CONFLICT");

    const final = await publication.getPublication(pool, "entry", entityId);
    assert.equal(final?.generation, 2);
    const events = await publication.listPublicationEvents(pool, "entry", entityId);
    assert.equal(events.length, 2, "no orphan event for the conflict");
    const stats = await outbox.stats();
    assert.equal(stats.pending, 2, "one outbox event per applied publish only");
  });
});

test("update publish writes PUBLISH_UPDATE; identical payload keeps modified_at", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, publication, _outbox, revs) => {
    const entityId = newStableId();
    const rev1 = revs.seal(entityId, "same-hash");
    await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev1.revisionId,
      expectedGeneration: 0,
      actor: ACTOR,
    });
    const rev2 = revs.seal(entityId, "same-hash");
    const second = await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev2.revisionId,
      expectedGeneration: 1,
      actor: ACTOR,
    });
    assert.equal(second.event.eventType, "PUBLISH_UPDATE");
    assert.deepEqual(
      second.publication.modifiedAt,
      CLOCK.now(),
      "unchanged hash keeps modified_at",
    );
    assert.deepEqual(
      second.publication.firstPublishedAt,
      CLOCK.now(),
      "first publish date is stable",
    );

    const rev3 = revs.seal(entityId, "changed-hash");
    const later = fixedClock("2026-10-02T09:00:00.000Z");
    const service2 = createPublicationService(pool, { clock: later, revisions: revs.port });
    const third = await service2.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev3.revisionId,
      expectedGeneration: 2,
      actor: ACTOR,
    });
    assert.deepEqual(third.publication.modifiedAt, later.now(), "content change moves modified_at");
    assert.deepEqual(third.publication.publishedAt, later.now());
  });
});

test("unpublish preserves history and is not a hard delete", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, publication, outbox, revs) => {
    const entityId = newStableId();
    const rev = revs.seal(entityId);
    const published = await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev.revisionId,
      expectedGeneration: 0,
      actor: ACTOR,
    });
    const unpublished = await publication.unpublish({
      entityType: "entry",
      entityId,
      expectedGeneration: published.publication.generation,
      actor: ACTOR,
      reason: "campaign ended",
    });
    assert.equal(unpublished.publication.state, "UNPUBLISHED");
    assert.deepEqual(
      unpublished.publication.currentRevisionId,
      rev.revisionId,
      "history preserved",
    );
    assert.equal(unpublished.event.eventType, "UNPUBLISH");
    assert.equal(unpublished.event.reason, "campaign ended");

    const stillReadable = await publication.getPublishedRevision(pool, "entry", entityId);
    assert.equal(stillReadable, null, "unpublished entity renders nothing");

    await assert.rejects(
      () =>
        publication.unpublish({
          entityType: "entry",
          entityId,
          expectedGeneration: unpublished.publication.generation,
          actor: ACTOR,
        }),
      expectPublicationError("PUBLICATION_NOT_PUBLISHED"),
    );

    const events = await publication.listPublicationEvents(pool, "entry", entityId);
    assert.deepEqual(
      events.map((e) => e.eventType),
      ["PUBLISH_FIRST", "UNPUBLISH"],
    );
    const stats = await outbox.stats();
    assert.equal(stats.pending, 2, "EntryUnpublished outbox event emitted");
  });
});

test("rollback points at a previous sealed revision without deleting newer ones", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, publication, _outbox, revs) => {
    const entityId = newStableId();
    const rev1 = revs.seal(entityId, "v1");
    const rev2 = revs.seal(entityId, "v2");
    await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev1.revisionId,
      expectedGeneration: 0,
      actor: ACTOR,
    });
    await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev2.revisionId,
      expectedGeneration: 1,
      actor: ACTOR,
    });
    const rolled = await publication.rollback({
      entityType: "entry",
      entityId,
      targetRevisionId: rev1.revisionId,
      expectedGeneration: 2,
      actor: ACTOR,
      reason: "quality regression",
    });
    assert.equal(rolled.event.eventType, "ROLLBACK");
    assert.deepEqual(rolled.publication.currentRevisionId, rev1.revisionId);
    assert.equal(rolled.publication.generation, 3, "rollback is a normal CAS pointer move");
    assert.deepEqual(rolled.publication.modifiedAt, CLOCK.now(), "content actually changed");

    const events = await publication.listPublicationEvents(pool, "entry", entityId);
    assert.deepEqual(
      events.map((e) => e.eventType),
      ["PUBLISH_FIRST", "PUBLISH_UPDATE", "ROLLBACK"],
    );
  });
});

test("publication_events table is append-only at the DB layer", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, publication, _outbox, revs) => {
    const entityId = newStableId();
    const rev = revs.seal(entityId);
    await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev.revisionId,
      expectedGeneration: 0,
      actor: ACTOR,
    });
    await assert.rejects(
      () => pool.query(`UPDATE publication_events SET reason = 'tampered'`),
      /append-only/,
    );
    await assert.rejects(() => pool.query(`DELETE FROM publication_events`), /append-only/);
  });
});

test("outbox write is transactional with the operation (no orphan events)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, publication, outbox, revs) => {
    const entityId = newStableId();
    const rev = revs.seal(entityId);
    await publication.publish({
      entityType: "entry",
      entityId,
      targetRevisionId: rev.revisionId,
      expectedGeneration: 0,
      actor: ACTOR,
    });
    await assert.rejects(
      () =>
        publication.publish({
          entityType: "entry",
          entityId,
          targetRevisionId: rev.revisionId,
          expectedGeneration: 0, // stale: generation already 1
          actor: ACTOR,
        }),
      expectPublicationError("PUBLICATION_CONFLICT"),
    );
    const stats = await outbox.stats();
    assert.equal(stats.pending, 1, "failed operation wrote no outbox row");

    // Manual outbox write inside an aborted transaction leaves nothing.
    await pool
      .withTransaction(async (tx) => {
        await writeOutboxEvent(tx, {
          aggregate: "test",
          aggregateId: "x",
          eventType: "Test",
          payload: {},
        });
        throw new Error("abort");
      })
      .catch(() => undefined);
    const after = await outbox.stats();
    assert.equal(after.pending, 1);
  });
});

test("outbox delivery is at-least-once with retry, backoff and dead-letter", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, _publication, _outboxDefault, revs) => {
    void revs;
    const flaky = createOutboxService(pool, {
      clock: CLOCK,
      maxAttempts: 2,
      backoffBaseMilliseconds: 0, // frozen clock: backoff must have elapsed
    });
    await pool.withTransaction(async (tx) => {
      await writeOutboxEvent(tx, {
        aggregate: "test",
        aggregateId: "evt-1",
        eventType: "Deliver",
        payload: { n: 1 },
      });
    });
    let batch = await flaky.claimBatch(10);
    assert.equal(batch.length, 1);
    await flaky.fail(batch[0]!.id, new Error("transient provider outage"));
    let stats = await flaky.stats();
    assert.equal(stats.pending, 1, "requeued for retry");
    batch = await flaky.claimBatch(10);
    assert.equal(batch.length, 1);
    assert.equal(batch[0]!.attempts, 2);
    await flaky.complete(batch[0]!.id);
    stats = await flaky.stats();
    assert.equal(stats.done, 1);

    // Exhaustion dead-letters; operator can inspect + retry.
    const single = createOutboxService(pool, {
      clock: CLOCK,
      maxAttempts: 1,
      backoffBaseMilliseconds: 0,
    });
    await pool.withTransaction(async (tx) => {
      await writeOutboxEvent(tx, {
        aggregate: "test",
        aggregateId: "evt-2",
        eventType: "Deliver",
        payload: { n: 2 },
      });
    });
    const dead = await single.claimBatch(10);
    await single.fail(dead[0]!.id, new Error("permanent"));
    stats = await single.stats();
    assert.equal(stats.dead, 1);
    const letters = await single.listDeadLetters();
    assert.equal(letters.length, 1);
    assert.match(letters[0]!.lastError ?? "", /permanent/);
    await single.retryDeadLetter(letters[0]!.id);
    stats = await single.stats();
    assert.equal(stats.pending, 1);
  });
});

test("expired outbox claims are recovered after worker death", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withPublicationFixture(t, async (pool, _publication, outbox, _revs) => {
    await pool.withTransaction(async (tx) => {
      await writeOutboxEvent(tx, {
        aggregate: "test",
        aggregateId: "evt-3",
        eventType: "Deliver",
        payload: {},
      });
    });
    const claimed = await outbox.claimBatch(10);
    assert.equal(claimed.length, 1);
    const laterClock = fixedClock("2026-10-01T09:10:00.000Z");
    const recovering = createOutboxService(pool, { clock: laterClock });
    const recovered = await recovering.recoverExpiredClaims();
    assert.equal(recovered, 1);
    const again = await outbox.claimBatch(10);
    assert.equal(again.length, 1, "event re-queued after lease expiry");
  });
});
