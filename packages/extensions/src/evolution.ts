// Expand → migrate → contract evolution model (PCMS-EXT-T015, Extensions
// spec §19). This is the required storage/API evolution pattern:
//
//   minor A (expand):  add the new shape; old + new both supported
//   minor B (migrate): run the data migration; deprecate the old shape
//   major  (contract): remove the old shape — only in the promised major
//
// `contract` can never accidentally pass a minor compatibility gate: the
// gate below fails closed unless the release is the promised major (shared
// gate primitive with the deprecation registry, PCMS-EXT-T011).
import { valid as semverValid } from "semver";
import { assertRemovalPolicyCompliant } from "./deprecations.js";
import { ExtensionError } from "./errors.js";

export const EVOLUTION_PHASES = ["expand", "migrate", "contract"] as const;
export type EvolutionPhase = (typeof EVOLUTION_PHASES)[number];

export interface EvolutionMetadata {
  /** Contract/storage item, e.g. "entry.field.summary" or "rest.entries.status". */
  readonly item: string;
  /** Minor version that introduced the new shape (expand). */
  readonly expand_in: string;
  /** Minor version that migrated the data and deprecated the old shape. */
  readonly migrate_in: string | undefined;
  /** Major version where the old shape is removed (contract). */
  readonly contract_in_major: number | undefined;
  /** Deprecation/migration tool for the migrate phase, if any. */
  readonly migration_tool?: string | undefined;
}

/**
 * Classifies which phase the pair (metadata, running version) is in —
 * used by docs, doctor and discovery to state what is supported right now:
 *   before migrate_in              → expand   (old + new supported)
 *   from migrate_in, pre contract  → migrate  (old deprecated, data moved)
 *   from contract major            → contract (old removed)
 */
export function classifyEvolutionPhase(
  metadata: EvolutionMetadata,
  currentVersion: string,
): EvolutionPhase {
  if (!semverValid(currentVersion)) {
    throw new ExtensionError(
      "EXTENSION_MANIFEST_INVALID",
      `"${currentVersion}" is not valid SemVer`,
      { details: { field: "currentVersion" } },
    );
  }
  const major = Number.parseInt(currentVersion.split(".")[0] ?? "0", 10);
  const currentMinor = Number.parseInt(currentVersion.split(".")[1] ?? "0", 10);
  if (metadata.migrate_in === undefined) return "expand";
  const migrateMajor = Number.parseInt(metadata.migrate_in.split(".")[0] ?? "0", 10);
  const migrateMinor = Number.parseInt(metadata.migrate_in.split(".")[1] ?? "0", 10);
  if (major > migrateMajor || (major === migrateMajor && currentMinor >= migrateMinor)) {
    if (metadata.contract_in_major !== undefined && major >= metadata.contract_in_major) {
      return "contract";
    }
    return "migrate";
  }
  return "expand";
}

/**
 * Compatibility gate for a proposed change: `expand` and `migrate` phases
 * are allowed in minor releases; `contract` (removal) only in the promised
 * major — a contract-phase change in any other release fails closed with
 * UPDATE_COMPATIBILITY_BLOCKED.
 */
export function assertEvolutionPhaseAllowed(
  metadata: EvolutionMetadata,
  input: {
    readonly phase: EvolutionPhase;
    /** Version the change lands in. */
    readonly targetVersion: string;
    readonly isMajorRelease: boolean;
  },
): void {
  if (!semverValid(input.targetVersion)) {
    throw new ExtensionError(
      "EXTENSION_MANIFEST_INVALID",
      `"${input.targetVersion}" is not valid SemVer`,
      { details: { field: "targetVersion" } },
    );
  }
  if (input.phase === "expand") return; // additive — always compatible
  if (input.phase === "migrate") return; // dual-run + deprecation — compatible
  // Contract phase = removal; a promised major is mandatory metadata.
  if (metadata.contract_in_major === undefined) {
    throw new ExtensionError(
      "EXTENSION_MANIFEST_INVALID",
      `evolution metadata for "${metadata.item}" declares a contract phase without a promised major`,
      { details: { item: metadata.item } },
    );
  }
  // Reuse the removal-policy gate so the minor compatibility rule lives in
  // exactly one place.
  assertRemovalPolicyCompliant(
    {
      id: `evolution.${metadata.item}`,
      contract: "evolution",
      item: metadata.item,
      deprecated_in: metadata.migrate_in ?? metadata.expand_in,
      planned_removal_major: metadata.contract_in_major,
      status: "active",
    },
    { removalVersion: input.targetVersion, isMajorRelease: input.isMajorRelease },
  );
}
