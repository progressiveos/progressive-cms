import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ThemeInstallError } from "./install-package.js";
import { createThemeRegistry } from "./manifest/registry.js";
import { parseThemeManifest } from "./manifest/schema.js";

const KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function root(configuredDir: string): string {
  const catalog = realpathSync(dirname(configuredDir));
  const dir = join(catalog, ".pcms-theme-revisions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir)
    throw new ThemeInstallError(
      "THEME_REVISION_INVALID",
      "revision store must be a contained directory",
    );
  syncPath(catalog);
  return dir;
}
function files(dir: string, prefix = ""): string[] {
  if (lstatSync(dir).isSymbolicLink())
    throw new ThemeInstallError("THEME_REVISION_INVALID", "theme source cannot be a symlink");
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new ThemeInstallError("THEME_REVISION_INVALID", "theme contains an unsupported file");
      return stat.isDirectory() ? files(path, `${prefix}${name}/`) : [`${prefix}${name}`];
    });
}
export function themeRevisionDirectory(
  configuredDir: string,
  storageKey: string,
  cmsVersion?: string,
): string {
  if (!KEY.test(storageKey))
    throw new ThemeInstallError("THEME_REVISION_INVALID", "invalid revision storage identity");
  const base = root(configuredDir);
  const dir = join(base, storageKey);
  if (!realpathSync(dir).startsWith(`${base}${sep}`) || lstatSync(dir).isSymbolicLink())
    throw new ThemeInstallError("THEME_REVISION_INVALID", "revision directory escaped its store");
  if (cmsVersion !== undefined) {
    const parsed = parseThemeManifest(readFileSync(join(dir, "theme.json"), "utf8"));
    if (!parsed.ok)
      throw new ThemeInstallError("THEME_PACKAGE_INVALID", "invalid retained theme manifest");
    const compatibility = createThemeRegistry().checkCompatibility(parsed.value, { cmsVersion });
    if (!compatibility.compatible)
      throw new ThemeInstallError(
        "THEME_PACKAGE_INVALID",
        compatibility.issues[0]?.message ?? "incompatible retained theme",
      );
  }
  return dir;
}
/** Only the lifecycle coordinator may remove a DB-proven unreferenced snapshot. */
export function removeThemeRevisionFiles(configuredDir: string, storageKey: string): void {
  if (!KEY.test(storageKey))
    throw new ThemeInstallError("THEME_REVISION_INVALID", "invalid revision storage identity");
  rmSync(join(root(configuredDir), storageKey), { recursive: true, force: true });
}
export function snapshotThemeFiles(
  configuredDir: string,
  source: string,
): { storageKey: string; sha256: string; dir: string } {
  files(source);
  const storageKey = randomUUID();
  const dir = join(root(configuredDir), storageKey);
  cpSync(source, dir, { recursive: true, errorOnExist: true, force: false });
  const hash = createHash("sha256");
  for (const name of files(dir)) {
    const path = join(dir, name);
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`).update(bytes);
  }
  syncTree(dir);
  syncPath(dirname(dir));
  return { storageKey, sha256: hash.digest("hex"), dir };
}
function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncTree(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) syncTree(path);
    else syncPath(path);
  }
  syncPath(dir);
}
/** The journal owns the recovery source; catalog renames are never its authority. */
export function restoreThemeCatalog(
  configuredDir: string,
  themeKey: string,
  source: string,
  operationId: string,
): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(themeKey) || !KEY.test(operationId))
    throw new ThemeInstallError("THEME_REVISION_INVALID", "invalid catalog identity");
  files(source);
  const catalog = realpathSync(dirname(configuredDir));
  const target = resolve(catalog, themeKey);
  const stage = join(catalog, `.pcms-theme-swap-${operationId}`);
  const previous = `${stage}.previous`;
  rmSync(stage, { recursive: true, force: true });
  cpSync(source, stage, { recursive: true });
  files(stage);
  syncTree(stage);
  // A prior interrupted rename may have left previous in place; the immutable
  // journal source makes it safe to replace that temporary catalog copy.
  rmSync(previous, { recursive: true, force: true });
  try {
    renameSync(target, previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  renameSync(stage, target);
  syncPath(catalog);
  rmSync(previous, { recursive: true, force: true });
}
