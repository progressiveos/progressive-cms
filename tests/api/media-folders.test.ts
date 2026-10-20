// Logical media folders (owner UX gap D): folders are editorial metadata —
// identity/URLs/storage are untouched by moves; delete of a non-empty folder
// is blocked; nesting is cycle-protected. Application-layer surface only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createMediaDiscoveryService,
  createMediaFolder,
  deleteMediaFolder,
  type IngestDependencies,
  InMemoryMediaStorage,
  listMediaFolders,
  MediaError,
  moveMediaAsset,
  updateMediaFolder,
  uploadMedia,
} from "@pcms/media";
import {
  assertBaseReachable,
  connectionInfo,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function memoryDeps(pool: DbPool): IngestDependencies {
  return {
    pool,
    storage: new InMemoryMediaStorage(),
    quarantine: new InMemoryMediaStorage(),
    limits: { maxUploadBytes: 1_000_000, maxImagePixels: 64_000_000, maxImageDimension: 16384 },
  };
}

async function poolFor(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

test("media folders: create, rename, move (cycle-protected), delete guard", {
  skip: DB_SKIP,
}, async (t) => {
  const pool = await poolFor(t);
  const blog = await createMediaFolder(pool, { name: "Блог", createdBy: "test" });
  const nested = await createMediaFolder(pool, {
    name: "2026",
    parentId: blog.id,
    createdBy: "test",
  });
  const listed = await listMediaFolders(pool);
  assert.equal(listed.length, 2);

  const renamed = await updateMediaFolder(pool, { folderId: blog.id, name: "Блог 2026" });
  assert.equal(renamed.name, "Блог 2026");

  // A folder into its own subtree is a cycle; root move is legal.
  await assert.rejects(
    () => updateMediaFolder(pool, { folderId: blog.id, parentId: nested.id }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_FOLDER_CYCLE",
  );

  // Deleting a folder that still contains a folder is blocked (no cascade).
  await assert.rejects(
    () => deleteMediaFolder(pool, blog.id),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_FOLDER_NOT_EMPTY",
  );

  await updateMediaFolder(pool, { folderId: nested.id, parentId: null });
  const moved = (await listMediaFolders(pool)).find((folder) => folder.id === nested.id);
  assert.equal(moved?.parentId, null);
});

test("media folders: asset move keeps identity; list filter; unknown folder rejected", {
  skip: DB_SKIP,
}, async (t) => {
  const pool = await poolFor(t);
  const deps = memoryDeps(pool);
  const services = await createMediaFolder(pool, { name: "Услуги", createdBy: "test" });

  const accepted = await uploadMedia(deps, {
    bytes: Buffer.from("an ordinary payload"),
    filename: "cover.txt",
    createdBy: "test",
  });
  const assetId = accepted.asset.id;

  await moveMediaAsset(pool, { assetId, folderId: services.id });
  await moveMediaAsset(pool, { assetId, folderId: services.id }); // idempotent
  const inFolder = await createMediaDiscoveryService(pool).searchAssets({ folderId: services.id });
  assert.equal(inFolder.items.length, 1);
  assert.equal(inFolder.items[0]?.id, assetId);
  // Logical move: identity (sha256/id) and bytes untouched.
  assert.equal(inFolder.items[0]?.sha256, accepted.asset.sha256);

  const root = await createMediaDiscoveryService(pool).searchAssets({ folderId: "none" });
  assert.equal(
    root.items.some((item) => item.id === assetId),
    false,
  );

  // Deleting the folder while it holds the asset is blocked; after moving the
  // asset back to root the folder deletes cleanly.
  await assert.rejects(
    () => deleteMediaFolder(pool, services.id),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_FOLDER_NOT_EMPTY",
  );
  await moveMediaAsset(pool, { assetId, folderId: null });
  await deleteMediaFolder(pool, services.id);
  assert.equal((await listMediaFolders(pool)).length, 0);

  await assert.rejects(
    () => moveMediaAsset(pool, { assetId, folderId: "01a00000-0000-7000-8000-000000000000" }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_FOLDER_NOT_FOUND",
  );
});
