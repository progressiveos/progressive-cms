// PCMS-PUB-T011 — sealed media version snapshot semantics against real
// media + revisions subsystems (Publication spec §52, Media spec §53):
// a sealed revision keeps resolving the MediaVersion current at seal time,
// even after a later logical replacement moves the asset to a new version.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  fixedClock,
  loadMigrations,
  migrateDatabase,
  newStableId,
} from "@pcms/core";
import {
  getAsset,
  InMemoryMediaStorage,
  listVersions,
  replaceDocument,
  uploadMedia,
} from "@pcms/media";
import {
  createRevisionStore,
  createVersionedEntityRegistry,
  type RevisionStore,
  type VersionedEntityAdapter,
} from "@pcms/revisions";
import { mediaSnapshotPortFromPool } from "../helpers/publication-composition.js";
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

const CLOCK = fixedClock("2026-10-01T09:00:00.000Z");

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
);
const PDF_V2 = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
);

const entryAdapter: VersionedEntityAdapter = {
  entityType: "entry",
  description: "article test adapter",
  validateForSeal: () => [],
  extractMediaAssetIds: (payload) => {
    const record = payload as { document?: string };
    return record.document === undefined ? [] : [record.document];
  },
};

async function withMediaRevisionFixture(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, store: RevisionStore) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 5,
    connectionTimeoutMilliseconds: 3000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const store = createRevisionStore(pool, {
    registry: createVersionedEntityRegistry([entryAdapter]),
    clock: CLOCK,
    mediaSnapshot: mediaSnapshotPortFromPool(pool),
  });
  await run(pool, store);
}

function mediaDeps(pool: DbPool) {
  const storage = new InMemoryMediaStorage();
  const quarantine = new InMemoryMediaStorage();
  return { pool, storage, quarantine };
}

test("seal pins the current MediaVersion; later replacement cannot rewrite history", (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  return withMediaRevisionFixture(t, async (pool, store) => {
    // Document asset, version 1.
    const accepted = await uploadMedia(mediaDeps(pool), {
      bytes: PDF,
      filename: "price-2026.pdf",
      declaredMimeType: "application/pdf",
      createdBy: "editor-1",
    });
    const assetId = accepted.asset.id;
    assert.equal(accepted.asset.currentVersionNo, 1);

    // Seal an article revision referencing the asset.
    const working = await store.createWorkingRevision({
      entityType: "entry",
      entityId: newStableId(),
      payload: { title: "Price article", document: assetId },
      schemaVersion: "1",
      actor: { actorClass: "human", actorId: "editor-1", origin: "human" },
    });
    const sealed = await store.sealRevision({ revisionId: working.id });
    assert.deepEqual(sealed.mediaVersions, { [assetId]: 1 });

    // Logical replacement → version 2, asset pointer moves atomically.
    const replacement = await replaceDocument(
      { pool, storage: new InMemoryMediaStorage(), maxSourceBytes: 1024 * 1024 },
      {
        assetId,
        bytes: PDF_V2,
        filename: "price-2026.pdf",
        createdBy: "editor-2",
        note: "price update",
      },
    );
    assert.equal(replacement.version.versionNo, 2);
    const assetNow = await getAsset(pool, assetId);
    assert.equal(assetNow?.currentVersionNo, 2);

    // The historical SEALED revision still resolves version 1 (the render
    // composition uses the sealed map, never the asset's current pointer).
    assert.equal(sealed.mediaVersions?.[assetId], 1);
    const versions = await listVersions(pool, assetId);
    assert.deepEqual(
      versions.map((v) => v.versionNo),
      [1, 2],
    );

    // A future revision intentionally adopts the newer current version.
    const working2 = await store.createWorkingRevision({
      entityType: "entry",
      entityId: working.entityId,
      payload: { title: "Price article (updated)", document: assetId },
      schemaVersion: "1",
      actor: { actorClass: "human", actorId: "editor-2", origin: "human" },
    });
    const sealed2 = await store.sealRevision({ revisionId: working2.id });
    assert.deepEqual(sealed2.mediaVersions, { [assetId]: 2 });
    assert.notEqual(sealed2.payloadHash, sealed.payloadHash, "new content, new hash");
  });
});
