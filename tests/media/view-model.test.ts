// PCMS-MEDIA-T011/T020 — responsive widths/srcset View Model + public URL
// identity: themes receive resolved, fingerprinted URLs and never express a
// transform in a URL; hash/version changes move the URL safely.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  buildResponsiveImageModel,
  createMediaPresetRegistry,
  generateVariantsForAsset,
  InMemoryMediaStorage,
  LocalMediaStorage,
  listVariants,
  MediaError,
  uploadMedia,
  type VariantDependencies,
  variantPublicUrl,
} from "@pcms/media";
import sharp from "sharp";
import {
  assertBaseReachable,
  connectionInfo,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const PRESETS = [
  {
    id: "hero",
    width: 64,
    height: 48,
    fit: "cover",
    formats: ["avif", "webp", "jpeg"],
    quality: 80,
    loading: "eager",
  },
  { id: "card", width: 40, fit: "cover", formats: ["webp"], quality: 75 },
];

const LIMITS = { maxUploadBytes: 5_000_000, maxImagePixels: 64_000_000, maxImageDimension: 16_384 };

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

async function setup(t: { after: (fn: () => void) => void }): Promise<{
  pool: DbPool;
  deps: VariantDependencies;
  uploadJpeg: (
    width: number,
    height: number,
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
  const root = mkdtempSync(join(tmpdir(), "pcms-vm-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const quarantine = new InMemoryMediaStorage();
  const deps: VariantDependencies = { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes };
  const uploadJpeg = async (width: number, height: number, name: string) => {
    const bytes = await sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 120, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const accepted = await uploadMedia(
      { pool, storage, quarantine, limits: LIMITS },
      { bytes, filename: name, createdBy: "test" },
    );
    return accepted.asset;
  };
  return { pool, deps, uploadJpeg };
}

test("responsive model serves preset srcset without manual transform URLs", {
  skip: DB_SKIP,
}, async (t) => {
  const { deps, uploadJpeg } = await setup(t);
  const asset = await uploadJpeg(320, 200, "hero.jpg");
  const registry = createMediaPresetRegistry(PRESETS);
  await generateVariantsForAsset(deps, asset, registry);
  const variants = await listVariants(deps.pool, asset.id);
  const model = buildResponsiveImageModel({
    asset,
    variants,
    presetId: "hero",
    registry,
    sizes: "(min-width: 1024px) 800px, 100vw",
    altOverride: "Team at work",
  });
  assert.equal(model.preset, "hero");
  assert.equal(model.width, 64);
  assert.equal(model.height, 48);
  assert.match(model.src, /^\/media\/a\/[0-9a-f-]{36}\/v1\/hero-[0-9a-f]{16}\.(avif|webp|jpg)$/);
  assert.ok(!model.src.includes("?"), "no query-string transforms (Media spec §63)");
  assert.ok(!model.src.includes("w="), "no width parameter");
  // three format sources, each with width descriptors
  assert.deepEqual(
    model.sources.map((s) => s.mime),
    ["image/avif", "image/webp", "image/jpeg"],
  );
  for (const source of model.sources) {
    assert.match(source.srcset, / 64w$/);
  }
  assert.ok(model.srcset.includes(", "), "combined srcset lists all variants");
  assert.equal(model.sizes, "(min-width: 1024px) 800px, 100vw");
  assert.equal(model.alt, "Team at work", "usage override wins");
  assert.equal(model.loading, "eager", "loading intent from the preset");
});

test("URL identity moves with version and content, not with edits", {
  skip: DB_SKIP,
}, async (t) => {
  const url = variantPublicUrl({
    assetId: "01900000-0000-7000-8000-000000000000",
    versionNo: 1,
    presetId: "card",
    variantKey: "a".repeat(32),
    format: "webp",
  });
  assert.equal(
    url,
    "/media/a/01900000-0000-7000-8000-000000000000/v1/card-aaaaaaaaaaaaaaaa.webp",
    "version+key fingerprinted path",
  );
  const differentKey = variantPublicUrl({
    assetId: "01900000-0000-7000-8000-000000000000",
    versionNo: 1,
    presetId: "card",
    variantKey: "b".repeat(32),
    format: "webp",
  });
  assert.notEqual(url, differentKey.replace("card-", "card-"), "different content → different URL");
  const version2 = variantPublicUrl({
    assetId: "01900000-0000-7000-8000-000000000000",
    versionNo: 2,
    presetId: "card",
    variantKey: "a".repeat(32),
    format: "webp",
  });
  assert.match(version2, /\/v2\//, "replacement version moves the URL");
});

test("missing variants are loud, not a silent fallback to the original", {
  skip: DB_SKIP,
}, async (t) => {
  const { deps, uploadJpeg } = await setup(t);
  const asset = await uploadJpeg(50, 40, "quiet.jpg");
  const registry = createMediaPresetRegistry(PRESETS);
  const storedVariants = await listVariants(deps.pool, asset.id);
  assert.throws(
    () => buildResponsiveImageModel({ asset, variants: [], presetId: "hero", registry }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_VARIANT_MISSING",
  );
  assert.throws(
    () =>
      buildResponsiveImageModel({
        asset,
        variants: storedVariants,
        presetId: "nonexistent",
        registry,
      }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_PRESET_UNKNOWN",
  );
});
