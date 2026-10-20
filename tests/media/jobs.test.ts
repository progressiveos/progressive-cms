// PCMS-MEDIA-T019 — async media jobs: bounded in-process runner with
// retries, coalescing and concurrency bounds; idempotent variant generation
// through the runner against PostgreSQL.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createMediaJobRunner,
  createMediaPresetRegistry,
  generateVariantsForAsset,
  InMemoryMediaStorage,
  LocalMediaStorage,
  listVariants,
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

test("runner retries transient failures with backoff", async () => {
  let attempts = 0;
  const retries: number[] = [];
  let gaveUp = 0;
  const runner = createMediaJobRunner({
    concurrency: 1,
    baseDelayMilliseconds: 1,
    maxAttempts: 3,
    onRetry: (_key, attempt) => retries.push(attempt),
    onGiveUp: () => {
      gaveUp += 1;
    },
  });
  runner.submit({
    key: "flaky",
    run: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient processor failure");
    },
  });
  await runner.whenIdle();
  assert.equal(attempts, 3);
  assert.deepEqual(retries, [1, 2]);
  assert.equal(gaveUp, 0);
});

test("runner gives up after max attempts", async () => {
  let attempts = 0;
  const failures: string[] = [];
  const runner = createMediaJobRunner({
    baseDelayMilliseconds: 1,
    maxAttempts: 2,
    onGiveUp: (key) => failures.push(key),
  });
  runner.submit({
    key: "broken",
    run: async () => {
      attempts += 1;
      throw new Error("permanent failure");
    },
  });
  await runner.whenIdle();
  assert.equal(attempts, 2);
  assert.deepEqual(failures, ["broken"]);
});

test("duplicate submissions coalesce onto one execution", async () => {
  let runs = 0;
  const runner = createMediaJobRunner({ concurrency: 4 });
  for (let i = 0; i < 10; i += 1) {
    runner.submit({
      key: "variants:asset-1",
      run: async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
  }
  await runner.whenIdle();
  assert.equal(runs, 1, "key-based coalescing");
});

test("concurrency is bounded", async () => {
  let running = 0;
  let maxObserved = 0;
  const runner = createMediaJobRunner({ concurrency: 2 });
  for (let i = 0; i < 10; i += 1) {
    runner.submit({
      key: `job-${i}`,
      run: async () => {
        running += 1;
        maxObserved = Math.max(maxObserved, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      },
    });
  }
  await runner.whenIdle();
  assert.equal(maxObserved, 2);
});

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

test("variant generation through the runner is idempotent", { skip: DB_SKIP }, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-jobs-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const deps: VariantDependencies = { pool, storage, maxSourceBytes: 5_000_000 };
  const bytes = await sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 90, g: 200, b: 10 } },
  })
    .jpeg()
    .toBuffer();
  const accepted = await uploadMedia(
    {
      pool,
      storage,
      quarantine: new InMemoryMediaStorage(),
      limits: { maxUploadBytes: 5_000_000, maxImagePixels: 64_000_000, maxImageDimension: 16_384 },
    },
    { bytes, filename: "job.jpg", createdBy: "test" },
  );
  const registry = createMediaPresetRegistry([
    { id: "thumb", width: 24, fit: "cover", formats: ["webp"], quality: 80 },
  ]);

  const runner = createMediaJobRunner({ concurrency: 2 });
  runner.submit({
    key: `variants:${accepted.asset.id}`,
    run: () => generateVariantsForAsset(deps, accepted.asset, registry).then(() => {}),
  });
  runner.submit({
    key: `variants:${accepted.asset.id}`,
    run: () => generateVariantsForAsset(deps, accepted.asset, registry).then(() => {}),
  });
  runner.submit({
    key: `variants:${accepted.asset.id}`,
    run: () => generateVariantsForAsset(deps, accepted.asset, registry).then(() => {}),
  });
  await runner.whenIdle();

  const variants = await listVariants(pool, accepted.asset.id);
  assert.equal(variants.length, 1, "exactly one derivative exists, not three");
});
