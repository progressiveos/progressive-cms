// PCMS-OPS-T101 — release artifact contracts: compiled-exports rewriting,
// release identifier and build metadata shape, and the M14 update-manifest
// draft the builder emits (validated against the frozen UPDATE_MANIFEST_V1
// schema so a release can never ship an unparsable target manifest).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseReleaseManifest } from "@pcms/extensions/internal";
import {
  createReleaseBuildMetadata,
  createReleaseId,
  RELEASE_LAYOUT,
  type ReleaseUpdateManifestDraft,
  resolveReleaseIdentity,
  toCompiledExports,
  toReleasePackageDocument,
} from "@pcms/operations";

test("toCompiledExports rewrites TypeScript export targets to compiled twins", () => {
  assert.equal(toCompiledExports("./src/index.ts"), "./src/index.js");
  assert.equal(toCompiledExports("./src/index.js"), "./src/index.js");
  assert.equal(toCompiledExports("types.d.ts"), "types.d.js");
  assert.deepEqual(toCompiledExports({ ".": "./src/index.ts", "./x": "./src/x.ts" }), {
    ".": "./src/index.js",
    "./x": "./src/x.js",
  });
  // Deeper shapes (import/export conditions) rewrite recursively.
  assert.deepEqual(toCompiledExports({ import: { types: "./src/i.ts", default: "./src/i.ts" } }), {
    import: { types: "./src/i.js", default: "./src/i.js" },
  });
  assert.deepEqual(toCompiledExports([["./a.ts"], "./b.ts"]), [["./a.js"], "./b.js"]);
  assert.equal(toCompiledExports(undefined), undefined);
  assert.equal(toCompiledExports(null), null);
});

test("toReleasePackageDocument keeps identity and rewrites only exports", () => {
  const source = {
    name: "@pcms/core",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { ajv: "8.20.0" },
    exports: { ".": "./src/index.ts" },
  };
  const released = toReleasePackageDocument(source);
  assert.equal(released.name, "@pcms/core");
  assert.equal(released.version, "0.0.0");
  assert.deepEqual(released.dependencies, { ajv: "8.20.0" });
  assert.deepEqual(released.exports, { ".": "./src/index.js" });
  // Identity/dependency fields stay byte-identical so npm ci keeps validating
  // the staged tree against the committed lockfile.
  assert.deepEqual(
    { name: released.name, version: released.version, dependencies: released.dependencies },
    { name: source.name, version: source.version, dependencies: source.dependencies },
  );
});

test("createReleaseId is sortable, commit-scoped and deterministic", () => {
  const builtAt = new Date("2026-09-21T19:30:00.000Z");
  const id = createReleaseId({ version: "0.0.0", builtAt, commit: "c136cb3abc123def" });
  assert.equal(id, "v0.0.0-20260921T193000Z-c136cb3");
  // Same inputs → same id (artifact reproducibility of naming); a different
  // commit or timestamp produces a different release directory.
  assert.equal(createReleaseId({ version: "0.0.0", builtAt, commit: "c136cb3abc123def" }), id);
  assert.notEqual(createReleaseId({ version: "0.0.0", builtAt, commit: "d86773d0000000" }), id);
});

test("build metadata carries traceability facts in a stable shape", () => {
  const metadata = createReleaseBuildMetadata({
    releaseId: "v0.0.0-20260921T193000Z-c136cb3",
    version: "0.0.0",
    gitCommit: "c136cb3abc123def",
    gitDirty: false,
    builtAt: new Date("2026-09-21T19:30:00.000Z"),
    nodeVersion: "v24.21.0",
    contractVersions: [
      { key: "rest_api", version: "1.0.0", source: "cms:api" },
      { key: "cms", version: "0.0.0", source: "package.json" },
    ],
  });
  assert.equal(metadata.schema, "pcms-release-build/1");
  assert.equal(metadata.gitCommit, "c136cb3abc123def");
  assert.equal(metadata.builtAtUtc, "2026-09-21T19:30:00.000Z");
  assert.deepEqual(metadata.entrypoints, {
    web: RELEASE_LAYOUT.webEntry,
    worker: RELEASE_LAYOUT.workerEntry,
    cli: RELEASE_LAYOUT.cliEntry,
  });
  // Contract versions are sorted by key — deterministic discovery, no churn.
  assert.deepEqual(
    metadata.contractVersions.map(({ key }) => key),
    ["cms", "rest_api"],
  );
});

test("release layout contract points at compiled entrypoints and separated state", () => {
  for (const entry of [
    RELEASE_LAYOUT.webEntry,
    RELEASE_LAYOUT.workerEntry,
    RELEASE_LAYOUT.cliEntry,
  ]) {
    assert.match(entry, /\.js$/);
  }
  // Migrations and theme assets ship inside the artifact; admin bundle too.
  assert.equal(RELEASE_LAYOUT.migrationsDir, "db/migrations");
  assert.equal(RELEASE_LAYOUT.adminDistDir, "apps/admin/dist");
  assert.match(RELEASE_LAYOUT.buildMetadata, /^build-metadata\.json$/);
});

test("the builder's update-manifest draft validates against UPDATE_MANIFEST_V1", () => {
  const draft: ReleaseUpdateManifestDraft = {
    manifest_version: "1",
    version: "0.0.0",
    required_runtime: { node: ">=24.21 <25", postgres: ">=14 <19" },
    core_db_migrations: ["0001_public_baseline"],
    supports_extension_contracts: ["2.0"],
    contract_versions: { cms: "0.0.0", rest_api: "1.0.0" },
    deprecations: [],
    security_notes: [],
    manual_steps: [],
    backup_required: true,
    rollback_policy: "rollback_safe",
    config_changes: [],
  };
  const parsed = parseReleaseManifest(draft);
  assert.equal(parsed.version, "0.0.0");
  assert.equal(parsed.rollback_policy, "rollback_safe");
  assert.equal(parsed.backup_required, true);
});

test("M17-T003: resolveReleaseIdentity classifies release layout vs dev tree", () => {
  // Release layout: build-metadata.json at the root wins, regardless of
  // workspace-member package.json files below it.
  const releaseRoot = mkdtempSync(join(tmpdir(), "pcms-rel-"));
  try {
    mkdirSync(join(releaseRoot, "packages/api/src"), { recursive: true });
    writeFileSync(
      join(releaseRoot, RELEASE_LAYOUT.buildMetadata),
      JSON.stringify(
        createReleaseBuildMetadata({
          releaseId: "v0.1.16-20260923T000000Z-690d100",
          version: "0.1.16",
          gitCommit: "690d100000000000000000000000000000000000",
          gitDirty: false,
          builtAt: new Date(0),
          nodeVersion: process.version,
          contractVersions: [],
        }),
      ),
    );
    const resolved = resolveReleaseIdentity(join(releaseRoot, "packages/api/src/context.js"));
    assert.equal(resolved.mode, "release");
    if (resolved.mode === "release") {
      assert.equal(resolved.identity.version, "0.1.16");
      assert.equal(resolved.root, releaseRoot);
    }
  } finally {
    rmSync(releaseRoot, { recursive: true, force: true });
  }

  // Development tree: topmost package.json without build metadata.
  const devRoot = mkdtempSync(join(tmpdir(), "pcms-dev-"));
  try {
    mkdirSync(join(devRoot, "packages/api/src"), { recursive: true });
    writeFileSync(join(devRoot, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
    writeFileSync(
      join(devRoot, "packages/api/package.json"),
      JSON.stringify({ name: "@pcms/api", version: "0.0.0" }),
    );
    const resolved = resolveReleaseIdentity(join(devRoot, "packages/api/src/context.js"));
    assert.deepEqual(resolved, { mode: "development", root: devRoot });
  } finally {
    rmSync(devRoot, { recursive: true, force: true });
  }
});
