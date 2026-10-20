// PCMS-MEDIA-T001 — storage adapter boundary: local adapter round-trip,
// adapter-generated keys (filename never filesystem authority), traversal
// safety and the bounded read guard.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { assertSafeKey, InMemoryMediaStorage, LocalMediaStorage, MediaError } from "@pcms/media";

function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "pcms-media-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  return join(root, "media");
}

const BYTES = Buffer.from("progressive-cms media blob \u{1F4BE} bytes");

test("local adapter stores under a generated content-addressed key", async (t) => {
  const storage = new LocalMediaStorage({ root: tempRoot(t) });
  const stored = await storage.put(BYTES);
  assert.match(stored.key, /^blobs\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  assert.equal(stored.sha256.length, 64);
  assert.equal(stored.sizeBytes, BYTES.length);

  const roundtrip = await storage.getBuffer(stored.key, 1024 * 1024);
  assert.deepEqual(roundtrip, BYTES);
  assert.deepEqual(await storage.stat(stored.key), { sizeBytes: BYTES.length });
});

test("duplicate bytes dedupe to the same storage object", async (t) => {
  const storage = new LocalMediaStorage({ root: tempRoot(t) });
  const first = await storage.put(BYTES);
  const second = await storage.put(Buffer.from(BYTES));
  assert.equal(second.key, first.key);
  assert.deepEqual(await storage.stat(first.key), { sizeBytes: BYTES.length });
});

test("original filename is never part of the storage identity", async (t) => {
  const storage = new LocalMediaStorage({ root: tempRoot(t) });
  // A hostile filename controls nothing: put() takes bytes only.
  const stored = await storage.put(BYTES);
  assert.ok(!stored.key.includes("passwd"));
  assert.ok(!stored.key.includes(".."));
  await assert.rejects(
    storage.stat(`blobs/../${stored.sha256}`),
    (error: unknown) => error instanceof MediaError,
  );
  await storage.put(BYTES);
  assert.ok(await storage.delete(stored.key));
});

test("adapter rejects keys that escape the root (traversal defense)", async (t) => {
  const storage = new LocalMediaStorage({ root: tempRoot(t) });
  for (const hostile of [
    "../outside",
    "blobs/../../etc/passwd",
    "/etc/passwd",
    "blobs//..",
    "UPPER",
    "blobs/a b",
  ]) {
    assert.throws(
      () => assertSafeKey(hostile),
      (error: unknown) => error instanceof MediaError,
      hostile,
    );
  }
  await assert.rejects(
    storage.getBuffer("../tmp/secret", 1024),
    (error: unknown) => error instanceof MediaError,
  );
});

test("getBuffer refuses to buffer beyond the declared bound", async () => {
  const storage = new InMemoryMediaStorage();
  const stored = await storage.put(Buffer.alloc(1000, 7));
  await assert.rejects(
    storage.getBuffer(stored.key, 999),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_TOO_LARGE",
  );
  assert.deepEqual((await storage.getBuffer(stored.key, 1000)).length, 1000);
});

test("streams are accepted and hashed incrementally", async () => {
  const storage = new InMemoryMediaStorage();
  const chunks = [Buffer.from("a".repeat(64)), Buffer.from("b".repeat(64))];
  const stored = await storage.put(Readable.from(chunks));
  assert.equal(stored.sizeBytes, 128);
  assert.equal(
    stored.sha256,
    (await import("node:crypto")).createHash("sha256").update(Buffer.concat(chunks)).digest("hex"),
  );
});
