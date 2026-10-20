// PCMS-MEDIA-T010 — AVIF/WebP/fallback variant generation against storage +
// PostgreSQL: dimensions/format correctness, idempotent regeneration,
// concurrency safety, and the SVG/non-image skip policy.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createMediaPresetRegistry,
  generateVariantsForAsset,
  InMemoryMediaStorage,
  LocalMediaStorage,
  listVariants,
  type MediaAssetRecord,
  readImageMetadata,
  readVariantBytes,
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

const PRESETS = [
  { id: "hero", width: 64, height: 48, fit: "cover", formats: ["avif", "webp"], quality: 80 },
  { id: "card", width: 40, fit: "cover", formats: ["webp", "jpeg"], quality: 75 },
];

const LIMITS = { maxUploadBytes: 5_000_000, maxImagePixels: 64_000_000, maxImageDimension: 16_384 };

interface Fixture {
  pool: DbPool;
  deps: VariantDependencies;
  upload: (bytes: Buffer, name: string, privileged?: boolean) => Promise<MediaAssetRecord>;
}

async function setup(t: { after: (fn: () => void) => void }): Promise<Fixture> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-variants-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const quarantine = new InMemoryMediaStorage();
  const deps: VariantDependencies = { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes };
  const upload = async (
    bytes: Buffer,
    name: string,
    privileged = false,
  ): Promise<MediaAssetRecord> => {
    const accepted = await uploadMedia(
      { pool, storage, quarantine, limits: LIMITS },
      { bytes, filename: name, createdBy: "test", privileged },
    );
    return accepted.asset;
  };
  return { pool, deps, upload };
}

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

test("variants are generated in every declared format with preset dimensions", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, deps, upload } = await setup(t);
  const source = await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 90, g: 20, b: 180 } },
  })
    .jpeg()
    .toBuffer();
  const asset = await upload(source, "photo.jpg");
  const registry = createMediaPresetRegistry(PRESETS);
  const generated = await generateVariantsForAsset(deps, asset, registry);
  assert.equal(generated.length, 4, "hero avif+webp, card webp+jpeg");
  const hero = generated.find((v) => v.presetId === "hero" && v.format === "avif");
  assert.ok(hero);
  assert.equal(hero.width, 64);
  assert.equal(hero.height, 48);
  const stored = await listVariants(pool, asset.id);
  assert.equal(stored.length, 4);
  for (const variant of stored) {
    assert.equal(variant.versionNo, 1);
    assert.match(variant.variantKey, /^[0-9a-f]{32}$/);
    const bytes = await readVariantBytes(deps, variant);
    assert.equal((await readImageMetadata(bytes)).format, variant.format, variant.format);
  }
});

test("regeneration reuses existing variants (idempotency)", { skip: DB_SKIP }, async (t) => {
  const { deps, upload } = await setup(t);
  const source = await sharp({
    create: { width: 100, height: 80, channels: 3, background: { r: 200, g: 10, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  const asset = await upload(source, "idem.jpg");
  const registry = createMediaPresetRegistry(PRESETS);
  const first = await generateVariantsForAsset(deps, asset, registry);
  assert.equal(first.filter((v) => !v.reused).length, 4);
  const second = await generateVariantsForAsset(deps, asset, registry);
  assert.equal(second.length, 4);
  assert.equal(second.filter((v) => v.reused).length, 4, "second run reuses everything");
});

test("concurrent generation stays safe: one winner per variant key", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, deps, upload } = await setup(t);
  const source = await sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 200, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  const asset = await upload(source, "race.jpg");
  const registry = createMediaPresetRegistry(PRESETS);
  const [a, b] = await Promise.all([
    generateVariantsForAsset(deps, asset, registry),
    generateVariantsForAsset(deps, asset, registry),
  ]);
  assert.equal(await listVariants(pool, asset.id).then((rows) => rows.length), 4);
  const seen = new Set(a.concat(b).map((v) => `${v.presetId}/${v.format}`));
  assert.equal(seen.size, 4, "no duplicated variant identities");
});

test("SVG and documents generate no raster variants", { skip: DB_SKIP }, async (t) => {
  const { deps, upload } = await setup(t);
  const registry = createMediaPresetRegistry(PRESETS);
  const svg = Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
  );
  const svgAsset = await upload(svg, "logo.svg", true);
  assert.equal(
    await generateVariantsForAsset(deps, svgAsset, registry).then((r) => r.length),
    0,
    "SVG is never silently rasterized",
  );
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 1)]);
  const doc = await upload(pdf, "brief.pdf");
  assert.equal(await generateVariantsForAsset(deps, doc, registry).then((r) => r.length), 0);
});
