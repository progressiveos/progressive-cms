#!/usr/bin/env node
// Prepare an immutable source snapshot; the existing builder remains the only builder.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPackageDirectory, validateSupplyArchive } from "./extension-package-assets.mjs";

function coreTreeDigest(sourceRepo, commit, root) {
  const files = git(sourceRepo, ["ls-tree", "-rz", "--name-only", commit])
    .toString()
    .split("\0")
    .filter(
      (path) =>
        path &&
        ![
          "extensions/first-party.lock.json",
          "extensions/catalog.ts",
          "extensions/catalog.ui-test.generated.ts",
        ].includes(path),
    );
  const digest = createHash("sha256");
  for (const path of files) digest.update(`${path}\n${sha256(readFileSync(join(root, path)))}\n`);
  return digest.digest("hex");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, args, options = {}) =>
  execFileSync("git", ["-C", root, ...args], { maxBuffer: 256 * 1024 * 1024, ...options });

export function prepareReleaseComposition({ sourceRepo, recipePath, out }) {
  sourceRepo = resolve(sourceRepo);
  recipePath = resolve(recipePath);
  out = resolve(out);
  if (existsSync(out)) throw new Error("composition output must not exist");
  const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
  if (
    recipe.schema !== "pcms-composition/1" ||
    !/^[a-f0-9]{40}$/.test(recipe.core_commit) ||
    !Array.isArray(recipe.packages) ||
    !recipe.packages.length
  )
    throw new Error("invalid immutable composition recipe");
  const script = "scripts/prepare-release-composition.mjs";
  if (
    !git(sourceRepo, ["show", `${recipe.core_commit}:${script}`]).equals(
      readFileSync(fileURLToPath(import.meta.url)),
    )
  )
    throw new Error("use the versioned composition tooling from the pinned Core commit");
  const seenIds = new Set();
  const seenDirs = new Set();
  for (const pkg of recipe.packages) {
    assertPackageDirectory(pkg.dir);
    if (
      !/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(pkg.id) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(pkg.version) ||
      !/^[a-f0-9]{64}$/.test(pkg.content_sha256) ||
      !/^[a-f0-9]{64}$/.test(pkg.source?.sha256) ||
      !/^[a-f0-9]{40}$/.test(pkg.source_commit) ||
      seenIds.has(pkg.id) ||
      seenDirs.has(pkg.dir)
    )
      throw new Error("invalid or duplicate composition package identity");
    seenIds.add(pkg.id);
    seenDirs.add(pkg.dir);
    const archive = resolve(dirname(recipePath), pkg.source.tarball);
    if (sha256(readFileSync(archive)) !== pkg.source.sha256)
      throw new Error(`${pkg.id}: supply SHA-256 mismatch`);
    validateSupplyArchive(archive, pkg.source.strip_components ?? 2);
  }
  mkdirSync(out, { recursive: true });
  const source = git(sourceRepo, ["archive", "--format=tar", recipe.core_commit]);
  execFileSync("tar", ["-xf", "-", "-C", out], { input: source });
  const coreTreeSha256 = coreTreeDigest(sourceRepo, recipe.core_commit, out);
  const lockPath = join(out, "extensions/first-party.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  for (const pkg of recipe.packages) {
    if (lock.packages.some((entry) => entry.id === pkg.id || entry.dir === pkg.dir))
      throw new Error(`${pkg.id}: composition must not replace an existing trusted package`);
    lock.packages.push({
      id: pkg.id,
      dir: pkg.dir,
      version: pkg.version,
      content_sha256: pkg.content_sha256,
      source: {
        tarball: `supply/${pkg.id}-${pkg.version}.tar.gz`,
        sha256: pkg.source.sha256,
        strip_components: pkg.source.strip_components ?? 2,
      },
      assets: pkg.assets,
    });
  }
  // Pin every existing supply too; never rely on a mutable sibling directory at build time.
  for (const pkg of lock.packages) {
    if (!pkg.source) continue;
    const extra = recipe.packages.find((entry) => entry.id === pkg.id);
    const from = extra
      ? resolve(dirname(recipePath), extra.source.tarball)
      : resolve(sourceRepo, pkg.source.tarball);
    if (sha256(readFileSync(from)) !== pkg.source.sha256)
      throw new Error(`${pkg.id}: existing supply SHA-256 mismatch`);
    const local = `supply/${pkg.id}-${pkg.version}.tar.gz`;
    mkdirSync(join(out, "supply"), { recursive: true });
    cpSync(from, join(out, local));
    pkg.source.tarball = local;
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const epoch = Number(
    git(sourceRepo, ["show", "-s", "--format=%ct", recipe.core_commit]).toString().trim(),
  );
  const coreVersion = JSON.parse(readFileSync(join(out, "package.json"))).version;
  const provenance = {
    schema: "pcms-composition-build/1",
    core: { commit: recipe.core_commit, version: coreVersion, tree_sha256: coreTreeSha256 },
    builder: { commit: recipe.core_commit, version: 1 },
    builtAtUtc: new Date(epoch * 1000).toISOString(),
    packages: lock.packages.map(({ id, dir, version, content_sha256, source, assets }) => ({
      id,
      dir,
      version,
      content_sha256,
      source: source
        ? { sha256: source.sha256, strip_components: source.strip_components ?? 2 }
        : null,
      assets: assets ?? {},
      source_commit: recipe.packages.find((pkg) => pkg.id === id)?.source_commit ?? null,
    })),
  };
  const compositionId = sha256(JSON.stringify(provenance));
  writeFileSync(
    join(out, "composition-manifest.json"),
    `${JSON.stringify({ ...provenance, composition_id: compositionId }, null, 2)}\n`,
  );
  // Catalog generation only needs the toolchain, not extension handler execution.
  // The caller runs npm ci and compose-first-party write-catalog next, before sealing the snapshot.
  return { root: out, compositionId, coreCommit: recipe.core_commit };
}

export function sealReleaseComposition(root, sourceRepo) {
  root = resolve(root);
  const provenance = JSON.parse(readFileSync(join(root, "composition-manifest.json"), "utf8"));
  const { composition_id, ...identity } = provenance;
  if (
    sha256(JSON.stringify(identity)) !== composition_id ||
    coreTreeDigest(resolve(sourceRepo), provenance.core.commit, root) !==
      provenance.core.tree_sha256
  )
    throw new Error("composition source drift: re-prepare from immutable inputs");
  if (existsSync(join(root, ".git"))) throw new Error("composition snapshot is already sealed");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Progressive CMS Builder",
    GIT_AUTHOR_EMAIL: "builder@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Progressive CMS Builder",
    GIT_COMMITTER_EMAIL: "builder@users.noreply.github.com",
    GIT_AUTHOR_DATE: provenance.builtAtUtc,
    GIT_COMMITTER_DATE: provenance.builtAtUtc,
  };
  const run = (args) => git(root, args, { env });
  run(["init", "--quiet", "--initial-branch=composed"]);
  run(["add", "--all"]);
  run([
    "add",
    "-f",
    "extensions/first-party.lock.json",
    "extensions/catalog.ts",
    "composition-manifest.json",
    "supply",
  ]);
  run([
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    `build: immutable composition ${provenance.composition_id}`,
  ]);
  return run(["rev-parse", "HEAD"]).toString().trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "prepare" && args.length === 3)
      console.log(
        JSON.stringify(
          prepareReleaseComposition({ sourceRepo: args[0], recipePath: args[1], out: args[2] }),
        ),
      );
    else if (command === "seal" && args.length === 2)
      console.log(sealReleaseComposition(args[0], args[1]));
    else
      throw new Error(
        "usage: prepare-release-composition.mjs prepare <core-repo> <recipe.json> <new-directory> | seal <prepared-directory> <core-repo>",
      );
  } catch (error) {
    console.error(`compose-release: ${error.message}`);
    process.exitCode = 1;
  }
}
