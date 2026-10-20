// The CMS version the RUNNING CLI belongs to (release root or workspace
// root — the nearest package.json named "progressive-cms"). Themes declaring
// `cms_compatibility` validate against it; without it the check reports
// "site reports unknown" for every honest theme (2026-10-02 site-developer
// report). Undefined only outside a CMS tree — an explicit --cms-version
// covers that case.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function localCmsVersion(): string | undefined {
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 8 && dir !== undefined; depth += 1) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === "progressive-cms" && manifest.version !== "0.0.0") {
          return manifest.version;
        }
      } catch {
        // Unreadable manifest — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
