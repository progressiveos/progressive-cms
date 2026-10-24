// Active-theme media preset resolution for processes without a request
// cycle (PCPUB ingest stages media in the WORKER — ADR-0014 §8; Publication
// spec §83.5). The web composition re-resolves mediaPresets from the active
// theme on every request (site.ts); a worker pinned to the boot seed in
// themes.renderDir silently generates zero derivatives for every preset the
// active theme declares beyond the seed set. Same pointer precedence as the
// web resolution: confirmed revision snapshot → installed native package →
// configured renderDir.
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DbClient } from "@pcms/core";
import { createMediaPresetRegistry } from "@pcms/media";
import {
  readThemeManifestPresets,
  resolveInstalledThemeDirectory,
  themeRevisionDirectory,
} from "@pcms/themes";
import type { ApplicationServices } from "./context.js";
import { readThemeLifecycleState } from "./theme-lifecycle.js";

export async function resolveActiveThemeDirectory(input: {
  readonly db: DbClient;
  readonly siteKey: string;
  readonly configuredDir: string;
  readonly cmsVersion?: string;
}): Promise<string> {
  const state = await readThemeLifecycleState(input.db, input.siteKey);
  if (state?.active_revision_id) {
    const revisions = await input.db.query<{ storage_key: string }>(
      "SELECT storage_key FROM theme_revisions WHERE site_key = $1 AND id = $2",
      [input.siteKey, state.active_revision_id],
    );
    if (revisions.rows[0]) {
      return themeRevisionDirectory(
        input.configuredDir,
        revisions.rows[0].storage_key,
        input.cmsVersion,
      );
    }
  }
  if (state?.theme_key != null && state.theme_key !== configuredThemeId(input.configuredDir)) {
    return resolveInstalledThemeDirectory(input.configuredDir, state.theme_key, input.cmsVersion);
  }
  return input.configuredDir;
}

function configuredThemeId(configuredDir: string): string {
  try {
    const id = (
      JSON.parse(readFileSync(join(configuredDir, "theme.json"), "utf8")) as { id?: unknown }
    ).id;
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // An unreadable boot seed falls back to its directory name, matching the
    // installed-directory lookup's own id comparison.
  }
  return basename(configuredDir);
}

export interface ActiveMediaPresetsRefresherInput {
  readonly application: ApplicationServices;
  readonly configuredDir: string | undefined;
  readonly cmsVersion?: string;
  readonly onApplied?: (info: {
    readonly dir: string;
    readonly presets: readonly string[];
  }) => void;
  readonly onFallback?: (error: unknown) => void;
}

/**
 * Re-resolves the application's mediaPresets from the ACTIVE theme. The
 * returned refresher is meant to run once at composition and again before
 * each media-touching job (theme activation does not restart workers). A
 * theme.json stat fingerprint catches in-place theme updates; an unchanged
 * pointer costs one SELECT plus one stat. A failed resolution keeps serving
 * the previous preset set and reports through onFallback — silently serving
 * the seed set looks exactly like "the theme declares no presets".
 */
export function createActiveMediaPresetsRefresher(
  input: ActiveMediaPresetsRefresherInput,
): () => Promise<void> {
  let appliedFingerprint: string | null | undefined;
  return async () => {
    if (input.configuredDir === undefined) return;
    try {
      const dir = await resolveActiveThemeDirectory({
        db: input.application.pool,
        siteKey: input.application.defaultSiteKey,
        configuredDir: input.configuredDir,
        ...(input.cmsVersion === undefined ? {} : { cmsVersion: input.cmsVersion }),
      });
      const fingerprint = manifestFingerprint(dir);
      if (appliedFingerprint !== undefined && appliedFingerprint === fingerprint) return;
      input.application.mediaPresets = createMediaPresetRegistry(readThemeManifestPresets(dir));
      appliedFingerprint = fingerprint;
      input.onApplied?.({
        dir,
        presets: input.application.mediaPresets.listPresets().map((preset) => preset.id),
      });
    } catch (error) {
      input.onFallback?.(error);
    }
  };
}

function manifestFingerprint(dir: string): string | null {
  try {
    const stat = statSync(join(dir, "theme.json"));
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}
