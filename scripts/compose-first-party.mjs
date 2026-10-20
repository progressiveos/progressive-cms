// First-party package composition (ADR-0017, CORE-P0-01 S2–S6).
//
// `extensions/first-party.lock.json` is the single declarative source of the
// trusted first-party composition: every shipped package, its exact version,
// CONTENT digest (a code change without a manifest bump changes the digest —
// R2) and, for extracted packages, the immutable tarball supply (R4). The
// runtime catalog `extensions/catalog.ts` is GENERATED from the lock: Web,
// Worker and the compatibility snapshot (Admin reads it via discovery)
// compose the same set — there is no second list anywhere. The ui-test
// variant (standard + ui-test entries) exists only for the Admin UI contract
// gate harness.
//
// Commands:
//   write-lock                 recompute digests/versions from the package dirs
//   write-catalog              regenerate extensions/catalog.ts (+ ui-test variant)
//   check                      verify lock ↔ dirs ↔ catalog parity (build/test gate)
//   emit-catalog <mode> <out>  write standard|core-only|ui-test-js dist catalogs
//   emit-admin <mode> <out>    write the Admin UI contributions module (standard|ui-test)

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { transformSync } from "esbuild";

const ROOT = process.cwd();
const LOCK_PATH = "extensions/first-party.lock.json";
const CATALOG_PATH = "extensions/catalog.ts";

function fail(message) {
  console.error(`[first-party] ERROR: ${message}`);
  process.exit(1);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical content digest of a package directory: every file (sorted posix
 * relative paths, node_modules excluded — derived artifacts are installed
 * from the package's own lockfile), hash-of-hashes. A byte change anywhere
 * in the package changes the digest — this is the R2 artifact identity. */
function digestDir(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.isDirectory() && entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  if (files.length === 0) fail(`package dir ${dir} is empty`);
  const hasher = createHash("sha256");
  for (const file of files) {
    const rel = relative(dir, file).split(sep).join("/");
    hasher.update(`${rel}\n${sha256(readFileSync(file))}\n`);
  }
  return hasher.digest("hex");
}

function readLock() {
  if (!existsSync(LOCK_PATH)) fail(`${LOCK_PATH} missing — run write-lock`);
  return JSON.parse(readFileSync(LOCK_PATH, "utf8"));
}

function packageDirsOnDisk() {
  return readdirSync("extensions", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join("extensions", entry.name, "manifest.json")))
    .map((entry) => `extensions/${entry.name}`)
    .sort();
}

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

/** materializeExternal(pkg): supply a locked external package (ADR-0017 R4
 * bootstrap — immutable tagged tarball). The TARBALL digest is verified
 * before a byte is unpacked; the CONTENT digest is verified after. A package
 * with its own package.json+lockfile gets `npm ci` into the vendored dir. */
function materializeExternal(pkg) {
  const dir = pkg.dir;
  if (existsSync(dir)) {
    try {
      if (digestDir(dir) === pkg.content_sha256) return; // already vendored, intact
    } catch {
      // unreadable/partial — refetch below
    }
  }
  if (pkg.source?.tarball === undefined || pkg.source?.sha256 === undefined) {
    fail(`${dir}: missing on disk and the lock entry carries no tarball source`);
  }
  const tarball = resolve(ROOT, pkg.source.tarball);
  if (!existsSync(tarball)) {
    fail(
      `${dir}: supply tarball missing: ${tarball} (build it in the extensions repository: pack.sh)`,
    );
  }
  const supply = sha256(readFileSync(tarball));
  if (supply !== pkg.source.sha256) {
    fail(
      `${tarball}: supply digest mismatch (expected ${pkg.source.sha256}, got ${supply}) — refusing to unpack`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const strip = pkg.source.strip_components ?? 2;
  execFileSync("tar", ["-xzf", tarball, "-C", dir, `--strip-components=${strip}`]);
  if (digestDir(dir) !== pkg.content_sha256) {
    fail(
      `${dir}: content digest mismatch after unpacking ${tarball} — supply does not match the lock (R2 artifact identity)`,
    );
  }
  if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "package-lock.json"))) {
    const npm = spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: dir,
      stdio: "inherit",
    });
    if (npm.status !== 0) fail(`${dir}: npm ci failed for the vendored package`);
  }
  console.log(`[first-party] materialized ${pkg.id} from ${pkg.source.tarball}`);
}

function importAlias(pkg, name) {
  return (
    pkg.dir.replace("extensions/", "").replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + "_" + name
  );
}

/** Composition imports + module expression for one package. */
function composeModuleExpr(pkg) {
  const manifest = manifestOf(pkg.dir);
  const rel = pkg.dir.replace("extensions/", "");
  const alias = importAlias(pkg, "module");
  if (manifest.entrypoint?.factory !== undefined) {
    return {
      imports: [
        `import { ${manifest.entrypoint.factory} as ${alias} } from "./${rel}/src/index.js";`,
      ],
      expr: `${alias}({ pool: input.pool }) as unknown as Record<string, unknown>`,
    };
  }
  const named = [];
  for (const registration of manifest.registrations?.operations ?? []) {
    named.push([registration.handler, importAlias(pkg, `${registration.handler}`)]);
  }
  for (const subscription of manifest.registrations?.event_subscriptions ?? []) {
    named.push([subscription.handler, importAlias(pkg, `${subscription.handler}`)]);
  }
  for (const validator of manifest.registrations?.validators ?? []) {
    named.push([validator.handler, importAlias(pkg, `${validator.handler}`)]);
  }
  for (const provider of manifest.registrations?.providers ?? []) {
    named.push([provider.handler, importAlias(pkg, `${provider.handler}`)]);
  }
  // Extension Contract 2.0 (ADR-0018): http routes and source contributors
  // carry named handlers too — the composed module must expose them.
  for (const route of manifest.registrations?.http_routes ?? []) {
    named.push([route.handler, importAlias(pkg, `${route.handler}`)]);
  }
  for (const source of [
    ...(manifest.registrations?.sitemap_sources ?? []),
    ...(manifest.registrations?.search_sources ?? []),
    ...(manifest.registrations?.media_usage_sources ?? []),
  ]) {
    named.push([source.handler, importAlias(pkg, `${source.handler}`)]);
  }
  // PREPUBLIC §2: search sources enumerate through a second named export —
  // the composed module must expose it or reindex fails closed.
  for (const source of manifest.registrations?.search_sources ?? []) {
    named.push([source.page_ids_handler, importAlias(pkg, `${source.page_ids_handler}`)]);
  }
  // PREPUBLIC §4: durable extension jobs execute named exports on workers —
  // the composed module must expose them or execution fails closed.
  for (const job of manifest.registrations?.jobs ?? []) {
    named.push([job.handler, importAlias(pkg, `${job.handler}`)]);
  }
  if (named.length === 0) {
    return {
      imports: [`import * as ${alias} from "./${rel}/src/index.js";`],
      expr: `${alias} as unknown as Record<string, unknown>`,
    };
  }
  return {
    imports: named.map(
      ([name, handlerAlias]) =>
        `import { ${name} as ${handlerAlias} } from "./${rel}/src/index.js";`,
    ),
    expr: `{ ${named
      .map(([name, handlerAlias]) => `${name}: ${handlerAlias}`)
      .join(", ")} } as unknown as Record<string, unknown>`,
  };
}

function artifactBlock(pkg, moduleExpr) {
  const manifest = manifestOf(pkg.dir);
  const migrations = manifest.migrations ? `\n      migrationsDir: "${pkg.dir}/migrations",` : "";
  return `    defineExtensionArtifact({
      manifest: JSON.parse(
        readFileSync("${pkg.dir}/manifest.json", "utf8"),
      ) as unknown,
      module: ${moduleExpr},${migrations}
      extensionsDir: "${pkg.dir}",
      contentSha256: "${pkg.content_sha256}",
    }),`;
}

/** The generated catalog. includeUiTest=false → the production composition
 * (ui-test entries excluded); true → the e2e harness variant. */
function generateCatalog(lock, options) {
  const packages = lock.packages.filter(
    (pkg) => options.includeUiTest || pkg.composition !== "ui-test",
  );
  const importLines = [];
  const artifacts = [];
  for (const pkg of packages) {
    const composed = composeModuleExpr(pkg, options);
    importLines.push(...composed.imports);
    artifacts.push(artifactBlock(pkg, composed.expr));
  }
  return `// GENERATED by scripts/compose-first-party.mjs from extensions/first-party.lock.json —
// do not edit by hand; regenerate with \`node scripts/compose-first-party.mjs write-catalog\`.
// First-party extension deployment catalog (ADR-0013 §52.1, ADR-0017): the
// trusted catalog is identical in every process that composes application
// services — \`apps/web\` and \`apps/worker\` both build it through this one
// helper, and the compatibility snapshot (Admin reads it via discovery)
// derives from the same set. Extensions are trusted deployment artifacts
// loaded by static import (no marketplace, no runtime code loading); the DB
// is not a package manager.
import { readFileSync } from "node:fs";
import type { DbPool } from "@pcms/core";
import {
  createExtensionCatalog,
  type DeployedExtensionArtifact,
  defineExtensionArtifact,
  type ExtensionCatalog,
} from "@pcms/extensions/internal";
${importLines.join("\n")}

export interface FirstPartyCatalogInput {
  readonly pool: DbPool;
}

/**
 * Every shipped extension artifact, in lock order (deterministic). A package
 * is composed here only by its lock entry — \`scripts/compose-first-party.mjs
 * check\` fails the build when the lock, the directories and this file drift.
 */
export function defineFirstPartyExtensionArtifacts(
  input: FirstPartyCatalogInput,
): readonly DeployedExtensionArtifact[] {
  return [
${artifacts.join("\n")}
  ];
}

/** The composition-side trusted catalog both process roots share. */
export function createFirstPartyExtensionCatalog(input: FirstPartyCatalogInput): ExtensionCatalog {
  const catalog = createExtensionCatalog();
  for (const artifact of defineFirstPartyExtensionArtifacts(input)) {
    catalog.register(artifact);
  }
  return catalog;
}
`;
}

/** core-only dist catalog (plain JavaScript — it lands in the stage as-is). */
function generateCoreOnlyCatalog() {
  return `// GENERATED by scripts/compose-first-party.mjs (composition: core-only) — do not edit.
// Core-only composition: the platform composes ZERO first-party artifacts.
import { createExtensionCatalog } from "@pcms/extensions/internal";

/**
 * @param {{ pool: import("@pcms/core").DbPool }} _input
 * @returns {import("@pcms/extensions/internal").DeployedExtensionArtifact[]}
 */
export function defineFirstPartyExtensionArtifacts(_input) {
  return [];
}

/** @param {{ pool: import("@pcms/core").DbPool }} input */
export function createFirstPartyExtensionCatalog(input) {
  const catalog = createExtensionCatalog();
  for (const artifact of defineFirstPartyExtensionArtifacts(input)) {
    catalog.register(artifact);
  }
  return catalog;
}
`;
}

/** Admin UI contributions module (ADR-0017 S6 UI contract): one lazy
 * registration entry per package with manifest admin_contributions. Mode
 * standard excludes ui-test packages; ui-test includes everything. */
function generateAdminContributions(lock, mode) {
  const entries = [];
  for (const pkg of lock.packages) {
    const manifest = manifestOf(pkg.dir);
    if (manifest.admin_contributions !== true) continue;
    if (mode === "standard" && pkg.composition === "ui-test") continue;
    const rel = pkg.dir.replace("extensions/", "");
    entries.push(
      [
        "  {",
        `    extensionId: ${JSON.stringify(manifest.id)},`,
        "    register: async (api) => {",
        `      const module = await import("../../../../extensions/${rel}/admin/index.js");`,
        "      module.registerAdminContributions(api);",
        "    },",
        "  },",
      ].join("\n"),
    );
  }
  return [
    `// GENERATED by scripts/compose-first-party.mjs (admin contributions, mode: ${mode}) — do not edit.`,
    'import type { ExtensionContribution } from "./contributions-api.js";',
    "",
    "export const extensionContributions: readonly ExtensionContribution[] = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}

function check() {
  const lock = readLock();
  for (const pkg of lock.packages) {
    if (pkg.source !== undefined) materializeExternal(pkg);
  }
  const onDisk = packageDirsOnDisk();
  const locked = lock.packages.map((pkg) => pkg.dir).sort();
  const extra = onDisk.filter((dir) => !locked.includes(dir));
  if (extra.length > 0) fail(`directories not in the lock: ${extra.join(", ")} (run write-lock)`);
  const missing = locked.filter((dir) => !onDisk.includes(dir));
  if (missing.length > 0) fail(`locked directories missing on disk: ${missing.join(", ")}`);
  for (const pkg of lock.packages) {
    const manifest = manifestOf(pkg.dir);
    if (manifest.id !== pkg.id) fail(`${pkg.dir}: manifest id ${manifest.id} != lock id ${pkg.id}`);
    if (manifest.version !== pkg.version)
      fail(`${pkg.dir}: manifest version ${manifest.version} != lock version ${pkg.version}`);
    const digest = digestDir(pkg.dir);
    if (digest !== pkg.content_sha256) {
      fail(
        `${pkg.dir}: content digest drift (code or manifest changed without a lock update) — run write-lock and review the diff (R2 artifact identity)`,
      );
    }
  }
  const generated = generateCatalog(lock, { includeUiTest: false });
  if (readFileSync(CATALOG_PATH, "utf8") !== generated) {
    fail(
      `${CATALOG_PATH} is out of sync with ${LOCK_PATH} — run \`node scripts/compose-first-party.mjs write-catalog\``,
    );
  }
  console.log(`[first-party] check ok: ${lock.packages.length} packages, composition "standard"`);
}

function writeLock() {
  const previous = existsSync(LOCK_PATH) ? readLock() : { packages: [] };
  const previousById = new Map(previous.packages.map((pkg) => [pkg.id, pkg]));
  const lock = {
    schema: "pcms-first-party-lock/1",
    packages: packageDirsOnDisk().map((dir) => {
      const manifest = manifestOf(dir);
      const previousEntry = previousById.get(manifest.id);
      return {
        id: manifest.id,
        dir,
        version: manifest.version,
        content_sha256: digestDir(dir),
        ...(manifest.permission_namespace === undefined
          ? {}
          : { permission_namespace: manifest.permission_namespace }),
        ...(previousEntry?.source === undefined ? {} : { source: previousEntry.source }),
        ...(previousEntry?.composition === undefined
          ? {}
          : { composition: previousEntry.composition }),
      };
    }),
  };
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`[first-party] wrote ${LOCK_PATH} (${lock.packages.length} packages)`);
}

const [, , command, arg1, arg2] = process.argv;
if (command === "prepare-supply") {
  for (const pkg of readLock().packages) {
    if (pkg.source === undefined) continue;
    const archive = resolve(ROOT, pkg.source.tarball);
    if (!existsSync(archive)) {
      const suffix = `-${pkg.version}.tar.gz`;
      if (!archive.endsWith(suffix)) fail(`${pkg.id}: unexpected supply filename`);
      const name = basename(archive).slice(0, -suffix.length);
      execFileSync("sh", ["pack.sh", `${name}-v${pkg.version}`], {
        cwd: dirname(dirname(archive)),
        stdio: "inherit",
      });
    }
    const actualSupplySha256 = sha256(readFileSync(archive));
    if (actualSupplySha256 !== pkg.source.sha256)
      fail(
        `${pkg.id}: immutable supply digest mismatch (expected ${pkg.source.sha256}, got ${actualSupplySha256})`,
      );
  }
  check();
} else if (command === "write-lock") {
  writeLock();
} else if (command === "write-catalog") {
  const lock = readLock();
  writeFileSync(CATALOG_PATH, generateCatalog(lock, { includeUiTest: false }));
  writeFileSync(
    CATALOG_PATH.replace(".ts", ".ui-test.generated.ts"),
    generateCatalog(lock, { includeUiTest: true }),
  );
} else if (command === "check") {
  check();
} else if (command === "emit-catalog") {
  if (arg1 !== "standard" && arg1 !== "core-only" && arg1 !== "ui-test-js")
    fail("emit-catalog: mode is standard|core-only|ui-test-js");
  if (!arg2) fail("emit-catalog: missing output path");
  const source =
    arg1 === "core-only"
      ? generateCoreOnlyCatalog()
      : generateCatalog(readLock(), { includeUiTest: true });
  const output =
    arg1 === "ui-test-js"
      ? transformSync(source, { format: "esm", loader: "ts", target: "es2023" }).code
      : source;
  writeFileSync(arg2, output);
} else if (command === "emit-admin") {
  if (arg1 !== "standard" && arg1 !== "ui-test") fail("emit-admin: mode is standard|ui-test");
  if (!arg2) fail("emit-admin: missing output path");
  writeFileSync(arg2, generateAdminContributions(readLock(), arg1));
} else {
  fail(
    "usage: compose-first-party.mjs prepare-supply|write-lock|write-catalog|check|emit-catalog <mode> <out>|emit-admin <mode> <out>",
  );
}
