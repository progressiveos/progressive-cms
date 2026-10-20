import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneReleaseDependencyTests } from "../../scripts/prune-release-dependency-tests.mjs";
import {
  checkReleaseZipEntries,
  findInternalReleaseReferences,
} from "../../scripts/release-content-policy.mjs";

const releaseId = "v1.0.0-rc.13-test";
const context = {
  packageNames: new Set(["core"]),
  extensionDirs: new Set(["progressive-web-research"]),
  themeDirs: new Set(["reference-theme-v1"]),
};

test("release allowlist accepts runtime components and the retained browser library", () => {
  const entries = [
    `${releaseId}/apps/admin/dist/index.html`,
    `${releaseId}/packages/core/src/index.js`,
    `${releaseId}/extensions/progressive-web-research/src/index.js`,
    `${releaseId}/extensions/progressive-web-research/node_modules/playwright-core/lib/index.js`,
    `${releaseId}/themes/reference-theme-v1/fixtures/README.md`,
    `${releaseId}/fixtures/content/reference-content-types.json`,
    `${releaseId}/skills/progressive-cms-operator/SKILL.md`,
    `${releaseId}/deploy/scripts/install-release.sh`,
    `${releaseId}/LICENSE`,
    `${releaseId}/NOTICE`,
    `${releaseId}/TRADEMARKS.md`,
    `${releaseId}/THIRD_PARTY_NOTICES.md`,
    `${releaseId}/extensions/progressive-web-research/LICENSE`,
    `${releaseId}/extensions/progressive-web-research/NOTICE`,
  ];
  assert.deepEqual(checkReleaseZipEntries(entries, releaseId, context), []);
});

test("release allowlist rejects internal docs, test payloads and test runners", () => {
  const entries = [
    `${releaseId}/docs/release/CORE-1.0-RC13-REPORT.md`,
    `${releaseId}/tests/browser/site.spec.ts`,
    `${releaseId}/scripts/run-installed-rc12-e2e.mjs`,
    `${releaseId}/node_modules/fastify/test/route.js`,
    `${releaseId}/node_modules/renderer/snapshots/home.snap`,
    `${releaseId}/node_modules/renderer/testing/runner.js`,
    `${releaseId}/node_modules/renderer/home.snap`,
    `${releaseId}/node_modules/@playwright/test/index.js`,
    `${releaseId}/themes/reference-theme-v1/fixtures/home.json`,
    `${releaseId}/fixtures/content/compatibility-corpus.json`,
  ];
  const failures = checkReleaseZipEntries(entries, releaseId, context);
  assert.ok(failures.length >= entries.length);
  assert.match(failures.join("\n"), /outside release component allowlist/);
  assert.match(failures.join("\n"), /test directory/);
  assert.match(failures.join("\n"), /test runner dependency/);
  assert.match(failures.join("\n"), /fixture payload/);
});

test("dependency pruning needs a package test script and keeps runtime files", () => {
  const root = mkdtempSync(join(tmpdir(), "pcms-release-prune-"));
  try {
    const pkg = join(root, "node_modules/example-package");
    mkdirSync(join(pkg, "test"), { recursive: true });
    mkdirSync(join(pkg, "fixtures"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ scripts: { test: "node test/index.js" } }),
    );
    writeFileSync(join(pkg, "index.js"), "export const runtime = true;\n");
    writeFileSync(join(pkg, "test/index.js"), "assert.equal(1, 1);\n");
    writeFileSync(join(pkg, "fixtures/sample.json"), "{}\n");

    const result = pruneReleaseDependencyTests(root);
    assert.equal(result.removedDirs, 2);
    assert.ok(result.removedBytes > 0);
    assert.equal(existsSync(join(pkg, "index.js")), true);
    assert.equal(existsSync(join(pkg, "test")), false);
    assert.equal(existsSync(join(pkg, "fixtures")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency pruning blocks when runtime code points into test payload", () => {
  const root = mkdtempSync(join(tmpdir(), "pcms-release-prune-"));
  try {
    const pkg = join(root, "node_modules/example-package");
    mkdirSync(join(pkg, "test"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ scripts: { test: "node test/index.js" } }),
    );
    writeFileSync(join(pkg, "index.js"), 'import "./test/runtime.js";\n');
    writeFileSync(join(pkg, "test/runtime.js"), "export {};\n");
    assert.throws(
      () => pruneReleaseDependencyTests(root),
      /runtime entrypoint references test payload/,
    );
    assert.equal(existsSync(join(pkg, "test/runtime.js")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency pruning removes compiled test files and unreferenced testing helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "pcms-release-prune-"));
  try {
    const pkg = join(root, "node_modules/example-package");
    mkdirSync(join(pkg, "src/testing"), { recursive: true });
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ scripts: { test: "mocha dist/**/*.test.js" }, main: "dist/index.js" }),
    );
    writeFileSync(join(pkg, "src/index.ts"), "export const runtime = true;\n");
    writeFileSync(join(pkg, "src/parser.test.ts"), 'import "./testing/helper.js";\n');
    writeFileSync(join(pkg, "src/testing/helper.ts"), "export const helper = true;\n");
    writeFileSync(join(pkg, "dist/index.js"), "export const runtime = true;\n");
    writeFileSync(join(pkg, "dist/parser.test.js"), "export {};\n");
    writeFileSync(join(pkg, "dist/parser.test.js.map"), "{}\n");
    writeFileSync(join(pkg, "dist/parser.test.d.ts"), "export {};\n");

    const result = pruneReleaseDependencyTests(root);
    assert.equal(result.removedDirs, 1);
    assert.equal(result.removedFiles, 4);
    assert.ok(result.removedBytes > 0);
    assert.equal(existsSync(join(pkg, "src/index.ts")), true);
    assert.equal(existsSync(join(pkg, "src/testing")), false);
    assert.equal(existsSync(join(pkg, "src/parser.test.ts")), false);
    assert.equal(existsSync(join(pkg, "dist/index.js")), true);
    assert.equal(existsSync(join(pkg, "dist/parser.test.js.map")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release ZIP checker rejects generated test declarations and source maps", () => {
  const entries = [
    `${releaseId}/node_modules/example/dist/parser.test.js.map`,
    `${releaseId}/node_modules/example/dist/parser.test.d.ts`,
  ];
  assert.ok(
    checkReleaseZipEntries(entries, releaseId, context).every((issue) =>
      /test\/spec file/.test(issue),
    ),
  );
});

test("release text gate rejects internal infrastructure and work references", () => {
  assert.deepEqual(
    findInternalReleaseReferences(
      "work2:example 10.255.0.82 PCMS-OPS-T111 ADR-0011 deploy/docs/UPDATE.md",
    ),
    [
      "private address",
      "private Incus target",
      "internal task reference",
      "internal architecture reference",
      "excluded deployment manual reference",
    ],
  );
  assert.deepEqual(
    findInternalReleaseReferences(
      "site.example.com downloads.p-cms.ru 192.0.2.10 is a public example",
    ),
    [],
  );
  assert.deepEqual(findInternalReleaseReferences("172.20.1.10"), ["private address"]);
});
