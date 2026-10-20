// PCMS-MEDIA-T027 — reference fixture corpus (Media spec §65): every edge
// fixture runs through the real ingest pipeline end-to-end. SSRF import
// cases live in remote-import.test.ts; type-level mismatches in mime.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  getAsset,
  getVersionAudit,
  type IngestDependencies,
  type IngestLimits,
  InMemoryMediaStorage,
  LocalMediaStorage,
  MediaError,
  readImageMetadata,
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
import { twoFrameGif } from "./gif-fixture.js";

const LIMITS: IngestLimits = {
  maxUploadBytes: 20_000_000,
  maxImagePixels: 64_000_000,
  maxImageDimension: 16_384,
};
const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

/** Minimal stored-ZIP OOXML document (sniff only reads entry names). */
function minimalOoxml(dir: string): Buffer {
  const entries: [string, string][] = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types/>'],
    [`${dir}/document.xml`, '<?xml version="1.0"?><doc/>'],
  ];
  const parts: Buffer[] = [];
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const dataBytes = Buffer.from(data, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt32LE(dataBytes.length, 18);
    header.writeUInt16LE(nameBytes.length, 26);
    parts.push(header, nameBytes, dataBytes);
  }
  return Buffer.concat(parts);
}

test("§65 fixture corpus runs end-to-end through the pipeline", { skip: DB_SKIP }, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-corpus-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const deps: IngestDependencies = {
    pool,
    storage,
    quarantine: new InMemoryMediaStorage(),
    limits: LIMITS,
  };
  const replaceDeps = { pool, storage, maxSourceBytes: LIMITS.maxUploadBytes };
  const makeImage = async (
    width: number,
    height: number,
    format: "jpeg" | "png" = "jpeg",
    alpha = false,
  ): Promise<Buffer> =>
    sharp({
      create: {
        width,
        height,
        channels: alpha ? 4 : 3,
        background: { r: 90, g: 120, b: 200, ...(alpha ? { alpha: 0.5 } : {}) },
      },
    })
      [format]()
      .toBuffer();

  // 1–2. JPEG portrait + landscape
  const portrait = await uploadMedia(deps, {
    bytes: await makeImage(120, 240),
    filename: "portrait.jpg",
    createdBy: "corpus",
  });
  assert.deepEqual([portrait.asset.width, portrait.asset.height], [120, 240]);
  const landscape = await uploadMedia(deps, {
    bytes: await makeImage(240, 120),
    filename: "landscape.jpg",
    createdBy: "corpus",
  });
  assert.deepEqual([landscape.asset.width, landscape.asset.height], [240, 120]);

  // 3. PNG transparency
  const transparent = await uploadMedia(deps, {
    bytes: await makeImage(50, 50, "png", true),
    filename: "sticker.png",
    createdBy: "corpus",
  });
  assert.equal(
    (
      await readImageMetadata(
        await deps.storage.getBuffer(
          (
            await pool.query<{ storage_key: string }>(
              `SELECT b.storage_key FROM media_blobs b WHERE b.sha256 = $1`,
              [transparent.asset.sha256],
            )
          ).rows[0]!.storage_key,
          LIMITS.maxUploadBytes,
        ),
      )
    ).hasAlpha,
    true,
  );

  // 4. large image (6 MP, accepted well below the configured ceiling)
  const large = await uploadMedia(deps, {
    bytes: await makeImage(3000, 2000),
    filename: "panorama.jpg",
    createdBy: "corpus",
  });
  assert.deepEqual([large.asset.width, large.asset.height], [3000, 2000]);

  // 5. rotated EXIF image — display dimensions swap on ingest
  const rotated = await sharp({
    create: { width: 120, height: 240, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const rotatedAsset = await uploadMedia(deps, {
    bytes: rotated,
    filename: "rotated.jpg",
    createdBy: "corpus",
  });
  assert.deepEqual(
    [rotatedAsset.asset.width, rotatedAsset.asset.height],
    [240, 120],
    "display dims applied",
  );

  // 6. ICC profile image (CMYK JPEG) — original preserved untouched
  const cmyk = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 10, b: 90 } },
  })
    .toColourspace("cmyk")
    .jpeg()
    .toBuffer();
  const cmykAsset = await uploadMedia(deps, {
    bytes: cmyk,
    filename: "print.jpg",
    createdBy: "corpus",
  });
  const cmykReread = await readImageMetadata(cmyk);
  assert.equal(cmykReread.colorSpace, "cmyk", "original keeps its profile");
  assert.equal(cmykAsset.asset.sizeBytes, cmyk.length);

  // 7. SVG safe (privileged) vs malicious
  const safeSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#07c"/></svg>',
  );
  const safeAsset = await uploadMedia(deps, {
    bytes: safeSvg,
    filename: "logo.svg",
    privileged: true,
    createdBy: "corpus",
  });
  assert.equal(safeAsset.asset.mimeType, "image/svg+xml");
  await assert.rejects(
    uploadMedia(deps, {
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      filename: "evil.svg",
      privileged: true,
      createdBy: "corpus",
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_SVG_NOT_ALLOWED",
  );

  // 8–9. PDF + DOCX documents
  const pdf = await uploadMedia(deps, {
    bytes: Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 2)]),
    filename: "manual.pdf",
    createdBy: "corpus",
  });
  assert.equal(pdf.asset.kind, "document");
  const docx = await uploadMedia(deps, {
    bytes: minimalOoxml("word"),
    filename: "manual.docx",
    createdBy: "corpus",
  });
  assert.match(docx.asset.mimeType, /wordprocessingml/);

  // 10. duplicate bytes — one blob, two assets
  const originalBytes = await makeImage(64, 64, "png");
  const firstCopy = await uploadMedia(deps, {
    bytes: originalBytes,
    filename: "first.png",
    createdBy: "corpus",
  });
  const secondCopy = await uploadMedia(deps, {
    bytes: Buffer.from(originalBytes),
    filename: "second.png",
    createdBy: "corpus",
  });
  assert.equal(secondCopy.duplicateBlob, true);
  assert.equal(firstCopy.blob.id, secondCopy.blob.id);

  // 11. versioned document
  const v2 = await replaceDocument(replaceDeps, {
    assetId: pdf.asset.id,
    bytes: Buffer.concat([Buffer.from("%PDF-1.7\nsecond edition"), Buffer.alloc(64, 3)]),
    filename: "manual-v2.pdf",
    createdBy: "editor",
    note: "second edition",
  });
  assert.equal(v2.asset.currentVersionNo, 2);
  const audit = await getVersionAudit(pool, pdf.asset.id);
  assert.equal(audit.length, 2);

  // 12. Unicode filename — metadata preserved, storage identity hash-based
  const unicode = await uploadMedia(deps, {
    bytes: Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32, 4)]),
    filename: "прайс-лист 2026.pdf",
    createdBy: "corpus",
  });
  assert.equal(unicode.asset.filenameOriginal, "прайс-лист 2026.pdf");
  assert.match(unicode.blob.storageKey, /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/);

  // 13. animated GIF
  const animated = await uploadMedia(deps, {
    bytes: twoFrameGif(),
    filename: "spinner.gif",
    createdBy: "corpus",
  });
  const gifMeta = await readImageMetadata(twoFrameGif());
  assert.equal(gifMeta.animated, true);
  assert.equal(animated.asset.kind, "image");

  // 15. unsupported executable — rejected, no rows
  await assert.rejects(
    uploadMedia(deps, {
      bytes: Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 5)]),
      filename: "tool.exe",
      createdBy: "corpus",
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TYPE_NOT_ALLOWED",
  );

  // Every accepted corpus asset is retrievable and ready
  const all = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM media_assets WHERE archived_at IS NULL",
  );
  assert.equal(all.rows[0]?.n, 13);
  const stored = await getAsset(pool, unicode.asset.id);
  assert.ok(stored);
});
