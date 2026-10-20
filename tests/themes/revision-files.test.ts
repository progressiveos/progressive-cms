import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { snapshotThemeFiles, themeRevisionDirectory } from "@pcms/themes";

test("theme revision snapshots retain exact immutable bytes and reject path/symlink escapes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-theme-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "theme");
  mkdirSync(dir);
  writeFileSync(join(dir, "theme.json"), "original");
  const first = snapshotThemeFiles(dir, dir);
  const second = snapshotThemeFiles(dir, dir);
  assert.notEqual(first.storageKey, second.storageKey);
  assert.equal(first.sha256, second.sha256);
  writeFileSync(join(dir, "theme.json"), "changed");
  assert.equal(readFileSync(join(first.dir, "theme.json"), "utf8"), "original");
  assert.equal(themeRevisionDirectory(dir, first.storageKey), first.dir);
  assert.throws(() => themeRevisionDirectory(dir, "../outside"), {
    code: "THEME_REVISION_INVALID",
  });
  symlinkSync(join(first.dir, "theme.json"), join(dir, "escape"));
  assert.throws(() => snapshotThemeFiles(dir, dir), { code: "THEME_REVISION_INVALID" });
});
