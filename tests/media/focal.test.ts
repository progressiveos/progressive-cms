// PCMS-MEDIA-T012 — focal point crop support: different presets can crop
// the same image around the asset's focal point; presets without focal
// interest fall back to their declared crop strategy.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  newStableId,
} from "@pcms/core";
import {
  createMediaPresetRegistry,
  generateVariantsForAsset,
  InMemoryMediaStorage,
  LocalMediaStorage,
  listVariants,
  readVariantBytes,
  updateAssetMetadata,
  uploadMedia,
  type VariantDependencies,
  variantKeyFor,
} from "@pcms/media";
import sharp from "sharp";
import {
  assertBaseReachable,
  connectionInfo,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const LIMITS = { maxUploadBytes: 5_000_000, maxImagePixels: 64_000_000, maxImageDimension: 16_384 };

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

async function setup(t: { after: (fn: () => void) => void }): Promise<{
  pool: DbPool;
  deps: VariantDependencies;
  upload: (
    bytes: Buffer,
    name: string,
  ) => Promise<Awaited<ReturnType<typeof uploadMedia>>["asset"]>;
}> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-focal-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const quarantine = new InMemoryMediaStorage();
  const deps: VariantDependencies = { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes };
  const upload = async (bytes: Buffer, name: string) => {
    const accepted = await uploadMedia(
      { pool, storage, quarantine, limits: LIMITS },
      { bytes, filename: name, createdBy: "test" },
    );
    return accepted.asset;
  };
  return { pool, deps, upload };
}

/** Wide image: left half red, right half blue (focal candidates). */
async function halfAndHalf(): Promise<Buffer> {
  const red = await sharp({
    create: { width: 100, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  const blue = await sharp({
    create: { width: 100, height: 50, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 200, height: 50, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .composite([
      { input: red, left: 0, top: 0 },
      { input: blue, left: 100, top: 0 },
    ])
    .png()
    .toBuffer();
}

async function dominantChannel(bytes: Buffer): Promise<"red" | "blue" | "mixed"> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  let redScore = 0;
  let blueScore = 0;
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const r = data[pixel * info.channels] ?? 0;
    const b = data[pixel * info.channels + 2] ?? 0;
    if (r > b) redScore += 1;
    else if (b > r) blueScore += 1;
  }
  const total = info.width * info.height;
  if (redScore / total > 0.9) return "red";
  if (blueScore / total > 0.9) return "blue";
  return "mixed";
}

test("focal point drives cover crops toward the focal region", { skip: DB_SKIP }, async (t) => {
  const { pool, deps, upload } = await setup(t);
  const asset = await upload(await halfAndHalf(), "scene.png");
  // Focal point on the red left half.
  const focused = await updateAssetMetadata(pool, asset.id, { focalX: 0.15, focalY: 0.5 });
  const registry = createMediaPresetRegistry([
    { id: "square", width: 40, height: 40, fit: "cover", formats: ["png"], quality: 90 },
  ]);
  const generated = await generateVariantsForAsset(deps, focused, registry);
  assert.equal(generated.length, 1);
  const bytes = await readVariantBytes(deps, generated[0]!);
  assert.equal(await dominantChannel(bytes), "red", "left focal point keeps the red half in frame");
});

test("moving the focal point changes the variant identity and the crop", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, deps, upload } = await setup(t);
  const asset = await upload(await halfAndHalf(), "shift.png");
  const registry = createMediaPresetRegistry([
    { id: "square", width: 40, height: 40, fit: "cover", formats: ["png"], quality: 90 },
  ]);
  const left = await updateAssetMetadata(pool, asset.id, { focalX: 0.15, focalY: 0.5 });
  await generateVariantsForAsset(deps, left, registry);
  const leftVariants = await listVariants(pool, asset.id);
  assert.equal(leftVariants.length, 1);
  const leftBytes = await readVariantBytes(deps, leftVariants[0]!);

  const right = await updateAssetMetadata(pool, asset.id, { focalX: 0.85, focalY: 0.5 });
  await generateVariantsForAsset(deps, right, registry);
  const both = await listVariants(pool, asset.id);
  assert.equal(both.length, 2, "new focal point ⇒ new variant key, new derivative");
  const rightVariant = both.find((v) => v.id !== leftVariants[0]?.id);
  assert.ok(rightVariant);
  const rightBytes = await readVariantBytes(deps, rightVariant);
  assert.equal(await dominantChannel(rightBytes), "blue", "right focal point shows the blue half");
  assert.notDeepEqual(leftBytes, rightBytes);
});

test("variant keys react to the focal coordinates even without generation", () => {
  const base = {
    sourceSha256: "c".repeat(64),
    versionNo: 1,
    presetId: "square",
    width: 40,
    height: 40,
    fit: "cover",
    crop: "center",
    focalX: 0.15,
    focalY: 0.5,
    quality: 90,
    format: "png",
  };
  const leftKey = variantKeyFor(base);
  assert.notEqual(leftKey, variantKeyFor({ ...base, focalX: 0.85 }));
});
