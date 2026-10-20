// Controlled registry of versioned-entity adapters (PCMS-PUB-T001).
// Replaces hard-coded `if entity_type === "entry"` dispatch everywhere in the
// subsystem; registration is deterministic and conflict-guarded.
import { RevisionError } from "./errors.js";
import type { VersionedEntityAdapter } from "./types.js";

export interface VersionedEntityRegistry {
  get(entityType: string): VersionedEntityAdapter;
  has(entityType: string): boolean;
  /** Deterministic (sorted by entityType) snapshot for discovery. */
  list(): readonly VersionedEntityAdapter[];
  describe(): readonly { readonly entityType: string; readonly description: string }[];
}

export function createVersionedEntityRegistry(
  adapters: readonly VersionedEntityAdapter[],
): VersionedEntityRegistry {
  const byType = new Map<string, VersionedEntityAdapter>();
  for (const adapter of adapters) {
    if (byType.has(adapter.entityType)) {
      throw new RevisionError(
        "REVISION_ENTITY_CONFLICT",
        `entity adapter "${adapter.entityType}" registered twice`,
      );
    }
    byType.set(adapter.entityType, adapter);
  }
  const sorted = [...byType.values()].sort((a, b) => (a.entityType < b.entityType ? -1 : 1));
  return {
    get(entityType) {
      const adapter = byType.get(entityType);
      if (adapter === undefined) {
        throw new RevisionError(
          "REVISION_ENTITY_UNKNOWN",
          `no versioned-entity adapter registered for "${entityType}"`,
          { details: { entityType } },
        );
      }
      return adapter;
    },
    has: (entityType) => byType.has(entityType),
    list: () => sorted,
    describe: () => sorted.map((a) => ({ entityType: a.entityType, description: a.description })),
  };
}
