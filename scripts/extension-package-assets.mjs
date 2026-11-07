import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function assertPackagePath(path) {
  if (
    typeof path !== "string" ||
    !path.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) ||
    path.split("/").includes("node_modules")
  )
    throw new Error(`unsafe extension asset path: ${String(path)}`);
}

export function assertPackageDirectory(dir) {
  if (typeof dir !== "string" || !/^extensions\/[a-z0-9][a-z0-9-]*$/.test(dir))
    throw new Error(`unsafe extension package directory: ${String(dir)}`);
}

export function validateSupplyArchive(archive, strip) {
  if (!Number.isInteger(strip) || strip < 0 || strip > 4)
    throw new Error("invalid strip_components");
  const names = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  const types = execFileSync("tar", ["-tvzf", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  if (names.length !== types.length || types.some((line) => !/^[-d]/.test(line)))
    throw new Error("extension supply links and special files are forbidden");
  const seen = new Set();
  for (const name of names) {
    const path = name.replace(/\/$/, "");
    assertPackagePath(path);
    const stripped = path.split("/").slice(strip).join("/");
    if (!stripped && name.endsWith("/")) continue;
    if (!stripped || seen.has(stripped))
      throw new Error(`invalid or duplicate supply path: ${name}`);
    seen.add(stripped);
  }
}

// Reject links rather than hashing one tree and subsequently copying another.
export function packageFiles(dir) {
  const files = [];
  const walk = (path) => {
    const stat = lstatSync(join(dir, path));
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(dir, path)).sort()) {
        if (name === "node_modules" && path === "") continue;
        walk(path ? `${path}/${name}` : name);
      }
    } else if (stat.isFile()) files.push(path);
    else throw new Error(`extension package contains a link or special file: ${path}`);
  };
  walk("");
  return files;
}

export function packageContentDigest(dir) {
  const files = packageFiles(dir);
  if (!files.length) throw new Error(`empty extension package: ${dir}`);
  const digest = createHash("sha256");
  for (const path of files)
    digest.update(
      `${path}\n${createHash("sha256")
        .update(readFileSync(join(dir, path)))
        .digest("hex")}\n`,
    );
  return digest.digest("hex");
}

export function validateExtensionAssets(root, pkg) {
  assertPackageDirectory(pkg.dir);
  const directory = join(root, pkg.dir);
  const files = packageFiles(directory);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const assets = pkg.assets ?? {};
  if (
    !assets ||
    typeof assets !== "object" ||
    Array.isArray(assets) ||
    Object.keys(assets).some((key) => !["runtime", "build_inputs"].includes(key))
  )
    throw new Error(`${pkg.dir}: invalid assets declaration`);
  const declared = new Set();
  for (const kind of ["runtime", "build_inputs"]) {
    const paths = assets[kind] ?? [];
    if (!Array.isArray(paths)) throw new Error(`${pkg.dir}: assets.${kind} must be an array`);
    for (const path of paths) {
      assertPackagePath(path);
      if (!path.includes("/") || declared.has(path) || !files.includes(path))
        throw new Error(`${pkg.dir}: missing, duplicate or reserved asset: ${path}`);
      if (kind === "runtime" && /\.(?:tsx?|mts|cts)$/.test(path))
        throw new Error(`${pkg.dir}: runtime asset is TypeScript source: ${path}`);
      declared.add(path);
    }
  }
  // Preserve the already reviewed first-party agent payload for old locks.
  const legacyAgent = pkg.dir === "extensions/progressive-site-migration";
  for (const name of readdirSync(directory)) {
    if (
      [
        "src",
        "migrations",
        "node_modules",
        "manifest.json",
        "README.md",
        "package.json",
        "package-lock.json",
        "LICENSE",
        "NOTICE",
      ].includes(name) ||
      (legacyAgent && name === "agent") ||
      [...declared].some((path) => path.startsWith(`${name}/`))
    )
      continue;
    throw new Error(`unreviewed extension release asset: ${pkg.dir}/${name}`);
  }
  for (const path of files) {
    const top = path.split("/")[0];
    if (
      ["src", "migrations"].includes(top) ||
      [
        "manifest.json",
        "README.md",
        "package.json",
        "package-lock.json",
        "LICENSE",
        "NOTICE",
      ].includes(path) ||
      (legacyAgent && top === "agent") ||
      declared.has(path)
    )
      continue;
    throw new Error(`unreviewed extension release asset: ${pkg.dir}/${path}`);
  }
  for (const view of manifest.registrations?.views ?? []) {
    assertPackagePath(view.base_template);
    if (!(assets.runtime ?? []).includes(view.base_template))
      throw new Error(
        `${pkg.dir}: base_template must be declared in assets.runtime: ${view.base_template}`,
      );
  }
  if (
    manifest.admin_contributions === true &&
    !(assets.build_inputs ?? []).some((path) => /^admin\/index\.tsx?$/.test(path))
  )
    throw new Error(`${pkg.dir}: Admin entrypoint must be declared in assets.build_inputs`);
  return {
    runtime: [
      ...(assets.runtime ?? []),
      ...(legacyAgent ? files.filter((path) => path.startsWith("agent/")) : []),
    ].sort(),
    build_inputs: [...(assets.build_inputs ?? [])].sort(),
  };
}

export function stageExtensionAssets(root, stage, pkg) {
  const assets = validateExtensionAssets(root, pkg);
  for (const path of assets.runtime) {
    const target = join(stage, pkg.dir, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, pkg.dir, path), target);
    if (!readFileSync(target).equals(readFileSync(join(root, pkg.dir, path))))
      throw new Error(`${pkg.dir}/${path}: staged asset differs from source`);
  }
  return assets;
}
