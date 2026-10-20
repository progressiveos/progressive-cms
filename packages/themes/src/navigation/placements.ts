// Navigation placement manifest contract (PCMS-THEME-T011; Theme Contract
// spec §22–§24).
//
// The THEME declares placements (id, max_depth, supported item types,
// required, fallback); the application layer hands over resolved navigation
// assignments (Content Tree ≠ Navigation Tree — M04 owns persistence and
// routing, this module owns the theme-side contract only). Validation:
// depth limits, supported item types per placement, required/fallback
// resolution, per-item-type shape rules.

import type { ThemeManifest, ThemeManifestNavigationPlacement } from "../manifest/schema.js";
import type { NavigationItemViewModel } from "../view-models.js";
import { STABLE_ID_PATTERN } from "./patterns.js";

export interface NavigationPlacementContract {
  readonly id: string;
  /** Human-facing name from the theme manifest (falls back to the key). */
  readonly label: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly maxDepth: number;
  readonly supportedItemTypes: readonly string[];
  readonly fallback: string | null;
  readonly supportsMegaMenu: boolean;
}

export interface NavigationAssignment {
  readonly placement: string;
  readonly items: readonly NavigationItemViewModel[];
}

export interface NavigationIssue {
  readonly code:
    | "THEME_PLACEMENT_UNKNOWN"
    | "THEME_PLACEMENT_REQUIRED_MISSING"
    | "THEME_NAV_DEPTH_EXCEEDED"
    | "THEME_NAV_ITEM_TYPE_UNSUPPORTED"
    | "THEME_NAV_ITEM_MALFORMED";
  readonly path: string;
  readonly message: string;
}

/** Fallback hops are bounded to keep resolution deterministic (§22). */
const MAX_FALLBACK_HOPS = 3;

export interface NavigationPlacementRegistry {
  listPlacements(): readonly NavigationPlacementContract[];
  getPlacement(id: string): NavigationPlacementContract | null;
  /**
   * Items for a placement: its own assignment, or — bounded — its
   * fallback's assignment (spec §22 "fallback placement optional").
   */
  resolveItems(
    assignments: readonly NavigationAssignment[],
    placementId: string,
  ): readonly NavigationItemViewModel[] | null;
  /** Full contract validation of assignments against declared placements. */
  validateAssignments(assignments: readonly NavigationAssignment[]): readonly NavigationIssue[];
}

function toContract(entry: ThemeManifestNavigationPlacement): NavigationPlacementContract {
  return {
    id: entry.id,
    label: entry.label ?? entry.id,
    description: entry.description ?? null,
    required: entry.required ?? false,
    maxDepth: entry.max_depth,
    supportedItemTypes: entry.supported_item_types,
    fallback: entry.fallback ?? null,
    supportsMegaMenu: entry.supports_mega_menu ?? false,
  };
}

function itemIssues(
  placement: NavigationPlacementContract,
  item: NavigationItemViewModel,
  path: string,
  depth: number,
  issues: NavigationIssue[],
): void {
  if (depth > placement.maxDepth) {
    issues.push({
      code: "THEME_NAV_DEPTH_EXCEEDED",
      path,
      message: `placement "${placement.id}" allows depth ${placement.maxDepth}, item at depth ${depth}`,
    });
    return;
  }
  if (!placement.supportedItemTypes.includes(item.type)) {
    issues.push({
      code: "THEME_NAV_ITEM_TYPE_UNSUPPORTED",
      path,
      message: `placement "${placement.id}" does not support item type "${item.type}"`,
    });
  }
  switch (item.type) {
    case "internal_entry": {
      if (typeof item.href !== "string" || !item.href.startsWith("/")) {
        issues.push({
          code: "THEME_NAV_ITEM_MALFORMED",
          path,
          message: "internal_entry items need a site-relative resolved href",
        });
      }
      if (typeof item.entry_id !== "string" || !new RegExp(STABLE_ID_PATTERN).test(item.entry_id)) {
        issues.push({
          code: "THEME_NAV_ITEM_MALFORMED",
          path,
          message: "internal_entry items need a canonical stable entry ID",
        });
      }
      break;
    }
    case "external_url": {
      if (typeof item.href !== "string" || !/^https?:\/\//i.test(item.href)) {
        issues.push({
          code: "THEME_NAV_ITEM_MALFORMED",
          path,
          message: "external_url items need an absolute http(s) href",
        });
      }
      break;
    }
    case "anchor": {
      if (typeof item.anchor !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.anchor)) {
        issues.push({
          code: "THEME_NAV_ITEM_MALFORMED",
          path,
          message: "anchor items need a bounded anchor name",
        });
      }
      break;
    }
    default:
      break;
  }
  if ("items" in item && Array.isArray(item.items)) {
    for (const [index, child] of item.items.entries()) {
      itemIssues(placement, child, `${path}/items/${index}`, depth + 1, issues);
    }
  }
}

export function createNavigationPlacementRegistry(
  manifest: ThemeManifest,
): NavigationPlacementRegistry {
  const byId = new Map(manifest.navigation_placements.map((p) => [p.id, toContract(p)]));
  return {
    listPlacements() {
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    getPlacement(id) {
      return byId.get(id) ?? null;
    },
    resolveItems(assignments, placementId) {
      const direct = assignments.find((a) => a.placement === placementId);
      if (direct !== undefined) return direct.items;
      let current = byId.get(placementId) ?? null;
      for (let hop = 0; hop < MAX_FALLBACK_HOPS && current?.fallback; hop += 1) {
        const fallbackAssignment = assignments.find((a) => a.placement === current?.fallback);
        if (fallbackAssignment !== undefined) return fallbackAssignment.items;
        current = current.fallback === null ? null : (byId.get(current.fallback) ?? null);
      }
      return null;
    },
    validateAssignments(assignments) {
      const issues: NavigationIssue[] = [];
      for (const [index, assignment] of assignments.entries()) {
        const placement = byId.get(assignment.placement);
        if (placement === undefined) {
          issues.push({
            code: "THEME_PLACEMENT_UNKNOWN",
            path: `/assignments/${index}`,
            message: `assignment targets undeclared placement "${assignment.placement}"`,
          });
          continue;
        }
        for (const [itemIndex, item] of assignment.items.entries()) {
          itemIssues(placement, item, `/assignments/${index}/items/${itemIndex}`, 1, issues);
        }
      }
      // Required placements must have an assignment or a resolvable fallback.
      for (const placement of byId.values()) {
        if (!placement.required) continue;
        if (this.resolveItems(assignments, placement.id) === null) {
          issues.push({
            code: "THEME_PLACEMENT_REQUIRED_MISSING",
            path: `/placements/${placement.id}`,
            message: `required placement "${placement.id}" has no assignment and no fallback`,
          });
        }
      }
      return issues;
    },
  };
}
