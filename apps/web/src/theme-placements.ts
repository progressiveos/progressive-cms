// Theme navigation placement descriptors for the navigation subsystem
// (PCMS-ADMIN-T013). The theme manifest is the source of truth for which
// placements exist; the Admin placements UI and binding validation consume
// them as plain data (M03 manifest contract, snake_case on the wire).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlacementDescriptor } from "@pcms/navigation";

interface ManifestPlacement {
  readonly id: string;
  readonly label?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly max_depth: number;
  readonly supported_item_types: readonly string[];
  readonly fallback?: string | null;
}

export function loadThemePlacements(themeDir: string): PlacementDescriptor[] {
  let manifest: { navigation_placements?: readonly ManifestPlacement[] };
  try {
    manifest = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8")) as {
      navigation_placements?: readonly ManifestPlacement[];
    };
  } catch {
    return [];
  }
  return (manifest.navigation_placements ?? []).map((placement) => ({
    id: placement.id,
    label: placement.label ?? placement.id,
    description: placement.description ?? null,
    required: placement.required === true,
    maxDepth: placement.max_depth,
    supportedItemTypes: placement.supported_item_types,
    fallback: placement.fallback ?? null,
  }));
}
