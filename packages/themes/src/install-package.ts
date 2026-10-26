// Theme package installer (owner directive 2026-09-29: themes join the
// registry/artifact lifecycle alongside skills and extensions). A .pcTheme
// package is a ZIP with `theme.json` at its root; installation validates the
// central directory BEFORE writing anything and refuses: path traversal /
// absolute / backslash entries, unknown top-level roots, oversized packages,
// broken theme manifests, overwriting the live (renderDir) theme. The full
// theme validator (manifest + assets + fixture render smoke) runs against a
// temp extraction before the real directory is touched. Lives in the domain
// package (L1): package lifecycle is domain logic (@pcms/publication already
// reads zips in L1).
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import yauzl from "yauzl";
import { satisfiesVersion } from "./manifest/semver.js";
import { validateThemeDir } from "./validate/theme-validate.js";

const MAX_ENTRIES = 4000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Top-level roots a theme package may contain: the mandatory contract
 * layout plus the optional §5 directories (scripts/styles/locales/tests). */
const ALLOWED_ROOTS = [
  "theme.json",
  "THEME.md",
  "README.md",
  "CHANGELOG.md",
  "blocks/",
  "templates/",
  "components/",
  "tokens/",
  "fixtures/",
  "assets/",
  "scripts/",
  "styles/",
  "locales/",
  "tests/",
];

export class ThemeInstallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ThemeInstallError";
  }
}

interface ZipEntry {
  readonly name: string;
  readonly uncompressedSize: number;
}

function readZipEntries(buffer: Buffer): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || zipFile === undefined) {
          reject(new ThemeInstallError("THEME_PACKAGE_INVALID", "not a readable zip package"));
          return;
        }
        const entries: ZipEntry[] = [];
        let total = 0;
        zipFile.on("entry", (entry: yauzl.Entry) => {
          entries.push({ name: entry.fileName, uncompressedSize: entry.uncompressedSize });
          total += entry.uncompressedSize;
          if (entries.length > MAX_ENTRIES) {
            reject(new ThemeInstallError("THEME_PACKAGE_INVALID", "too many package entries"));
            return;
          }
          if (total > MAX_TOTAL_BYTES) {
            reject(new ThemeInstallError("THEME_PACKAGE_INVALID", "package over the size cap"));
            return;
          }
          zipFile.readEntry();
        });
        zipFile.on("end", () => resolve(entries));
        zipFile.readEntry(); // lazyEntries: the first entry needs the kick
        zipFile.on("error", () =>
          reject(new ThemeInstallError("THEME_PACKAGE_INVALID", "corrupt zip package")),
        );
      },
    );
  });
}

function extractZipEntries(
  buffer: Buffer,
  wanted: ReadonlySet<string>,
  targetDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || zipFile === undefined) {
          reject(new ThemeInstallError("THEME_PACKAGE_INVALID", "not a readable zip package"));
          return;
        }
        zipFile.on("entry", (entry: yauzl.Entry) => {
          const writeIt = wanted.has(entry.fileName) && !entry.fileName.endsWith("/");
          if (!writeIt) {
            zipFile.readEntry();
            return;
          }
          zipFile.openReadStream(entry, (streamError, stream) => {
            if (streamError || stream === undefined) {
              reject(
                new ThemeInstallError(
                  "THEME_PACKAGE_INVALID",
                  `cannot read entry ${entry.fileName}`,
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => {
              const fileDir = join(targetDir, entry.fileName.split("/").slice(0, -1).join("/"));
              mkdirSync(fileDir, { recursive: true });
              writeFileSync(join(targetDir, entry.fileName), Buffer.concat(chunks));
              zipFile.readEntry();
            });
            stream.on("error", () =>
              reject(new ThemeInstallError("THEME_PACKAGE_INVALID", "stream error")),
            );
          });
        });
        zipFile.on("end", () => resolve());
        zipFile.on("error", () =>
          reject(new ThemeInstallError("THEME_PACKAGE_INVALID", "corrupt zip package")),
        );
        zipFile.readEntry(); // lazyEntries kick
      },
    );
  });
}

/** Root-level files a package may carry besides `theme.json`. */
const ALLOWED_ROOT_FILES = new Set(["theme.json", "THEME.md", "README.md", "CHANGELOG.md"]);

/**
 * One package-allowlist decision, shared by install validation and the
 * export builder so a round trip can never produce a package the installer
 * would refuse (or export something the installer would reject).
 */
export function isAllowedThemeEntryName(name: string): boolean {
  if (name.startsWith("/") || name.includes("..") || name.includes("\\")) return false;
  const top = name.includes("/") ? `${name.split("/")[0]}/` : name;
  if (!ALLOWED_ROOTS.includes(top) && !ALLOWED_ROOTS.includes(name)) return false;
  if (!name.endsWith("/") && !name.includes("/")) return ALLOWED_ROOT_FILES.has(name);
  return true;
}

/** Entry-path gate: traversal/absolute/backslash names and unknown roots are
 * rejected before anything is extracted. */
export function validateThemeEntryNames(names: readonly string[]): void {
  for (const name of names) {
    if (name.startsWith("/") || name.includes("..") || name.includes("\\")) {
      throw new ThemeInstallError("THEME_PACKAGE_INVALID", `unsafe entry path: ${name}`);
    }
    if (!isAllowedThemeEntryName(name)) {
      const top = name.includes("/") ? `${name.split("/")[0]}/` : name;
      throw new ThemeInstallError(
        "THEME_PACKAGE_INVALID",
        ALLOWED_ROOTS.includes(top)
          ? `unknown package file: ${name}`
          : `unknown package root: ${top}`,
      );
    }
  }
}

export interface ThemePackageInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
}

/** Structural + full-theme validation. Returns the theme identity; throws
 * ThemeInstallError with a stable code otherwise. */
export async function validateThemePackage(
  packageBytes: Buffer,
  cmsVersion?: string,
): Promise<ThemePackageInfo> {
  const entries = await readZipEntries(packageBytes);
  validateThemeEntryNames(entries.map(({ name }) => name));
  if (!entries.some(({ name }) => name === "theme.json")) {
    throw new ThemeInstallError(
      "THEME_PACKAGE_INVALID",
      "package needs theme.json at its root (.pcTheme layout)",
    );
  }
  const stage = mkdtempSync(join(tmpdir(), "pcms-theme-"));
  try {
    await extractZipEntries(packageBytes, new Set(entries.map(({ name }) => name)), stage);
    // Full contract validation — manifest, assets, fixture render smoke — on
    // the staged copy; the live themes root stays untouched until this passes.
    const report = validateThemeDir(stage, {
      ...(cmsVersion === undefined ? {} : { cmsVersion }),
    });
    if (!report.ok) {
      const first = report.issues[0];
      throw new ThemeInstallError(
        "THEME_PACKAGE_INVALID",
        `theme validation failed: ${first?.code ?? "unknown"} ${first?.message ?? ""}`.trim(),
      );
    }
    const manifest = JSON.parse(readFileSync(join(stage, "theme.json"), "utf8")) as {
      id?: unknown;
      name?: unknown;
      version?: unknown;
    };
    if (typeof manifest.id !== "string" || manifest.id.length === 0) {
      throw new ThemeInstallError("THEME_PACKAGE_INVALID", "theme.json has no usable id");
    }
    return {
      id: manifest.id,
      name: typeof manifest.name === "string" ? manifest.name : manifest.id,
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      sha256: createHash("sha256").update(packageBytes).digest("hex"),
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Reuse the package gate and extractor without touching the live catalog. */
export async function stageThemePackage(
  packageBytes: Buffer,
  cmsVersion: string,
): Promise<{ info: ThemePackageInfo; dir: string; cleanup: () => void }> {
  const info = await validateThemePackage(packageBytes, cmsVersion);
  const dir = mkdtempSync(join(tmpdir(), "pcms-theme-revision-"));
  try {
    const entries = await readZipEntries(packageBytes);
    await extractZipEntries(packageBytes, new Set(entries.map(({ name }) => name)), dir);
    writeFileSync(
      join(dir, ".pcms-install.json"),
      JSON.stringify({
        installedAt: new Date().toISOString(),
        sha256: info.sha256,
        version: info.version,
      }),
    );
    return { info, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export interface InstalledTheme {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** The theme the configured themes.renderDir actually renders. */
  readonly isRenderTarget: boolean;
  readonly installedAt: string | null;
  readonly source: string | null;
  readonly broken: string | null;
}

/** Scans the themes root (parent of themes.renderDir) for installed themes.
 * A directory without a readable theme.json shows up as `broken` — it must
 * stay visible so the operator can uninstall it. */
export function listInstalledThemes(
  themesRoot: string,
  renderDirThemeId: string,
): readonly InstalledTheme[] {
  if (!existsSync(themesRoot)) return [];
  const themes: InstalledTheme[] = [];
  for (const entry of readdirSync(themesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(themesRoot, entry.name);
    const manifestPath = join(dir, "theme.json");
    if (!existsSync(manifestPath)) continue;
    let id = entry.name;
    let name = entry.name;
    let version = "";
    let broken: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        id?: unknown;
        name?: unknown;
        version?: unknown;
      };
      if (typeof parsed.id === "string") id = parsed.id;
      if (typeof parsed.name === "string") name = parsed.name;
      if (typeof parsed.version === "string") version = parsed.version;
    } catch (error) {
      broken = `unreadable theme.json: ${(error as Error).message}`;
    }
    let installedAt: string | null = null;
    let source: string | null = null;
    const sidecarPath = join(dir, ".pcms-install.json");
    if (existsSync(sidecarPath)) {
      try {
        const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
          installedAt?: unknown;
          source?: unknown;
        };
        if (typeof sidecar.installedAt === "string") installedAt = sidecar.installedAt;
        if (typeof sidecar.source === "string") source = sidecar.source;
      } catch {
        // Unreadable sidecar is cosmetic — ignore.
      }
    }
    themes.push({
      id,
      name,
      version,
      isRenderTarget: id === renderDirThemeId || entry.name === renderDirThemeId,
      installedAt,
      source,
      broken,
    });
  }
  return themes.sort((a, b) => a.id.localeCompare(b.id));
}

export interface InstallThemeOptions {
  /** CMS build version for the package validator's `cms_compatibility`
   * check — undefined keeps today's honest "unknown" report. */
  readonly cmsVersion?: string;
  /** Parent of themes.renderDir — where themes live. */
  readonly themesRoot: string;
  /** The theme id the configured renderDir serves (never overwritten). */
  readonly renderDirThemeId: string;
  /** Source note for the install sidecar (registry url / filename). */
  readonly source?: string;
}

/** Validates the package, then atomically-replaces `themesRoot/<id>`. The
 * renderDir theme is refused: active updates use updateActiveThemePackage. */
export async function installThemePackage(
  packageBytes: Buffer,
  options: InstallThemeOptions,
): Promise<ThemePackageInfo> {
  const info = await validateThemePackage(packageBytes, options.cmsVersion);
  if (info.id === options.renderDirThemeId) {
    throw new ThemeInstallError(
      "THEME_INSTALL_RENDER_TARGET",
      `"${info.id}" is the active renderDir theme — use cms theme update-active, not package overwrite`,
    );
  }
  const targetDir = join(options.themesRoot, info.id);
  if (!existsSync(options.themesRoot)) {
    mkdirSync(options.themesRoot, { recursive: true });
  }
  if (existsSync(targetDir)) {
    // Reinstall = replace (same contract as community skills).
    rmSync(targetDir, { recursive: true, force: true });
  }
  const entries = await readZipEntries(packageBytes);
  const wanted = new Set(
    entries.filter((entry) => !entry.name.endsWith("/")).map((entry) => entry.name),
  );
  await extractZipEntries(packageBytes, wanted, targetDir);
  const sidecar = JSON.stringify(
    {
      installedAt: new Date().toISOString(),
      sha256: info.sha256,
      version: info.version,
      ...(options.source === undefined ? {} : { source: options.source }),
    },
    null,
    2,
  );
  writeFileSync(join(targetDir, ".pcms-install.json"), `${sidecar}\n`);
  return info;
}

const activeUpdates = new Set<string>();

/** Stage and prepare the complete render stack before replacing any live files. */
export async function updateActiveThemePackage(
  packageBytes: Buffer,
  options: {
    readonly themeDir: string;
    readonly themeId: string;
    readonly cmsVersion: string;
    readonly prepare: (stagedDir: string) => Promise<() => void>;
  },
): Promise<ThemePackageInfo & { cleanup_warning?: string }> {
  const target = resolve(options.themeDir);
  if (activeUpdates.has(target)) {
    throw new ThemeInstallError("THEME_UPDATE_CONFLICT", "an active theme update is in progress");
  }
  activeUpdates.add(target);
  let stage: string | undefined;
  try {
    const targetStat = lstatSync(target);
    if (!targetStat.isDirectory()) {
      throw new ThemeInstallError(
        "THEME_UPDATE_TARGET_INVALID",
        "active theme must be a directory, not a symlink",
      );
    }
    const currentSource = readFileSync(join(target, "theme.json"), "utf8");
    const current = JSON.parse(currentSource) as { id: string; version: string };
    const info = await validateThemePackage(packageBytes, options.cmsVersion);
    if (info.id !== options.themeId || info.id !== current.id) {
      throw new ThemeInstallError(
        "THEME_UPDATE_ID_INVALID",
        `package id "${info.id}" does not match the active theme id "${current.id}" — ` +
          "update-active only updates the SAME theme; to install a NEW theme use " +
          "POST /api/v1/themes/install, then POST /api/v1/theme/activate; no Web restart is required",
      );
    }
    if (!satisfiesVersion(info.version, `>${current.version}`)) {
      throw new ThemeInstallError(
        "THEME_UPDATE_VERSION_CONFLICT",
        "package version must be newer than the active theme",
      );
    }
    stage = mkdtempSync(join(dirname(target), ".pcms-theme-update-"));
    const entries = await readZipEntries(packageBytes);
    await extractZipEntries(packageBytes, new Set(entries.map(({ name }) => name)), stage);
    // Preserve access for the configured asset server; mkdtemp starts with mode 0700.
    chmodSync(stage, targetStat.mode & 0o777);
    writeFileSync(
      join(stage, ".pcms-install.json"),
      `${JSON.stringify({
        installedAt: new Date().toISOString(),
        sha256: info.sha256,
        version: info.version,
      })}\n`,
    );
    const commitRender = await options.prepare(stage);
    if (readFileSync(join(target, "theme.json"), "utf8") !== currentSource) {
      throw new ThemeInstallError(
        "THEME_UPDATE_CONFLICT",
        "active theme changed during validation",
      );
    }
    const previous = `${stage}.previous`;
    // Synchronous renames and the in-memory commit cannot interleave with a web request.
    renameSync(target, previous);
    let replaced = false;
    try {
      renameSync(stage, target);
      replaced = true;
      commitRender();
    } catch (error) {
      if (replaced) rmSync(target, { recursive: true, force: true });
      renameSync(previous, target);
      throw error;
    }
    try {
      rmSync(previous, { recursive: true, force: true });
      return info;
    } catch {
      // Cleanup cannot turn a committed, serving update into a reported failure.
      return {
        ...info,
        cleanup_warning:
          "The new theme is serving, but the previous directory could not be removed.",
      };
    }
  } finally {
    if (stage !== undefined) rmSync(stage, { recursive: true, force: true });
    activeUpdates.delete(target);
  }
}

/** Deletes an installed theme. The renderDir theme is protected — switch the
 * deployment's themes.renderDir first. */
export function uninstallThemePackage(
  themesRoot: string,
  themeId: string,
  renderDirThemeId: string,
): void {
  if (themeId === renderDirThemeId) {
    throw new ThemeInstallError(
      "THEME_UNINSTALL_RENDER_TARGET",
      `"${themeId}" is the active renderDir theme — switch themes.renderDir first`,
    );
  }
  const targetDir = join(themesRoot, themeId);
  if (!existsSync(join(targetDir, "theme.json"))) {
    throw new ThemeInstallError("THEME_NOT_INSTALLED", `no installed theme "${themeId}"`);
  }
  rmSync(targetDir, { recursive: true, force: true });
}

/** Only native installed packages (or the operator-configured bootstrap theme) are activatable. */
export function resolveInstalledThemeDirectory(
  configuredDir: string,
  themeKey: string,
  cmsVersion?: string,
): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(themeKey)) {
    throw new ThemeInstallError("THEME_KEY_UNKNOWN", "invalid installed theme key");
  }
  const root = realpathSync(dirname(configuredDir));
  const configuredManifest = join(configuredDir, "theme.json");
  const configuredMatches =
    existsSync(configuredManifest) &&
    JSON.parse(readFileSync(configuredManifest, "utf8")).id === themeKey;
  const target = join(root, configuredMatches ? basename(configuredDir) : themeKey);
  if (!existsSync(target))
    throw new ThemeInstallError("THEME_NOT_INSTALLED", "theme is not installed");
  if (realpathSync(target) !== target || !target.startsWith(root + sep)) {
    throw new ThemeInstallError(
      "THEME_PACKAGE_INVALID",
      "theme must be a direct installed directory",
    );
  }
  let receiptVersion: string | undefined;
  if (resolve(configuredDir) !== target) {
    try {
      const receipt = JSON.parse(readFileSync(join(target, ".pcms-install.json"), "utf8"));
      if (
        receipt === null ||
        typeof receipt !== "object" ||
        !/^[0-9a-f]{64}$/.test(receipt.sha256 ?? "") ||
        typeof receipt.version !== "string"
      )
        throw new Error("invalid receipt");
      receiptVersion = receipt.version;
    } catch {
      throw new ThemeInstallError(
        "THEME_PACKAGE_UNTRUSTED",
        "theme has no valid native installation receipt",
      );
    }
  }
  const report = validateThemeDir(target, { ...(cmsVersion === undefined ? {} : { cmsVersion }) });
  if (!report.ok)
    throw new ThemeInstallError(
      "THEME_PACKAGE_INVALID",
      report.issues[0]?.message ?? "invalid theme",
    );
  const manifest = JSON.parse(readFileSync(join(target, "theme.json"), "utf8"));
  if (receiptVersion !== undefined && receiptVersion !== manifest.version)
    throw new ThemeInstallError(
      "THEME_PACKAGE_UNTRUSTED",
      "installed version does not match its receipt",
    );
  if (manifest.id !== themeKey)
    throw new ThemeInstallError("THEME_KEY_UNKNOWN", "installed identity mismatch");
  return target;
}
