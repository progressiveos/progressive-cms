// Compatibility scanner (PCMS-EXT-T012, Extensions spec §27–§30).
//
// Read-only scan of an actual installation. The scanner is a pure function
// over a bounded CompatibilitySnapshot: collection adapters live in the
// composition layer (they know the site's services), the scanner owns the
// checks and the machine-readable issue output. It never mutates anything
// and never loads unbounded data — collectors pass counts, bounded lists and
// a truncation flag instead of full tables.
import { coerce, satisfies } from "semver";
import type { DeprecationRecord } from "./deprecations.js";
import type { CompatibilityIssue, PreflightOutcome } from "./issues.js";
import { preflightOutcome, sortIssues } from "./issues.js";
import type { ExtensionLifecycleState } from "./lifecycle.js";
import type { ContractVersionEntry } from "./versions.js";

export interface RuntimeRange {
  readonly current: string;
  readonly supportedRange: string;
}

export interface ScannedExtension {
  readonly id: string;
  readonly deployed: boolean;
  readonly installed: boolean;
  readonly state: ExtensionLifecycleState | undefined;
  readonly manifestVersion: string;
  readonly extensionContractVersion: string | undefined;
  readonly cmsCompatibility: string | undefined;
  /** undefined when not installed (nothing to compare). */
  readonly fingerprintMatches: boolean | undefined;
  /** Installed artifact content digest (ADR-0017 R2); null = pre-S2 row. */
  readonly artifactDigest: string | null;
  readonly requires: readonly { readonly capability: string; readonly range: string }[];
  readonly provides: readonly { readonly capability: string; readonly version: string }[];
  readonly configIssues: readonly { readonly path: string; readonly message: string }[];
  readonly migrations:
    | {
        readonly applied: readonly string[];
        readonly pending: readonly string[];
        readonly drifted: readonly string[];
      }
    | undefined;
}

export interface CompatibilitySnapshot {
  readonly generatedAt: string;
  readonly cms: {
    readonly version: string;
    readonly nodeRuntime: RuntimeRange;
    readonly postgresRuntime: RuntimeRange;
    readonly database: {
      readonly pendingMigrations: readonly string[];
      readonly driftedMigrations: readonly string[];
      /** Full DB ledger (M17-T005): preflight compares it with the TARGET. */
      readonly appliedMigrations: readonly string[];
    };
  };
  /** Effective contract versions of this build (from the T010 registry). */
  readonly contracts: readonly ContractVersionEntry[];
  readonly theme:
    | {
        readonly contractVersion: string | undefined;
        readonly supportedContractRange: string;
      }
    | undefined;
  readonly extensions: readonly ScannedExtension[];
  /** Effective capability provisions (system + enabled extensions). */
  readonly capabilities: readonly {
    readonly key: string;
    readonly version: string;
    readonly provider: string;
  }[];
  readonly content:
    | {
        readonly blockTypes: readonly {
          readonly type: string;
          readonly version: string | undefined;
          readonly supportedRange: string | undefined;
          /** The version this build's block registry provides, when known. */
          readonly currentVersion: string | undefined;
          readonly usageCount: number;
        }[];
        readonly unknownExtensionNamespaces: readonly string[];
        readonly deprecatedUsages: readonly {
          readonly usageKey: string;
          readonly location: string;
        }[];
        readonly truncated: boolean;
      }
    | undefined;
  readonly deprecations: readonly DeprecationRecord[];
}

export interface CompatibilityReport {
  readonly outcome: PreflightOutcome;
  readonly issues: readonly CompatibilityIssue[];
  readonly generatedAt: string;
}

/**
 * Runtime versions may be partial ("16.9", "v24.21.0"); coerce them into
 * full SemVer before range checks so a PostgreSQL minor like 16.9 is not
 * misjudged as unsupported.
 */
function runtimeSupported(runtime: RuntimeRange): boolean {
  const coerced = coerce(runtime.current);
  return coerced !== null && satisfies(coerced, runtime.supportedRange);
}

const MAX_EXTENSIONS = 512;
const MAX_BLOCK_TYPES = 512;
const MAX_DEPRECATED_USAGES = 512;

/**
 * Runs every compatibility check against the snapshot. Deterministic:
 * identical snapshots produce identical reports; issues are sorted
 * (category, subject, code). Blocking issues mean the installation must
 * not be upgraded without remediation.
 */
export function scanCompatibility(snapshot: CompatibilitySnapshot): CompatibilityReport {
  const issues: CompatibilityIssue[] = [];

  // ---- runtime (Node.js / PostgreSQL supported ranges) ----
  if (!runtimeSupported(snapshot.cms.nodeRuntime)) {
    issues.push({
      code: "COMPAT_RUNTIME_UNSUPPORTED",
      severity: "error",
      blocking: true,
      category: "runtime",
      subject: "node",
      message: `Node.js ${snapshot.cms.nodeRuntime.current} is outside the supported range ${snapshot.cms.nodeRuntime.supportedRange}`,
      remediation: "move the runtime into the supported range before updating",
    });
  }
  if (!runtimeSupported(snapshot.cms.postgresRuntime)) {
    issues.push({
      code: "COMPAT_RUNTIME_UNSUPPORTED",
      severity: "error",
      blocking: true,
      category: "database",
      subject: "postgres",
      message: `PostgreSQL ${snapshot.cms.postgresRuntime.current} is outside the supported range ${snapshot.cms.postgresRuntime.supportedRange}`,
      remediation: "plan the PostgreSQL major upgrade as an Operations procedure",
    });
  }

  // ---- database migration state ----
  if (snapshot.cms.database.driftedMigrations.length > 0) {
    issues.push({
      code: "COMPAT_DB_MIGRATION_DRIFT",
      severity: "error",
      blocking: true,
      category: "database",
      subject: "core",
      location: snapshot.cms.database.driftedMigrations.join(","),
      message: `applied core migrations changed on disk: ${snapshot.cms.database.driftedMigrations.join(", ")}`,
      remediation: "restore the deployed migration files",
    });
  }
  if (snapshot.cms.database.pendingMigrations.length > 0) {
    issues.push({
      code: "COMPAT_DB_MIGRATION_PENDING",
      severity: "warning",
      blocking: false,
      category: "database",
      subject: "core",
      message: `${snapshot.cms.database.pendingMigrations.length} pending core migration(s): ${snapshot.cms.database.pendingMigrations.join(", ")}`,
      remediation: "run cms db migrate during the update window",
    });
  }

  // ---- active theme ----
  if (snapshot.theme !== undefined && snapshot.theme.contractVersion !== undefined) {
    if (!satisfies(snapshot.theme.contractVersion, snapshot.theme.supportedContractRange)) {
      issues.push({
        code: "COMPAT_THEME_CONTRACT_UNSUPPORTED",
        severity: "error",
        blocking: true,
        category: "theme",
        subject: "active-theme",
        message: `active theme targets Theme Contract ${snapshot.theme.contractVersion}, supported range is ${snapshot.theme.supportedContractRange}`,
        remediation: "update the theme to a supported contract version",
      });
    }
  }

  // ---- capability resolution for every extension ----
  const providers = new Map<string, { version: string; provider: string }[]>();
  for (const provision of snapshot.capabilities) {
    const list = providers.get(provision.key) ?? [];
    list.push({ version: provision.version, provider: provision.provider });
    providers.set(provision.key, list);
  }
  const requirementSatisfied = (requirement: {
    capability: string;
    range: string;
  }): "satisfied" | "missing" | "version_mismatch" => {
    const available = providers.get(requirement.capability) ?? [];
    if (available.length === 0) return "missing";
    return available.some((entry) => satisfies(entry.version, requirement.range))
      ? "satisfied"
      : "version_mismatch";
  };

  const enabledIds = new Set(
    snapshot.extensions
      .filter((extension) => extension.state === "ENABLED")
      .map((extension) => extension.id),
  );

  if (snapshot.extensions.length > MAX_EXTENSIONS) {
    issues.push({
      code: "COMPAT_SNAPSHOT_TRUNCATED",
      severity: "warning",
      blocking: false,
      category: "extension",
      subject: "extensions",
      message: `snapshot truncated to ${MAX_EXTENSIONS} extensions`,
    });
  }

  for (const extension of snapshot.extensions.slice(0, MAX_EXTENSIONS)) {
    if (
      extension.installed &&
      extension.cmsCompatibility !== undefined &&
      !satisfies(snapshot.cms.version, extension.cmsCompatibility)
    ) {
      issues.push({
        code: "COMPAT_EXTENSION_CORE_UNSUPPORTED",
        severity: "error",
        blocking: true,
        category: "contract",
        subject: extension.id,
        location: `cms_compatibility ${extension.cmsCompatibility}`,
        message: `Core ${snapshot.cms.version} is outside the supported range ${extension.cmsCompatibility} declared by "${extension.id}"`,
        remediation: "deploy an extension version compatible with this Core release",
      });
    }
    // config validity gates activation
    if (extension.configIssues.length > 0 && extension.state !== undefined) {
      issues.push({
        code: "COMPAT_EXTENSION_CONFIG_INVALID",
        severity: "error",
        blocking: true,
        category: "config",
        subject: extension.id,
        message: `extension config is invalid: ${extension.configIssues
          .map((entry) => `${entry.path}: ${entry.message}`)
          .join("; ")}`,
        remediation: "fix the configuration and reinstall",
      });
    }
    // fingerprint guard
    if (extension.fingerprintMatches === false) {
      issues.push({
        code: "COMPAT_EXTENSION_FINGERPRINT_MISMATCH",
        severity: "error",
        blocking: true,
        category: "extension",
        subject: extension.id,
        message:
          "deployed manifest differs from the installed fingerprint; reinstall the extension",
        remediation: "run install to accept the new manifest",
      });
    }
    // migration state
    if (extension.migrations !== undefined) {
      if (extension.migrations.drifted.length > 0) {
        issues.push({
          code: "COMPAT_EXTENSION_MIGRATION_DRIFT",
          severity: "error",
          blocking: true,
          category: "migration",
          subject: extension.id,
          location: extension.migrations.drifted.join(","),
          message: `applied extension migrations changed on disk: ${extension.migrations.drifted.join(", ")}`,
          remediation: "restore the deployed migration files",
        });
      }
      if (extension.migrations.pending.length > 0) {
        issues.push({
          code: "COMPAT_EXTENSION_MIGRATION_PENDING",
          severity: "warning",
          blocking: false,
          category: "migration",
          subject: extension.id,
          message: `${extension.migrations.pending.length} pending extension migration(s): ${extension.migrations.pending.join(", ")}`,
          remediation: "reinstall the extension to apply pending migrations",
        });
      }
    }
    // capability requirements
    for (const [index, requirement] of extension.requires.entries()) {
      const status = requirementSatisfied(requirement);
      if (status === "missing") {
        issues.push({
          code: "COMPAT_CAPABILITY_MISSING",
          severity: "error",
          blocking: true,
          category: "capability",
          subject: extension.id,
          location: `requires[${index}]`,
          message: `capability "${requirement.capability}" (${requirement.range}) is not provided by any enabled provider`,
          remediation: "install/enable the providing extension or subsystem",
        });
      } else if (status === "version_mismatch") {
        issues.push({
          code: "COMPAT_CAPABILITY_VERSION_MISMATCH",
          severity: "error",
          blocking: true,
          category: "capability",
          subject: extension.id,
          location: `requires[${index}]`,
          message: `capability "${requirement.capability}" available versions do not satisfy ${requirement.range}`,
          remediation: "update the providing extension or the requiring extension",
        });
      } else if (extension.state === "ENABLED") {
        // A disabled provider that is the only satisfier for an enabled
        // extension's requirement means that provider was disabled while a
        // dependent stayed on — surfaced as a hard error.
        const satisfiedBy = (providers.get(requirement.capability) ?? []).filter((entry) =>
          satisfies(entry.version, requirement.range),
        );
        const onlyDisabled = satisfiedBy.every(
          (entry) =>
            snapshot.extensions.find((candidate) => candidate.id === entry.provider) !==
              undefined &&
            !enabledIds.has(entry.provider) &&
            !entry.provider.startsWith("cms:"),
        );
        if (onlyDisabled && satisfiedBy.length > 0) {
          issues.push({
            code: "COMPAT_CAPABILITY_PROVIDER_DISABLED",
            severity: "error",
            blocking: true,
            category: "capability",
            subject: extension.id,
            location: `requires[${index}]`,
            message: `capability "${requirement.capability}" is satisfied only by disabled extension(s): ${satisfiedBy.map((entry) => entry.provider).join(", ")}`,
            remediation: "re-enable the provider extension",
          });
        }
      }
    }
  }

  // ---- content / blocks ----
  if (snapshot.content !== undefined) {
    if (snapshot.content.truncated) {
      issues.push({
        code: "COMPAT_SNAPSHOT_TRUNCATED",
        severity: "warning",
        blocking: false,
        category: "content",
        subject: "content",
        message: "content snapshot was truncated; counts are approximate",
      });
    }
    for (const block of snapshot.content.blockTypes.slice(0, MAX_BLOCK_TYPES)) {
      if (block.version === undefined || block.supportedRange === undefined) continue;
      if (satisfies(block.version, block.supportedRange)) {
        // Older-but-supported versions stay visible as legacy info: the
        // content sits on a version the build still accepts, but not the
        // one the block registry currently provides.
        if (block.currentVersion !== undefined && block.version !== block.currentVersion) {
          issues.push({
            code: "COMPAT_BLOCK_VERSION_LEGACY",
            severity: "info",
            blocking: false,
            category: "content",
            subject: block.type,
            message: `block type used at version ${block.version} (supported: ${block.supportedRange}, current: ${block.currentVersion}, ${block.usageCount} usage(s)) — still supported`,
          });
        }
        continue;
      }
      issues.push({
        code: "COMPAT_BLOCK_VERSION_UNSUPPORTED",
        severity: "error",
        blocking: true,
        category: "content",
        subject: block.type,
        message: `block type "${block.type}" used at version ${block.version} is outside the supported range ${block.supportedRange} (${block.usageCount} usage(s))`,
        remediation: "migrate the content or restore block support before updating",
      });
    }
    for (const namespace of snapshot.content.unknownExtensionNamespaces) {
      issues.push({
        code: "COMPAT_UNKNOWN_EXTENSION_NAMESPACE",
        severity: "info",
        blocking: false,
        category: "content",
        subject: namespace,
        message:
          "content carries an extension namespace no deployed extension provides (preserved untouched)",
        remediation: "deploy the owning extension or accept the preserved payload",
      });
    }
    const usageKeys = new Set(
      snapshot.deprecations
        .filter((record) => record.status === "active")
        .map((record) => record.usage_key)
        .filter((key) => key !== undefined),
    );
    const usageToRecord = new Map(
      snapshot.deprecations
        .filter((record) => record.usage_key !== undefined)
        .map((record) => [record.usage_key as string, record]),
    );
    for (const usage of snapshot.content.deprecatedUsages.slice(0, MAX_DEPRECATED_USAGES)) {
      if (!usageKeys.has(usage.usageKey)) continue;
      const record = usageToRecord.get(usage.usageKey);
      issues.push({
        code: "COMPAT_DEPRECATED_USAGE",
        severity: "warning",
        blocking: false,
        category: "contract",
        subject: usage.usageKey,
        location: usage.location,
        message: `deprecated usage${record === undefined ? "" : ` (removal planned in major ${record.planned_removal_major})`}${record?.replacement === undefined ? "" : ` — replace with ${record.replacement}`}`,
        remediation: record?.migration_tool ?? "migrate to the replacement",
      });
    }
  }

  // ---- deprecated-but-supported contracts of this build ----
  for (const record of snapshot.deprecations) {
    if (record.status !== "active") continue;
    issues.push({
      code: "COMPAT_CONTRACT_DEPRECATED",
      severity: "info",
      blocking: false,
      category: "contract",
      subject: record.id,
      message: `${record.item} is deprecated since ${record.deprecated_in}; removal planned in major ${record.planned_removal_major}`,
      remediation: record.replacement ?? "plan the migration",
    });
  }

  const sorted = sortIssues(issues);
  return { outcome: preflightOutcome(sorted), issues: sorted, generatedAt: snapshot.generatedAt };
}
