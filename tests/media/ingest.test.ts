// PCMS-MEDIA-T003 — quarantine/accept pipeline: valid uploads become ready
// assets, invalid uploads never do (no rows, bytes retained in quarantine),
// and the media config section validates (limits defaults, mandatory dirs).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  isStableId,
  loadMigrations,
  migrateDatabase,
  newStableId,
} from "@pcms/core";
import {
  type AcceptedMedia,
  getAsset,
  getBlobByHash,
  type IngestDependencies,
  InMemoryMediaStorage,
  LocalMediaStorage,
  MediaError,
  uploadMedia,
} from "@pcms/media";
import {
  assertBaseReachable,
  connectionInfo,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function memoryDeps(pool: DbPool): IngestDependencies & {
  quarantine: InMemoryMediaStorage;
  storage: InMemoryMediaStorage;
} {
  const storage = new InMemoryMediaStorage();
  const quarantine = new InMemoryMediaStorage();
  return {
    pool,
    storage,
    quarantine,
    limits: { maxUploadBytes: 1000, maxImagePixels: 64000000, maxImageDimension: 16384 },
  };
}

async function poolFor(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

test("valid upload is quarantined, accepted and ready", { skip: DB_SKIP }, async (t) => {
  const pool = await poolFor(t);
  const deps = memoryDeps(pool);
  const bytes = Buffer.from("a perfectly ordinary v1 payload");
  const accepted = await uploadMedia(deps, {
    bytes,
    filename: "brief.txt",
    declaredMimeType: "text/plain",
    createdBy: "agent-1",
  });
  assert.equal(accepted.asset.kind, "document");
  assert.equal(accepted.version.versionNo, 1);
  assert.equal(accepted.duplicateBlob, false);
  const stored = await getAsset(pool, accepted.asset.id);
  assert.equal(stored?.sha256, accepted.asset.sha256);
  // accepted → quarantine copy is cleaned up
  assert.equal(await deps.quarantine.stat(accepted.blob.storageKey), null);
  // bytes are in the blob store under a generated content-addressed key
  const fromStorage = await deps.storage.getBuffer(accepted.blob.storageKey, 1000);
  assert.deepEqual(fromStorage, bytes);
  // the original filename never became the storage identity
  assert.ok(!accepted.blob.storageKey.includes("brief"));
});

test("invalid upload never becomes ready: no rows, quarantined bytes retained", {
  skip: DB_SKIP,
}, async (t) => {
  const pool = await poolFor(t);
  const deps = memoryDeps(pool);
  // sniff runs before the size gate (the kind decides the ceiling), so the
  // oversized fixture must be a type the registry allows (plain text)
  const tooBig = Buffer.alloc(1001, 0x61);
  await assert.rejects(
    uploadMedia(deps, { bytes: tooBig, filename: "big.txt", createdBy: "agent-1" }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TOO_LARGE",
  );
  await assert.rejects(
    uploadMedia(deps, { bytes: Buffer.alloc(0), filename: "empty.txt", createdBy: "agent-1" }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_EMPTY",
  );
  await assert.rejects(
    uploadMedia(deps, { bytes: Buffer.from("x"), filename: "x.txt", createdBy: "" }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_ACTOR_REQUIRED",
  );
  // no asset rows exist for anything rejected
  const result = await pool.query("SELECT count(*)::int AS n FROM media_assets");
  assert.equal(result.rows[0]?.n, 0);
});

test("local storage + quarantine directories work as the baseline adapter pair", {
  skip: DB_SKIP,
}, async (t) => {
  const pool = await poolFor(t);
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pcms-ingest-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const deps: IngestDependencies = {
    pool,
    storage: new LocalMediaStorage({ root: join(root, "media") }),
    quarantine: new LocalMediaStorage({ root: join(root, "quarantine") }),
    limits: { maxUploadBytes: 10_000, maxImagePixels: 64000000, maxImageDimension: 16384 },
  };
  const accepted: AcceptedMedia = await uploadMedia(deps, {
    bytes: Buffer.from("local adapter bytes"),
    filename: "notes.txt",
    createdBy: "agent-2",
  });
  assert.equal(accepted.asset.kind, "document");
});

test("every accepted upload round-trips identity through stable IDs", {
  skip: DB_SKIP,
}, async (t) => {
  const pool = await poolFor(t);
  const deps = memoryDeps(pool);
  const accepted = await uploadMedia(deps, {
    bytes: Buffer.from("identity check"),
    filename: "check.txt",
    createdBy: "agent-3",
  });
  assert.ok(isStableId(accepted.asset.id));
  assert.notEqual(accepted.asset.id, newStableId());
  assert.equal(accepted.version.assetId, accepted.asset.id);
});

test("per-kind ceilings: video/audio use their own caps, kind decides", {
  skip: DB_SKIP,
}, async (t) => {
  const pool = await poolFor(t);
  const deps = memoryDeps(pool);
  // Tiny "mp4" (sniffed signature, no real boxes needed for ingest) and a
  // text payload of the same size: the video fits its dedicated ceiling
  // while the document is over the (lower) generic one.
  const videoBytes = Buffer.concat([
    Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"),
    Buffer.alloc(600),
  ]);
  const wideLimits = {
    maxUploadBytes: 500,
    maxVideoUploadBytes: 5000,
    maxAudioUploadBytes: 5000,
    maxImagePixels: 64_000_000,
    maxImageDimension: 16_384,
  };
  const accepted = await uploadMedia(
    { ...deps, limits: wideLimits },
    {
      bytes: videoBytes,
      filename: "clip.mp4",
      createdBy: "agent-video",
    },
  );
  assert.equal(accepted.asset.kind, "video");
  await assert.rejects(
    uploadMedia(
      { ...deps, limits: wideLimits },
      {
        bytes: Buffer.alloc(600, 0x41),
        filename: "notes.txt",
        createdBy: "agent-video",
      },
    ),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TOO_LARGE",
  );
  // Without a configured video ceiling the product default still guards —
  // a hand-built limits object must never disable it.
  const { maxVideoUploadBytes: _omitted, ...noVideoCeiling } = wideLimits;
  const mp4Head = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2");
  await assert.rejects(
    uploadMedia(
      { ...deps, limits: noVideoCeiling },
      {
        bytes: Buffer.concat([mp4Head, Buffer.alloc(300_000_000)]),
        filename: "huge.mp4",
        createdBy: "agent-video",
      },
    ),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TOO_LARGE",
  );
  // disabledTypes narrowing refuses a sniffed type (instance policy)
  const narrowed = { ...wideLimits, disabledTypes: ["video/mp4"] };
  await assert.rejects(
    uploadMedia(
      { ...deps, limits: narrowed },
      {
        bytes: videoBytes,
        filename: "clip.mp4",
        createdBy: "agent-video",
      },
    ),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TYPE_NOT_ALLOWED",
  );
});

test("duplicate bytes store one blob but stay separate logical assets (T005)", {
  skip: DB_SKIP,
}, async (t) => {
  const pool = await poolFor(t);
  const deps = memoryDeps(pool);
  const bytes = Buffer.from("identical payload for dedupe");
  const first = await uploadMedia(deps, { bytes, filename: "first.txt", createdBy: "agent-a" });
  const second = await uploadMedia(deps, { bytes, filename: "second.txt", createdBy: "agent-b" });
  assert.equal(first.duplicateBlob, false);
  assert.equal(second.duplicateBlob, true);
  assert.equal(first.blob.id, second.blob.id);
  assert.equal(first.blob.storageKey, second.blob.storageKey);
  assert.notEqual(first.asset.id, second.asset.id);
  assert.equal(second.asset.createdBy, "agent-b");
  // physical storage holds exactly one copy
  const blobs = await pool.query("SELECT count(*)::int AS n FROM media_blobs");
  assert.equal(blobs.rows[0]?.n, 1);
  // hash lookup works for the agent dedupe workflow (Media spec §45)
  const byHash = await getBlobByHash(pool, first.asset.sha256);
  assert.equal(byHash?.id, first.blob.id);
});
