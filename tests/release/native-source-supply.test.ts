import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkNativeSourceSupply } from "../../scripts/check-native-source-supply.mjs";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pcms-native-supply-"));
  const dir = join(root, "node_modules/@img/sharp-libvips-linux-x64");
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.3.4" }));
  writeFileSync(join(dir, "versions.json"), JSON.stringify({ vips: "8.18.7" }));
  writeFileSync(join(dir, "lib/vips.so"), "binary");
  const manifest = {
    schema: "pcms-native-sources/1",
    archive: "sources.zip",
    url: "https://github.com/progressiveos/example/releases/download/v1/sources.zip",
    bytes: 6,
    sha256: sha256("source"),
    packages: [
      {
        name: "@img/sharp-libvips-linux-x64",
        version: "1.3.4",
        libraries: { vips: "8.18.7" },
        files: [{ path: "lib/vips.so", sha256: sha256("binary") }] satisfies [unknown],
      },
    ] satisfies [unknown],
  };
  const save = () =>
    writeFileSync(join(root, "THIRD_PARTY_NATIVE_SOURCES.json"), JSON.stringify(manifest));
  save();
  return { root, manifest, save };
}

test("native source gate verifies the anonymous source stream against the staged binary", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const result = await checkNativeSourceSupply(f.root, {
    fetch: async (url, options) => {
      assert.equal(url, f.manifest.url);
      assert.equal(options?.credentials, "omit");
      assert.equal(options?.headers, undefined);
      return new Response("source");
    },
  });
  assert.deepEqual(result, { url: f.manifest.url, bytes: 6, sha256: sha256("source") });
});

test("native source gate rejects package/library/binary drift and unsafe source paths before download", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const original = JSON.stringify(f.manifest);
  let downloads = 0;
  const fetchSource: typeof fetch = async () => {
    downloads++;
    return new Response("source");
  };
  for (const change of [
    () => {
      f.manifest.packages[0].version = "1.3.5";
    },
    () => {
      f.manifest.packages[0].libraries.vips = "9.0.0";
    },
    () => {
      f.manifest.packages[0].files[0].sha256 = sha256("other");
    },
    () => {
      f.manifest.packages[0].files[0].path = "../outside";
    },
    () => {
      f.manifest.url = f.manifest.url.replace("https:", "http:");
    },
    () => {
      f.manifest.url = f.manifest.url.replace("github.com", "secret@github.com");
    },
  ]) {
    Object.assign(f.manifest, JSON.parse(original));
    change();
    f.save();
    await assert.rejects(checkNativeSourceSupply(f.root, { fetch: fetchSource }));
  }
  assert.equal(downloads, 0);
});

test("native source gate fails closed on unavailable, truncated, oversized or corrupted source", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (const [body, status] of [
    ["", 404],
    ["short", 200],
    ["too long", 200],
    ["broken", 200],
  ] as const)
    await assert.rejects(
      checkNativeSourceSupply(f.root, { fetch: async () => new Response(body, { status }) }),
    );
});
