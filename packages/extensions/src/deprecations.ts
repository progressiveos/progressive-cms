// Deprecation registry (PCMS-EXT-T011, Extensions spec §17–§18).
//
// A deprecation is a first-class, machine-readable record: what is
// deprecated, since when, what replaces it, in which major it disappears,
// and how an installation detects its own usage (usage_key feeds the
// compatibility scanner). Persisted/public identities (field IDs, block
// types, template IDs, permission keys, API fields, MCP tools, theme
// settings, capability IDs, extension IDs) can never simply vanish in a
// minor release — the update preflight and contract-diff gate read this
// registry to enforce the removal policy.
import { valid as semverValid } from "semver";
import { ExtensionError } from "./errors.js";

export const DEPRECATION_STATUSES = ["active", "scheduled", "revoked"] as const;
export type DeprecationStatus = (typeof DEPRECATION_STATUSES)[number];

export interface DeprecationRecord {
  /** Stable public identity of the record, e.g. "rest_api.entries.status". */
  readonly id: string;
  /** Contract/subsystem owning the item, e.g. "rest_api", "theme_contract". */
  readonly contract: string;
  /** The deprecated item, e.g. "GET /entries/{id} field status". */
  readonly item: string;
  /** Version the item was introduced in (SemVer). */
  readonly introduced?: string;
  /** Version the deprecation was announced in (SemVer). */
  readonly deprecated_in: string;
  /** Replacement, if one exists. */
  readonly replacement?: string;
  /** Major version where the removal is planned (policy promise). */
  readonly planned_removal_major: number;
  /** Machine tool/migration path that rewrites the usage. */
  readonly migration_tool?: string;
  readonly status: DeprecationStatus;
  /** Detection key the compatibility scanner looks for on real sites. */
  readonly usage_key?: string;
  readonly documentation?: string;
}

const DEPRECATION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,62}(\.[a-z0-9][a-z0-9_-]{0,62}){1,9}$/;

const RECORD_KEYS_MAX = 512;

/** Deterministic validation of a deprecation record; throws on violation. */
function validateRecord(record: DeprecationRecord): void {
  if (!DEPRECATION_ID_PATTERN.test(record.id)) {
    throw new ExtensionError(
      "EXTENSION_MANIFEST_INVALID",
      `deprecation id "${record.id}" is invalid (dotted lowercase identity expected)`,
      { details: { deprecation_id: record.id } },
    );
  }
  if (!semverValid(record.deprecated_in)) {
    throw new ExtensionError(
      "EXTENSION_MANIFEST_INVALID",
      `deprecation "${record.id}" has invalid deprecated_in "${record.deprecated_in}"`,
      { details: { deprecation_id: record.id } },
    );
  }
  if (record.introduced !== undefined && !semverValid(record.introduced)) {
    throw new ExtensionError(
      "EXTENSION_MANIFEST_INVALID",
      `deprecation "${record.id}" has invalid introduced "${record.introduced}"`,
      { details: { deprecation_id: record.id } },
    );
  }
  if (!Number.isInteger(record.planned_removal_major) || record.planned_removal_major < 1) {
    throw new ExtensionError(
      "EXTENSION_MANIFEST_INVALID",
      `deprecation "${record.id}" must plan removal in a positive integer major version`,
      { details: { deprecation_id: record.id } },
    );
  }
  if (record.status === "active" && record.replacement === undefined) {
    throw new ExtensionError(
      "EXTENSION_MANIFEST_INVALID",
      `active deprecation "${record.id}" must name a replacement or a documented exception`,
      { details: { deprecation_id: record.id } },
    );
  }
}

export interface DeprecationRegistry {
  register(record: DeprecationRecord): void;
  get(id: string): DeprecationRecord | undefined;
  /** Deterministic discovery: sorted by id. */
  list(): readonly DeprecationRecord[];
  byContract(contract: string): readonly DeprecationRecord[];
  /** Records a scanner can link to actual usages. */
  activeUsageKeys(): readonly string[];
}

export function createDeprecationRegistry(
  records: readonly DeprecationRecord[] = [],
): DeprecationRegistry {
  const byId = new Map<string, DeprecationRecord>();
  const registry: DeprecationRegistry = {
    register(record) {
      if (byId.size >= RECORD_KEYS_MAX) {
        throw new ExtensionError(
          "EXTENSION_MANIFEST_INVALID",
          "deprecation registry exceeds its bounded size",
        );
      }
      validateRecord(record);
      if (byId.has(record.id)) {
        throw new ExtensionError(
          "EXTENSION_REGISTRATION_CONFLICT",
          `deprecation "${record.id}" already registered`,
          { details: { deprecation_id: record.id } },
        );
      }
      byId.set(record.id, record);
    },
    get(id) {
      return byId.get(id);
    },
    list() {
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    byContract(contract) {
      return registry.list().filter((record) => record.contract === contract);
    },
    activeUsageKeys() {
      return registry
        .list()
        .filter((record) => record.status === "active" && record.usage_key !== undefined)
        .map((record) => record.usage_key as string)
        .sort();
    },
  };
  for (const record of records) registry.register(record);
  return registry;
}

/**
 * Removal policy gate used by the update preflight and the contract-diff
 * CI (minor compatibility). A persisted/public item may only disappear in
 * the major its deprecation record promised. Removing it in a minor — or in
 * an earlier major than announced — fails closed.
 */
export function assertRemovalPolicyCompliant(
  record: DeprecationRecord | undefined,
  input: {
    /** Version where the removal happens. */
    readonly removalVersion: string;
    /** True when the change is a breaking one (major boundary). */
    readonly isMajorRelease: boolean;
  },
): void {
  if (record === undefined) {
    // Undeprecated removal is only ever allowed in a major release.
    if (!input.isMajorRelease) {
      throw new ExtensionError(
        "UPDATE_COMPATIBILITY_BLOCKED",
        "public/persisted item removed in a minor release without any deprecation record",
      );
    }
    return;
  }
  if (!input.isMajorRelease) {
    throw new ExtensionError(
      "UPDATE_COMPATIBILITY_BLOCKED",
      `deprecation "${record.id}" removal attempted in a minor release`,
      {
        details: { deprecation_id: record.id, planned_removal_major: record.planned_removal_major },
      },
    );
  }
  const removalMajor = Number.parseInt(input.removalVersion.split(".")[0] ?? "0", 10);
  if (removalMajor < record.planned_removal_major) {
    throw new ExtensionError(
      "UPDATE_COMPATIBILITY_BLOCKED",
      `deprecation "${record.id}" promised removal in major ${record.planned_removal_major}, attempted in ${removalMajor}`,
      { details: { deprecation_id: record.id } },
    );
  }
}
