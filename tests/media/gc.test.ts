// PCMS-MEDIA-T028 — orphan variant/blob GC: dry-run lists only provably
// unreachable objects (DB-backed reachability), apply removes row + physical
// object; originals and retained history are structurally protected.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createMediaPresetRegistry,
  gcApply,
  gcDryRun,
  generateVariantsForAsset,
  getBlobByHash,
  hardDeleteAsset,
  InMemoryMediaStorage,
  LocalMediaStorage,
  listVariants,
  MediaError,
  replaceDocument,
  uploadMedia,
  type VariantDependencies,
} from "@pcms/media";
import sharp from "sharp";
import {
  assertBaseReachable,
  connectionInfo,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const LIMITS = { maxUploadBytes: 1_000_000, maxImagePixels: 64_000_000, maxImageDimension: 16_384 };
const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

test("GC protects originals and removes only proven orphans", { skip: DB_SKIP }, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-gc-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const deps: VariantDependencies = { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes };
  const ingest = { pool, storage, quarantine: new InMemoryMediaStorage(), limits: LIMITS };
  const makeJpeg = (
    width: number,
    height: number,
    color: { r: number; g: number; b: number },
  ): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: color } })
      .jpeg()
      .toBuffer();

  const liveAsset = await uploadMedia(ingest, {
    bytes: await makeJpeg(30, 30, { r: 10, g: 90, b: 200 }),
    filename: "live.jpg",
    createdBy: "gc",
  });
  const registry = createMediaPresetRegistry([
    { id: "thumb", width: 16, fit: "cover", formats: ["webp"], quality: 70 },
  ]);
  await generateVariantsForAsset(deps, liveAsset.asset, registry);

  const doomedAsset = await uploadMedia(ingest, {
    bytes: await makeJpeg(20, 20, { r: 200, g: 10, b: 10 }),
    filename: "doomed.jpg",
    createdBy: "gc",
  });

  // No orphans yet: everything is referenced.
  const clean = await gcDryRun(pool);
  assert.equal(clean.unreachableBlobs.length, 0);
  assert.equal(clean.danglingVariants.length, 0);

  // Hard delete the doomed asset (no references): its version row goes away,
  // so its blob becomes provably unreachable.
  const emptyPort = { listInboundReferences: async () => [] as never[] };
  const deleted = await hardDeleteAsset(
    { pool, port: emptyPort },
    { assetId: doomedAsset.asset.id, actor: "admin", deleteCapability: "cap" },
  );
  assert.equal(deleted.deleted, true);

  // A superseded document version's blob stays protected while the version
  // row exists (immutable history).
  const pdf1 = Buffer.concat([Buffer.from("%PDF-1.7\nv1"), Buffer.alloc(32, 1)]);
  const pdf2 = Buffer.concat([Buffer.from("%PDF-1.7\nv2"), Buffer.alloc(32, 2)]);
  const doc = await uploadMedia(ingest, { bytes: pdf1, filename: "doc.pdf", createdBy: "gc" });
  await replaceDocument(
    { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes },
    {
      assetId: doc.asset.id,
      bytes: pdf2,
      filename: "doc-v2.pdf",
      createdBy: "editor",
    },
  );

  const report = await gcDryRun(pool);
  assert.equal(report.unreachableBlobs.length, 1, "only the hard-deleted asset's blob");
  assert.equal(report.unreachableBlobs[0]!.sha256, doomedAsset.asset.sha256);

  // variants of the live asset are still there and untouched
  assert.equal((await listVariants(pool, liveAsset.asset.id)).length, 1);

  const result = await gcApply(pool, storage, report);
  assert.equal(result.removedBlobRows, 1);
  assert.equal(result.removedPhysicalObjects, 1);
  assert.ok(result.reclaimedBytes > 0);
  assert.equal(await getBlobByHash(pool, doomedAsset.asset.sha256), null);
  assert.equal(
    await storage.stat(report.unreachableBlobs[0]!.storageKey),
    null,
    "physical object removed",
  );

  // re-run: idempotent, nothing left to collect
  const again = await gcDryRun(pool);
  assert.equal(again.unreachableBlobs.length, 0);
  const reapplied = await gcApply(pool, storage, again);
  assert.equal(reapplied.removedBlobRows, 0);
});

test("hard delete without capability is refused (GC never sees the asset)", {
  skip: DB_SKIP,
}, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const storage = new LocalMediaStorage({
    root: join(mkdtempSync(join(tmpdir(), "pcms-gc2-")), "media"),
  });
  const ingest = { pool, storage, quarantine: new InMemoryMediaStorage(), limits: LIMITS };
  const asset = await uploadMedia(ingest, {
    bytes: await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer(),
    filename: "x.jpg",
    createdBy: "gc",
  });
  const emptyPort = { listInboundReferences: async () => [] as never[] };
  await assert.rejects(
    hardDeleteAsset({ pool, port: emptyPort }, { assetId: asset.asset.id, actor: "anonymous" }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_DELETE_FORBIDDEN",
  );
});
