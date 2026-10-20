import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PUBLIC_LICENSE_FILES } from "../../scripts/release-content-policy.mjs";

test("native binary source/notice supply matches the installed pinned packages", () => {
  const manifest = JSON.parse(readFileSync("THIRD_PARTY_NATIVE_SOURCES.json", "utf8"));
  assert.equal(manifest.schema, "pcms-native-sources/1");
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.sources.length > 0);
  assert.ok(manifest.rust_crates.length > 0);
  for (const item of [...manifest.sources, ...manifest.rust_crates]) {
    assert.equal(new URL(item.url).protocol, "https:");
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!item.file.startsWith("/") && !item.file.split("/").includes(".."));
    assert.equal(item.error, undefined);
  }
  for (const pkg of manifest.packages) {
    const dir = join("node_modules", pkg.name);
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, pkg.version);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "versions.json"), "utf8")), pkg.libraries);
    for (const file of pkg.files)
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(dir, file.path)))
          .digest("hex"),
        file.sha256,
      );
  }
  const notices = readFileSync("THIRD_PARTY_NATIVE_NOTICES.txt", "utf8");
  assert.match(notices, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(notices, /Mozilla Public License/i);
  assert.ok(PUBLIC_LICENSE_FILES.includes("THIRD_PARTY_NATIVE_NOTICES.txt"));
  assert.ok(PUBLIC_LICENSE_FILES.includes("THIRD_PARTY_NATIVE_SOURCES.json"));
});
