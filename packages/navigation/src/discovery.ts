// Machine-readable navigation discovery (PCMS-NAV-T023; Navigation spec
// §63). The surface agents and transports (API/MCP, M09) consume: plain,
// JSON-serializable answers built only from public application services —
// an agent never guesses the contract from source code or tables.
import type { DbPool } from "@pcms/core";
import { NavigationError } from "./errors.js";
import {
  createNavigationService,
  createPlacementBindingService,
  type NavigationItemNode,
  type NavigationRevisionRecord,
  type NavigationService,
  type NavigationSetRecord,
  type PlacementBindingIssue,
  type PlacementBindingService,
  type PlacementDescriptor,
} from "./index.js";

export interface NavigationDiscovery {
  /** spec §63 list_navigation_sets */
  listNavigationSets(): Promise<
    { id: string; key: string; title: string; derivedFromSetId: string | null }[]
  >;
  /** spec §63 get_navigation_tree — accepts set ID or key. */
  getNavigationTree(setRef: string): Promise<NavigationItemNode[]>;
  /** spec §63 get_navigation_revision */
  getNavigationRevision(setRef: string, revision: number): Promise<NavigationRevisionRecord | null>;
  listNavigationRevisions(setRef: string): Promise<NavigationRevisionRecord[]>;
  /** spec §63 list_placements — as declared by the active theme. */
  listPlacements(): readonly PlacementDescriptor[];
  /** spec §63 get_placement_bindings */
  getPlacementBindings(): Promise<{ placementKey: string; navigationSetId: string }[]>;
  /** spec §63 validate_navigation — bindings + stale override conflicts. */
  validateNavigation(): Promise<{ ok: boolean; issues: readonly PlacementBindingIssue[] }>;
  /** Deterministic full snapshot for contract tests and agent onboarding. */
  describe(): Promise<Record<string, unknown>>;
}

export function createNavigationDiscovery(
  pool: DbPool,
  placementDescriptors: readonly PlacementDescriptor[],
): NavigationDiscovery {
  const navigation: NavigationService = createNavigationService(pool);
  const bindings: PlacementBindingService = createPlacementBindingService(pool, navigation);

  async function resolveSet(setRef: string): Promise<NavigationSetRecord> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(setRef)) {
      return navigation.getSet(setRef);
    }
    const set = await navigation.findSetByKey(setRef);
    if (set === null) {
      throw new NavigationError("NAV_SET_NOT_FOUND", `navigation set not found`, {
        details: { set_ref: setRef },
      });
    }
    return set;
  }

  return {
    async listNavigationSets() {
      const sets = await navigation.listSets();
      return sets.map((s) => ({
        id: s.id,
        key: s.key,
        title: s.title,
        derivedFromSetId: s.derivedFromSetId,
      }));
    },

    async getNavigationTree(setRef) {
      const set = await resolveSet(setRef);
      return navigation.materializeTree(set.id);
    },

    async getNavigationRevision(setRef, revision) {
      const set = await resolveSet(setRef);
      return navigation.getRevision(set.id, revision);
    },

    async listNavigationRevisions(setRef) {
      const set = await resolveSet(setRef);
      return navigation.listRevisions(set.id);
    },

    listPlacements() {
      return [...placementDescriptors];
    },

    async getPlacementBindings() {
      const all = await bindings.listBindings();
      return all.map((b) => ({ placementKey: b.placementKey, navigationSetId: b.navigationSetId }));
    },

    async validateNavigation() {
      const issues = await bindings.validateBindings(placementDescriptors);
      return { ok: issues.length === 0, issues };
    },

    async describe() {
      const sets = await this.listNavigationSets();
      return {
        subsystem: "@pcms/navigation",
        contract: "navigation-v1",
        sets: sets,
        placements: [...placementDescriptors],
        bindings: await this.getPlacementBindings(),
        validation: await this.validateNavigation(),
        itemTypes: ["internal_entry", "external_url", "anchor", "group", "separator", "action"],
      };
    },
  };
}
