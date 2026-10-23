import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSelectedReleaseStatus } from "@pcms/operations";

test("selected release is read afresh and does not replace boot identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runningRoot = join(root, "old");
  const next = join(root, "next");
  mkdirSync(runningRoot);
  mkdirSync(next);
  for (const [directory, version, releaseId] of [
    [runningRoot, "1.0.0-rc.27", "old"],
    [next, "1.0.0-rc.29", "next"],
  ] as const) {
    writeFileSync(
      join(directory, "build-metadata.json"),
      JSON.stringify({ schema: "pcms-release-build/1", version, releaseId }),
    );
  }
  const currentSymlink = join(root, "current");
  symlinkSync("old", currentSymlink);
  const read = () =>
    readSelectedReleaseStatus({ currentSymlink, runningRoot, runningReleaseId: "old" });
  assert.deepEqual(read(), {
    version: "1.0.0-rc.27",
    release_id: "old",
    matches_running: true,
    read_error: null,
  });
  unlinkSync(currentSymlink);
  symlinkSync("next", currentSymlink);
  assert.deepEqual(read(), {
    version: "1.0.0-rc.29",
    release_id: "next",
    matches_running: false,
    read_error: null,
  });
  writeFileSync(join(next, "build-metadata.json"), "{");
  assert.deepEqual(read(), {
    version: null,
    release_id: null,
    matches_running: false,
    read_error: "INVALID_METADATA",
  });
  writeFileSync(join(next, "build-metadata.json"), "{}");
  assert.equal(read().read_error, "INVALID_METADATA");
  if (process.getuid?.() !== 0) {
    chmodSync(join(next, "build-metadata.json"), 0);
    assert.deepEqual(read(), {
      version: null,
      release_id: null,
      matches_running: false,
      read_error: "EACCES",
    });
    chmodSync(join(next, "build-metadata.json"), 0o600);
  }
  unlinkSync(currentSymlink);
  assert.deepEqual(read(), {
    version: null,
    release_id: null,
    matches_running: null,
    read_error: "ENOENT",
  });
});
