import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assertReleaseZipPermissions, packReleaseZip } from "../../scripts/pack-release-zip.mjs";
import {
  checkReleaseZipEntries,
  readReleaseZipEntries,
} from "../../scripts/release-content-policy.mjs";

test("actual release packer normalizes generated files and directories for both umasks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-zip-modes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mask of [0o022, 0o077]) {
    const out = join(root, `source-${mask}`);
    const paths = [
      "apps/admin/dist/index.html",
      "apps/web/src/main.js",
      "deploy/scripts/install-release.sh",
      "fixtures/content/reference-content-types.json",
      "skills/progressive-cms-site-builder/assets/theme-starter/fixtures/example.json",
    ];
    for (const path of paths) {
      const file = join(out, "release", path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "runtime");
      chmodSync(file, path.endsWith(".sh") ? 0o700 : 0o600);
    }
    const zip = join(root, `${mask}.zip`);
    const previous = process.umask(mask);
    try {
      await packReleaseZip(out, "release", zip);
    } finally {
      process.umask(previous);
    }
    assertReleaseZipPermissions(zip);
    const entries = readReleaseZipEntries(zip);
    assert.ok(entries.includes("release/apps/admin/dist/"));
    assert.deepEqual(
      checkReleaseZipEntries(entries, "release", {
        packageNames: new Set(),
        extensionDirs: new Set(),
        themeDirs: new Set(),
        docsIncluded: false,
      }),
      [],
    );
    for (const extractionMask of ["022", "077"]) {
      const stage = join(root, `unpacked-${mask}-${extractionMask}`);
      mkdirSync(stage);
      const result = spawnSync(
        "sh",
        ["-c", 'umask "$1"; unzip -q "$2" -d "$3"', "extract", extractionMask, zip, stage],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      for (const path of paths) {
        assert.equal(
          statSync(join(stage, "release", path)).mode & 0o777,
          path.endsWith(".sh") ? 0o755 : 0o644,
        );
        assert.equal(statSync(dirname(join(stage, "release", path))).mode & 0o777, 0o755);
      }
    }
  }
});

test("ZIP permissions gate rejects archived 0600 and unexpected directory roots", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-zip-unsafe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "index.html");
  writeFileSync(file, "admin", { mode: 0o600 });
  const zip = join(root, "unsafe.zip");
  assert.equal(spawnSync("zip", ["-q", zip, "index.html"], { cwd: root }).status, 0);
  assert.throws(() => assertReleaseZipPermissions(zip), /unsafe runtime permissions/);
  assert.ok(
    checkReleaseZipEntries(["release/", "release/private/"], "release", {
      packageNames: new Set(),
      extensionDirs: new Set(),
      themeDirs: new Set(),
      docsIncluded: false,
    }).some((failure: string) => failure.includes("outside release component allowlist")),
  );
});
