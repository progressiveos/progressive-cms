// Extensions application operations (PCMS-EXT-T019; Extensions spec §12–§13,
// §17–§18, §48). The ONLY place transport-facing callers touch the extensions
// subsystem: discovery operations are permission-light reads of published
// contracts; privileged lifecycle/update operations gate on extensions.manage
// and audit into the M08 security-event stream. REST, MCP and CLI all call
// these functions.
import { recordSecurityEvent } from "@pcms/auth";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

function auditBase(ctx: OperationContext) {
  return {
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    transport: (ctx.transport === "rest" ? "api" : ctx.transport) as "api" | "mcp" | "cli",
  };
}

function requireDeployedExtensionId(extensionId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62})+$/.test(extensionId)) {
    throw new ApiError("EXTENSION_NOT_DEPLOYED", `extension id "${extensionId}" is invalid`, {
      status: 422,
    });
  }
  return extensionId;
}

/** Immediate same-process revoke (gate E2): composed operations and media
 * provider registrations/instances must reflect the new lifecycle state on
 * the very next request, not on a TTL tick. Cross-process revocation rides
 * the lifecycle-revision gate (ADR-0017 §Inter-process disable). */
function revokeComposedState(app: ApplicationServices, extensionId: string): void {
  app.extensionOperations.invalidate();
  app.mediaProviders.invalidate(extensionId);
}

function extensionView(manifest: {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly extension_contract: string;
  readonly cms_compatibility: string | null;
  readonly requires: readonly { readonly capability: string; readonly range: string }[];
  readonly provides: readonly { readonly capability: string; readonly version: string }[];
  readonly data_policy: string;
  readonly description?: { readonly ru: string; readonly en: string };
  readonly icon?: string;
}) {
  return {
    id: manifest.id,
    name: manifest.name,
    // S4: manifest-authored metadata — Admin renders it instead of keeping
    // per-extension dictionaries/icons in Core.
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
    version: manifest.version,
    extension_contract: manifest.extension_contract,
    cms_compatibility: manifest.cms_compatibility,
    requires: manifest.requires.map((entry) => ({
      capability: entry.capability,
      range: entry.range,
    })),
    provides: manifest.provides.map((entry) => ({
      capability: entry.capability,
      version: entry.version,
    })),
    data_policy: manifest.data_policy,
  };
}

// ---- machine discovery (read-only) ----

export async function getContractVersions(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "extensions.manage");
  return {
    items: app.extensions.contractVersions.list().map((entry) => ({
      key: entry.key,
      version: entry.version,
      source: entry.source,
    })),
  };
}

export async function getCapabilities(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "extensions.manage");
  const items = await app.extensions.capabilities();
  return {
    items: items.map((entry) => ({
      capability: entry.key,
      version: entry.version,
      provider: entry.provider,
    })),
  };
}

export async function listExtensions(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "extensions.manage");
  const [installations, report] = await Promise.all([
    app.extensions.lifecycle.listInstallations(),
    app.extensions.scanCompatibility(),
  ]);
  const items = app.extensions.catalog.list().map((artifact) => {
    const installation = installations.find((entry) => entry.extensionId === artifact.manifest.id);
    const issues = report.issues.filter((issue) => issue.subject === artifact.manifest.id);
    return {
      ...extensionView(artifact.manifest),
      installed: installation !== undefined,
      state: installation?.state ?? null,
      installed_version: installation?.version ?? null,
      config: installation?.config ?? {},
      compatibility_outcome: issues.some((issue) => issue.blocking)
        ? "BLOCKED"
        : issues.length > 0
          ? "READY_WITH_WARNINGS"
          : "READY",
      issues: issues.map(issueView),
      has_config_schema: artifact.manifest.config_schema !== undefined,
      registrations: {
        blocks: artifact.manifest.registrations.blocks.length,
        field_types: artifact.manifest.registrations.field_types.length,
        routes: artifact.manifest.registrations.routes.length,
        event_subscriptions: artifact.manifest.registrations.event_subscriptions.length,
        validators: artifact.manifest.registrations.validators.length,
        providers: artifact.manifest.registrations.providers.length,
        operations: artifact.manifest.registrations.operations.length,
      },
    };
  });
  // Undeployed-but-installed rows must be visible (state without artifact).
  for (const installation of installations) {
    if (app.extensions.catalog.has(installation.extensionId)) continue;
    items.push({
      id: installation.extensionId,
      name: installation.extensionId,
      version: installation.version,
      extension_contract: "2.0",
      cms_compatibility: null,
      requires: [],
      provides: [],
      data_policy: "retain",
      installed: true,
      state: installation.state,
      installed_version: installation.version,
      config: installation.config,
      has_config_schema: false,
      compatibility_outcome: "BLOCKED",
      issues: [
        {
          code: "COMPAT_EXTENSION_FINGERPRINT_MISMATCH",
          severity: "error",
          blocking: true,
          category: "extension",
          subject: installation.extensionId,
          message:
            "installed extension has no deployed artifact (removed from the trusted catalog?)",
          remediation: "redeploy the extension or uninstall it",
        },
      ],
      registrations: {
        blocks: 0,
        field_types: 0,
        routes: 0,
        event_subscriptions: 0,
        validators: 0,
        providers: 0,
        operations: 0,
      },
    });
  }
  return { items: items.sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

function issueView(issue: {
  readonly code: string;
  readonly severity: string;
  readonly blocking: boolean;
  readonly category: string;
  readonly subject: string;
  readonly location?: string;
  readonly message: string;
  readonly remediation?: string;
}) {
  return {
    code: issue.code,
    severity: issue.severity,
    blocking: issue.blocking,
    category: issue.category,
    subject: issue.subject,
    ...(issue.location === undefined ? {} : { location: issue.location }),
    message: issue.message,
    ...(issue.remediation === undefined ? {} : { remediation: issue.remediation }),
  };
}

export async function getExtensionCompatibility(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string },
) {
  requirePermission(app, ctx, "extensions.manage");
  const id = requireDeployedExtensionId(input.extension_id);
  const result = await app.extensions.extensionCompatibility(id);
  if (!result.found) {
    throw new ApiError("EXTENSION_NOT_DEPLOYED", `extension "${id}" is not deployed`, {
      status: 404,
    });
  }
  return { extension_id: id, outcome: result.outcome, issues: result.issues.map(issueView) };
}

export async function getCompatibilityReport(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "extensions.manage");
  const report = await app.extensions.scanCompatibility();
  return {
    outcome: report.outcome,
    generated_at: report.generatedAt,
    issues: report.issues.map(issueView),
  };
}

export async function listDeprecations(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "extensions.manage");
  return {
    items: app.extensions.deprecations.list().map((record) => ({
      id: record.id,
      contract: record.contract,
      item: record.item,
      deprecated_in: record.deprecated_in,
      replacement: record.replacement ?? null,
      planned_removal_major: record.planned_removal_major,
      migration_tool: record.migration_tool ?? null,
      status: record.status,
      usage_key: record.usage_key ?? null,
    })),
  };
}

export async function getUpdatePreflight(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly manifest?: unknown } = {},
) {
  requirePermission(app, ctx, "extensions.manage");
  // When the operator supplies a target, it must match the configured one
  // byte-for-byte (same fail-closed comparison as apply) — check and apply
  // can then never disagree about what is being installed.
  if (input.manifest !== undefined) {
    const { parseReleaseManifest } = await import("@pcms/extensions/internal");
    const submitted = parseReleaseManifest(input.manifest);
    if (JSON.stringify(submitted) !== JSON.stringify(app.extensions.releaseManifest)) {
      throw new ApiError(
        "UPDATE_MANIFEST_INVALID",
        "the submitted manifest does not match the configured target release",
        { status: 409 },
      );
    }
  }
  const preflight = await app.extensions.updatePreflight();
  return {
    outcome: preflight.outcome,
    current: preflight.current,
    target: {
      version: preflight.target.version,
      rollback_policy: preflight.target.rollbackPolicy,
      backup_required: preflight.target.backupRequired,
      security_notes: preflight.target.securityNotes,
      manual_steps: preflight.target.manualSteps,
    },
    planned_core_migrations: preflight.plannedCoreMigrations,
    planned_extension_migrations: preflight.plannedExtensionMigrations,
    contract_changes: preflight.contractChanges,
    config_changes: preflight.configChanges,
    issues: preflight.issues.map(issueView),
  };
}

// ---- privileged lifecycle operations (audited) ----

export async function installExtension(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string; readonly config?: Record<string, unknown> },
) {
  requirePermission(app, ctx, "extensions.manage");
  const id = requireDeployedExtensionId(input.extension_id);
  try {
    const result = await app.extensions.lifecycle.install({
      extensionId: id,
      config: input.config ?? {},
    });
    revokeComposedState(app, id);
    await recordSecurityEvent(app.pool, null, {
      type: "EXTENSION_INSTALLED",
      ...auditBase(ctx),
      subjectType: "extension",
      subjectId: id,
      metadata: {
        version: result.installation.version,
        applied_migrations: result.appliedMigrations.length,
      },
    });
    return {
      extension_id: id,
      state: result.installation.state,
      version: result.installation.version,
      applied_migrations: result.appliedMigrations,
    };
  } catch (error) {
    throw toApiError(error);
  }
}

export async function enableExtension(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string },
) {
  requirePermission(app, ctx, "extensions.manage");
  const id = requireDeployedExtensionId(input.extension_id);
  try {
    const result = await app.extensions.lifecycle.enable(id);
    revokeComposedState(app, id);
    await recordSecurityEvent(app.pool, null, {
      type: "EXTENSION_ENABLED",
      ...auditBase(ctx),
      subjectType: "extension",
      subjectId: id,
      metadata: { version: result.installation.version },
    });
    return { extension_id: id, state: result.installation.state };
  } catch (error) {
    throw toApiError(error);
  }
}

export async function disableExtension(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string },
) {
  requirePermission(app, ctx, "extensions.manage");
  const id = requireDeployedExtensionId(input.extension_id);
  try {
    const result = await app.extensions.lifecycle.disable(id);
    revokeComposedState(app, id);
    await recordSecurityEvent(app.pool, null, {
      type: "EXTENSION_DISABLED",
      ...auditBase(ctx),
      subjectType: "extension",
      subjectId: id,
      metadata: { version: result.installation.version },
    });
    return { extension_id: id, state: result.installation.state };
  } catch (error) {
    throw toApiError(error);
  }
}

export async function uninstallExtension(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly extension_id: string; readonly confirmation?: string },
) {
  requirePermission(app, ctx, "extensions.manage");
  const id = requireDeployedExtensionId(input.extension_id);
  try {
    const result = await app.extensions.lifecycle.uninstall({
      extensionId: id,
      ...(input.confirmation === undefined ? {} : { confirmation: input.confirmation }),
    });
    revokeComposedState(app, id);
    await recordSecurityEvent(app.pool, null, {
      type: "EXTENSION_UNINSTALLED",
      ...auditBase(ctx),
      subjectType: "extension",
      subjectId: id,
      metadata: { data_policy: result.dataPolicy },
    });
    return { extension_id: id, data_policy: result.dataPolicy };
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * Update apply: the M14 application orchestration contract. Physical
 * deployment belongs to M15; until that adapter is connected the
 * orchestrator records the attempt and fails closed — never a fake success.
 */
export async function applyUpdate(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly manifest: unknown;
    readonly backup_confirmation?: string;
    /** Registry apply-update path: the manifest came from a sha256-verified
     * registry artifact, so it IS the operator-confirmed target — the
     * boot-time configured-target compare (which can never match on first
     * download) is skipped and preflight runs against THIS manifest. */
    readonly confirmed_from_registry?: boolean;
  },
) {
  requirePermission(app, ctx, "extensions.manage");
  const { parseReleaseManifest, createUpdateOrchestrator } = await import(
    "@pcms/extensions/internal"
  );
  const target = parseReleaseManifest(input.manifest);
  const preflight =
    input.confirmed_from_registry === true
      ? await app.extensions.updatePreflightAgainst(target)
      : await (async () => {
          if (app.extensions.releaseManifest === null) {
            throw new ApiError(
              "UPDATE_MANIFEST_INVALID",
              "no target release manifest is configured for this environment",
              { status: 409 },
            );
          }
          if (JSON.stringify(target) !== JSON.stringify(app.extensions.releaseManifest)) {
            throw new ApiError(
              "UPDATE_MANIFEST_INVALID",
              "the submitted manifest does not match the configured target release",
              { status: 409 },
            );
          }
          return app.extensions.updatePreflight();
        })();
  // Production adapters (PCMS-OPS-T114) when the deployment provides them;
  // otherwise the orchestrator records the attempt and fails closed before
  // touching anything.
  const ports = app.updateOrchestrationPorts ?? {
    backupGate: { confirm: async () => undefined },
    maintenance: undefined,
    releaseDeployment: undefined,
    serviceRestart: undefined,
    postflightDoctor: undefined,
    migrations: undefined,
  };
  const orchestrator = createUpdateOrchestrator({
    pool: app.pool,
    clock: app.clock,
    preflight,
    target,
    actor: { type: ctx.actor.type, ...(ctx.actor.id === undefined ? {} : { id: ctx.actor.id }) },
    ports,
  });
  try {
    const record = await orchestrator.apply({ backupConfirmation: input.backup_confirmation });
    await recordSecurityEvent(app.pool, null, {
      type: "UPDATE_APPLY_ATTEMPT",
      ...auditBase(ctx),
      subjectType: "update",
      subjectId: record.id,
      metadata: {
        from_version: record.fromVersion,
        to_version: record.toVersion,
        status: record.status,
        failure_code: record.failureCode ?? null,
      },
    });
    return {
      id: record.id,
      status: record.status,
      failure_code: record.failureCode ?? null,
      rollback_policy: record.rollbackPolicy,
      backup_warnings: record.validationSummary.backup_warnings ?? [],
    };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (typeof code === "string" && code.startsWith("UPDATE_")) {
      throw new ApiError(code, error instanceof Error ? error.message : String(error), {
        status: 409,
      });
    }
    throw error;
  }
}

/** Maps stable ExtensionError codes onto HTTP statuses (transport concern). */
function toApiError(error: unknown): Error {
  const code = (error as { code?: string } | null)?.code;
  if (
    typeof code !== "string" ||
    !code.startsWith("EXTENSION_") ||
    code === "EXTENSION_EVENT_CONSUMPTION_INVALID"
  ) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const status = code.endsWith("_NOT_DEPLOYED") || code.endsWith("_NOT_INSTALLED") ? 404 : 409;
  return new ApiError(code, error instanceof Error ? error.message : String(error), { status });
}
