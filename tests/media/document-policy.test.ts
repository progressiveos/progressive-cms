// PCMS-MEDIA-T014 — document MIME policy end-to-end: PDF/DOCX/TXT/CSV land
// as document assets; executables/scripts/archives never become media.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  type IngestDependencies,
  type IngestLimits,
  InMemoryMediaStorage,
  MediaError,
  uploadMedia,
} from "@pcms/media";
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

function minimalOoxml(dir: string): Buffer {
  const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
  const doc = `<?xml version="1.0"?><w:document xmlns:w="word"/>`;
  const entries: [string, string][] = [
    ["[Content_Types].xml", contentTypes],
    [`${dir}/document.xml`, doc],
  ];
  const local = (name: string, data: string): Buffer => {
    const nameBytes = Buffer.from(name, "utf8");
    const dataBytes = Buffer.from(data, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt32LE(dataBytes.length, 18);
    return Buffer.concat([header, nameBytes, dataBytes]);
  };
  return Buffer.concat(entries.map(([name, data]) => local(name, data)));
}

test("documents upload as document-kind assets; executables are denied", {
  skip: DB_SKIP,
}, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const deps: IngestDependencies = {
    pool,
    storage: new InMemoryMediaStorage(),
    quarantine: new InMemoryMediaStorage(),
    limits: LIMITS,
  };

  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n1 0 obj\n"), Buffer.alloc(64, 0x20)]);
  const pdfAsset = await uploadMedia(deps, {
    bytes: pdf,
    filename: "price-list.pdf",
    createdBy: "editor",
  });
  assert.equal(pdfAsset.asset.kind, "document");
  assert.equal(pdfAsset.asset.mimeType, "application/pdf");

  const docx = await uploadMedia(deps, {
    bytes: minimalOoxml("word"),
    filename: "brief.docx",
    createdBy: "editor",
  });
  assert.equal(docx.asset.kind, "document");
  assert.match(docx.asset.mimeType, /wordprocessingml/);

  for (const [bytes, filename, declared] of [
    [
      Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(32)]),
      "tool.exe",
      "application/x-msdownload",
    ],
    [Buffer.from("#!/bin/sh\nrm -rf /\n"), "cleanup.sh", "text/x-sh"],
    [Buffer.from("<?php echo $_GET['x']; ?>"), "shell.php", "application/x-php"],
    [
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 9)]),
      "bundle.zip",
      "application/zip",
    ],
  ] as [Buffer, string, string][]) {
    await assert.rejects(
      uploadMedia(deps, { bytes, filename, declaredMimeType: declared, createdBy: "editor" }),
      (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TYPE_NOT_ALLOWED",
      filename,
    );
  }
  // nothing dangerous ever became a row
  const count = await pool.query(
    "SELECT count(*)::int AS n FROM media_assets WHERE kind = 'generic_file'",
  );
  assert.equal(count.rows[0]?.n, 0);
});
