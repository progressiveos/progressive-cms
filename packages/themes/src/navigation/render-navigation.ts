// Reference rendering for navigation placements across presentation contexts
// (PCMS-THEME-T012; Theme Contract spec §23–§24).
//
// CMS Core does not know CSS breakpoint semantics (§23): the theme decides
// which placement renders in which presentation context (e.g.
// header.primary → desktop, header.compact → tablet, header.mobile → mobile)
// and owns the actual media queries. One Navigation Set may be assigned to
// several placements. This helper builds the plain-data template scope:
// every declared placement resolves to its assignment (or a bounded fallback,
// or null) so templates can branch per context.

import type { NavigationPlacementViewModel } from "../view-models.js";
import type { NavigationAssignment, NavigationPlacementRegistry } from "./placements.js";

/**
 * Builds the `nav` template scope: for every placement declared by the
 * theme manifest, the resolved items (own assignment → fallback → null).
 * Templates access it as `nav["header.primary"]` etc.
 */
export function buildNavigationScope(
  registry: Pick<NavigationPlacementRegistry, "listPlacements" | "resolveItems">,
  assignments: readonly NavigationAssignment[],
): Readonly<Record<string, NavigationPlacementViewModel>> {
  const scope: Record<string, NavigationPlacementViewModel> = {};
  for (const placement of registry.listPlacements()) {
    const items = registry.resolveItems(assignments, placement.id);
    scope[placement.id] = {
      placement: placement.id,
      max_depth: placement.maxDepth,
      items: items ?? [],
    };
  }
  return scope;
}
