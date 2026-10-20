// PCMS-PUB-T002/T003/T004 — revision store against PostgreSQL: WORKING/SEALED
// schema, DB-enforced sealed immutability, optimistic edit generation and
// seal + payload hash (Publication spec §5/§6, §49–§51).
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
import {
  createRevisionStore,
  createVersionedEntityRegistry,
  hashCanonicalPayload,
  RevisionError,
  type RevisionRecord,
  type RevisionStore,
  type VersionedEntityAdapter,
} from "@pcms/revisions";
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

const testAdapter: VersionedEntityAdapter = {
  entityType: "entry",
  description: "test entry adapter",
  canonicalize: (payload) => payload,
  validateForSeal: (payload) => {
    const record = payload as { title?: string };
    if (typeof record.title !== "string" || record.title.trim() === "") {
      return [
        {
          code: "TEST_TITLE_REQUIRED",
          path: "/title",
          message: "title required",
          severity: "error",
        },
      ];
    }
    return [];
  },
  extractMediaAssetIds: (payload) => {
    const record = payload as { doc?: string };
    return record.doc === undefined ? [] : [record.doc];
  },
};

function registry() {
  return createVersionedEntityRegistry([testAdapter]);
}

async function withRevisionFixture(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, store: RevisionStore) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfo(db),
    max: 5,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(pool, createRevisionStore(pool, { registry: registry(), clock: CLOCK }));
}

const ACTOR = { actorClass: "human", actorId: "user-1", origin: "human" } as const;

function expectRevisionError(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof RevisionError, `expected RevisionError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test("working revision persists identity, numbering and actor provenance", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (pool, store) => {
    const entityId = newStableId();
    const created = await store.createWorkingRevision({
      entityType: "entry",
      entityId,
      payload: { title: "Draft" },
      schemaVersion: "1",
      actor: ACTOR,
    });
    assert.equal(created.state, "WORKING");
    assert.equal(created.revisionNo, 1);
    assert.equal(created.locale, "default");
    assert.equal(created.createdBy, "user-1");
    assert.equal(created.createdByType, "human");
    assert.equal(created.origin, "human");
    assert.equal(created.editGeneration, 0);
    assert.equal(created.sealedAt, null);
    assert.equal(created.payloadHash, null);
    assert.deepEqual(created.updatedAt, CLOCK.now());

    await store.sealRevision({ revisionId: created.id });
    const second = await store.createWorkingRevision({
      entityType: "entry",
      entityId,
      payload: { title: "Draft 2" },
      schemaVersion: "1",
      actor: ACTOR,
    });
    assert.equal(second.revisionNo, 2, "revision numbers are per-entity monotonic");
  });
});

test("at most one WORKING revision per entity/context exists", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (_pool, store) => {
    const entityId = newStableId();
    await store.createWorkingRevision({
      entityType: "entry",
      entityId,
      payload: { title: "Draft" },
      schemaVersion: "1",
      actor: ACTOR,
    });
    await assert.rejects(
      () =>
        store.createWorkingRevision({
          entityType: "entry",
          entityId,
          payload: { title: "Draft" },
          schemaVersion: "1",
          actor: ACTOR,
        }),
      expectRevisionError("REVISION_ALREADY_WORKING"),
    );
    // different locale is a distinct context (spec §3)
    await store.createWorkingRevision({
      entityType: "entry",
      entityId,
      payload: { title: "Entwurf" },
      schemaVersion: "1",
      locale: "de",
      actor: ACTOR,
    });
  });
});

test("unregistered entity types are rejected by the registry boundary", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (_pool, store) => {
    await assert.rejects(
      () =>
        store.createWorkingRevision({
          entityType: "theme_settings",
          entityId: newStableId(),
          payload: {},
          schemaVersion: "1",
          actor: ACTOR,
        }),
      expectRevisionError("REVISION_ENTITY_UNKNOWN"),
    );
  });
});

test("autosave uses optimistic edit generation; conflicts surface REVISION_STALE", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (pool, store) => {
    const entityId = newStableId();
    const working = await store.createWorkingRevision({
      entityType: "entry",
      entityId,
      payload: { title: "v1" },
      schemaVersion: "1",
      actor: ACTOR,
    });
    const saved = await store.updateWorkingRevision({
      revisionId: working.id,
      payload: { title: "v2" },
      expectedEditGeneration: 0,
    });
    assert.equal(saved.editGeneration, 1);
    assert.deepEqual((saved.payload as { title: string }).title, "v2");

    await assert.rejects(
      () =>
        store.updateWorkingRevision({
          revisionId: working.id,
          payload: { title: "lost update" },
          expectedEditGeneration: 0,
        }),
      expectRevisionError("REVISION_STALE"),
    );
    const reread = await store.getRevision(pool, working.id);
    assert.ok(reread !== null);
    assert.equal((reread.payload as { title: string }).title, "v2", "stale save must not win");
  });
});

test("invalid payloads cannot be sealed (REVISION_VALIDATION_FAILED)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (pool, store) => {
    const working = await store.createWorkingRevision({
      entityType: "entry",
      entityId: newStableId(),
      payload: { title: "" },
      schemaVersion: "1",
      actor: ACTOR,
    });
    await assert.rejects(
      () => store.sealRevision({ revisionId: working.id }),
      (error: unknown) => {
        assert.ok(error instanceof RevisionError);
        assert.equal(error.code, "REVISION_VALIDATION_FAILED");
        const issues = error.details?.issues as { code: string; severity: string }[];
        assert.equal(issues.length, 1);
        assert.equal(issues[0]!.code, "TEST_TITLE_REQUIRED");
        return true;
      },
    );
    const stillWorking = await store.getRevision(pool, working.id);
    assert.equal(stillWorking?.state, "WORKING");
  });
});

test("seal canonicalizes, hashes and freezes; immutability is DB-enforced", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (pool, store) => {
    const entityId = newStableId();
    const working = await store.createWorkingRevision({
      entityType: "entry",
      entityId,
      payload: { title: "Published" },
      schemaVersion: "1",
      actor: ACTOR,
    });
    const sealed = await store.sealRevision({ revisionId: working.id });
    assert.equal(sealed.state, "SEALED");
    assert.equal(sealed.payloadHash, hashCanonicalPayload({ title: "Published" }));
    assert.deepEqual(sealed.sealedAt, CLOCK.now());
    assert.deepEqual(sealed.updatedAt, CLOCK.now());

    // Same canonical payload on a different entity → identical hash (§14).
    const twin = await store.sealRevision({
      revisionId: (
        await store.createWorkingRevision({
          entityType: "entry",
          entityId: newStableId(),
          payload: { title: "Published" },
          schemaVersion: "1",
          actor: ACTOR,
        })
      ).id,
    });
    assert.equal(twin.payloadHash, sealed.payloadHash);

    // Direct DB mutation attempts hit the trigger, not just app checks.
    await assert.rejects(
      () =>
        pool.query(`UPDATE revisions SET payload = '{"title":"hacked"}' WHERE id = $1`, [
          sealed.id,
        ]),
      /immutable/,
    );
    await assert.rejects(
      () => pool.query(`UPDATE revisions SET payload_hash = 'deadbeef' WHERE id = $1`, [sealed.id]),
      /immutable/,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM revisions WHERE id = $1`, [sealed.id]),
      /cannot be deleted/,
    );
    await assert.rejects(
      () =>
        store.updateWorkingRevision({
          revisionId: sealed.id,
          payload: {},
          expectedEditGeneration: 0,
        }),
      expectRevisionError("REVISION_NOT_WORKING"),
    );
    await assert.rejects(
      () => store.sealRevision({ revisionId: sealed.id }),
      expectRevisionError("REVISION_NOT_WORKING"),
    );
    await assert.rejects(
      () => store.deleteWorkingRevision(sealed.id),
      expectRevisionError("REVISION_NOT_WORKING"),
    );

    // Any further edit creates a NEW WORKING revision (spec §6).
    const next = await store.createWorkingRevision({
      entityType: "entry",
      entityId,
      payload: { title: "Edited after publish" },
      schemaVersion: "1",
      actor: ACTOR,
      parentRevisionId: sealed.id,
    });
    assert.equal(next.revisionNo, 2);
    assert.deepEqual(next.parentRevisionId, sealed.id);
  });
});

test("seal with stale expected generation is rejected (REVISION_STALE)", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (_pool, store) => {
    const working = await store.createWorkingRevision({
      entityType: "entry",
      entityId: newStableId(),
      payload: { title: "x" },
      schemaVersion: "1",
      actor: ACTOR,
    });
    await store.updateWorkingRevision({
      revisionId: working.id,
      payload: { title: "y" },
      expectedEditGeneration: 0,
    });
    await assert.rejects(
      () => store.sealRevision({ revisionId: working.id, expectedEditGeneration: 0 }),
      expectRevisionError("REVISION_STALE"),
    );
    const sealed = await store.sealRevision({ revisionId: working.id, expectedEditGeneration: 1 });
    assert.equal(sealed.state, "SEALED");
  });
});

test("seal snapshots referenced media versions; missing assets fail MEDIA_NOT_READY", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (pool, store) => {
    const storeWithMedia = createRevisionStore(pool, {
      registry: registry(),
      clock: CLOCK,
      mediaSnapshot: {
        resolveCurrentVersions: async (ids) =>
          Object.fromEntries(ids.filter((id) => id === assetId).map((id) => [id, 1])),
      },
    });
    const assetId = newStableId();
    const working = await storeWithMedia.createWorkingRevision({
      entityType: "entry",
      entityId: newStableId(),
      payload: { title: "with doc", doc: assetId },
      schemaVersion: "1",
      actor: ACTOR,
    });
    const sealed = await storeWithMedia.sealRevision({ revisionId: working.id });
    assert.deepEqual(sealed.mediaVersions, { [assetId]: 1 });

    const missing = await storeWithMedia.createWorkingRevision({
      entityType: "entry",
      entityId: newStableId(),
      payload: { title: "broken ref", doc: newStableId() },
      schemaVersion: "1",
      actor: ACTOR,
    });
    await assert.rejects(
      () => storeWithMedia.sealRevision({ revisionId: missing.id }),
      expectRevisionError("MEDIA_NOT_READY"),
    );
  });
});

test("WORKING revisions can be dropped by draft policy; SEALED ones cannot", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (pool, store) => {
    const working = await store.createWorkingRevision({
      entityType: "entry",
      entityId: newStableId(),
      payload: { title: "abandoned" },
      schemaVersion: "1",
      actor: ACTOR,
    });
    await store.deleteWorkingRevision(working.id);
    assert.equal(await store.getRevision(pool, working.id), null);
  });
});

test("listRevisions is deterministic (revision_no DESC) and paginated", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withRevisionFixture(t, async (pool, store) => {
    const entityId = newStableId();
    const ids: StableId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const working = await store.createWorkingRevision({
        entityType: "entry",
        entityId,
        payload: { title: `rev ${i}` },
        schemaVersion: "1",
        actor: ACTOR,
      });
      ids.push(working.id);
      if (i < 2) {
        await store.sealRevision({ revisionId: working.id });
      } else {
        await store.deleteWorkingRevision(working.id);
        const recreated = await store.createWorkingRevision({
          entityType: "entry",
          entityId,
          payload: { title: "rev 3 kept" },
          schemaVersion: "1",
          actor: ACTOR,
        });
        ids.push(recreated.id);
        await store.sealRevision({ revisionId: recreated.id });
      }
    }
    const listed = await store.listRevisions(pool, "entry", entityId);
    assert.deepEqual(
      listed.map((r: RevisionRecord) => r.revisionNo),
      [3, 2, 1],
    );
    const page = await store.listRevisions(pool, "entry", entityId, { limit: 2, offset: 1 });
    assert.deepEqual(
      page.map((r: RevisionRecord) => r.revisionNo),
      [2, 1],
    );
    assert.deepEqual(listed.map((r: RevisionRecord) => r.id).includes(ids[0]!), true);
  });
});
