// `cms update check` engine (PCMS-EXT-T013, Extensions spec §23).
//
// Read-only preflight of an operator-supplied target release manifest
// against a compatibility snapshot of the actual installation. Pure
// function: it never touches the database, never writes extension state,
// never runs migrations and never downloads anything.
import { coerce, gt, satisfies } from "semver";
import type { CompatibilityIssue, PreflightOutcome } from "./issues.js";
import { preflightOutcome, sortIssues } from "./issues.js";
import type { ReleaseManifestV1 } from "./release-manifest.js";
import type { CompatibilitySnapshot } from "./scanner.js";
import type { ContractVersionKey } from "./versions.js";

export interface UpdatePreflight {
  readonly outcome: PreflightOutcome;
  readonly issues: readonly CompatibilityIssue[];
  readonly current: { readonly version: string };
  readonly target: {
    readonly version: string;
    readonly rollbackPolicy: ReleaseManifestV1["rollback_policy"];
    readonly backupRequired: boolean;
    readonly securityNotes: readonly string[];
    readonly manualSteps: readonly string[];
  };
  readonly plannedCoreMigrations: readonly string[];
  /** Target-listed migrations already in the DB ledger (M17-T005). */
  readonly alreadyAppliedCoreMigrations: readonly string[];
  readonly plannedExtensionMigrations: readonly string[];
  readonly contractChanges: readonly {
    readonly key: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly configChanges: ReleaseManifestV1["config_changes"];
}

/**
 * Compares the current installation snapshot with the target release
 * manifest. Deterministic and fail-closed: any blocking issue means the
 * update must not be applied.
 */
export function checkUpdate(input: {
  readonly snapshot: CompatibilitySnapshot;
  readonly target: ReleaseManifestV1;
}): UpdatePreflight {
  const { snapshot, target } = input;
  const issues: CompatibilityIssue[] = [];

  const currentVersion = snapshot.cms.version;
  if (!gt(target.version, currentVersion)) {
    issues.push({
      code: "UPDATE_NOT_AN_UPGRADE",
      severity: "warning",
      blocking: false,
      category: "update",
      subject: "version",
      message: `target version ${target.version} is not newer than the running ${currentVersion}`,
      remediation: "check that the target manifest is the intended release",
    });
  }

  // Runtime compatibility against the TARGET's ranges (not the current
  // ones): the new release may raise the minimum runtime.
  if (!satisfiesSafe(snapshot.cms.nodeRuntime.current, target.required_runtime.node)) {
    issues.push({
      code: "UPDATE_RUNTIME_INCOMPATIBLE",
      severity: "error",
      blocking: true,
      category: "runtime",
      subject: "node",
      message: `Node.js ${snapshot.cms.nodeRuntime.current} does not satisfy the target range ${target.required_runtime.node}`,
      remediation: "upgrade Node.js to the supported range before applying the update",
    });
  }
  if (!satisfiesSafe(snapshot.cms.postgresRuntime.current, target.required_runtime.postgres)) {
    issues.push({
      code: "UPDATE_DATABASE_INCOMPATIBLE",
      severity: "error",
      blocking: true,
      category: "database",
      subject: "postgres",
      message: `PostgreSQL ${snapshot.cms.postgresRuntime.current} does not satisfy the target range ${target.required_runtime.postgres}`,
      remediation: "perform the PostgreSQL major upgrade as an Operations procedure first",
    });
  }

  // Core migrations the update would apply (M17-T005): the DB LEDGER is
  // compared against the TARGET release's declared inventory — never against
  // the running release's migration files. The pre-M17 computation went
  // through the current tree's pending set and therefore reported
  // `planned_core_migrations: []` whenever the DB had caught up with the
  // running release while the target introduced new migrations.
  const applied = new Set(snapshot.cms.database.appliedMigrations);
  const plannedCore = target.core_db_migrations.filter((name) => !applied.has(name));
  const alreadyAppliedCore = target.core_db_migrations.filter((name) => applied.has(name));
  // Ledger entries the target does not declare: drift or foreign (extension)
  // migrations. Surfaced as a warning — extensions may legitimately own
  // ledger rows — but never silently ignored.
  const targetMigrations = new Set(target.core_db_migrations);
  const unknownToTarget = snapshot.cms.database.appliedMigrations.filter(
    (name) => !targetMigrations.has(name),
  );
  if (unknownToTarget.length > 0) {
    issues.push({
      code: "UPDATE_MIGRATION_FOREIGN_ROWS",
      severity: "warning",
      blocking: false,
      category: "update",
      subject: "database",
      message: `ledger contains ${unknownToTarget.length} migration(s) the target does not declare: ${unknownToTarget.join(", ")}`,
      remediation: "verify these rows are extension-owned or intentionally retired",
    });
  }

  // Extension migrations the update would apply (ADR-0017 R2): a target
  // package whose CONTENT digest differs from the installed artifact gets
  // reconciled on apply (a code-only revision changes the digest, not the
  // manifest); its target migration list minus the installed ledger is the
  // plan. The applier re-validates against the real ledger — this is the
  // honest plan, not the executed set.
  const plannedExtensionMigrations: string[] = [];
  for (const pkg of target.first_party_extensions ?? []) {
    const installed = snapshot.extensions.find((entry) => entry.id === pkg.id && entry.installed);
    if (installed === undefined) continue; // not installed — nothing to migrate
    if (installed.artifactDigest === pkg.content_sha256) continue; // artifact unchanged
    const appliedSet = new Set(installed.migrations?.applied ?? []);
    for (const migration of pkg.migrations) {
      if (!appliedSet.has(migration.name)) {
        plannedExtensionMigrations.push(`${pkg.id}/${migration.name}`);
      }
    }
  }

  // Contract changes: keys present in both with different values.
  const currentContracts = new Map(snapshot.contracts.map((entry) => [entry.key, entry.version]));
  const contractChanges: { key: string; from: string; to: string }[] = [];
  for (const [key, to] of Object.entries(target.contract_versions)) {
    const from = currentContracts.get(key as ContractVersionKey);
    if (from === undefined) continue;
    if (from !== to) contractChanges.push({ key, from, to });
  }

  // Extension compatibility against the target release.
  for (const extension of snapshot.extensions) {
    if (!extension.installed) continue;
    if (
      extension.extensionContractVersion !== undefined &&
      !target.supports_extension_contracts.includes(extension.extensionContractVersion)
    ) {
      issues.push({
        code: "UPDATE_COMPATIBILITY_BLOCKED",
        severity: "error",
        blocking: true,
        category: "contract",
        subject: extension.id,
        location: `extension_contract ${extension.extensionContractVersion}`,
        message: `target release does not support extension contract ${extension.extensionContractVersion} required by "${extension.id}"`,
        remediation: "update the extension to a supported contract before applying this release",
      });
    }
    if (
      extension.cmsCompatibility !== undefined &&
      !satisfies(target.version, extension.cmsCompatibility)
    ) {
      issues.push({
        code: "UPDATE_COMPATIBILITY_BLOCKED",
        severity: "error",
        blocking: true,
        category: "contract",
        subject: extension.id,
        location: `cms_compatibility ${extension.cmsCompatibility}`,
        message: `target Core ${target.version} is outside the supported range ${extension.cmsCompatibility} declared by "${extension.id}"`,
        remediation: "update the extension to a version compatible with the target Core release",
      });
    }
    const targetContracts = target.contract_versions ?? {};
    // Requirements that map onto target contract keys must stay satisfied
    // after the update (capability "theme-contract" ↔ contract key
    // "theme_contract").
    for (const requirement of extension.requires) {
      const contractKey = requirement.capability.replaceAll("-", "_");
      const targetVersion = targetContracts[contractKey];
      if (targetVersion === undefined) continue;
      if (!satisfies(targetVersion, requirement.range)) {
        issues.push({
          code: "UPDATE_COMPATIBILITY_BLOCKED",
          severity: "error",
          blocking: true,
          category: "capability",
          subject: extension.id,
          location: `requires ${requirement.capability}@${requirement.range}`,
          message: `target release provides ${contractKey} ${targetVersion}, which does not satisfy ${requirement.capability}@${requirement.range} required by "${extension.id}"`,
          remediation: "update the extension to a compatible version or skip this release",
        });
      }
    }
  }

  // Theme contract against the target release.
  if (snapshot.theme?.contractVersion !== undefined) {
    const targetTheme = target.contract_versions["theme_contract"];
    if (
      targetTheme !== undefined &&
      !satisfies(snapshot.theme.contractVersion, `^${targetTheme.split(".")[0] ?? "0"}`)
    ) {
      issues.push({
        code: "UPDATE_COMPATIBILITY_BLOCKED",
        severity: "error",
        blocking: true,
        category: "theme",
        subject: "active-theme",
        message: `active theme targets Theme Contract ${snapshot.theme.contractVersion}, incompatible with target ${targetTheme}`,
        remediation: "update the theme before applying this release",
      });
    }
  }

  // Removed deprecated items: a usage detected on the site that the target
  // declares removed is a hard block.
  const usages = new Set((snapshot.content?.deprecatedUsages ?? []).map((usage) => usage.usageKey));
  for (const deprecation of target.deprecations) {
    const removedIn = deprecation.removed_in;
    if (
      deprecation.usage_key !== undefined &&
      usages.has(deprecation.usage_key) &&
      removedIn !== undefined
    ) {
      issues.push({
        code: "UPDATE_COMPATIBILITY_BLOCKED",
        severity: "error",
        blocking: true,
        category: "contract",
        subject: deprecation.usage_key,
        message: `the site uses "${deprecation.usage_key}", which the target release removes in ${removedIn}`,
        remediation: deprecation.replacement ?? "migrate away from the removed item",
      });
      continue;
    }
    issues.push({
      code: "UPDATE_DEPRECATED_ANNOUNCED",
      severity: "warning",
      blocking: false,
      category: "contract",
      subject: deprecation.id,
      message: `the target release deprecates "${deprecation.id}"${removedIn === undefined ? "" : ` (removal in ${removedIn})`}`,
      remediation: deprecation.replacement ?? "plan the migration before the removal major",
    });
  }

  // Config changes: security-relevant removals or required keys without
  // defaults block; the rest surface as warnings.
  for (const change of target.config_changes ?? []) {
    if (change.kind === "removed" && change.security_relevant) {
      issues.push({
        code: "UPDATE_COMPATIBILITY_BLOCKED",
        severity: "error",
        blocking: true,
        category: "config",
        subject: change.key,
        message: `security-relevant config key "${change.key}" is removed in the target release`,
        remediation: change.description ?? "migrate the configuration before updating",
      });
    } else if (change.kind === "added" && change.has_default === false) {
      issues.push({
        code: "UPDATE_CONFIG_REQUIRED",
        severity: "error",
        blocking: true,
        category: "config",
        subject: change.key,
        message: `target release introduces required config key "${change.key}" without a default`,
        remediation: "set the configuration before applying the update",
      });
    } else {
      issues.push({
        code: "UPDATE_CONFIG_CHANGED",
        severity: "warning",
        blocking: false,
        category: "config",
        subject: change.key,
        message: `config change (${change.kind}): ${change.description ?? change.key}`,
        remediation: "review the configuration after the update",
      });
    }
  }

  // Backup gate: surfaced here, enforced by the apply orchestration.
  if (target.backup_required && plannedCore.length > 0) {
    issues.push({
      code: "UPDATE_BACKUP_REQUIRED",
      severity: "warning",
      blocking: false,
      category: "update",
      subject: "backup",
      message: `backup is required before applying ${plannedCore.length} pending core migration(s)`,
      remediation: "run the backup per Operations procedure before update apply",
    });
  }

  const sorted = sortIssues(issues);
  const blocking = sorted.some((entry) => entry.blocking);
  return {
    outcome: preflightOutcome(sorted),
    issues: sorted,
    current: { version: currentVersion },
    target: {
      version: target.version,
      rollbackPolicy: target.rollback_policy,
      backupRequired: target.backup_required,
      securityNotes: target.security_notes,
      manualSteps: target.manual_steps,
    },
    plannedCoreMigrations: plannedCore,
    alreadyAppliedCoreMigrations: alreadyAppliedCore,
    // Extension migrations only apply when a new extension artifact is
    // installed; a CMS update alone replays nothing (deterministic empty).
    plannedExtensionMigrations,
    contractChanges,
    configChanges: target.config_changes ?? [],
  };
}

/** Runtime versions may be partial ("16.9"); coerce before range checks. */
function satisfiesSafe(version: string, range: string): boolean {
  const coerced = coerce(version);
  return coerced !== null && satisfies(coerced, range);
}
