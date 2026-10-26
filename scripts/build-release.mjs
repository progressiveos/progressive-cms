#!/usr/bin/env node
// Production release artifact builder (PCMS-OPS-T101, Operations spec §6/§7/§12/§44).
//
// Produces a deterministic, traceable release artifact from a clean checkout:
//
//   build/release/<release-id>/          staged release root (npm ci --omit=dev)
//   build/release/progressive-cms-<release-id>.tar.gz      + .sha256
//
// The artifact carries compiled server code (plain Node, no tsx), the Admin
// SPA bundle, production dependencies per the committed lockfile, migration
// files, the reference theme, and build-metadata.json / update-manifest.json /
// release-manifest.json for traceability (Operations spec §43), M14 update
// tooling (T114) and M17 release identity (T001/T002/T004).
//
// Usage (build machine only — never on the production container):
//   npm run release                 # full: npm run build + stage + pack
//   npm run release -- --skip-build # reuse the existing dist/ output
//   npm run release -- --rollback-policy restore_required
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_CONTRACT_VERSION, BUNDLE_VERSION } from "@pcms/api";
import { BLOCK_DOCUMENT_SCHEMA_VERSION } from "@pcms/blocks";
import { CONFIG_SCHEMA_VERSION } from "@pcms/core";
import {
  EXTENSION_CONTRACT_VERSION,
  parseReleaseManifest,
  SUPPORTED_NODE_RANGE,
  SUPPORTED_POSTGRES_RANGE,
} from "@pcms/extensions/internal";
import { MCP_PROTOCOL_VERSION } from "@pcms/mcp";
import {
  createMaintenancePageHtml,
  createReleaseBuildMetadata,
  createReleaseId,
  DEFAULT_MAINTENANCE_SETTINGS,
  loadPcmsMarkSvg,
  RELEASE_LAYOUT,
  toReleasePackageDocument,
} from "@pcms/operations";
import { SEARCH_INDEX_VERSION } from "@pcms/search";
import { THEME_CONTRACT_VERSION } from "@pcms/themes";
import { checkNativeSourceSupply } from "./check-native-source-supply.mjs";
import { assertReleaseZipClean, readPreparedOfficialSkillFiles } from "./check-release-zip.mjs";
import { assertReleaseZipPermissions, packReleaseZip } from "./pack-release-zip.mjs";
import { pruneReleaseDependencyTests } from "./prune-release-dependency-tests.mjs";
import {
  isAllowedReleasePath,
  OFFICIAL_DOCS_SKILL_FILES,
  PUBLIC_LICENSE_FILES,
  readReleaseZipEntries,
} from "./release-content-policy.mjs";
import { DOCS_RELEASE_DIR, stageDocsDirectory } from "./stage-docs-dir.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Composition mode is a BUILD-TIME selector only: read it and strip it from
// the environment before any child process (npm build, smoke, npm ci) runs —
// the release config validator rejects unknown PCMS_* variables.
const composition = process.env.PCMS_COMPOSITION === "core-only" ? "core-only" : "standard";
delete process.env.PCMS_COMPOSITION;
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const skipBuild = process.argv.includes("--skip-build");
const rollbackPolicy = arg("--rollback-policy") ?? "rollback_safe";
const outRoot = resolve(repoRoot, arg("--out") ?? "build/release");
// CORE-RC19 (simplified delivery): the accepted public documentation folder,
// supplied via `--docs-dir`. Core-docs owns and approves that folder. Official
// standalone Skills require it for mandatory artifact byte comparisons.
const docsDirArg = arg("--docs-dir");
let docsSummary = null;
let docsOfficialSkills = null;
const fail = (message) => {
  console.error(`build-release: ${message}`);
  process.exit(1);
};
const sh = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr ?? result.stdout}`,
    );
  }
  return result;
};

// Shape of the accepted folder is checked here, after `fail` exists, so a bad
// path stops the build before any staging work happens. The check is mechanical
// (see scripts/stage-docs-dir.mjs): a real directory, an `index.md` at the root,
// no traversal, no private or binary files.
if (docsDirArg === undefined)
  fail("--docs-dir is required: supply the accepted prepared Docs folder");
if (docsDirArg !== undefined) {
  const resolvedDocsDir = resolve(repoRoot, docsDirArg);
  if (!existsSync(resolvedDocsDir)) fail(`docs directory not found: ${resolvedDocsDir}`);
  try {
    const probe = stageDocsDirectory(resolvedDocsDir, resolve(outRoot, ".docs-probe"));
    docsOfficialSkills = readPreparedOfficialSkillFiles(resolvedDocsDir);
    docsSummary = { source: resolvedDocsDir, ...probe };
    rmSync(resolve(outRoot, ".docs-probe"), { recursive: true, force: true });
  } catch (error) {
    fail(`docs directory is not usable for release inclusion: ${String(error.message ?? error)}`);
  }
  console.log(
    `build-release: docs directory accepted (${docsSummary.files.length} files, ${(docsSummary.bytes / 1024).toFixed(1)} KiB)`,
  );
}

if (
  rollbackPolicy !== "rollback_safe" &&
  rollbackPolicy !== "restore_required" &&
  rollbackPolicy !== "forward_fix_only"
) {
  fail(`unknown --rollback-policy "${rollbackPolicy}"`);
}

const gitCommit = sh("git", ["rev-parse", "HEAD"]).stdout.trim();
const gitDirty = sh("git", ["status", "--porcelain"]).stdout.trim().length > 0;
if (gitDirty && process.argv.includes("--require-clean")) {
  fail(
    "working tree is dirty; commit or stash before building a release (traceability requirement)",
  );
}

if (!skipBuild) {
  // Clean before compilation; keep outputs available for an explicit --skip-build.
  rmSync(join(repoRoot, "dist"), { recursive: true, force: true });
  // First-party lock gate BEFORE tsc: it materializes external packages
  // (verify-then-unpack, ADR-0017 R4) that the generated catalog imports.
  const composeCheck = spawnSync(process.execPath, ["scripts/compose-first-party.mjs", "check"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (composeCheck.status !== 0) fail("first-party lock check failed (see above)");
  console.log("build-release: npm run build");
  sh("npm", ["run", "build"]);
}
for (const required of [
  "dist/apps/web/src/main.js",
  "dist/apps/worker/src/main.js",
  "apps/admin/dist",
]) {
  if (!existsSync(join(repoRoot, required)))
    fail(`missing build output: ${required} (run without --skip-build)`);
}

const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
// M17-T001: the release version IS the source version. No --version override —
// a production artifact must never claim a version the source does not carry
// (pre-M17 incident: production 0.1.15 built from 0.1.14 source).
const version = rootPackage.version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
  fail(`invalid SemVer version "${version}"`);

// M17 §9 version uniqueness: a deployed version number is immutable. Two
// different artifacts both claiming e.g. 0.1.16 is a launch-safety hazard —
// refuse when this output directory already holds artifacts of the same
// version; a deliberate pre-deployment rebuild must pass
// --allow-version-reuse (never for a version already deployed to production).
if (!process.argv.includes("--allow-version-reuse")) {
  const sameVersionArtifacts = existsSync(outRoot)
    ? readdirSync(outRoot).filter((name) => name.startsWith(`progressive-cms-v${version}-`))
    : [];
  if (sameVersionArtifacts.length > 0) {
    fail(
      `version ${version} was already built (${sameVersionArtifacts.join(", ")}). Bump package.json before building a distinct production artifact, or pass --allow-version-reuse for a pre-deployment rebuild.`,
    );
  }
}

const builtAt = new Date();
const releaseId = createReleaseId({ version, builtAt, commit: gitCommit });
const stage = join(outRoot, releaseId);
const packageNames = new Set(
  readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);
const themeDirs = new Set(
  readdirSync(join(repoRoot, "themes"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(repoRoot, "themes", entry.name, "theme.json")),
    )
    .map((entry) => entry.name),
);

const contractVersions = [
  { key: "cms", version, source: "package.json" },
  { key: "config_schema", version: CONFIG_SCHEMA_VERSION, source: "cms:core" },
  { key: "extension_contract", version: EXTENSION_CONTRACT_VERSION, source: "cms:extensions" },
  { key: "rest_api", version: API_CONTRACT_VERSION, source: "cms:api" },
  { key: "mcp", version: MCP_PROTOCOL_VERSION, source: "cms:mcp" },
  { key: "theme_contract", version: THEME_CONTRACT_VERSION, source: "cms:themes" },
  { key: "block_document", version: BLOCK_DOCUMENT_SCHEMA_VERSION, source: "cms:blocks" },
  { key: "search_index", version: SEARCH_INDEX_VERSION, source: "cms:search" },
  { key: "bundle", version: BUNDLE_VERSION, source: "cms:api" },
];

// --- stage the artifact -----------------------------------------------------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const copy = (from, to) => {
  if (!existsSync(join(repoRoot, from))) fail(`missing artifact input: ${from}`);
  cpSync(join(repoRoot, from), join(stage, to), { recursive: true });
};
const copyCompiledWorkspace = (kind, name) => {
  // Compiled tree dist/<kind>/<name> mirrors the staged <kind>/<name> layout,
  // so relative imports inside compiled files keep resolving unchanged.
  copy(`dist/${kind}/${name}`, `${kind}/${name}`);
  const sourceManifest = JSON.parse(
    readFileSync(join(repoRoot, kind, name, "package.json"), "utf8"),
  );
  writeFileSync(
    join(stage, kind, name, "package.json"),
    `${JSON.stringify(toReleasePackageDocument(sourceManifest), null, 2)}\n`,
  );
};

for (const name of readdirSync(join(repoRoot, "packages"))) {
  copyCompiledWorkspace("packages", name);
}
for (const name of ["web", "worker"]) {
  copyCompiledWorkspace("apps", name);
}
cpSync(join(repoRoot, "apps/admin/dist"), join(stage, RELEASE_LAYOUT.adminDistDir), {
  recursive: true,
});
// First-party extensions (ADR-0013): compiled by tsc through the web/worker
// catalog import (dist/extensions/...); shipped in their repository layout so
// the catalog's cwd-relative manifest reads resolve at the release root.
// dist/extensions mirrors extensions/ — an extension registered in the
// catalog without a manifest here fails the build instead of boot.
//
// ADR-0017 S2: the composition source is extensions/first-party.lock.json.
// The lock gate (dirs ↔ digests ↔ generated catalog) fails the build on
// drift; the release manifest carries the package inventory (exact version +
// content digest + migration checksums) so update preflight/apply can plan
// extension migrations without executing target code (R2). Composition mode:
// PCMS_COMPOSITION=core-only ships a catalog that composes zero artifacts.
const firstPartyLock = JSON.parse(
  readFileSync(join(repoRoot, "extensions/first-party.lock.json"), "utf8"),
);
const firstPartyPackages =
  composition === "core-only"
    ? []
    : firstPartyLock.packages.filter((pkg) => pkg.composition !== "ui-test");
const uiTestPackages = firstPartyLock.packages.filter((pkg) => pkg.composition === "ui-test");
const firstPartyExtensions = firstPartyPackages.map((pkg) => ({
  id: pkg.id,
  version: pkg.version,
  content_sha256: pkg.content_sha256,
  migrations: existsSync(join(repoRoot, pkg.dir, "migrations"))
    ? readdirSync(join(repoRoot, pkg.dir, "migrations"))
        .filter((name) => name.endsWith(".sql"))
        .sort()
        .map((name) => ({
          name: name.replace(/\.sql$/, ""),
          checksum: createHash("sha256")
            .update(readFileSync(join(repoRoot, pkg.dir, "migrations", name)))
            .digest("hex"),
        }))
    : [],
}));
if (!existsSync(join(repoRoot, "dist/extensions/catalog.js"))) {
  fail("missing build output: dist/extensions/catalog.js (run without --skip-build)");
}
if (composition === "core-only") {
  // Emit the core-only catalog straight into the stage (the compiled dist
  // catalog composes the standard set; core-only composes none).
  mkdirSync(join(stage, "extensions"), { recursive: true });
  const emitted = spawnSync(
    process.execPath,
    [
      "scripts/compose-first-party.mjs",
      "emit-catalog",
      "core-only",
      join(stage, "extensions/catalog.js"),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (emitted.status !== 0) fail("core-only catalog emission failed");
} else {
  copy("dist/extensions/catalog.js", "extensions/catalog.js");
}
const packagedExtensionDirs = new Set(firstPartyPackages.map((pkg) => pkg.dir));
for (const entry of readdirSync(join(repoRoot, "extensions"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const extensionDir = `extensions/${entry.name}`;
  if (!packagedExtensionDirs.has(extensionDir)) continue;
  if (!existsSync(join(repoRoot, extensionDir, "manifest.json")))
    fail(`missing manifest for locked extension: ${extensionDir}`);
  if (!existsSync(join(repoRoot, "dist/extensions", entry.name, "src"))) {
    fail(`missing build output: dist/extensions/${entry.name}/src`);
  }
  mkdirSync(join(stage, "extensions", entry.name), { recursive: true });
  cpSync(
    join(repoRoot, "dist/extensions", entry.name, "src"),
    join(stage, "extensions", entry.name, "src"),
    { recursive: true },
  );
  copy(`extensions/${entry.name}/manifest.json`, `extensions/${entry.name}/manifest.json`);
  for (const notice of ["LICENSE", "NOTICE"]) {
    copy(`extensions/${entry.name}/${notice}`, `extensions/${entry.name}/${notice}`);
  }
  const extensionMigrations = join(repoRoot, extensionDir, "migrations");
  if (existsSync(extensionMigrations)) {
    for (const migration of readdirSync(extensionMigrations, { withFileTypes: true })) {
      if (!migration.isFile() || !migration.name.endsWith(".sql")) {
        fail(`unreviewed extension migration asset: ${extensionDir}/migrations/${migration.name}`);
      }
      copy(
        `${extensionDir}/migrations/${migration.name}`,
        `${extensionDir}/migrations/${migration.name}`,
      );
    }
  }
  const allowedExtensionAssets =
    entry.name === "progressive-site-migration" ? new Set(["agent"]) : new Set();
  for (const entry2 of readdirSync(join(repoRoot, "extensions", entry.name), {
    withFileTypes: true,
  })) {
    if (
      [
        "src",
        "node_modules",
        "manifest.json",
        "migrations",
        "README.md",
        "package.json",
        "package-lock.json",
        "LICENSE",
        "NOTICE",
      ].includes(entry2.name)
    )
      continue;
    if (!allowedExtensionAssets.has(entry2.name)) {
      fail(`unreviewed extension release asset: ${extensionDir}/${entry2.name}`);
    }
    copy(`extensions/${entry.name}/${entry2.name}`, `extensions/${entry.name}/${entry2.name}`);
  }
  // External packages own their npm dependencies: the vendored node_modules
  // (installed by the lock gate's materialize step) ships with the package.
  if (existsSync(join(repoRoot, "extensions", entry.name, "package.json"))) {
    cpSync(
      join(repoRoot, "extensions", entry.name, "node_modules"),
      join(stage, "extensions", entry.name, "node_modules"),
      { recursive: true },
    );
  }
}
if (
  existsSync(join(stage, "extensions/catalog.ui-test.generated.js")) ||
  uiTestPackages.some((pkg) => existsSync(join(stage, pkg.dir)))
) {
  fail("ui-test catalog and packages must not be included in a release artifact");
}

for (const migration of readdirSync(join(repoRoot, "db/migrations"), { withFileTypes: true })) {
  if (!migration.isFile() || !migration.name.endsWith(".sql")) {
    fail(`unreviewed Core migration asset: db/migrations/${migration.name}`);
  }
  copy(`db/migrations/${migration.name}`, `${RELEASE_LAYOUT.migrationsDir}/${migration.name}`);
}
// Ship only reference-theme files that the renderer consumes. The theme
// validator requires a nonempty fixtures directory, so the package carries
// this explanatory note instead of preview/test records.
for (const themeName of themeDirs) {
  const themeRoot = join(repoRoot, "themes", themeName);
  const stageTheme = join(stage, RELEASE_LAYOUT.themesDir, themeName);
  const runtimeThemeRoots = new Set(["assets", "blocks", "components", "templates", "tokens"]);
  const sourceOnlyThemeFiles = new Set(["CHANGELOG.md", "README.md", "THEME.md", "fixtures"]);
  for (const entry of readdirSync(themeRoot, { withFileTypes: true })) {
    if (
      entry.name !== "theme.json" &&
      !runtimeThemeRoots.has(entry.name) &&
      !sourceOnlyThemeFiles.has(entry.name)
    ) {
      fail(`unreviewed theme release asset: themes/${themeName}/${entry.name}`);
    }
  }
  mkdirSync(stageTheme, { recursive: true });
  copy(`themes/${themeName}/theme.json`, `${RELEASE_LAYOUT.themesDir}/${themeName}/theme.json`);
  for (const assetRoot of ["assets", "blocks", "components", "templates", "tokens"]) {
    if (existsSync(join(themeRoot, assetRoot))) {
      copy(
        `themes/${themeName}/${assetRoot}`,
        `${RELEASE_LAYOUT.themesDir}/${themeName}/${assetRoot}`,
      );
    }
  }
  mkdirSync(join(stageTheme, "fixtures"), { recursive: true });
  writeFileSync(
    join(stageTheme, "fixtures/README.md"),
    "# Reference theme preview data\n\nCore releases do not include sample or test content. Use site-owned content for preview and validation.\n",
  );
}
// The release includes portable deployment code/configuration only. Internal
// pilot manuals and site-specific operating notes remain in the source repo.
for (const path of [
  ...PUBLIC_LICENSE_FILES,
  "deploy/scripts/backup-site.sh",
  "deploy/scripts/install-release.sh",
  "deploy/scripts/install-restart-bridge.sh",
  "deploy/scripts/restore-site.sh",
  "deploy/nginx/external-rp-site.conf.example",
  "deploy/nginx/progressive-cms.conf",
  "deploy/nginx/proxy-snippet.conf",
  "deploy/polkit/49-progressive-cms-update.rules",
  "deploy/sites/pcms.production.template.json",
])
  copy(path, path);
for (const entry of readdirSync(join(repoRoot, "deploy/systemd"), { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:service|path)$/.test(entry.name)) {
    copy(`deploy/systemd/${entry.name}`, `deploy/systemd/${entry.name}`);
  }
}
// `cms site validate` uses this runtime schema corpus by default. Remove its
// bundled example entries: users supply real site content for validation.
const referenceContentTypes = JSON.parse(
  readFileSync(join(repoRoot, "fixtures/content/reference-content-types.json"), "utf8"),
);
referenceContentTypes.fixtures = [];
mkdirSync(join(stage, "fixtures/content"), { recursive: true });
writeFileSync(
  join(stage, "fixtures/content/reference-content-types.json"),
  `${JSON.stringify(referenceContentTypes, null, 2)}\n`,
);

// Ship the explicitly versioned Agent Skill packages and their references.
const extensionDirsForPolicy = new Set(
  [...packagedExtensionDirs].map((dir) => dir.replace(/^extensions\//, "")),
);
const releasePolicyContext = { packageNames, extensionDirs: extensionDirsForPolicy, themeDirs };
const copySkillFiles = (sourceDir, relativeDir = "") => {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const archivePath = `skills/${relativePath}`;
    const sourcePath = join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      copySkillFiles(sourcePath, relativePath);
    } else if (isAllowedReleasePath(archivePath, releasePolicyContext)) {
      const destination = join(stage, archivePath);
      mkdirSync(join(destination, ".."), { recursive: true });
      cpSync(sourcePath, destination);
    }
  }
};
copySkillFiles(join(repoRoot, "skills"));
for (const [relativePath, bytes] of docsOfficialSkills) {
  const destination = join(stage, relativePath);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, bytes);
}
const packagedSkillIndex = join(stage, "skills/references/INDEX.md");
writeFileSync(
  packagedSkillIndex,
  readFileSync(packagedSkillIndex, "utf8")
    .split("\n")
    .filter((line) => !line.includes("docs/") && !line.includes("SHOP-DEVELOPER-HANDOFF"))
    .join("\n"),
);
// A skill package with an invalid manifest fails the build — skills are
// versioned release artifacts, not loose docs.
{
  const { validateSkillManifest } = await import("@pcms/skills");
  const skillsStage = join(stage, RELEASE_LAYOUT.skillsDir);
  for (const entry of readdirSync(skillsStage, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(skillsStage, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const validation = validateSkillManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (!validation.ok) {
      throw new Error(
        `skill manifest invalid: ${entry.name}: ${JSON.stringify(validation.issues)}`,
      );
    }
  }
}
// Brand asset for the maintenance surfaces (kept next to its compiled
// consumer — packages/operations/src/maintenance-page.js resolves it from
// ../assets/).
copy("packages/operations/assets/pcms-mark.svg", "packages/operations/assets/pcms-mark.svg");
// CORE-RC19 (simplified delivery): copy the ACCEPTED documentation folder into
// `docs/` as ordinary files. No versioned subtree, no manifest, no separate
// version — Core-docs' folder lands as-is. Core owns no HTTP route for it here.
if (docsSummary !== null) {
  const docsRoot = join(stage, DOCS_RELEASE_DIR);
  try {
    const staged = stageDocsDirectory(docsSummary.source, docsRoot);
    docsSummary = { ...docsSummary, ...staged };
  } catch (error) {
    fail(`docs staging failed: ${String(error.message ?? error)}`);
  }
  console.log(
    `build-release: staged docs at ${DOCS_RELEASE_DIR}/ (${docsSummary.files.length} files)`,
  );
}
// The nginx emergency fallback page is materialized from the SAME Core-owned
// renderer the CMS Maintenance Mode uses — one design source, two surfaces
// (task brief §35/§36).
mkdirSync(join(stage, "deploy/maintenance"), { recursive: true });
writeFileSync(
  join(stage, "deploy/maintenance/emergency.html"),
  createMaintenancePageHtml(DEFAULT_MAINTENANCE_SETTINGS, { logoSvg: loadPcmsMarkSvg() }),
);
copy("config/pcms.example.json", RELEASE_LAYOUT.configExample);

// Release root package.json: production manifest for npm ci and the
// readCmsVersionFromRelease() discovery path. Dev-only fields are dropped.
writeFileSync(
  join(stage, RELEASE_LAYOUT.rootPackageJson),
  `${JSON.stringify(
    {
      name: rootPackage.name,
      version,
      license: rootPackage.license,
      private: rootPackage.private,
      type: rootPackage.type,
      workspaces: rootPackage.workspaces,
      engines: rootPackage.engines,
      allowScripts: rootPackage.allowScripts,
    },
    null,
    2,
  )}\n`,
);
copy("package-lock.json", RELEASE_LAYOUT.rootLockfile);

const metadata = createReleaseBuildMetadata({
  releaseId,
  version,
  gitCommit,
  gitDirty,
  builtAt,
  nodeVersion: process.version,
  contractVersions,
});
writeFileSync(join(stage, RELEASE_LAYOUT.buildMetadata), `${JSON.stringify(metadata, null, 2)}\n`);

// M17-T002/T004: canonical release manifest — the single document the runtime
// (doctor, update preflight, agent bootstrap) reads for deployed identity and
// the TARGET migration inventory (name + checksum) so an update preflight can
// plan without executing the target's code. Lives at the release root; the
// installer validates it against build-metadata when present.
const coreDbMigrations = readdirSync(join(repoRoot, "db/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name: name.replace(/\.sql$/, ""),
    checksum: createHash("sha256")
      .update(readFileSync(join(repoRoot, "db/migrations", name)))
      .digest("hex"),
  }));
const releaseManifest = {
  schema: "pcms-release/1",
  releaseId,
  version,
  gitCommit,
  gitDirty,
  builtAtUtc: builtAt.toISOString(),
  migration_head: coreDbMigrations.at(-1)?.name ?? null,
  core_db_migrations: coreDbMigrations,
  first_party_extensions: firstPartyExtensions,
  composition,
  required_runtime: { node: SUPPORTED_NODE_RANGE, postgres: SUPPORTED_POSTGRES_RANGE },
  contract_versions: Object.fromEntries(
    contractVersions.map(({ key, version: v }) => [key, String(v)]),
  ),
  // CORE-RC19 (simplified delivery): a traceability record that the accepted
  // documentation folder was included, with its file count and content digest.
  // Deliberately NOT a gate and NOT a pin — the release ZIP's own checksum is
  // the integrity mechanism, and the folder's content is Core-docs' approval.
  docs:
    docsSummary === null
      ? null
      : {
          path: DOCS_RELEASE_DIR,
          files: docsSummary.files.length,
          bytes: docsSummary.bytes,
          contentHash: docsSummary.contentHash,
        },
};
writeFileSync(
  join(stage, RELEASE_LAYOUT.releaseManifest),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
);

const updateManifest = {
  manifest_version: "1",
  version,
  required_runtime: { node: SUPPORTED_NODE_RANGE, postgres: SUPPORTED_POSTGRES_RANGE },
  core_db_migrations: readdirSync(join(repoRoot, "db/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort(),
  supports_extension_contracts: [EXTENSION_CONTRACT_VERSION],
  contract_versions: Object.fromEntries(
    contractVersions.map(({ key, version: v }) => [key, String(v)]),
  ),
  deprecations: [],
  security_notes: [],
  manual_steps: [],
  backup_required: true,
  rollback_policy: rollbackPolicy,
  config_changes: [],
};
// Structural gate: the generated manifest must parse against the frozen M14
// UPDATE_MANIFEST_V1_SCHEMA before it ships inside the artifact.
parseReleaseManifest(updateManifest);
writeFileSync(
  join(stage, RELEASE_LAYOUT.updateManifest),
  `${JSON.stringify(updateManifest, null, 2)}\n`,
);

// --- production dependencies per lockfile -----------------------------------
console.log("build-release: materializing production-only lockfile and dependencies (staged)");
sh(
  "npm",
  [
    "install",
    "--package-lock-only",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
  ],
  { cwd: stage },
);
sh("npm", ["ci", "--omit=dev"], { cwd: stage });
const prunedDependencyPayloads = pruneReleaseDependencyTests(stage);
console.log(
  `build-release: removed ${prunedDependencyPayloads.removedDirs} reviewed package test directories and ${prunedDependencyPayloads.removedFiles} test files (${prunedDependencyPayloads.removedBytes} bytes); runtime dependency graph retained`,
);
const nativeSourceSupply = await checkNativeSourceSupply(stage);
console.log(
  `build-release: native source supply verified (${nativeSourceSupply.bytes} bytes, SHA-256 ${nativeSourceSupply.sha256}): ${nativeSourceSupply.url}`,
);

// --- smoke: the compiled artifact runs under plain node ---------------------
const smoke = spawnSync(
  process.execPath,
  [
    join(stage, RELEASE_LAYOUT.cliEntry),
    "config",
    "validate",
    "--config",
    join(stage, RELEASE_LAYOUT.configExample),
  ],
  { cwd: stage, encoding: "utf8" },
);
if (smoke.status !== 0) {
  fail(`release smoke failed (${smoke.status}):\n${smoke.stdout}${smoke.stderr}`);
}
const themeSmoke = spawnSync(
  process.execPath,
  [
    join(stage, RELEASE_LAYOUT.cliEntry),
    "theme",
    "validate",
    join(stage, RELEASE_LAYOUT.themesDir, "reference-theme-v1"),
    "--json",
  ],
  { cwd: stage, encoding: "utf8" },
);
if (themeSmoke.status !== 0) {
  fail(
    `reference theme release smoke failed (${themeSmoke.status}):\n${themeSmoke.stdout}${themeSmoke.stderr}`,
  );
}
// The extension catalog is statically imported by web/worker mains; a release
// that packages it unreadable/unresolvable fails at boot on the target, not
// here. Import it from the staged tree to bind every relative + workspace
// dependency now.
const catalogSmoke = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(join(stage, "extensions/catalog.js"))});`,
  ],
  { cwd: stage, encoding: "utf8" },
);
if (catalogSmoke.status !== 0) {
  fail(
    `extension catalog smoke failed (${catalogSmoke.status}):\n${catalogSmoke.stdout}${catalogSmoke.stderr}`,
  );
}

// --- pack (zip — the product-wide artifact format, registry contract) -------
console.log("build-release: packing");
const artifactPath = join(outRoot, `progressive-cms-${releaseId}.zip`);
await packReleaseZip(outRoot, releaseId, artifactPath);
assertReleaseZipPermissions(artifactPath);
sh("unzip", ["-tq", artifactPath]);
const cleanEntryCount = assertReleaseZipClean(artifactPath, releaseId, {
  packageNames,
  extensionDirs: extensionDirsForPolicy,
  themeDirs,
  docsIncluded: docsSummary !== null,
  preparedDocsDir: docsSummary?.source,
});
console.log(`build-release: public release content allowlist passed (${cleanEntryCount} entries)`);
console.log(
  `build-release: official Skills byte-verified against prepared Docs (${OFFICIAL_DOCS_SKILL_FILES.length} root resources + ${OFFICIAL_DOCS_SKILL_FILES.length} docs copies)`,
);
// CORE-RC19 (simplified delivery): confirm the accepted documentation folder
// actually made it into the packed ZIP, mechanically. There is no per-file pin
// and no separate manifest to reconcile — the release ZIP's own checksum (below)
// is the integrity mechanism. Requiring `index.md` is the one entry point the
// folder must have, so a build that dropped the documentation cannot pass
// silently.
if (docsSummary !== null) {
  const prefix = `${releaseId}/${DOCS_RELEASE_DIR}/`;
  const shipped = new Set(
    readReleaseZipEntries(artifactPath)
      .filter((entry) => entry.startsWith(prefix) && !entry.endsWith("/"))
      .map((entry) => entry.slice(prefix.length)),
  );
  if (!shipped.has("index.md")) {
    fail(`packaged release ZIP has no ${DOCS_RELEASE_DIR}/index.md`);
  }
  const missingCount = docsSummary.files.filter((path) => !shipped.has(path)).length;
  if (missingCount > 0) {
    fail(
      `packaged ${DOCS_RELEASE_DIR}/ is incomplete: ${missingCount} of ${docsSummary.files.length} files are missing`,
    );
  }
  console.log(`build-release: docs present in the ZIP (${shipped.size} files, index.md included)`);
}
const artifact = readFileSync(artifactPath);
const sha256 = createHash("sha256").update(artifact).digest("hex");
writeFileSync(
  join(outRoot, `progressive-cms-${releaseId}.zip.sha256`),
  `${sha256}  progressive-cms-${releaseId}.zip\n`,
);

const sizeBytes = statSync(artifactPath).size;
console.log(`build-release: ${releaseId}`);
console.log(`build-release: commit ${gitCommit}${gitDirty ? " (DIRTY tree)" : ""}`);
console.log(
  `build-release: artifact progressive-cms-${releaseId}.zip (${(sizeBytes / 1048576).toFixed(1)} MiB, sha256 ${sha256})`,
);
