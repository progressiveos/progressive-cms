// PCMS-PCPUB E11 gates (ADR-0014 §7/§11; owner §52/§79): parser hardening
// under hostile input. Every failure surfaces as a typed PcpubError (or a
// plain rejection) — never a crash, never silent acceptance. Includes the
// decompression-bomb bound and malformed-UTF-8 manifest rejection.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PCPUB_LIMITS,
  openPcpubArchive,
  PcpubError,
  parseManifest,
  parsePcmd,
} from "@pcms/publication";
import yazl from "yazl";

let seed = 0x2f6e2b1;
/** Deterministic xorshift PRNG — reproducible "fuzz" corpus. */
function next(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pcpub-fuzz-"));
}

/** Raw store-only ZIP builder (hostile entry names yazl refuses to write). */
function rawZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (data: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, entry.data);
    const dirEntry = Buffer.alloc(46);
    dirEntry.writeUInt32LE(0x02014b50, 0);
    dirEntry.writeUInt16LE(20, 4);
    dirEntry.writeUInt16LE(20, 6);
    dirEntry.writeUInt16LE(0x0800, 8);
    dirEntry.writeUInt32LE(crc, 16);
    dirEntry.writeUInt32LE(entry.data.length, 20);
    dirEntry.writeUInt32LE(entry.data.length, 24);
    dirEntry.writeUInt16LE(nameBytes.length, 28);
    dirEntry.writeUInt32LE(offset, 42);
    central.push(dirEntry, nameBytes);
    offset += 30 + nameBytes.length + entry.data.length;
  }
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, eocd]);
}

test("random bytes never crash the archive reader — typed rejection only", async () => {
  const dir = await tempDir();
  try {
    for (let round = 0; round < 40; round += 1) {
      const size = next() % 4096;
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i += 1) bytes[i] = next() & 0xff;
      const path = join(dir, `fuzz-${round}.bin`);
      await writeFile(path, bytes);
      // Must reject typed; must never hang or throw a non-PcpubError shape
      // (openPcpubArchive wraps all parse failures as PCPUB_ARCHIVE_*).
      await assert.rejects(openPcpubArchive(path, DEFAULT_PCPUB_LIMITS), (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const code = (error as Error & { code?: string }).code;
        return (
          error.name === "PcpubError" ||
          /END_OF_CENTRAL_DIRECTORY|invalid/i.test(error.message) ||
          code === "PCPUB_ARCHIVE_UNREADABLE" ||
          code === "PCPUB_ARCHIVE_UNSAFE_PATH" ||
          code === "PCPUB_ARCHIVE_UNDECLARED_ENTRY"
        );
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a valid ZIP header with junk entries still fails closed", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "junk.pcpub");
    await writeFile(
      path,
      rawZip([
        { name: "content/../../evil.pcmd", data: Buffer.from("junk") },
        { name: "content/../../evil.pcmd", data: Buffer.from("junk") },
      ]),
    );
    await assert.rejects(
      openPcpubArchive(path, DEFAULT_PCPUB_LIMITS),
      (error: unknown) =>
        error instanceof Error &&
        /unsafe|duplicate|allowlist|damaged|relative/i.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decompression bomb: small archive, huge uncompressed entry — bounded", async () => {
  const dir = await tempDir();
  try {
    // 160 MiB of zeros deflates to ~150 KiB — far under the compressed cap,
    // far over the per-entry uncompressed cap. This IS the bomb shape.
    const bomb = Buffer.alloc(160 * 1024 * 1024, 0);
    const zipfile = new yazl.ZipFile();
    zipfile.addBuffer(bomb, "assets/bomb.png", { compress: true });
    zipfile.end();
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      zipfile.outputStream.on("end", resolve);
      zipfile.outputStream.on("error", reject);
    });
    const path = join(dir, "bomb.pcpub");
    await writeFile(path, Buffer.concat(chunks));
    const { stat } = await import("node:fs/promises");
    assert.ok((await stat(path)).size < 1024 * 1024, "bomb must be small compressed");
    await assert.rejects(
      openPcpubArchive(path, DEFAULT_PCPUB_LIMITS),
      (error: unknown) =>
        error instanceof PcpubError && error.code === "PCPUB_ARCHIVE_ENTRY_TOO_LARGE",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest decoder: malformed UTF-8 and hostile JSON fail typed", () => {
  assert.throws(
    () => parseManifest(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), DEFAULT_PCPUB_LIMITS),
    /UTF-8 JSON/,
  );
  const hostile = Buffer.from('{"format":"x","__proto__":{"a":1}}', "utf8");
  assert.throws(
    () => parseManifest(hostile, DEFAULT_PCPUB_LIMITS),
    (error: unknown) => error instanceof PcpubError,
  );
});

test("PCMD parser: mutated documents never parse into invalid state", () => {
  const base = `---
pcmd_version: 1
operation: create
external_id: hero
content_type: page
fields:
  title: Заголовок
---
:::block text@1
rich_text: "x"
:::
`;
  for (let round = 0; round < 300; round += 1) {
    const bytes = Buffer.from(base, "utf8");
    const mutations = 1 + (next() % 6);
    for (let i = 0; i < mutations; i += 1) {
      const at = Math.floor(next() % bytes.length);
      bytes[at] = next() & 0xff;
    }
    // Either parses (mutation landed in a value) or throws PcpubError —
    // NEVER a RangeError/TypeError from the parser internals.
    try {
      const document = parsePcmd(bytes.toString("utf8"), "fuzz", 200);
      assert.ok(document.blocks.length <= 200);
      assert.ok(document.operation === "create" || document.operation === "update");
    } catch (error) {
      assert.ok(error instanceof PcpubError, `typed error expected, got ${error}`);
    }
  }
});
