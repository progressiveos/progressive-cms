// PCMS-MEDIA-T025 — Media View Model/helper service: the composition bridge
// hands themes a resolved, storage-free model. Proven against the real
// Theme Contract helper (@pcms/themes buildImageModel) — themes never see
// storage internals and never build transform URLs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createMediaPresetRegistry,
  createMediaViewModelProvider,
  generateVariantsForAsset,
  InMemoryMediaStorage,
  LocalMediaStorage,
  uploadMedia,
  type VariantDependencies,
} from "@pcms/media";
import { buildImageModel, type MediaAssetViewModel } from "@pcms/themes";
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
    formats: ["avif", "webp"],
    quality: 80,
    loading: "eager",
  },
  { id: "thumbnail", width: 24, fit: "cover", formats: ["webp"], quality: 70 },
];
const LIMITS = { maxUploadBytes: 1_000_000, maxImagePixels: 64_000_000, maxImageDimension: 16_384 };
const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

test("provider output plugs straight into the Theme image helper", { skip: DB_SKIP }, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-vmprovider-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const quarantine = new InMemoryMediaStorage();
  const deps: VariantDependencies = { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes };

  const bytes = await sharp({
    create: { width: 200, height: 120, channels: 3, background: { r: 60, g: 180, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  const accepted = await uploadMedia(
    { pool, storage, quarantine, limits: LIMITS },
    { bytes, filename: "stage.jpg", createdBy: "editor" },
  );
  await updateAlt(pool, accepted.asset.id, "Keynote stage");
  const registry = createMediaPresetRegistry(PRESETS);
  await generateVariantsForAsset(deps, accepted.asset, registry);

  // The composition layer exposes ONLY this provider to the theme layer.
  const provider = createMediaViewModelProvider({ pool, registry });
  const viewModel = await provider.getAssetViewModel(accepted.asset.id, {
    altOverride: "Usage alt",
  });
  assert.ok(viewModel);
  // no storage internals leak into the public model
  const serialized = JSON.stringify(viewModel);
  assert.ok(!serialized.includes("blobs/"), "no storage keys");
  assert.ok(!serialized.includes(".tmp"), "no paths");
  assert.ok(!serialized.includes(accepted.blob.sha256), "no blob digests");

  assert.equal(viewModel.derivatives.length, 3, "hero avif+webp, thumbnail webp");
  assert.deepEqual(
    viewModel.derivatives.map((d) => d.preset),
    ["hero", "hero", "thumbnail"],
    "deterministic order",
  );
  assert.ok(
    viewModel.derivatives.every((d) => /^image\//.test(d.mime)),
    "derivatives carry their served MIME type (Theme picture sources)",
  );
  assert.equal(viewModel.alt, "Usage alt", "usage-level alt resolution applied");

  // Feed it to the REAL theme contract helper:
  const themeAsset: MediaAssetViewModel = {
    id: viewModel.id,
    alt: viewModel.alt,
    width: viewModel.width,
    height: viewModel.height,
    derivatives: viewModel.derivatives,
  };
  const image = buildImageModel(themeAsset, "hero", {
    id: "hero",
    width: 64,
    height: 48,
    loading: "eager",
  });
  assert.equal(image.src, viewModel.derivatives[0]!.url);
  assert.match(image.src, /^\/media\/a\/[0-9a-f-]+\/v1\/hero-[0-9a-f]{16}\.(avif|webp)$/);
  assert.ok(image.srcset.includes("webp") || image.srcset.includes("avif"));
  assert.equal(image.loading, "eager");
  assert.equal(image.alt, "Usage alt");

  // unknown asset → null; decorative → empty alt
  assert.equal(await provider.getAssetViewModel("01900000-0000-7000-8000-00000000dead"), null);
  const decorative = await provider.getAssetViewModel(accepted.asset.id, { decorative: true });
  assert.equal(decorative?.alt, "");
});

async function updateAlt(pool: DbPool, assetId: string, alt: string): Promise<void> {
  const { updateAssetMetadata } = await import("@pcms/media");
  await updateAssetMetadata(pool, assetId as never, { altDefault: alt });
}
