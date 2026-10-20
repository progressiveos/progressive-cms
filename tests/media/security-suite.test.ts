// PCMS-MEDIA-T029 — consolidated security/resource-limit/integration suite.
// Every rejection path is proven against the REAL pipeline with PostgreSQL:
// hostile filenames, MIME spoofing, decompression bombs, corrupt decoders,
// dangerous SVG, oversized uploads — and none of them ever leaves a row or
// a stored object behind. SSRF/redirect bypasses: remote-import.test.ts;
// delete/authorization capability checks: usage.test.ts, gc.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createMediaDiscoveryService,
  type IngestDependencies,
  type IngestLimits,
  InMemoryMediaStorage,
  LocalMediaStorage,
  MediaError,
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
  maxUploadBytes: 100_000,
  maxImagePixels: 1_000_000,
  maxImageDimension: 2048,
};
const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

async function setup(t: { after: (fn: () => void) => void }): Promise<{
  pool: DbPool;
  deps: IngestDependencies;
  storageRoot: string;
}> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-security-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storageRoot = join(root, "media");
  const storage = new LocalMediaStorage({ root: storageRoot });
  return {
    pool,
    deps: { pool, storage, quarantine: new InMemoryMediaStorage(), limits: LIMITS },
    storageRoot,
  };
}

function countPhysicalObjects(storageRoot: string): number {
  const blobsDir = join(storageRoot, "blobs");
  if (!existsSync(blobsDir)) return 0;
  return readdirSync(blobsDir).reduce(
    (acc, dir) => acc + readdirSync(join(blobsDir, dir)).length,
    0,
  );
}

async function assertNoRowsAndNoObjects(pool: DbPool, storageRoot: string): Promise<void> {
  const assets = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM media_assets");
  const blobs = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM media_blobs");
  assert.equal(assets.rows[0]?.n, 0, "no asset rows after rejection");
  assert.equal(blobs.rows[0]?.n, 0, "no blob rows after rejection");
  assert.equal(countPhysicalObjects(storageRoot), 0, "no physical objects in the blob store");
}

test("path-traversal and hostile filenames never touch storage identity", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, deps, storageRoot } = await setup(t);
  const bytes = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 90, b: 0 } },
  })
    .jpeg()
    .toBuffer();
  for (const hostile of [
    "../../etc/passwd.jpg",
    "..\\..\\windows\\system32\\evil.jpg",
    'weird "quote" <b>.jpg',
    "слоны-и-мамонты 🐘.jpg",
  ]) {
    const accepted = await uploadMedia(deps, { bytes, filename: hostile, createdBy: "attacker" });
    // identity is purely content-addressed — no segment of the hostile name survives
    assert.match(accepted.blob.storageKey, /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    // metadata keeps the human-readable name — but it is never a path
    const stored = await pool.query<{ filename_original: string }>(
      "SELECT filename_original FROM media_assets WHERE id = $1",
      [accepted.asset.id],
    );
    assert.equal(stored.rows[0]?.filename_original, hostile);
  }
});

test("MIME spoofing (exe as .jpg with image/jpeg declaration) is rejected", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, deps, storageRoot } = await setup(t);
  await assert.rejects(
    uploadMedia(deps, {
      bytes: Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 6)]),
      filename: "totally-a-photo.jpg",
      declaredMimeType: "image/jpeg",
      createdBy: "attacker",
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TYPE_NOT_ALLOWED",
  );
  await assertNoRowsAndNoObjects(pool, storageRoot);
});

test("decompression bombs are rejected at the configured pixel ceiling", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, deps, storageRoot } = await setup(t);
  // Valid PNG header declaring 6000×6000 = 36 MP > the 1 MP test ceiling.
  const ihdr = Buffer.alloc(17);
  ihdr.write("IHDR", 0, "latin1");
  ihdr.writeUInt32BE(6000, 4);
  ihdr.writeUInt32BE(6000, 8);
  ihdr.writeUInt8(8, 12);
  ihdr.writeUInt8(2, 13);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(ihdr) >>> 0, 0);
  const idat = Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54]);
  const idatCrc = Buffer.alloc(4);
  idatCrc.writeUInt32BE(crc32(idat.subarray(4)) >>> 0, 0);
  const bomb = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    length,
    ihdr,
    crc,
    idat,
    idatCrc,
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ]);
  await assert.rejects(
    uploadMedia(deps, { bytes: bomb, filename: "bomb.png", createdBy: "attacker" }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_PIXEL_LIMIT",
  );
  await assertNoRowsAndNoObjects(pool, storageRoot);
});

test("corrupt decoder input never becomes an asset", { skip: DB_SKIP }, async (t) => {
  const { pool, deps, storageRoot } = await setup(t);
  await assert.rejects(
    uploadMedia(deps, {
      bytes: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("garbage"),
      ]),
      filename: "corrupt.png",
      createdBy: "attacker",
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_DECODE_FAILED",
  );
  await assertNoRowsAndNoObjects(pool, storageRoot);
});

test("dangerous SVG is rejected even on the privileged path", { skip: DB_SKIP }, async (t) => {
  const { pool, deps, storageRoot } = await setup(t);
  await assert.rejects(
    uploadMedia(deps, {
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//evil")</script></svg>',
      ),
      filename: "beacon.svg",
      privileged: true,
      createdBy: "attacker",
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_SVG_NOT_ALLOWED",
  );
  await assertNoRowsAndNoObjects(pool, storageRoot);
});

test("oversized uploads hit the byte ceiling before decode work", { skip: DB_SKIP }, async (t) => {
  const { pool, deps, storageRoot } = await setup(t);
  // The sniff gates the type before the size ceiling (the kind decides the
  // cap), so the oversized fixture must be sniffable JPEG to reach it.
  await assert.rejects(
    uploadMedia(deps, {
      bytes: Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(LIMITS.maxUploadBytes + 1),
      ]),
      filename: "huge.jpg",
      createdBy: "attacker",
    }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TOO_LARGE",
  );
  await assertNoRowsAndNoObjects(pool, storageRoot);
});

test("document replacement keeps the audit trail and type lock (integration)", {
  skip: DB_SKIP,
}, async (t) => {
  const { pool, deps, storageRoot } = await setup(t);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\nsafe"), Buffer.alloc(32, 1)]);
  const accepted = await uploadMedia(deps, {
    bytes: pdf,
    filename: "report.pdf",
    createdBy: "editor",
  });
  await assert.rejects(
    replaceDocument(
      { pool, storage: deps.storage, maxSourceBytes: LIMITS.maxUploadBytes },
      {
        assetId: accepted.asset.id,
        bytes: Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(32, 1)]),
        filename: "report.pdf",
        createdBy: "attacker",
      },
    ),
    (error: unknown) => error instanceof MediaError,
  );
  // the asset still resolves to the original version
  const discovery = createMediaDiscoveryService(pool);
  const inspection = await discovery.inspectAsset(accepted.asset.id);
  assert.equal(inspection.versions.length, 1);
  assert.equal(inspection.versions[0]!.sha256, accepted.asset.sha256);
});
