import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "__snapshots__",
  "snapshots",
  "__mocks__",
  "spec",
  "specs",
]);
const NON_RUNTIME_DIRS = new Set([
  "docs",
  "examples",
  "scripts",
  "benchmark",
  "benchmarks",
  "coverage",
  "types",
]);
const CODE_FILES = new Set([".js", ".cjs", ".mjs", ".ts", ".tsx"]);
const TEST_FILE = /\.(?:test|spec)\..+$/i;

function hasTestScript(manifest) {
  return Object.keys(manifest.scripts ?? {}).some((name) => /^test(?:$|:|-)/.test(name));
}

function packageRoots(modulesDir) {
  const roots = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === ".bin" || entry.name === ".package-lock.json")
      continue;
    const entryPath = join(modulesDir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
        if (scoped.isDirectory() && !scoped.isSymbolicLink())
          roots.push(join(entryPath, scoped.name));
      }
    } else {
      roots.push(entryPath);
    }
  }
  return roots;
}

function packageDirectories(packageRoot) {
  const dirs = [];
  const walk = (dir, rel = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules") continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      dirs.push({ relative: next, absolute, name: entry.name });
      walk(absolute, next);
    }
  };
  walk(packageRoot);
  return dirs;
}

function packageTestFiles(packageRoot) {
  const files = [];
  const walk = (dir, rel = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!TEST_DIRS.has(entry.name) && entry.name !== "fixtures") walk(absolute, next);
      } else if (TEST_FILE.test(entry.name)) {
        files.push({ relative: next, absolute, name: entry.name });
      }
    }
  };
  walk(packageRoot);
  return files;
}

function treeBytes(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) bytes += treeBytes(path);
    else bytes += statSync(path).size;
  }
  return bytes;
}

function escapesPackageEntryPoint(manifest, candidate) {
  const relevant = JSON.stringify({
    main: manifest.main,
    module: manifest.module,
    exports: manifest.exports,
    bin: manifest.bin,
  });
  return relevant.includes(candidate);
}

function hasStaticRuntimeReference(packageRoot, dirs, candidate) {
  if (
    escapesPackageEntryPoint(
      JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      candidate,
    )
  ) {
    return true;
  }
  const candidatePaths = new Set([candidate]);
  if (candidate.includes("/")) candidatePaths.add(candidate.split("/").at(-1));
  const pathReferences = [...candidatePaths].map((candidatePath) => {
    const escaped = candidatePath
      .split("/")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[/\\\\]");
    return new RegExp(`(?:\\./|\\.\\./)${escaped}(?:/|["'])`);
  });
  const walk = (dir, rel = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        entry.name === "node_modules" ||
        NON_RUNTIME_DIRS.has(entry.name) ||
        TEST_FILE.test(entry.name)
      )
        continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (dirs.some((d) => next === d || next.startsWith(`${d}/`))) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(absolute, next)) return true;
      } else if (CODE_FILES.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        const source = readFileSync(absolute, "utf8");
        if (pathReferences.some((pathReference) => pathReference.test(source))) return true;
      }
    }
    return false;
  };
  return walk(packageRoot);
}

function prunePackage(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile())
    return { removedDirs: 0, removedFiles: 0, removedBytes: 0 };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!hasTestScript(manifest)) return { removedDirs: 0, removedFiles: 0, removedBytes: 0 };
  const dirs = packageDirectories(packageRoot);
  const testFiles = packageTestFiles(packageRoot);
  const candidates = dirs.filter(({ name }) => TEST_DIRS.has(name));
  const hasTestTree = candidates.some(({ name }) => TEST_DIRS.has(name));
  if (hasTestTree)
    candidates.push(
      ...dirs.filter(
        ({ name, relative: path }) =>
          name === "fixtures" && !path.split("/").some((part) => TEST_DIRS.has(part)),
      ),
    );
  if (testFiles.length > 0) candidates.push(...dirs.filter(({ name }) => name === "testing"));
  const unique = new Map(candidates.map((candidate) => [candidate.relative, candidate]));
  const selected = [...unique.values()]
    .filter(
      (candidate) =>
        TEST_DIRS.has(candidate.name) ||
        candidate.name === "testing" ||
        (candidate.name === "fixtures" && hasTestTree),
    )
    .filter(
      (candidate, _index, all) =>
        !all.some(
          (parent) =>
            parent.relative !== candidate.relative &&
            candidate.relative.startsWith(`${parent.relative}/`),
        ),
    );
  const selectedFiles = testFiles.filter(
    (file) => !selected.some((dir) => file.relative.startsWith(`${dir.relative}/`)),
  );
  if (selected.length === 0 && selectedFiles.length === 0)
    return { removedDirs: 0, removedFiles: 0, removedBytes: 0 };
  const paths = [...selected, ...selectedFiles]
    .map(({ relative: path }) => path)
    .sort((a, b) => a.length - b.length);
  for (const path of paths) {
    if (hasStaticRuntimeReference(packageRoot, paths, path)) {
      throw new Error(
        `${relative(process.cwd(), packageRoot)}: runtime entrypoint references test payload ${path}`,
      );
    }
  }
  let removedBytes = 0;
  const allSelected = [...selected, ...selectedFiles].sort(
    (a, b) => b.relative.length - a.relative.length,
  );
  for (const candidate of allSelected) {
    const stat = lstatSync(candidate.absolute, { throwIfNoEntry: false });
    if (!stat) continue;
    removedBytes += stat.isDirectory()
      ? treeBytes(candidate.absolute)
      : statSync(candidate.absolute).size;
    rmSync(candidate.absolute, { recursive: true, force: true });
  }
  return {
    removedDirs: selected.length,
    removedFiles: selectedFiles.length,
    removedBytes,
  };
}

function findNestedModules(packageRoot) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(dir, entry.name);
      if (entry.name === "node_modules") found.push(child);
      else if (!TEST_DIRS.has(entry.name) && entry.name !== "fixtures") walk(child);
    }
  };
  walk(packageRoot);
  return found;
}

export function pruneReleaseDependencyTests(releaseRoot) {
  const modulesDirs = [];
  const findModules = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(dir, entry.name);
      if (entry.name === "node_modules") modulesDirs.push(child);
      else if (!TEST_DIRS.has(entry.name) && entry.name !== "fixtures") findModules(child);
    }
  };
  findModules(releaseRoot);

  const visited = new Set();
  const totals = { removedDirs: 0, removedFiles: 0, removedBytes: 0 };
  const visitModules = (modulesDir) => {
    if (visited.has(modulesDir)) return;
    visited.add(modulesDir);
    for (const packageRoot of packageRoots(modulesDir)) {
      const result = prunePackage(packageRoot);
      totals.removedDirs += result.removedDirs;
      totals.removedFiles += result.removedFiles;
      totals.removedBytes += result.removedBytes;
      for (const nested of findNestedModules(packageRoot)) visitModules(nested);
    }
  };
  for (const modulesDir of modulesDirs) visitModules(modulesDir);
  return totals;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const releaseRoot = process.argv[2];
  if (!releaseRoot)
    throw new Error("usage: node scripts/prune-release-dependency-tests.mjs <release-root>");
  const result = pruneReleaseDependencyTests(resolve(releaseRoot));
  console.log(
    `prune-release-dependency-tests: removed ${result.removedDirs} reviewed directories and ${result.removedFiles} test files (${result.removedBytes} bytes)`,
  );
}
