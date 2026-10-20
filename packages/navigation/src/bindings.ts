// Placement bindings + theme-side depth/type validation (PCMS-NAV-T007;
// Navigation spec §15–§20, Theme Contract §22–§24).
//
// `PlacementDescriptor` is a structural mirror of the theme manifest's
// navigation placement declaration. L1 packages never import each other —
// the composition layer extracts descriptors from `@pcms/themes`
// (`NavigationPlacementRegistry.listPlacements()`) and passes them in as
// plain data. Validation here is a re-check on the Navigation side (depth
// against the materialized tree); the theme-side registry performs the same
// checks on the resolved View Models — defense in depth, shared semantics.
import type { DbPool } from "@pcms/core";
import { NavigationError } from "./errors.js";
import type { NavigationItemNode, NavigationPlacementBinding } from "./model.js";
import type { NavigationService } from "./service.js";

/** Structural mirror of a theme placement declaration (Theme Contract §22). */
export interface PlacementDescriptor {
  readonly id: string;
  /** Human-facing name from the theme manifest (falls back to the key). */
  readonly label: string;
  readonly description: string | null;
  readonly required: boolean;
  /** Rendering capability of the placement — deeper trees are an error, never truncated (§12). */
  readonly maxDepth: number;
  readonly supportedItemTypes: readonly string[];
  /** Alternate placement key whose binding satisfies this placement. */
  readonly fallback: string | null;
}

export interface PlacementBindingIssue {
  readonly code:
    | "NAV_PLACEMENT_UNKNOWN"
    | "NAV_DEPTH_UNSUPPORTED"
    | "NAV_ITEM_TYPE_UNSUPPORTED"
    | "NAV_PLACEMENT_REQUIRED_MISSING"
    | "NAV_OVERRIDE_STALE"
    | "NAV_TARGET_MISSING";
  readonly placement: string;
  /** Tree path or binding subject the issue refers to. */
  readonly path: string;
  readonly message: string;
}

interface BindingRow extends Record<string, unknown> {
  placement_key: string;
  navigation_set_id: string;
  created_at: Date;
}

function toRecord(row: BindingRow | undefined): NavigationPlacementBinding {
  if (row === undefined) {
    throw new NavigationError("NAV_PLACEMENT_KEY_INVALID", `binding row missing`);
  }
  return {
    placementKey: row.placement_key,
    navigationSetId: row.navigation_set_id,
    createdAt: row.created_at,
  };
}

function walkIssues(
  placement: PlacementDescriptor,
  items: readonly NavigationItemNode[],
  path: string,
  depth: number,
  issues: PlacementBindingIssue[],
): void {
  for (const [index, item] of items.entries()) {
    const itemPath = `${path}/items/${index}`;
    if (depth > placement.maxDepth) {
      issues.push({
        code: "NAV_DEPTH_UNSUPPORTED",
        placement: placement.id,
        path: itemPath,
        message: `placement "${placement.id}" renders depth ${placement.maxDepth}, item sits at depth ${depth}`,
      });
    } else if (!placement.supportedItemTypes.includes(item.type)) {
      issues.push({
        code: "NAV_ITEM_TYPE_UNSUPPORTED",
        placement: placement.id,
        path: itemPath,
        message: `placement "${placement.id}" does not support item type "${item.type}"`,
      });
    }
    walkIssues(placement, item.children, itemPath, depth + 1, issues);
  }
}

export interface PlacementBindingService {
  /** Binds a placement key to a set; one set may serve many placements. */
  bindPlacement(input: {
    placementKey: string;
    navigationSetId: string;
  }): Promise<NavigationPlacementBinding>;
  unbindPlacement(placementKey: string): Promise<void>;
  listBindings(): Promise<NavigationPlacementBinding[]>;
  getBinding(placementKey: string): Promise<NavigationPlacementBinding | null>;
  /**
   * Validates all current bindings against the theme's placement
   * descriptors: unknown placements, depth/type capability of the bound
   * (materialized) trees, required placements left without a binding or
   * fallback, stale derived overrides. Shared and independent menus are
   * validated identically — Core does not know which placement is "mobile".
   */
  validateBindings(descriptors: readonly PlacementDescriptor[]): Promise<PlacementBindingIssue[]>;
}

const PLACEMENT_KEY_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;

export function createPlacementBindingService(
  pool: DbPool,
  navigation: NavigationService,
): PlacementBindingService {
  async function getBinding(placementKey: string): Promise<NavigationPlacementBinding | null> {
    const result = await pool.query<BindingRow>(
      `SELECT placement_key, navigation_set_id, created_at FROM navigation_placement_bindings WHERE placement_key = $1`,
      [placementKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  return {
    async bindPlacement({ placementKey, navigationSetId }) {
      if (!PLACEMENT_KEY_PATTERN.test(placementKey)) {
        throw new NavigationError(
          "NAV_PLACEMENT_KEY_INVALID",
          `placement key must match ^[a-z][a-z0-9.-]{0,127}$`,
          {
            details: { placement_key: placementKey },
          },
        );
      }
      await navigation.getSet(navigationSetId);
      // Binding a derived set is legal (derived mobile menu, spec §17);
      // conflicts surface at materialization/validation.
      return pool.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO navigation_placement_bindings (placement_key, navigation_set_id) VALUES ($1, $2)
           ON CONFLICT (placement_key) DO UPDATE SET navigation_set_id = EXCLUDED.navigation_set_id`,
          [placementKey, navigationSetId],
        );
        const row = await tx.query<BindingRow>(
          `SELECT placement_key, navigation_set_id, created_at FROM navigation_placement_bindings WHERE placement_key = $1`,
          [placementKey],
        );
        return toRecord(row.rows[0]);
      });
    },

    async unbindPlacement(placementKey) {
      await pool.query(`DELETE FROM navigation_placement_bindings WHERE placement_key = $1`, [
        placementKey,
      ]);
    },

    async listBindings() {
      const result = await pool.query<BindingRow>(
        `SELECT placement_key, navigation_set_id, created_at FROM navigation_placement_bindings ORDER BY placement_key`,
      );
      return result.rows.map(toRecord);
    },

    getBinding,

    async validateBindings(descriptors) {
      const issues: PlacementBindingIssue[] = [];
      const byId = new Map(descriptors.map((d) => [d.id, d]));
      const bindings = await this.listBindings();
      const boundPlacements = new Set<string>();

      for (const binding of bindings) {
        boundPlacements.add(binding.placementKey);
        const placement = byId.get(binding.placementKey);
        if (placement === undefined) {
          issues.push({
            code: "NAV_PLACEMENT_UNKNOWN",
            placement: binding.placementKey,
            path: `/bindings/${binding.placementKey}`,
            message: `binding targets a placement the theme does not declare`,
          });
          continue;
        }
        let tree: NavigationItemNode[];
        try {
          tree = await navigation.materializeTree(binding.navigationSetId);
        } catch (err) {
          if (err instanceof NavigationError && err.code === "NAV_OVERRIDE_STALE") {
            issues.push({
              code: "NAV_OVERRIDE_STALE",
              placement: binding.placementKey,
              path: `/bindings/${binding.placementKey}`,
              message: `bound derived set has stale overrides`,
            });
            continue;
          }
          throw err;
        }
        walkIssues(placement, tree, `/bindings/${binding.placementKey}`, 1, issues);
      }

      // Required placements need their own binding or a resolvable fallback.
      for (const placement of descriptors) {
        if (!placement.required || boundPlacements.has(placement.id)) continue;
        let satisfied = false;
        let current = placement;
        for (let hop = 0; hop < 3 && current.fallback !== null; hop += 1) {
          if (boundPlacements.has(current.fallback)) {
            satisfied = true;
            break;
          }
          const next = byId.get(current.fallback);
          if (next === undefined) break;
          current = next;
        }
        if (!satisfied) {
          issues.push({
            code: "NAV_PLACEMENT_REQUIRED_MISSING",
            placement: placement.id,
            path: `/placements/${placement.id}`,
            message: `required placement "${placement.id}" has no binding and no resolvable fallback`,
          });
        }
      }
      return issues;
    },
  };
}
