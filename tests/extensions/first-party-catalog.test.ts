// ADR-0013 §52.1 — first-party trusted catalog parity. Every shipped
// extension directory under `extensions/` MUST be registered in the shared
// first-party catalog helper; web and worker both compose through it, so the
// helper pinning the directory is the structural guarantee that REST cannot
// report a deployed artifact as undeployed while the worker sees it.
// ADR-0017 S2: the composition source is `extensions/first-party.lock.json`
// (exact version + content digest per package); `extensions/catalog.ts` is
// generated from it, and `scripts/compose-first-party.mjs check` is the
// lock ↔ directories ↔ catalog ↔ digests gate this suite runs end-to-end.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { defineFirstPartyExtensionArtifacts } from "../../extensions/catalog.js";

const run = promisify(execFile);

test("first-party catalog helper covers every shipped extension artifact", () => {
  // The STANDARD composition = every locked package EXCEPT ui-test entries
  // (they carry only Admin UI contributions and never compose server-side).
  const lock = JSON.parse(
    readFileSync(
      join(import.meta.dirname ?? ".", "..", "..", "extensions", "first-party.lock.json"),
      "utf8",
    ),
  ) as { packages: readonly { id: string; dir: string; composition?: string }[] };
  const shipped = lock.packages
    .filter((pkg) => pkg.composition !== "ui-test")
    .map((pkg) => pkg.dir.split("/").pop())
    .toSorted();
  assert.ok(shipped.length > 0, "extensions/ directory inventory unexpectedly empty");
  const artifacts = defineFirstPartyExtensionArtifacts({
    pool: {} as never,
  }).map((artifact) => artifact.manifest.id);
  assert.equal(artifacts.length, shipped.length);
  for (const id of artifacts) {
    assert.match(id, /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/);
  }
});

test("lock ↔ directories ↔ generated catalog ↔ content digests are in sync", async () => {
  // The full parity gate: every locked package matches its directory
  // (id/version), every directory is locked, every content digest matches
  // the bytes on disk (R2: a code change without a lock update fails here),
  // and catalog.ts is byte-identical to the lock-generated source.
  await run("node", ["scripts/compose-first-party.mjs", "check"], {
    cwd: join(import.meta.dirname ?? ".", "..", ".."),
  });
  // Every deployed artifact carries its lock digest (artifact identity).
  for (const artifact of defineFirstPartyExtensionArtifacts({ pool: {} as never })) {
    assert.match(artifact.contentSha256 ?? "", /^[0-9a-f]{64}$/, artifact.manifest.id);
  }
});

test("core-only composition emits a catalog that composes zero artifacts", async () => {
  const out = join("/tmp", `pcms-core-only-catalog-${process.pid}.ts`);
  await run("node", ["scripts/compose-first-party.mjs", "emit-catalog", "core-only", out], {
    cwd: join(import.meta.dirname ?? ".", "..", ".."),
  });
  const emitted = readFileSync(out, "utf8");
  assert.match(emitted, /composition: core-only/);
  assert.match(emitted, /return \[\];/);
  assert.doesNotMatch(emitted, /defineExtensionArtifact\(/);
});

test("ui-test composition emits executable JavaScript for a test-only release", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-ui-test-catalog-"));
  const out = join(dir, "catalog.js");
  try {
    await run("node", ["scripts/compose-first-party.mjs", "emit-catalog", "ui-test-js", out], {
      cwd: join(import.meta.dirname ?? ".", "..", ".."),
    });
    const emitted = readFileSync(out, "utf8");
    assert.match(emitted, /progressive-admin-fixture/);
    assert.match(emitted, /progressive-platform-fixture/);
    assert.doesNotMatch(emitted, /\bimport\s+type\b|\bas unknown as\b/);
    await run(process.execPath, ["--check", out]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
