// PCMS-MEDIA-T023/T024 — media metadata model round-trip (title/alt/
// caption/source/license) and usage-level alt override resolution
// (override > default > decorative empty).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  type StableId,
} from "@pcms/core";
import {
  getAsset,
  InMemoryMediaStorage,
  MediaError,
  resolveAlt,
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

const LIMITS = { maxUploadBytes: 100_000, maxImagePixels: 64_000_000, maxImageDimension: 16_384 };
const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

async function poolWithImage(t: {
  after: (fn: () => void) => void;
}): Promise<{ pool: DbPool; assetId: StableId }> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const jpeg = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 120, g: 40, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  const accepted = await uploadMedia(
    {
      pool,
      storage: new InMemoryMediaStorage(),
      quarantine: new InMemoryMediaStorage(),
      limits: LIMITS,
    },
    { bytes: jpeg, filename: "stage.jpg", createdBy: "editor" },
  );
  return { pool, assetId: accepted.asset.id };
}

test("full metadata map round-trips; technical identity is untouched", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, assetId } = await poolWithImage(t);
  const before = await getAsset(pool, assetId);
  const updated = await updateAssetMetadata(pool, assetId, {
    title: "Team on stage",
    altDefault: "Four teammates presenting on a conference stage",
    captionDefault: "Keynote 2026",
    description: "Annual company keynote, September 2026",
    sourceName: "Acme Media Archive",
    sourceUrl: "https://archive.acme.example/entries/123",
    author: "J. Doe",
    license: "CC-BY-4.0",
    copyright: "© 2026 Acme Inc.",
  });
  assert.equal(updated.title, "Team on stage");
  assert.equal(updated.altDefault, "Four teammates presenting on a conference stage");
  assert.equal(updated.captionDefault, "Keynote 2026");
  assert.equal(updated.description, "Annual company keynote, September 2026");
  assert.equal(updated.sourceName, "Acme Media Archive");
  assert.equal(updated.sourceUrl, "https://archive.acme.example/entries/123");
  assert.equal(updated.author, "J. Doe");
  assert.equal(updated.license, "CC-BY-4.0");
  assert.equal(updated.copyright, "© 2026 Acme Inc.");

  // re-read from the DB — persistence round-trip
  const reread = await getAsset(pool, assetId);
  assert.equal(reread?.license, "CC-BY-4.0");
  assert.equal(reread?.sourceName, "Acme Media Archive");

  // metadata edits never touch technical identity
  assert.equal(reread?.sha256, before?.sha256);
  assert.equal(reread?.sizeBytes, before?.sizeBytes);
  assert.equal(reread?.mimeType, before?.mimeType);

  // clearing a field writes NULL, not an empty echo
  const cleared = await updateAssetMetadata(pool, assetId, { captionDefault: null });
  assert.equal(cleared.captionDefault, null);

  await assert.rejects(
    updateAssetMetadata(pool, assetId, { focalX: 2 }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_FOCAL_OUT_OF_RANGE",
  );
});

test("alt resolution: override wins, decorative empties, default falls back", () => {
  const asset = { altDefault: "Default alt from the library" };
  assert.equal(resolveAlt({ asset, altOverride: "Usage-specific alt" }), "Usage-specific alt");
  assert.equal(resolveAlt({ asset }), "Default alt from the library");
  assert.equal(resolveAlt({ asset, altOverride: null }), "Default alt from the library");
  assert.equal(
    resolveAlt({ asset, altOverride: "" }),
    "Default alt from the library",
    "empty override = no override",
  );
  assert.equal(resolveAlt({ asset, decorative: true }), "");
  assert.equal(
    resolveAlt({ asset, altOverride: "ignored", decorative: true }),
    "",
    "decorative wins over everything",
  );
  assert.equal(
    resolveAlt({ asset: { altDefault: null } }),
    "",
    "no default → empty, never invented alt text",
  );
});
