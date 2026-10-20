// Asset manifest/build pipeline contract (PCMS-THEME-T017; Theme Contract
// spec §31/§32/§54).
//
// Themes either use assets directly (no build) or ship a build pipeline; the
// production contract is identical either way: assets are declared in
// `theme.json`, and when `assets.fingerprint` is true the build emits
// content-hashed filenames (`theme.a1b2c3d4.css`) with deterministic output.
// Public theme assets are fully isolated from Admin UI bundles (§32) — a
// public asset referencing the Admin design system is a build error.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Hard per-file asset bound; budgets/quality gating refine this (T028). */
export const MAX_ASSET_BYTES = 1_000_000;

export interface AssetIssue {
  readonly code: "THEME_ASSET_MISSING" | "THEME_ASSET_TOO_LARGE" | "THEME_ASSET_ADMIN_LEAKAGE";
  readonly path: string;
  readonly message: string;
}

export interface AssetBuildOutput {
  /** Theme-relative source path, e.g. `assets/css/theme.css`. */
  readonly source: string;
  /** Production output path (fingerprinted when enabled). */
  readonly output: string;
  readonly hash: string;
  readonly bytes: number;
}

const ASSET_PATH_RE =
  /^assets\/[a-z0-9][a-z0-9._/-]{0,127}\.(css|js|svg|png|jpg|jpeg|webp|avif|woff2|json|txt)$/;

export function hashAsset(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

function fingerprintName(source: string, hash: string): string {
  const dot = source.lastIndexOf(".");
  return `${source.slice(0, dot)}.${hash}${source.slice(dot)}`;
}

/**
 * Plans the production asset outputs for the manifest's declared files.
 * Reads every file (missing/too large → issues), hashes content, and — when
 * `fingerprint` is on — rewrites the output name. Deterministic: outputs are
 * sorted by source path and hashes depend only on content.
 */
export function planAssetBuild(
  themeDir: string,
  assets: {
    readonly css?: readonly string[];
    readonly js?: readonly string[];
    readonly fingerprint?: boolean;
  },
): { readonly outputs: readonly AssetBuildOutput[]; readonly issues: readonly AssetIssue[] } {
  const declared = [...(assets.css ?? []), ...(assets.js ?? [])].sort((a, b) => a.localeCompare(b));
  const outputs: AssetBuildOutput[] = [];
  const issues: AssetIssue[] = [];
  for (const source of declared) {
    if (!ASSET_PATH_RE.test(source)) {
      issues.push({
        code: "THEME_ASSET_MISSING",
        path: source,
        message: `asset path is outside assets/: ${source}`,
      });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(join(themeDir, source), "utf8");
    } catch {
      issues.push({
        code: "THEME_ASSET_MISSING",
        path: source,
        message: `declared asset not found: ${source}`,
      });
      continue;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_ASSET_BYTES) {
      issues.push({
        code: "THEME_ASSET_TOO_LARGE",
        path: source,
        message: `asset exceeds ${MAX_ASSET_BYTES} bytes: ${bytes}`,
      });
      continue;
    }
    if (detectAdminLeakage(source, content)) {
      issues.push({
        code: "THEME_ASSET_ADMIN_LEAKAGE",
        path: source,
        message: "public asset references the Admin UI bundle (§32 asset isolation)",
      });
      continue;
    }
    const hash = hashAsset(content);
    outputs.push({
      source,
      output: assets.fingerprint === true ? fingerprintName(source, hash) : source,
      hash,
      bytes,
    });
  }
  return { outputs, issues };
}

/**
 * Asset isolation check (§32): public theme assets must never pull in the
 * Admin UI / Progressive Design System bundle.
 */
export function detectAdminLeakage(source: string, content: string): boolean {
  if (!source.endsWith(".js") && !source.endsWith(".css")) return false;
  return /@pcms\/admin|pcms-admin|design-system\/admin|admin-design-system/.test(content);
}
