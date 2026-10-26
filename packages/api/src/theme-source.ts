// Served-theme source export (CORE-THEME-REMOTE-PACKAGE-CYCLE).
//
// An agent edits a theme on its own machine: it downloads the package of the
// theme the public renderer ACTUALLY serves, edits it locally, uploads the
// result and applies it through the normal lifecycle. This module owns the
// download half — resolve that source, refuse to substitute another one, and
// build a deterministic `.pcTheme` archive from it.
//
// Determinism matters: the descriptor publishes a digest and the download
// must produce the same bytes, so entries are sorted and carry a fixed
// timestamp/mode. The archive uses the INSTALLER's allowlist, so an exported
// package is always installable again.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createThemeDiscovery,
  isAllowedThemeEntryName,
  resolveInstalledThemeDirectory,
} from "@pcms/themes";
import yazl from "yazl";
import type { ApplicationServices } from "./context.js";
import { ApiError } from "./errors.js";

/** Fixed ZIP timestamp: identical source bytes must give identical archive bytes. */
const FIXED_MTIME = new Date("1980-01-01T00:00:00.000Z");

export interface ThemeSourceFile {
  readonly name: string;
  readonly bytes: Buffer;
}

/**
 * Files of a served theme directory that belong in a package. Service state
 * (`.pcms-install.json`, snapshots, receipts — every hidden entry) is skipped:
 * it is instance data, not theme source. Anything else outside the package
 * allowlist fails loudly instead of producing an archive that silently loses
 * the author's file.
 */
/**
 * Core-owned service state — the installer receipt written next to
 * `theme.json`. Only the ROOT file is service state: the same name deeper in
 * the tree (`assets/.pcms-install.json`) is ordinary author content the
 * installer allowlist accepts, and dropping it would silently lose bytes.
 * Names are matched exactly, never by a `.pcms-` prefix (`.pcms-brand.bin`).
 */
const SERVICE_STATE_ROOT_FILES: ReadonlySet<string> = new Set([".pcms-install.json"]);

function isServiceState(relativeName: string): boolean {
  return SERVICE_STATE_ROOT_FILES.has(relativeName);
}

export function readThemeSourceFiles(directory: string, prefix = ""): ThemeSourceFile[] {
  const out: ThemeSourceFile[] = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    const relative = `${prefix}${name}`;
    if (isServiceState(relative)) continue; // only the root receipt
    if (stat.isSymbolicLink()) {
      throw new ApiError(
        "THEME_EXPORT_UNSUPPORTED",
        `theme contains a symlink and cannot be exported: ${relative}`,
        { status: 409 },
      );
    }
    if (stat.isDirectory()) {
      out.push(...readThemeSourceFiles(path, `${relative}/`));
      continue;
    }
    if (!stat.isFile()) {
      throw new ApiError(
        "THEME_EXPORT_UNSUPPORTED",
        `theme contains a special file and cannot be exported: ${relative}`,
        { status: 409 },
      );
    }
    if (!isAllowedThemeEntryName(relative)) {
      // Not exportable AND not installable: refuse loudly instead of
      // returning a package that silently lost the author's file.
      throw new ApiError(
        "THEME_EXPORT_UNSUPPORTED",
        `theme file is outside the package layout: ${relative}`,
        { status: 409 },
      );
    }
    out.push({ name: relative, bytes: readFileSync(path) });
  }
  return out;
}

/** Deterministic `.pcTheme` archive of the given files. */
export async function buildThemeArchive(files: readonly ThemeSourceFile[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    zip.addBuffer(file.bytes, file.name, {
      mtime: FIXED_MTIME,
      mode: 0o644,
      compress: true,
    });
  }
  zip.end();
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

export interface ServedThemeSource {
  readonly themeId: string;
  readonly servedVersion: string;
  /** Version of the installed catalog package, when the theme is installed. */
  readonly installedHeadVersion: string | null;
  readonly revisionId: string | null;
  readonly themeGeneration: number;
  readonly directory: string;
}

/**
 * The theme this request actually serves. The renderer pins one snapshot per
 * request (revision directory + generation), so a concurrent activation can
 * never make the descriptor and the archive disagree inside one request.
 * Before the first lifecycle mutation there is no revision — exporting the
 * bootstrap theme is read-only and creates no baseline.
 */
export function resolveServedThemeSource(app: ApplicationServices): ServedThemeSource {
  const snapshot = app.themeRuntime.requestSnapshot?.();
  if (snapshot === undefined) {
    throw new ApiError(
      "THEME_SOURCE_UNAVAILABLE",
      "no theme is being served by this process (theme renderer not registered)",
      { status: 409 },
    );
  }
  const manifest = createThemeDiscovery(snapshot.directory).getManifest();
  let installedHeadVersion: string | null = null;
  const configuredDir = app.themeRuntime.configuredDir;
  // The catalog lookup enforces cms_compatibility; without the running version
  // every ranged theme would look "unknown" and the head version would vanish.
  const cmsVersion = app.extensions.contractVersions.get("cms")?.version;
  if (configuredDir !== undefined) {
    try {
      const installedDir = resolveInstalledThemeDirectory(configuredDir, manifest.id, cmsVersion);
      installedHeadVersion = createThemeDiscovery(installedDir).getManifest().version;
    } catch {
      // Not installed as a catalog package (bootstrap/renderDir theme).
      installedHeadVersion = null;
    }
  }
  return {
    themeId: manifest.id,
    servedVersion: manifest.version,
    installedHeadVersion,
    revisionId: snapshot.revision_id,
    themeGeneration: snapshot.generation,
    directory: snapshot.directory,
  };
}

export interface ThemeSourceDescriptor {
  readonly theme_id: string;
  readonly served_version: string;
  readonly installed_head_version: string | null;
  readonly revision_id: string | null;
  readonly theme_generation: number;
  readonly package_sha256: string;
  readonly size_bytes: number;
  readonly download_path: string;
}

/** Archive + descriptor for one served source (one read, one digest). */
export async function describeThemeSource(
  source: ServedThemeSource,
): Promise<{ descriptor: ThemeSourceDescriptor; bytes: Buffer }> {
  const bytes = await buildThemeArchive(readThemeSourceFiles(source.directory));
  return {
    bytes,
    descriptor: {
      theme_id: source.themeId,
      served_version: source.servedVersion,
      installed_head_version: source.installedHeadVersion,
      revision_id: source.revisionId,
      theme_generation: source.themeGeneration,
      package_sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length,
      download_path: `/api/v1/themes/source/package?expected_generation=${source.themeGeneration}`,
    },
  };
}
