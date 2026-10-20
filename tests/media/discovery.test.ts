// PCMS-MEDIA-T026 — machine discovery/search: hash lookup (dedupe
// workflow), metadata text search across the §48 fields, kind/mime filters,
// deterministic bounded pages and the full inspect view.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createMediaDiscoveryService,
  createMediaPresetRegistry,
  generateVariantsForAsset,
  InMemoryMediaStorage,
  LocalMediaStorage,
  MAX_SEARCH_LIMIT,
  MediaError,
  updateAssetMetadata,
  uploadMedia,
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

test("agents can find, search and inspect media", { skip: DB_SKIP }, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtemp();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const quarantine = new InMemoryMediaStorage();
  const ingest = {
    pool,
    storage,
    quarantine,
    limits: LIMITS,
  };
  const jpeg = async (color: [number, number, number]): Promise<Buffer> =>
    sharp({
      create: {
        width: 30,
        height: 20,
        channels: 3,
        background: { r: color[0]!, g: color[1]!, b: color[2]! },
      },
    })
      .jpeg()
      .toBuffer();

  const stage = await uploadMedia(ingest, {
    bytes: await jpeg([200, 10, 10]),
    filename: "stage-keynote.jpg",
    createdBy: "agent-1",
  });
  await updateAssetMetadata(pool, stage.asset.id, {
    title: "Keynote stage",
    author: "J. Doe",
    sourceName: "Acme Archive",
  });
  const office = await uploadMedia(ingest, {
    bytes: await jpeg([10, 200, 10]),
    filename: "office.jpg",
    createdBy: "agent-2",
  });
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32, 1)]);
  const brief = await uploadMedia(ingest, {
    bytes: pdf,
    filename: "brief.pdf",
    createdBy: "agent-1",
  });
  void office;
  void brief;

  const discovery = createMediaDiscoveryService(pool);

  // text search across §48 fields
  assert.equal((await discovery.searchAssets({ text: "keynote" })).total, 1, "filename");
  assert.equal((await discovery.searchAssets({ text: "J. Doe" })).total, 1, "author");
  assert.equal((await discovery.searchAssets({ text: "Acme" })).total, 1, "source");
  await updateAssetMetadata(pool, stage.asset.id, { captionDefault: "The main stage" });
  assert.equal((await discovery.searchAssets({ text: "stage" })).total, 1, "caption");

  // filters and deterministic pages
  const docs = await discovery.searchAssets({ kind: "document" });
  assert.equal(docs.total, 1);
  assert.equal(docs.items[0]!.filenameOriginal, "brief.pdf");
  const byMime = await discovery.searchAssets({ mimeType: "image/jpeg" });
  assert.equal(byMime.total, 2, "stage + office are jpegs");
  const page = await discovery.searchAssets({ limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(
    (await discovery.searchAssets({ limit: MAX_SEARCH_LIMIT + 5 })).items.length,
    3,
    "limit is capped",
  );

  // hash lookup for the dedupe workflow (§45)
  const sameBytes = await uploadMedia(ingest, {
    bytes: await jpeg([200, 10, 10]),
    filename: "duplicate.jpg",
    createdBy: "agent-3",
  });
  const byHash = await discovery.findAssetsByHash(stage.asset.sha256);
  assert.equal(byHash.length, 2, "both assets share the blob hash");
  assert.deepEqual(byHash.map((a) => a.filenameOriginal).sort(), [
    "duplicate.jpg",
    "stage-keynote.jpg",
  ]);
  void sameBytes;
  await assert.rejects(
    discovery.findAssetsByHash("nothex"),
    (error: unknown) => error instanceof MediaError,
  );

  // inspect view
  const registry = createMediaPresetRegistry([
    { id: "thumb", width: 16, fit: "cover", formats: ["webp"], quality: 70 },
  ]);
  await generateVariantsForAsset(
    { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes },
    stage.asset,
    registry,
  );
  const inspection = await discovery.inspectAsset(stage.asset.id);
  assert.equal(inspection.asset.id, stage.asset.id);
  assert.equal(inspection.versions.length, 1);
  assert.equal(inspection.variants.length, 1);
  assert.equal(inspection.variants[0]!.presetId, "thumb");
  await assert.rejects(
    discovery.inspectAsset("01900000-0000-7000-8000-00000000dead"),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_ASSET_NOT_FOUND",
  );
});

// R20 — the summary seam reads focal_x/focal_y, but the searchAssets and
// findAssetsByHash SELECTs did not select those columns, so list/hash
// summaries reported null (Number(undefined) → NaN → JSON null) while the
// detail view was correct; the Admin focal picker then showed the default
// center after reload. One seam test must cover both SELECTs.
test("list and hash summaries match detail on saved focal", { skip: DB_SKIP }, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtemp();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const ingest = {
    pool,
    storage: new LocalMediaStorage({ root: join(root, "media") }),
    quarantine: new InMemoryMediaStorage(),
    limits: LIMITS,
  };
  const uploaded = await uploadMedia(ingest, {
    bytes: await sharp({
      create: { width: 30, height: 20, channels: 3, background: { r: 10, g: 10, b: 200 } },
    })
      .jpeg()
      .toBuffer(),
    filename: "focal-seam.jpg",
    createdBy: "agent-1",
  });
  await updateAssetMetadata(pool, uploaded.asset.id, { focalX: 0.2, focalY: 0.8 });

  const discovery = createMediaDiscoveryService(pool);
  const readAll = async () => {
    const listed = (await discovery.searchAssets({ text: "focal-seam" })).items[0];
    const byHash = (await discovery.findAssetsByHash(uploaded.asset.sha256))[0];
    const inspected = (await discovery.inspectAsset(uploaded.asset.id)).asset;
    assert.ok(listed, "asset missing from the list summary");
    assert.ok(byHash, "asset missing from the hash summary");
    return { list: listed, hash: byHash, detail: inspected } as const;
  };

  for (const [surface, summary] of Object.entries(await readAll())) {
    assert.deepEqual([summary.focalX, summary.focalY], [0.2, 0.8], `${surface} drops the focal`);
  }

  // Native reset returns null/null on every surface.
  await updateAssetMetadata(pool, uploaded.asset.id, { focalX: null, focalY: null });
  for (const [surface, summary] of Object.entries(await readAll())) {
    assert.deepEqual([summary.focalX, summary.focalY], [null, null], `${surface} after reset`);
  }
});

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "pcms-discovery-"));
}
