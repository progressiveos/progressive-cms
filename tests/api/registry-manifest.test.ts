// Registry surface: the update-manifest extractor from release artifacts.
// PCMS release artifacts are tar.gz (incoming/ + install-release.sh format).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { __extractUpdateManifest } from "../../packages/api/src/http/routes/registry.js";

function makeTarball(dir: string, files: Record<string, string>): Buffer {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  execFileSync("tar", ["-czf", join(dir, "a.tar.gz"), "-C", dir, ...Object.keys(files)]);
  return readFileSync(join(dir, "a.tar.gz"));
}

function makeZip(dir: string, files: Record<string, string>, rootDir: string): Buffer {
  mkdirSync(join(dir, rootDir), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, rootDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("zip", ["-rq", join(dir, "a.zip"), rootDir], { cwd: dir });
  return readFileSync(join(dir, "a.zip"));
}

test("extracts update-manifest.json from a real release tarball", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  try {
    const bytes = makeTarball(dir, {
      "update-manifest.json": JSON.stringify({
        manifest_version: "1",
        version: "0.1.91",
        rollback_policy: "rollback_safe",
      }),
      "some-file.txt": "payload",
    });
    const parsed = (await __extractUpdateManifest(bytes)) as { version?: string };
    assert.equal(parsed.version, "0.1.91");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extracts update-manifest.json from a zip release artifact (0.1.91+ contract)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-zip-"));
  try {
    const bytes = makeZip(
      dir,
      {
        "update-manifest.json": JSON.stringify({
          manifest_version: "1",
          version: "0.1.98",
          rollback_policy: "rollback_safe",
        }),
        "apps/web/dist/main.js": "payload",
      },
      "v0.1.98-20260929T000000Z-deadbee",
    );
    const parsed = (await __extractUpdateManifest(bytes)) as { version?: string };
    assert.equal(parsed.version, "0.1.98");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zip without a manifest → invalid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-zip-"));
  try {
    const bytes = makeZip(dir, { "only-file.txt": "payload" }, "v0.0.0-test");
    await assert.rejects(
      () => __extractUpdateManifest(bytes),
      (error: unknown) => String((error as Error).message).includes("update-manifest.json"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tarball without a manifest → invalid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  try {
    const bytes = makeTarball(dir, { "only-file.txt": "payload" });
    await assert.rejects(
      () => __extractUpdateManifest(bytes),
      (error: unknown) => String((error as Error).message).includes("update-manifest.json"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
