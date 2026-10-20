// Extension lifecycle service (PCMS-EXT-T006/T007, Extensions spec §12–§13).
//
// Four clearly separated notions (task brief §6):
//   DEPLOYED  — the artifact is in the trusted catalog (composition-time)
//   INSTALLED — the manifest is accepted, config/migration state registered
//   ENABLED   — registrations participate in application composition
//   DISABLED  — installed and data preserved, registrations inactive
//
// Every operation runs a machine-readable preflight first; blocking issues
// stop the operation with a stable error. Authorization and audit are
// application-layer concerns: the service exposes a structural audit port.
import type { DbClient, DbPool } from "@pcms/core";
import { satisfies } from "semver";
import {
  assertCapabilitiesSatisfied,
  type CapabilityRegistry,
  createCapabilityRegistry,
} from "./capabilities.js";
import {
  type DeployedExtensionArtifact,
  type ExtensionCatalog,
  manifestFingerprint,
} from "./catalog.js";
import { validateExtensionConfig } from "./config.js";
import { ExtensionError } from "./errors.js";
import {
  blockingIssues,
  type CompatibilityIssue,
  type PreflightOutcome,
  sortIssues,
} from "./issues.js";
import type { ExtensionManifest } from "./manifest.js";
import {
  applyExtensionMigrations,
  type ExtensionMigrationStatus,
  extensionMigrationStatus,
  loadMigrations,
} from "./migrations.js";
import type { ExtensionTransactionContext } from "./platform.js";

export const INSTALLATIONS_TABLE = "pcms_extension_installations";

export type ExtensionLifecycleState = "INSTALLED" | "ENABLED" | "DISABLED";

export interface ExtensionInstallation {
  readonly extensionId: string;
  readonly version: string;
  readonly state: ExtensionLifecycleState;
  readonly manifestFingerprint: string;
  /** Content digest of the deployed package (ADR-0017 R2); null = pre-S2 row. */
  readonly artifactDigest: string | null;
  readonly config: Record<string, unknown>;
  readonly installedAt: Date;
  readonly updatedAt: Date;
}

interface InstallationRow {
  extension_id: string;
  version: string;
  state: ExtensionLifecycleState;
  manifest_fingerprint: string;
  artifact_digest: string | null;
  config: unknown;
  installed_at: Date;
  updated_at: Date;
  [column: string]: unknown;
}

/** Structural audit port — composition binds this to the audit channel. */
export interface ExtensionLifecycleAuditEvent {
  readonly operation: "install" | "enable" | "disable" | "uninstall";
  readonly extensionId: string;
  readonly fromVersion: string | undefined;
  readonly toVersion: string;
  readonly outcome: "ok" | "blocked" | "failed";
  readonly at: Date;
}

export interface ExtensionLifecycleServiceOptions {
  readonly pool: DbPool;
  readonly clock: { now(): Date };
  readonly coreVersion: string;
  /** Trusted deployed artifacts (composition-time). */
  readonly catalog: ExtensionCatalog;
  /** System-provided capabilities (cms:core, cms:themes, …), preloaded. */
  readonly systemCapabilities: CapabilityRegistry;
  /** Audit sink; composition binds the platform audit channel here. */
  readonly audit?: undefined | ((event: ExtensionLifecycleAuditEvent) => Promise<void>);
}

function registryWithEnabled(
  base: CapabilityRegistry,
  catalog: ExtensionCatalog,
  enabled: readonly ExtensionInstallation[],
): CapabilityRegistry {
  const merged = createCapabilityRegistry();
  for (const provision of base.list()) merged.provide(provision);
  for (const installation of enabled) {
    const artifact = catalog.get(installation.extensionId);
    if (artifact === undefined) continue;
    for (const provision of artifact.manifest.provides) {
      merged.provide({
        key: provision.capability,
        version: provision.version,
        provider: installation.extensionId,
      });
    }
  }
  return merged;
}

function installedRowToInstallation(row: InstallationRow): ExtensionInstallation {
  return {
    extensionId: row.extension_id,
    version: row.version,
    state: row.state,
    manifestFingerprint: row.manifest_fingerprint,
    artifactDigest: row.artifact_digest,
    config: (row.config ?? {}) as Record<string, unknown>,
    installedAt: new Date(row.installed_at),
    updatedAt: new Date(row.updated_at),
  };
}

export interface LifecyclePreflight {
  readonly outcome: PreflightOutcome;
  readonly issues: readonly CompatibilityIssue[];
  /** Pending extension migrations surfaced by the preflight (install/enable). */
  readonly pendingMigrations: readonly string[];
  /** Impacted enabled extensions (disable preflight). */
  readonly impactedExtensions: readonly string[];
}

export interface ExtensionLifecycleService {
  // discovery
  listDeployed(): readonly ExtensionManifest[];
  getDeployed(extensionId: string): ExtensionManifest | undefined;
  listInstallations(): Promise<readonly ExtensionInstallation[]>;
  getInstallation(extensionId: string): Promise<ExtensionInstallation | undefined>;

  // preflights (read-only)
  installPreflight(
    extensionId: string,
    config: Record<string, unknown>,
  ): Promise<LifecyclePreflight>;
  enablePreflight(extensionId: string): Promise<LifecyclePreflight>;
  disablePreflight(extensionId: string): Promise<LifecyclePreflight>;
  uninstallPreflight(extensionId: string, confirmation?: string): Promise<LifecyclePreflight>;

  // operations
  install(input: {
    readonly extensionId: string;
    readonly config: Record<string, unknown>;
  }): Promise<{
    readonly installation: ExtensionInstallation;
    readonly appliedMigrations: readonly string[];
  }>;
  enable(extensionId: string): Promise<{ readonly installation: ExtensionInstallation }>;
  disable(extensionId: string): Promise<{ readonly installation: ExtensionInstallation }>;
  uninstall(input: {
    readonly extensionId: string;
    /** Required verbatim for destructive data policies. */
    readonly confirmation?: string;
  }): Promise<{
    readonly installation: ExtensionInstallation | undefined;
    readonly dataPolicy: "retain" | "archive" | "drop";
  }>;

  /** Migrations of one installed extension as deployed (compat scanner input). */
  migrationStatus(extensionId: string): Promise<ExtensionMigrationStatus | undefined>;

  /** Enabled extension ids (registration composition input), sorted. */
  enabledIds(): Promise<string[]>;

  /**
   * Authoritative lifecycle revision (ADR-0017 R3): bumped in the same
   * transaction as every mutation. Processes re-check it before executing
   * extension operations / dispatching subscriptions — fail-closed
   * inter-process revoke does not rely on local cache invalidation.
   */
  revision(): Promise<string>;

  /**
   * Release-update reconcile (ADR-0017 R2): the running code IS the target
   * artifact (trusted build-time composition), so bring every installed
   * row's identity to the deployed artifact — apply pending migrations
   * (ledger is skip-applied/idempotent) and stamp version/fingerprint/digest.
   * Lifecycle STATE (ENABLED/DISABLED) and config never change here; a
   * package that left the composition keeps its row (history recoverable).
   * A code-only revision (manifest unchanged) is caught by the digest.
   */
  reconcileIdentity(): Promise<
    readonly { readonly extensionId: string; readonly appliedMigrations: readonly string[] }[]
  >;
}

export function createExtensionLifecycleService(
  options: ExtensionLifecycleServiceOptions,
): ExtensionLifecycleService {
  const { pool, clock, catalog, systemCapabilities } = options;

  const audit = async (event: ExtensionLifecycleAuditEvent): Promise<void> => {
    if (options.audit === undefined) return;
    await options.audit(event);
  };

  const listInstallations = async (): Promise<readonly ExtensionInstallation[]> => {
    const result = await pool.query<InstallationRow>(
      `SELECT extension_id, version, state, manifest_fingerprint, artifact_digest, config, installed_at, updated_at
       FROM ${INSTALLATIONS_TABLE} ORDER BY extension_id`,
    );
    return result.rows.map(installedRowToInstallation);
  };

  const getInstallation = async (
    extensionId: string,
  ): Promise<ExtensionInstallation | undefined> => {
    const result = await pool.query<InstallationRow>(
      `SELECT extension_id, version, state, manifest_fingerprint, artifact_digest, config, installed_at, updated_at
       FROM ${INSTALLATIONS_TABLE} WHERE extension_id = $1`,
      [extensionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : installedRowToInstallation(row);
  };

  /** Fails closed unless the extension is deployed; returns its manifest. */
  const requireDeployed = (extensionId: string): ExtensionManifest => {
    const artifact = catalog.get(extensionId);
    if (artifact === undefined) {
      throw new ExtensionError(
        "EXTENSION_NOT_DEPLOYED",
        `extension "${extensionId}" is not present in the trusted deployment catalog`,
        { details: { extension_id: extensionId } },
      );
    }
    return artifact.manifest;
  };

  const migrationsOf = (extensionId: string) => {
    const artifact = catalog.get(extensionId);
    if (artifact === undefined) {
      throw new ExtensionError(
        "EXTENSION_NOT_DEPLOYED",
        `extension "${extensionId}" is not present in the trusted deployment catalog`,
        { details: { extension_id: extensionId } },
      );
    }
    return {
      artifact,
      migrations:
        artifact.migrationsDir === undefined ? [] : loadMigrations(artifact.migrationsDir),
    };
  };

  /**
   * Shared manifest/config/capability/migration checks. Capability and
   * provider-conflict problems gate activation (enable) — installation
   * only registers state, so there they surface as non-blocking warnings.
   */
  const activationIssues = async (
    manifest: ExtensionManifest,
    config: Record<string, unknown>,
    enabledExcluding: string | undefined,
    phase: "install" | "enable",
  ): Promise<CompatibilityIssue[]> => {
    const issues: CompatibilityIssue[] = [];
    const configCheck = validateExtensionConfig({
      extensionId: manifest.id,
      config,
      schema: manifest.config_schema,
    });
    if (!configCheck.ok) {
      issues.push({
        code: "EXTENSION_CONFIG_INVALID",
        severity: "error",
        blocking: true,
        category: "config",
        subject: manifest.id,
        message: `extension config is invalid: ${configCheck.issues.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`,
        remediation: "fix the extension configuration and retry",
      });
    }
    if (!satisfies(options.coreVersion, manifest.cms_compatibility)) {
      issues.push({
        code: "EXTENSION_CORE_INCOMPATIBLE",
        severity: "error",
        blocking: true,
        category: "contract",
        subject: manifest.id,
        location: `cms_compatibility ${manifest.cms_compatibility}`,
        message: `extension "${manifest.id}" supports Core ${manifest.cms_compatibility}, running Core is ${options.coreVersion}`,
        remediation: "deploy an extension version compatible with this Core release",
      });
    }
    // Capability satisfaction against system + enabled extensions.
    const installations = await listInstallations();
    const enabled = installations.filter(
      (entry) =>
        entry.state === "ENABLED" &&
        (enabledExcluding === undefined || entry.extensionId !== enabledExcluding),
    );
    const effective = registryWithEnabled(systemCapabilities, catalog, enabled);
    try {
      assertCapabilitiesSatisfied(effective, manifest.requires, manifest.id);
    } catch (error) {
      if (error instanceof ExtensionError && error.code === "EXTENSION_DEPENDENCY_UNSATISFIED") {
        issues.push({
          code: "EXTENSION_DEPENDENCY_UNSATISFIED",
          severity: "error",
          blocking: phase === "enable",
          category: "capability",
          subject: manifest.id,
          message: error.message,
          remediation: "enable or install the required capability providers first",
        });
      } else {
        throw error;
      }
    }
    // Provider conflicts: a single-provider capability already owned by
    // another provider must not be silently overridden.
    for (const provision of manifest.provides) {
      const foreign = effective
        .providers(provision.capability)
        .filter((entry) => entry.provider !== manifest.id);
      const conflicting = foreign.find((entry) => !entry.multi);
      if (conflicting !== undefined) {
        issues.push({
          code: "EXTENSION_CAPABILITY_CONFLICT",
          severity: "error",
          blocking: phase === "enable",
          category: "capability",
          subject: provision.capability,
          message: `capability "${provision.capability}" is already provided by "${conflicting.provider}" and is not multi-provider`,
          remediation: "disable the conflicting provider or make the capability multi-provider",
        });
      }
    }
    return issues;
  };

  const migrationIssues = async (
    extensionId: string,
    pendingMigrations: string[],
  ): Promise<CompatibilityIssue[]> => {
    const issues: CompatibilityIssue[] = [];
    const { migrations } = migrationsOf(extensionId);
    if (migrations.length > 0) {
      const status = await extensionMigrationStatus(pool, extensionId, migrations);
      if (status.drifted.length > 0) {
        issues.push({
          code: "EXTENSION_MIGRATION_DRIFT",
          severity: "error",
          blocking: true,
          category: "migration",
          subject: extensionId,
          location: status.drifted.join(","),
          message: `applied migrations changed on disk: ${status.drifted.join(", ")}`,
          remediation: "restore the deployed migration files or correct the ledger",
        });
      }
      pendingMigrations.push(...status.pending);
    }
    return issues;
  };

  /**
   * D07 — lifecycle obligations guard. Runs inside a transaction that already
   * holds (or tries to take) the advisory lock for each declared obligation,
   * so a concurrent business transaction creating an obligation serializes
   * with the lifecycle change. Fail-closed: if the lock cannot be taken or
   * the handler is missing/unreliable, the extension is NOT disabled.
   */
  async function obligationIssues(
    extensionId: string,
    artifact: DeployedExtensionArtifact,
    client: DbClient,
  ): Promise<{ blocked: boolean; issues: CompatibilityIssue[] }> {
    const obligations = artifact.manifest.registrations.obligations ?? [];
    const issues: CompatibilityIssue[] = [];
    for (const obligation of obligations) {
      // Transaction-level advisory lock: released automatically on commit/
      // rollback. A business operation creating an obligation holds the same
      // lock in its transaction, so the two cannot overlap — no race window.
      const locked = await client.query<{ ok: number }>(
        `SELECT pg_try_advisory_xact_lock($1::bigint) AS ok`,
        [obligation.lock_key],
      );
      if (!locked.rows[0]?.ok) {
        issues.push({
          code: "EXTENSION_OBLIGATION_CHECK_UNAVAILABLE",
          severity: "error",
          blocking: true,
          category: "database",
          subject: extensionId,
          location: `obligation ${obligation.obligation_id}`,
          message: `could not acquire the obligation lock for "${obligation.obligation_id}"; a concurrent business operation may be creating an obligation`,
          remediation: "retry the disable/uninstall after the concurrent operation completes",
        });
        continue;
      }
      const handler = (artifact.module as Record<string, unknown>)[obligation.count_handler] as
        | ((tx: ExtensionTransactionContext) => Promise<number>)
        | undefined;
      if (typeof handler !== "function") {
        issues.push({
          code: "EXTENSION_HANDLER_UNRESOLVED",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          location: `obligation ${obligation.obligation_id}.count_handler`,
          message: `obligation handler "${obligation.count_handler}" is not a named function export of the deployed module`,
          remediation: "deploy an extension version with the declared obligation handler",
        });
        continue;
      }
      const tx: ExtensionTransactionContext = {
        query: (sql, params) => client.query(sql, params),
        audit: () => {},
        outbox: { append: () => {} },
      };
      let reported: unknown;
      try {
        reported = await handler(tx);
      } catch (error) {
        issues.push({
          code: "EXTENSION_OBLIGATION_CHECK_FAILED",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          location: `obligation ${obligation.obligation_id}.count_handler`,
          message: `obligation handler "${obligation.count_handler}" failed: ${error instanceof Error ? error.message : String(error)}`,
          remediation: "fix the obligation handler; do not disable until it can report reliably",
        });
        continue;
      }
      // Fail closed on anything that is not a real non-negative integer: a
      // handler returning undefined/NaN/negative/Infinity/a string cannot
      // prove the obligation set is empty, so it must not authorize disable.
      if (typeof reported !== "number" || !Number.isInteger(reported) || reported < 0) {
        issues.push({
          code: "EXTENSION_OBLIGATION_CHECK_INVALID",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          location: `obligation ${obligation.obligation_id}.count_handler`,
          message: `obligation handler "${obligation.count_handler}" returned ${String(reported)}; a non-negative integer count is required`,
          remediation: "fix the obligation handler to return the outstanding count as an integer",
        });
        continue;
      }
      const count = reported;
      if (count > 0) {
        issues.push({
          code: "EXTENSION_OBLIGATIONS_OUTSTANDING",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          location: `obligation ${obligation.obligation_id}`,
          message: `extension "${extensionId}" has ${count} outstanding obligation(s); disable/uninstall is blocked`,
          remediation: "fulfill or cancel outstanding obligations before disabling",
        });
      }
    }
    return { blocked: issues.some((i) => i.blocking), issues };
  }

  const preflight = (
    issues: readonly CompatibilityIssue[],
    extra: Partial<Pick<LifecyclePreflight, "pendingMigrations" | "impactedExtensions">> = {},
  ): LifecyclePreflight => {
    const sorted = sortIssues(issues);
    const hasBlocking = blockingIssues(sorted).length > 0;
    return {
      outcome: hasBlocking ? "BLOCKED" : sorted.length > 0 ? "READY_WITH_WARNINGS" : "READY",
      issues: sorted,
      pendingMigrations: extra.pendingMigrations ?? [],
      impactedExtensions: extra.impactedExtensions ?? [],
    };
  };

  const configIssues = (
    manifest: ExtensionManifest,
    config: Record<string, unknown>,
  ): CompatibilityIssue[] => {
    const check = validateExtensionConfig({
      extensionId: manifest.id,
      config,
      schema: manifest.config_schema,
    });
    if (check.ok) return [];
    return [
      {
        code: "EXTENSION_CONFIG_INVALID",
        severity: "error",
        blocking: true,
        category: "config",
        subject: manifest.id,
        message: `extension config is invalid: ${check.issues.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`,
        remediation: "fix the extension configuration and retry",
      },
    ];
  };

  const saveState = async (
    extensionId: string,
    state: ExtensionLifecycleState,
    expectedPrevious: readonly ExtensionLifecycleState[],
  ): Promise<ExtensionInstallation> => {
    const updated = await pool.withTransaction(async (client) => {
      const result = await client.query<InstallationRow>(
        `UPDATE ${INSTALLATIONS_TABLE}
         SET state = $2, updated_at = $3
         WHERE extension_id = $1 AND state = ANY($4)
         RETURNING extension_id, version, state, manifest_fingerprint, artifact_digest, config, installed_at, updated_at`,
        [extensionId, state, clock.now(), expectedPrevious],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      // R3: the authoritative lifecycle revision moves in the same tx.
      await client.query(
        `UPDATE pcms_extension_state_revision SET revision = revision + 1 WHERE id = true`,
      );
      return installedRowToInstallation(row);
    });
    if (updated === undefined) {
      throw new ExtensionError(
        "EXTENSION_NOT_INSTALLED",
        `extension "${extensionId}" is not installed (or not in an expected state)`,
        { details: { extension_id: extensionId } },
      );
    }
    return updated;
  };

  const service: ExtensionLifecycleService = {
    listDeployed() {
      return catalog.list().map((artifact) => artifact.manifest);
    },
    getDeployed(extensionId) {
      return catalog.get(extensionId)?.manifest;
    },
    listInstallations,
    getInstallation,

    async installPreflight(extensionId, config) {
      const manifest = requireDeployed(extensionId);
      const pendingMigrations: string[] = [];
      const issues = [
        ...(await activationIssues(manifest, config, undefined, "install")),
        ...(await migrationIssues(extensionId, pendingMigrations)),
      ];
      const existing = await getInstallation(extensionId);
      if (existing !== undefined) {
        issues.push({
          code: "EXTENSION_ALREADY_INSTALLED",
          severity: "warning",
          blocking: false,
          category: "extension",
          subject: extensionId,
          message: `already installed as version ${existing.version}; same-fingerprint install replays as a no-op`,
        });
      }
      return preflight(issues, { pendingMigrations });
    },

    async enablePreflight(extensionId) {
      const manifest = requireDeployed(extensionId);
      const installation = await getInstallation(extensionId);
      const issues: CompatibilityIssue[] = [];
      if (installation === undefined) {
        issues.push({
          code: "EXTENSION_NOT_INSTALLED",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          message: "extension must be installed before it can be enabled",
          remediation: "run install first",
        });
        return preflight(issues);
      }
      if (installation.manifestFingerprint !== manifestFingerprint(manifest)) {
        issues.push({
          code: "EXTENSION_DEPLOYMENT_INVALID",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          message:
            "deployed manifest differs from the installed fingerprint; reinstall the extension",
          remediation: "run install to accept the new manifest",
        });
      }
      const pendingMigrations: string[] = [];
      issues.push(
        ...configIssues(manifest, installation.config),
        ...(await activationIssues(manifest, installation.config, undefined, "enable")),
        ...(await migrationIssues(extensionId, pendingMigrations)),
      );
      return preflight(issues, { pendingMigrations });
    },

    async disablePreflight(extensionId) {
      requireDeployed(extensionId);
      const installation = await getInstallation(extensionId);
      const issues: CompatibilityIssue[] = [];
      if (installation === undefined) {
        issues.push({
          code: "EXTENSION_NOT_INSTALLED",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          message: "extension is not installed",
        });
        return preflight(issues);
      }
      const impacted: string[] = [];
      if (installation.state === "ENABLED") {
        const manifest = requireDeployed(extensionId);
        const provides = new Set(manifest.provides.map((entry) => entry.capability));
        const installations = await listInstallations();
        const enabledOthers = installations.filter(
          (entry) => entry.state === "ENABLED" && entry.extensionId !== extensionId,
        );
        const withoutSelf = registryWithEnabled(systemCapabilities, catalog, enabledOthers);
        for (const other of enabledOthers) {
          const otherManifest = catalog.get(other.extensionId)?.manifest;
          if (otherManifest === undefined) continue;
          for (const requirement of otherManifest.requires) {
            if (!provides.has(requirement.capability)) continue;
            const providers = withoutSelf.providers(requirement.capability);
            const ok = providers.some((provision) =>
              satisfies(provision.version, requirement.range),
            );
            if (!ok) {
              impacted.push(other.extensionId);
              issues.push({
                code: "EXTENSION_DISABLE_BLOCKED",
                severity: "error",
                blocking: true,
                category: "capability",
                subject: other.extensionId,
                location: `requires ${requirement.capability}@${requirement.range}`,
                message: `enabled extension "${other.extensionId}" requires capability "${requirement.capability}" provided only by "${extensionId}"`,
                remediation: `disable "${other.extensionId}" first or provide the capability elsewhere`,
              });
            }
          }
        }
      }
      return preflight(issues, { impactedExtensions: [...new Set(impacted)].sort() });
    },

    async uninstallPreflight(extensionId, confirmation) {
      const manifest = requireDeployed(extensionId);
      const installation = await getInstallation(extensionId);
      const issues: CompatibilityIssue[] = [];
      if (installation === undefined) {
        issues.push({
          code: "EXTENSION_NOT_INSTALLED",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          message: "extension is not installed",
        });
        return preflight(issues);
      }
      if (installation.state === "ENABLED") {
        issues.push({
          code: "EXTENSION_UNINSTALL_BLOCKED",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          message: "disable the extension before uninstalling",
          remediation: "run disable first",
        });
      }
      // Destructive policies need an explicit confirmation token.
      if (manifest.data_policy === "drop" && confirmation !== extensionId) {
        issues.push({
          code: "EXTENSION_DATA_POLICY_CONFIRMATION_REQUIRED",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: extensionId,
          message: `data policy "${manifest.data_policy}" destroys extension data; pass the extension id as explicit confirmation`,
          remediation: "back up the data, then retry with the explicit confirmation",
        });
      }
      return preflight(issues);
    },

    async install(input) {
      const manifest = requireDeployed(input.extensionId);
      const existing = await getInstallation(input.extensionId);
      const fingerprint = manifestFingerprint(manifest);
      if (existing !== undefined) {
        if (
          existing.manifestFingerprint === fingerprint &&
          JSON.stringify(existing.config) === JSON.stringify(input.config)
        ) {
          // Replay/idempotency: identical install is a no-op.
          return { installation: existing, appliedMigrations: [] };
        }
        // Upgrade path: different fingerprint or config re-runs preflight.
      }
      const check = await service.installPreflight(input.extensionId, input.config);
      if (check.outcome === "BLOCKED") {
        const blocking = blockingIssues(check.issues);
        throw new ExtensionError(
          blocking[0]?.code ?? "EXTENSION_MANIFEST_INVALID",
          `install preflight for "${input.extensionId}" is blocked: ${blocking.map((entry) => entry.code).join(", ")}`,
          { details: { extension_id: input.extensionId, issues: check.issues } },
        );
      }
      const { migrations } = migrationsOf(input.extensionId);
      const appliedMigrations = migrations.length
        ? (
            await applyExtensionMigrations(pool, {
              extensionId: input.extensionId,
              extensionVersion: manifest.version,
              migrations,
            })
          ).applied
        : [];
      const installation = await pool.withTransaction(async (client) => {
        const result = await client.query<InstallationRow>(
          `INSERT INTO ${INSTALLATIONS_TABLE}
           (extension_id, version, state, manifest_fingerprint, artifact_digest, config, installed_at, updated_at)
           VALUES ($1, $2, 'INSTALLED', $3, $4::text, $5::jsonb, $6, $6)
           ON CONFLICT (extension_id) DO UPDATE
           SET version = EXCLUDED.version,
               manifest_fingerprint = EXCLUDED.manifest_fingerprint,
               artifact_digest = EXCLUDED.artifact_digest,
               config = EXCLUDED.config,
               updated_at = EXCLUDED.updated_at
           RETURNING extension_id, version, state, manifest_fingerprint, artifact_digest, config, installed_at, updated_at`,
          [
            input.extensionId,
            manifest.version,
            fingerprint,
            catalog.get(input.extensionId)?.contentSha256 ?? null,
            JSON.stringify(input.config),
            clock.now(),
          ],
        );
        // R3: installs/upgrades move the lifecycle revision too.
        await client.query(
          `UPDATE pcms_extension_state_revision SET revision = revision + 1 WHERE id = true`,
        );
        return installedRowToInstallation(result.rows[0] as InstallationRow);
      });
      await audit({
        operation: "install",
        extensionId: input.extensionId,
        fromVersion: existing?.version,
        toVersion: manifest.version,
        outcome: "ok",
        at: clock.now(),
      });
      return { installation, appliedMigrations };
    },

    async enable(extensionId) {
      const manifest = requireDeployed(extensionId);
      const check = await service.enablePreflight(extensionId);
      if (check.outcome === "BLOCKED") {
        const blocking = blockingIssues(check.issues);
        await audit({
          operation: "enable",
          extensionId,
          fromVersion: undefined,
          toVersion: manifest.version,
          outcome: "blocked",
          at: clock.now(),
        });
        throw new ExtensionError(
          blocking[0]?.code ?? "EXTENSION_MANIFEST_INVALID",
          `enable preflight for "${extensionId}" is blocked: ${blocking.map((entry) => entry.code).join(", ")}`,
          { details: { extension_id: extensionId, issues: check.issues } },
        );
      }
      const installation = await getInstallation(extensionId);
      if (installation === undefined) {
        throw new ExtensionError(
          "EXTENSION_NOT_INSTALLED",
          `extension "${extensionId}" is not installed`,
          { details: { extension_id: extensionId } },
        );
      }
      // Enable replay: already enabled → no-op.
      const updated =
        installation.state === "ENABLED"
          ? installation
          : await saveState(extensionId, "ENABLED", ["INSTALLED", "DISABLED"]);
      await audit({
        operation: "enable",
        extensionId,
        fromVersion: undefined,
        toVersion: manifest.version,
        outcome: "ok",
        at: clock.now(),
      });
      return { installation: updated };
    },

    async disable(extensionId) {
      const manifest = requireDeployed(extensionId);
      const check = await service.disablePreflight(extensionId);
      if (check.outcome === "BLOCKED") {
        const blocking = blockingIssues(check.issues);
        await audit({
          operation: "disable",
          extensionId,
          fromVersion: undefined,
          toVersion: manifest.version,
          outcome: "blocked",
          at: clock.now(),
        });
        throw new ExtensionError(
          "EXTENSION_DISABLE_BLOCKED",
          `disable of "${extensionId}" is blocked: ${blocking.map((entry) => entry.code).join(", ")}`,
          { details: { extension_id: extensionId, issues: check.issues } },
        );
      }
      // D07 obligations guard + the state transition run in ONE transaction.
      // The obligation advisory locks are transaction-scoped, so checking in a
      // separate transaction and writing DISABLED later would reopen exactly
      // the race the guard exists to close: a business operation could create
      // an obligation in the window between COMMIT and the state write.
      const artifact = catalog.get(extensionId);
      const outcome = await pool.withTransaction(async (client) => {
        const current = await client.query<InstallationRow>(
          `SELECT extension_id, version, state, manifest_fingerprint, artifact_digest, config, installed_at, updated_at
           FROM ${INSTALLATIONS_TABLE} WHERE extension_id = $1 FOR UPDATE`,
          [extensionId],
        );
        const row = current.rows[0];
        if (row === undefined) {
          throw new ExtensionError(
            "EXTENSION_NOT_INSTALLED",
            `extension "${extensionId}" is not installed`,
            { details: { extension_id: extensionId } },
          );
        }
        const installation = installedRowToInstallation(row);
        if (artifact !== undefined && artifact.manifest.registrations.obligations.length > 0) {
          const obligationCheck = await obligationIssues(extensionId, artifact, client);
          if (obligationCheck.blocked) return { blocked: obligationCheck } as const;
        }
        // Disable replay: already disabled → no-op (still inside the lock).
        if (installation.state === "DISABLED") {
          return { installation } as const;
        }
        const updated = await client.query<InstallationRow>(
          `UPDATE ${INSTALLATIONS_TABLE}
           SET state = 'DISABLED', updated_at = $2
           WHERE extension_id = $1 AND state = ANY($3)
           RETURNING extension_id, version, state, manifest_fingerprint, artifact_digest, config, installed_at, updated_at`,
          [extensionId, clock.now(), ["INSTALLED", "ENABLED"]],
        );
        const written = updated.rows[0];
        if (written === undefined) {
          throw new ExtensionError(
            "EXTENSION_NOT_INSTALLED",
            `extension "${extensionId}" is not installed (or not in an expected state)`,
            { details: { extension_id: extensionId } },
          );
        }
        await client.query(
          `UPDATE pcms_extension_state_revision SET revision = revision + 1 WHERE id = true`,
        );
        return { installation: installedRowToInstallation(written) } as const;
      });
      if ("blocked" in outcome) {
        const blocking = blockingIssues(outcome.blocked.issues);
        await audit({
          operation: "disable",
          extensionId,
          fromVersion: undefined,
          toVersion: manifest.version,
          outcome: "blocked",
          at: clock.now(),
        });
        throw new ExtensionError(
          blocking[0]?.code ?? "EXTENSION_DISABLE_BLOCKED",
          `disable of "${extensionId}" is blocked: ${blocking
            .map((entry) => entry.code)
            .join(", ")}`,
          { details: { extension_id: extensionId, issues: outcome.blocked.issues } },
        );
      }
      const updated = outcome.installation;
      await audit({
        operation: "disable",
        extensionId,
        fromVersion: undefined,
        toVersion: manifest.version,
        outcome: "ok",
        at: clock.now(),
      });
      return { installation: updated };
    },

    async uninstall(input) {
      const manifest = requireDeployed(input.extensionId);
      const check = await service.uninstallPreflight(input.extensionId, input.confirmation);
      if (check.outcome === "BLOCKED") {
        const blocking = blockingIssues(check.issues);
        await audit({
          operation: "uninstall",
          extensionId: input.extensionId,
          fromVersion: undefined,
          toVersion: manifest.version,
          outcome: "blocked",
          at: clock.now(),
        });
        const code =
          blocking.find((entry) => entry.code === "EXTENSION_DATA_POLICY_CONFIRMATION_REQUIRED")
            ?.code ??
          blocking[0]?.code ??
          "EXTENSION_UNINSTALL_BLOCKED";
        throw new ExtensionError(
          code,
          `uninstall of "${input.extensionId}" is blocked: ${blocking.map((entry) => entry.code).join(", ")}`,
          {
            details: { extension_id: input.extensionId, issues: check.issues },
          },
        );
      }
      // D07 obligations guard + the destructive transition run in ONE
      // transaction: the advisory locks are transaction-scoped, so a separate
      // check followed by a later delete would let a business operation slip
      // an obligation in between.
      const artifact = catalog.get(input.extensionId);
      const outcome = await pool.withTransaction(async (client) => {
        const current = await client.query<InstallationRow>(
          `SELECT extension_id, version, state, manifest_fingerprint, artifact_digest, config, installed_at, updated_at
           FROM ${INSTALLATIONS_TABLE} WHERE extension_id = $1 FOR UPDATE`,
          [input.extensionId],
        );
        const row = current.rows[0];
        if (row === undefined) {
          throw new ExtensionError(
            "EXTENSION_NOT_INSTALLED",
            `extension "${input.extensionId}" is not installed`,
            { details: { extension_id: input.extensionId } },
          );
        }
        const installation = installedRowToInstallation(row);
        // Re-check the lifecycle state INSIDE the transaction, after the row
        // lock: the preflight read is advisory and a concurrent enable may
        // have committed ENABLED in the meantime. Uninstalling an enabled
        // extension is forbidden, so this must be re-validated here.
        if (installation.state === "ENABLED") {
          return {
            blocked: {
              blocked: true,
              issues: [
                {
                  code: "EXTENSION_UNINSTALL_BLOCKED",
                  severity: "error",
                  blocking: true,
                  category: "extension",
                  subject: input.extensionId,
                  message:
                    "the extension is ENABLED (a concurrent enable committed before this uninstall)",
                  remediation: "run disable first, then uninstall",
                },
              ],
            },
          } as const;
        }
        if (artifact !== undefined && artifact.manifest.registrations.obligations.length > 0) {
          const obligationCheck = await obligationIssues(input.extensionId, artifact, client);
          if (obligationCheck.blocked) return { blocked: obligationCheck } as const;
        }
        // Uninstall removes executable state only; data policy governs data.
        // Retained data outlives executable state. Keep the source contract so
        // media deletion fails closed even if the package leaves composition.
        if (manifest.registrations.media_usage_sources.length > 0) {
          await client.query(
            `INSERT INTO pcms_kernel_metadata (key, value, updated_at)
            VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [
              `extension.retained_media:${input.extensionId}`,
              JSON.stringify(manifest.registrations.media_usage_sources),
            ],
          );
        }
        await client.query(`DELETE FROM ${INSTALLATIONS_TABLE} WHERE extension_id = $1`, [
          input.extensionId,
        ]);
        // R3: uninstall moves the lifecycle revision too.
        await client.query(
          `UPDATE pcms_extension_state_revision SET revision = revision + 1 WHERE id = true`,
        );
        return { installation } as const;
      });
      if ("blocked" in outcome) {
        const blocking = blockingIssues(outcome.blocked.issues);
        await audit({
          operation: "uninstall",
          extensionId: input.extensionId,
          fromVersion: undefined,
          toVersion: manifest.version,
          outcome: "blocked",
          at: clock.now(),
        });
        const code =
          blocking.find((entry) => entry.code === "EXTENSION_OBLIGATION_CHECK_UNAVAILABLE")?.code ??
          blocking[0]?.code ??
          "EXTENSION_UNINSTALL_BLOCKED";
        throw new ExtensionError(
          code,
          `uninstall of "${input.extensionId}" is blocked: ${blocking
            .map((entry) => entry.code)
            .join(", ")}`,
          {
            details: { extension_id: input.extensionId, issues: outcome.blocked.issues },
          },
        );
      }
      const installation = outcome.installation;
      await audit({
        operation: "uninstall",
        extensionId: input.extensionId,
        fromVersion: undefined,
        toVersion: manifest.version,
        outcome: "ok",
        at: clock.now(),
      });
      return { installation, dataPolicy: manifest.data_policy };
    },

    async migrationStatus(extensionId) {
      requireDeployed(extensionId);
      const { migrations } = migrationsOf(extensionId);
      if (migrations.length === 0) return undefined;
      return extensionMigrationStatus(pool, extensionId, migrations);
    },

    enabledIds(): Promise<string[]> {
      return listInstallations().then((installations) =>
        installations
          .filter((entry) => entry.state === "ENABLED")
          .map((entry) => entry.extensionId)
          .sort(),
      );
    },

    async revision() {
      const result = await pool.query<{ revision: string }>(
        `SELECT revision::text AS revision FROM pcms_extension_state_revision WHERE id = true`,
      );
      return result.rows[0]?.revision ?? "0";
    },

    async reconcileIdentity() {
      const reconciled: {
        extensionId: string;
        appliedMigrations: readonly string[];
      }[] = [];
      for (const installation of await listInstallations()) {
        const artifact = catalog.get(installation.extensionId);
        if (artifact === undefined) continue; // left the composition — row kept
        const digest = artifact.contentSha256 ?? null;
        const fingerprint = manifestFingerprint(artifact.manifest);
        if (
          installation.artifactDigest === digest &&
          installation.manifestFingerprint === fingerprint &&
          installation.version === artifact.manifest.version
        ) {
          continue; // already at the deployed identity
        }
        const { migrations } = migrationsOf(installation.extensionId);
        const appliedMigrations = migrations.length
          ? (
              await applyExtensionMigrations(pool, {
                extensionId: installation.extensionId,
                extensionVersion: artifact.manifest.version,
                migrations,
              })
            ).applied
          : [];
        await pool.withTransaction(async (client) => {
          await client.query(
            `UPDATE ${INSTALLATIONS_TABLE}
             SET version = $2, manifest_fingerprint = $3, artifact_digest = $4, updated_at = $5
             WHERE extension_id = $1`,
            [installation.extensionId, artifact.manifest.version, fingerprint, digest, clock.now()],
          );
          // R3: an identity reconcile moves the lifecycle revision too.
          await client.query(
            `UPDATE pcms_extension_state_revision SET revision = revision + 1 WHERE id = true`,
          );
        });
        reconciled.push({ extensionId: installation.extensionId, appliedMigrations });
      }
      return reconciled;
    },
  };

  return service;
}
