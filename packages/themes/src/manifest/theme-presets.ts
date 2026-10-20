// Theme-declared media presets for the composition roots (gap #2 of the
// Spangar audit): the Media subsystem generates derivatives only for presets
// it knows, and presets are declared by the ACTIVE THEME (Theme Contract
// spec §28 — "theme declares, media fulfils"). BOTH apps — web and worker —
// feed `manifest.media_presets` into createApplicationServices: the worker
// stages .pcpub media (and anything else that generates variants), so a
// worker without the theme's presets silently produces zero derivatives.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateThemeManifest } from "./schema.js";

export function readThemeManifestPresets(themeDir: string | undefined): readonly unknown[] {
  if (themeDir === undefined) return [];
  const manifestResult = validateThemeManifest(
    JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8")) as unknown,
  );
  if (!manifestResult.ok) return [];
  return manifestResult.value.media_presets;
}
