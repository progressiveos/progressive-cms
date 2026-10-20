import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Verify the staged native binaries and their shared, anonymously available source. */
export async function checkNativeSourceSupply(
  root,
  { fetch: fetchSource = globalThis.fetch } = {},
) {
  const manifest = JSON.parse(readFileSync(join(root, "THIRD_PARTY_NATIVE_SOURCES.json"), "utf8"));
  assert.equal(manifest.schema, "pcms-native-sources/1");
  const url = new URL(manifest.url);
  assert.equal(url.protocol, "https:", "native sources require HTTPS");
  assert.ok(!url.username && !url.password && !url.hash, "native source URL must be public");
  assert.equal(decodeURIComponent(url.pathname.split("/").at(-1)), manifest.archive);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0);
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length > 0);
  for (const pkg of manifest.packages) {
    assert.match(pkg.name, /^@img\/sharp-libvips-[a-z0-9-]+$/);
    const dir = join(root, "node_modules", pkg.name);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, pkg.version);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "versions.json"), "utf8")), pkg.libraries);
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0);
    for (const file of pkg.files) {
      assert.ok(
        typeof file.path === "string" &&
          !file.path.startsWith("/") &&
          !file.path.includes("\\") &&
          file.path.split("/").every((part) => part && part !== "." && part !== ".."),
        "unsafe native file path",
      );
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(dir, file.path)))
          .digest("hex"),
        file.sha256,
        `${pkg.name}/${file.path}: native binary changed`,
      );
    }
  }
  const response = await fetchSource(url.href, {
    credentials: "omit",
    signal: AbortSignal.timeout(180_000),
  });
  assert.equal(response.status, 200, "native corresponding source is unavailable anonymously");
  assert.equal(new URL(response.url || url.href).protocol, "https:");
  assert.ok(response.body, "native source response has no body");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= manifest.bytes, "native source exceeds its pinned size");
    hash.update(chunk);
  }
  assert.equal(bytes, manifest.bytes, "native source size mismatch");
  assert.equal(hash.digest("hex"), manifest.sha256, "native source checksum mismatch");
  return { url: url.href, bytes, sha256: manifest.sha256 };
}
