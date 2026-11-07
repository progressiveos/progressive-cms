import { gt, satisfies } from "semver";
import { validateExtensionConfig } from "./config.js";
import type { ExtensionJobRegistration } from "./manifest.js";
import type { CompatibilityIssue } from "./issues.js";
import type { VerifiedExtensionPackage } from "./package-delivery.js";
import type { ReleaseManifestV1 } from "./release-manifest.js";
import type { UpdatePreflight } from "./update-check.js";

/** Product-specific planning feeds the existing update orchestrator and backup gate. */
export function planIndependentExtensionUpdate(input: {
  readonly target: Omit<VerifiedExtensionPackage, "directory">;
  readonly currentVersion: string | null;
  readonly currentDigest: string | null;
  readonly currentPermissions: readonly string[];
  readonly currentConfig?: Record<string, unknown>;
  readonly currentEnabled?: boolean;
  readonly currentJobs?: readonly ExtensionJobRegistration[];
  readonly enabledExtensions?: readonly {
    readonly id: string;
    readonly requires: readonly { readonly capability: string; readonly range: string }[];
  }[];
  readonly approvedPermissions: readonly string[];
  readonly capabilities: readonly {
    readonly key: string;
    readonly version: string;
    readonly provider?: string;
  }[];
  readonly appliedMigrations: readonly { readonly name: string; readonly checksum: string }[];
  readonly queuedJobs: readonly { readonly jobId: string; readonly payloadVersion: number }[];
  readonly coreVersion: string;
}): {
  readonly preflight: UpdatePreflight;
  readonly target: ReleaseManifestV1;
  readonly noOp: boolean;
  readonly newPermissions: readonly string[];
} {
  const pkg = input.target;
  const issues: CompatibilityIssue[] = [];
  const block = (code: string, message: string): void => {
    issues.push({
      code,
      severity: "error",
      blocking: true,
      category: "update",
      subject: pkg.manifest.id,
      message,
      remediation: "select a compatible trusted package or resolve the reported prerequisite",
    });
  };
  if (!satisfies(input.coreVersion, pkg.manifest.cms_compatibility, { includePrerelease: true }))
    block("EXTENSION_CMS_INCOMPATIBLE", "package does not support the installed Core");
  const config = validateExtensionConfig({
    extensionId: pkg.manifest.id,
    config: input.currentConfig ?? {},
    schema: pkg.manifest.config_schema,
  });
  if (!config.ok)
    block(
      "EXTENSION_CONFIG_INVALID",
      `preserved configuration is incompatible: ${config.issues.map((issue) => issue.path).join(", ")}`,
    );
  const capabilities = input.currentEnabled
    ? [
        ...input.capabilities.filter((capability) => capability.provider !== pkg.manifest.id),
        ...pkg.manifest.provides.map((capability) => ({
          key: capability.capability,
          version: capability.version,
          provider: pkg.manifest.id,
        })),
      ]
    : input.capabilities;
  for (const extension of input.enabledExtensions ?? []) {
    if (extension.id === pkg.manifest.id) continue;
    for (const requirement of extension.requires)
      if (
        !capabilities.some(
          (capability) =>
            capability.key === requirement.capability &&
            satisfies(capability.version, requirement.range, { includePrerelease: true }),
        )
      )
        block(
          "EXTENSION_DEPENDENT_INCOMPATIBLE",
          `enabled extension ${extension.id} requires ${requirement.capability}@${requirement.range}`,
        );
  }
  if (input.currentEnabled)
    for (const provision of pkg.manifest.provides)
      if (
        input.capabilities.some(
          (capability) =>
            capability.key === provision.capability && capability.provider !== pkg.manifest.id,
        )
      )
        block(
          "EXTENSION_CAPABILITY_CONFLICT",
          `capability ${provision.capability} already has another provider`,
        );
  const noOp = input.currentDigest === pkg.digest && input.currentVersion === pkg.manifest.version;
  if (!noOp && input.currentVersion !== null && !gt(pkg.manifest.version, input.currentVersion))
    block(
      "UPDATE_NOT_AN_UPGRADE",
      "extension target must be strictly newer; same-version changed bytes and downgrades are forbidden",
    );
  for (const required of pkg.manifest.requires) {
    if (
      !capabilities.some(
        (capability) =>
          capability.key === required.capability &&
          satisfies(capability.version, required.range, { includePrerelease: true }),
      )
    )
      block(
        "EXTENSION_CAPABILITY_UNSATISFIED",
        `missing capability ${required.capability}@${required.range}`,
      );
  }
  for (const permission of pkg.manifest.permissions) {
    if (
      !input.currentPermissions.includes(permission) &&
      !input.approvedPermissions.includes(permission)
    )
      block(
        "EXTENSION_PRIVILEGE_APPROVAL_REQUIRED",
        `explicit approval required for ${permission}`,
      );
  }
  if (pkg.manifest.migrations) {
    const prefix = `${pkg.manifest.migrations.dir}/`;
    for (const path of Object.keys(pkg.descriptor.files).filter((path) =>
      path.startsWith(prefix),
    )) {
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(path.slice(prefix.length)))
        block("EXTENSION_MIGRATION_LAYOUT_INVALID", `unsupported migration layout: ${path}`);
    }
  }
  const targetMigrations = Object.entries(pkg.descriptor.files)
    .filter(
      ([path]) =>
        pkg.manifest.migrations &&
        path.startsWith(`${pkg.manifest.migrations.dir}/`) &&
        path.endsWith(".sql"),
    )
    .map(([path, checksum]) => ({
      name:
        path
          .split("/")
          .at(-1)
          ?.replace(/\.sql$/, "") ?? "",
      checksum,
    }));
  for (const applied of input.appliedMigrations) {
    if (
      !targetMigrations.some(
        (migration) => migration.name === applied.name && migration.checksum === applied.checksum,
      )
    )
      block(
        "EXTENSION_MIGRATION_DRIFT",
        `target changes or omits applied migration ${applied.name}`,
      );
  }
  for (const queued of input.queuedJobs) {
    const job = pkg.manifest.registrations.jobs.find((job) => job.job_id === queued.jobId);
    if (
      !job ||
      (job.payload_version !== queued.payloadVersion &&
        !job.accepts_payload_versions?.includes(queued.payloadVersion))
    )
      block(
        "EXTENSION_JOB_PAYLOAD_INCOMPATIBLE",
        `queued job ${queued.jobId}@${queued.payloadVersion} would become unreadable`,
      );
  }
  const pending = targetMigrations.filter(
    (migration) => !input.appliedMigrations.some((applied) => applied.name === migration.name),
  );
  const incompatibleRollbackJobs = pkg.manifest.registrations.jobs.some((job) => {
    const old = input.currentJobs?.find((candidate) => candidate.job_id === job.job_id);
    return (
      !old ||
      (old.payload_version !== job.payload_version &&
        !old.accepts_payload_versions?.includes(job.payload_version))
    );
  });
  const rollback =
    pending.length > 0 || input.currentVersion === null || incompatibleRollbackJobs
      ? "restore_required"
      : "rollback_safe";
  const target: ReleaseManifestV1 = {
    manifest_version: "1",
    version: pkg.manifest.version,
    required_runtime: { node: ">=24.21 <25", postgres: ">=14 <19" },
    core_db_migrations: [],
    supports_extension_contracts: [pkg.manifest.extension_contract],
    contract_versions: {},
    deprecations: [],
    security_notes: [],
    manual_steps: [],
    backup_required: true,
    rollback_policy: rollback,
    config_changes: [],
  };
  return {
    noOp,
    newPermissions: pkg.manifest.permissions.filter(
      (permission) => !input.currentPermissions.includes(permission),
    ),
    target,
    preflight: {
      outcome: issues.length ? "BLOCKED" : "READY",
      issues,
      current: { version: input.currentVersion ?? "0.0.0" },
      target: {
        version: pkg.manifest.version,
        rollbackPolicy: rollback,
        backupRequired: true,
        securityNotes: [],
        manualSteps: [],
      },
      plannedCoreMigrations: [],
      alreadyAppliedCoreMigrations: [],
      plannedExtensionMigrations: pending.map(
        (migration) => `${pkg.manifest.id}/${migration.name}`,
      ),
      contractChanges: [],
      configChanges: [],
      product: {
        kind: "extension",
        id: pkg.manifest.id,
        digest: pkg.digest,
        coreVersion: input.coreVersion,
      },
    },
  };
}
