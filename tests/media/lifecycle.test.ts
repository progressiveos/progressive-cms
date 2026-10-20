// PCMS-MEDIA-T015/T016 — logical document replacement + version audit:
// existing references see the current version, history is append-only and
// stable, images reject in-place replacement, type changes are refused.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  getAsset,
  getVersionAudit,
  type IngestLimits,
  InMemoryMediaStorage,
  LocalMediaStorage,
  MediaError,
  type ReplaceDependencies,
  replaceDocument,
  uploadMedia,
} from "@pcms/media";
import sharp from "sharp";
import {
  assertBaseReachable,
  connectionInfo,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const LIMITS: IngestLimits = {
  maxUploadBytes: 5_000_000,
  maxImagePixels: 64_000_000,
  maxImageDimension: 16_384,
};
const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

async function setup(t: { after: (fn: () => void) => void }): Promise<{
  pool: DbPool;
  replace: ReplaceDependencies;
  upload: (
    bytes: Buffer,
    name: string,
    declared?: string,
  ) => Promise<Awaited<ReturnType<typeof uploadMedia>>>;
}> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-lifecycle-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const quarantine = new InMemoryMediaStorage();
  const upload = async (bytes: Buffer, name: string, declared?: string) =>
    uploadMedia(
      { pool, storage, quarantine, limits: LIMITS },
      {
        bytes,
        filename: name,
        createdBy: "agent-a",
        ...(declared === undefined ? {} : { declaredMimeType: declared }),
      },
    );
  return { pool, replace: { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes }, upload };
}

function pdf(content: string): Buffer {
  return Buffer.concat([Buffer.from(`%PDF-1.7\n${content}\n`), Buffer.alloc(32, 0x20)]);
}

test("document replacement moves the current version; refs see new bytes", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, replace, upload } = await setup(t);
  const january = await upload(pdf("price January"), "price-2026-01.pdf");
  const september = await replaceDocument(replace, {
    assetId: january.asset.id,
    bytes: pdf("price September"),
    filename: "price-2026-09.pdf",
    createdBy: "editor-b",
    note: "september update",
  });
  assert.equal(september.asset.currentVersionNo, 2);
  assert.equal(september.asset.sha256, september.version.sha256);
  assert.equal(september.duplicateBlob, false);

  // A content row "referencing" the asset ID resolves to the CURRENT version:
  const current = await getAsset(pool, january.asset.id);
  assert.equal(current?.filenameOriginal, "price-2026-09.pdf");
  const storedBytes = await replace.storage.getBuffer(
    (
      await pool.query<{ storage_key: string }>(
        `SELECT b.storage_key FROM media_blobs b JOIN media_versions v ON v.blob_id = b.id
         WHERE v.asset_id = $1 AND v.version_no = $2`,
        [january.asset.id, current?.currentVersionNo],
      )
    ).rows[0]!.storage_key,
    LIMITS.maxUploadBytes,
  );
  assert.ok(storedBytes.includes("price September"));
  // the old version blob is still retained (audit + historical integrity)
  const oldBlob = await pool.query<{ storage_key: string }>(
    `SELECT b.storage_key FROM media_blobs b JOIN media_versions v ON v.blob_id = b.id
     WHERE v.asset_id = $1 AND v.version_no = 1`,
    [january.asset.id],
  );
  const oldBytes = await replace.storage.getBuffer(
    oldBlob.rows[0]!.storage_key,
    LIMITS.maxUploadBytes,
  );
  assert.ok(oldBytes.includes("price January"));
});

test("version audit is append-only and stable across replacements", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, replace, upload } = await setup(t);
  const v1 = await upload(pdf("v1 body"), "doc.pdf");
  await replaceDocument(replace, {
    assetId: v1.asset.id,
    bytes: pdf("v2 body"),
    filename: "doc-v2.pdf",
    createdBy: "editor-1",
  });
  const firstAudit = await getVersionAudit(pool, v1.asset.id);
  assert.deepEqual(
    firstAudit.map((v) => [v.versionNo, v.createdBy]),
    [
      [1, "agent-a"],
      [2, "editor-1"],
    ],
  );
  await replaceDocument(replace, {
    assetId: v1.asset.id,
    bytes: pdf("v3 body"),
    filename: "doc-v3.pdf",
    createdBy: "editor-2",
    note: "final",
  });
  const secondAudit = await getVersionAudit(pool, v1.asset.id);
  assert.equal(secondAudit.length, 3);
  assert.deepEqual(
    firstAudit.map((v) => v.versionNo),
    [1, 2],
    "earlier audit entries unchanged",
  );
  assert.equal(secondAudit[2]?.note, "final");
});

test("images refuse in-place replacement; type swaps are refused", { skip: DB_SKIP }, async (t) => {
  const { replace, upload } = await setup(t);
  const bytes = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .png()
    .toBuffer();
  const image = await upload(bytes, "photo.png");
  await assert.rejects(
    replaceDocument(replace, {
      assetId: image.asset.id,
      bytes: await sharp({
        create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 10, b: 10 } },
      })
        .png()
        .toBuffer(),
      filename: "photo-2.png",
      createdBy: "editor",
    }),
    (error: unknown) =>
      error instanceof MediaError && error.code === "MEDIA_IMAGE_REPLACEMENT_FORBIDDEN",
  );

  const doc = await upload(pdf("original"), "report.pdf");
  await assert.rejects(
    replaceDocument(replace, {
      assetId: doc.asset.id,
      bytes: Buffer.from("plain text pretending to be a new pdf"),
      filename: "report.txt",
      createdBy: "editor",
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_MIME_MISMATCH",
  );
  await assert.rejects(
    replaceDocument(replace, {
      assetId: "01900000-0000-7000-8000-000000000000",
      bytes: pdf("x"),
      filename: "x.pdf",
      createdBy: "editor",
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_ASSET_NOT_FOUND",
  );
});
