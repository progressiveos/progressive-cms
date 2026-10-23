// Update apply orchestration contract (PCMS-EXT-T014, Extensions spec §24–§25).
//
// The orchestrator owns the APPLICATION-level phases and their order; the
// physical work (package deployment, systemd restarts, pg_dump, maintenance
// pages) belongs to M15 Operations behind typed ports. Without production
// adapters the orchestrator fails closed — it never pretends an update
// happened. Every attempt is recorded in pcms_update_history, failures
// included, with no secrets.
import { randomUUID } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { ExtensionError } from "./errors.js";
import type { CompatibilityIssue } from "./issues.js";
import type { ReleaseManifestV1 } from "./release-manifest.js";
import type { UpdatePreflight } from "./update-check.js";

export const UPDATE_HISTORY_TABLE = "pcms_update_history";

/** Explicit orchestration state machine (invalid transitions impossible). */
export const UPDATE_PHASES = [
  "PLANNED",
  "PREFLIGHT_PASSED",
  "BACKUP_CONFIRMED",
  "MAINTENANCE",
  "DEPLOYING",
  "MIGRATING",
  "VALIDATING",
  "RESTARTING",
  "SUCCEEDED",
  "FAILED",
] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

const TRANSITIONS: Readonly<Record<UpdatePhase, readonly UpdatePhase[]>> = {
  PLANNED: ["PREFLIGHT_PASSED"],
  PREFLIGHT_PASSED: ["BACKUP_CONFIRMED"],
  BACKUP_CONFIRMED: ["MAINTENANCE"],
  MAINTENANCE: ["DEPLOYING"],
  DEPLOYING: ["MIGRATING"],
  MIGRATING: ["VALIDATING"],
  VALIDATING: ["RESTARTING"],
  RESTARTING: ["SUCCEEDED"],
  SUCCEEDED: [],
  FAILED: [],
};

/** M15 Operations implements these ports; v1 ships only fakes in tests. */
export interface BackupGate {
  /** Confirms the operator's backup proof for this plan. Must throw to veto. */
  confirm(plan: UpdatePreflight): Promise<void>;
  /** Non-blocking housekeeping warnings after a verified backup. */
  warnings?(): readonly "BACKUP_RETENTION_FAILED"[];
}

export interface MaintenanceController {
  enter(plan: UpdatePreflight): Promise<void>;
  exit(plan: UpdatePreflight): Promise<void>;
}

/** Deploys the new release artifact (release dir switch — M15 mechanics). */
export interface ReleaseDeploymentPort {
  deploy(plan: UpdatePreflight): Promise<void>;
}

export interface ServiceRestartPort {
  restart(plan: UpdatePreflight): Promise<void>;
}

export interface PostflightDoctor {
  /** Runs the doctor on the updated installation; must throw or fail on problems. */
  run(
    plan: UpdatePreflight,
  ): Promise<{ readonly ok: boolean; readonly issues?: readonly CompatibilityIssue[] }>;
}

/** Core/extension migration application port (bound to the migrators). */
export interface MigrationApplier {
  /**
   * Applies the planned set and reports what ACTUALLY applied (M17-T006) —
   * history must record the migrator's result, not the preflight plan.
   * Returning undefined keeps older adapters/fakes valid (plan is fallback).
   */
  applyCore(plannedMigrations: readonly string[]): Promise<readonly string[] | undefined>;
  applyExtensionMigrations(
    plannedMigrations: readonly string[],
  ): Promise<readonly string[] | undefined>;
}

export interface UpdateOrchestrationPorts {
  readonly backupGate: BackupGate;
  readonly maintenance: MaintenanceController | undefined;
  readonly releaseDeployment: ReleaseDeploymentPort | undefined;
  readonly serviceRestart: ServiceRestartPort | undefined;
  readonly postflightDoctor: PostflightDoctor | undefined;
  readonly migrations: MigrationApplier | undefined;
}

export interface UpdateActor {
  readonly type: string;
  readonly id?: string | undefined;
}

export interface UpdateHistoryRecord {
  readonly id: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly actor: UpdateActor;
  readonly startedAt: Date;
  readonly completedAt: Date | undefined;
  readonly status: "RUNNING" | "SUCCEEDED" | "FAILED";
  readonly coreMigrations: readonly string[];
  readonly extensionMigrations: readonly string[];
  readonly validationSummary: Record<string, unknown>;
  readonly failureCode: string | undefined;
  readonly rollbackPolicy: ReleaseManifestV1["rollback_policy"];
}

export interface UpdateOrchestrator {
  /** The typed phase order — deterministic, machine-readable. */
  readonly phases: readonly UpdatePhase[];
  /** Runs the full orchestration; records every attempt. */
  apply(input: { readonly backupConfirmation?: string | undefined }): Promise<UpdateHistoryRecord>;
  /** History is inspectable even after failures. */
  history(limit?: number): Promise<readonly UpdateHistoryRecord[]>;
}

/** Internal mutable working copy (public records stay readonly). */
type MutableUpdateRecord = {
  -readonly [K in keyof UpdateHistoryRecord]: UpdateHistoryRecord[K];
};

interface HistoryRow {
  id: string;
  from_version: string;
  to_version: string;
  actor_type: string;
  actor_id: string | null;
  started_at: Date;
  completed_at: Date | null;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  core_migrations: unknown;
  extension_migrations: unknown;
  validation_summary: unknown;
  failure_code: string | null;
  rollback_policy: string;
  [column: string]: unknown;
}

function rowToRecord(row: HistoryRow): UpdateHistoryRecord {
  return {
    id: row.id,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    actor: { type: row.actor_type, id: row.actor_id ?? undefined },
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at === null ? undefined : new Date(row.completed_at),
    status: row.status,
    coreMigrations: (row.core_migrations as string[]) ?? [],
    extensionMigrations: (row.extension_migrations as string[]) ?? [],
    validationSummary: (row.validation_summary as Record<string, unknown>) ?? {},
    failureCode: row.failure_code ?? undefined,
    rollbackPolicy: row.rollback_policy as UpdateHistoryRecord["rollbackPolicy"],
  };
}

/** Latest update-orchestrator record (any status), or null when this
 * deployment never applied an update. Feeds GET /registry/update-status:
 * the async apply path reports RUNNING and pollers arbitrate on THIS
 * table, never on the apply response body. */
export async function latestUpdateRecord(pool: DbPool): Promise<UpdateHistoryRecord | null> {
  const result = await pool.query<HistoryRow>(
    `SELECT * FROM ${UPDATE_HISTORY_TABLE} ORDER BY started_at DESC LIMIT 1`,
  );
  const row = result.rows[0];
  return row === undefined ? null : rowToRecord(row);
}

/** Pre-orchestrator failure of an async apply (download/stage/manifest run
 * before any history row exists): record it FAILED, otherwise a status
 * poller would wait on the previous record forever. */
export async function recordFailedUpdateAttempt(
  pool: DbPool,
  clock: { now(): Date },
  input: {
    readonly from_version: string;
    readonly to_version: string;
    readonly failure_code: string;
    readonly actor: UpdateActor;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO ${UPDATE_HISTORY_TABLE}
     (id, from_version, to_version, actor_type, actor_id, started_at, completed_at,
      status, core_migrations, extension_migrations, validation_summary, failure_code, rollback_policy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'FAILED', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $8, 'rollback_safe')`,
    [
      randomUUID(),
      input.from_version,
      input.to_version,
      input.actor.type,
      input.actor.id ?? null,
      clock.now(),
      clock.now(),
      input.failure_code,
    ],
  );
}

export function createUpdateOrchestrator(input: {
  readonly pool: DbPool;
  readonly clock: { now(): Date };
  readonly preflight: UpdatePreflight;
  readonly target: ReleaseManifestV1;
  readonly ports: UpdateOrchestrationPorts;
  readonly actor: UpdateActor;
}): UpdateOrchestrator {
  const { pool, clock, preflight, target, ports, actor } = input;

  let phase: UpdatePhase = "PLANNED";
  const history: string[] = [];
  const transition = (to: UpdatePhase): void => {
    if (!TRANSITIONS[phase].includes(to)) {
      throw new ExtensionError(
        "UPDATE_POSTFLIGHT_FAILED",
        `illegal orchestration transition ${phase} → ${to}`,
        { details: { from: phase, to } },
      );
    }
    history.push(`${phase}→${to}`);
    phase = to;
  };

  const insertRecord = async (record: UpdateHistoryRecord): Promise<void> => {
    await pool.query(
      `INSERT INTO ${UPDATE_HISTORY_TABLE}
       (id, from_version, to_version, actor_type, actor_id, started_at, completed_at,
        status, core_migrations, extension_migrations, validation_summary, failure_code, rollback_policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13)`,
      [
        record.id,
        record.fromVersion,
        record.toVersion,
        record.actor.type,
        record.actor.id ?? null,
        record.startedAt,
        record.completedAt ?? null,
        record.status,
        JSON.stringify(record.coreMigrations),
        JSON.stringify(record.extensionMigrations),
        JSON.stringify(record.validationSummary),
        record.failureCode ?? null,
        record.rollbackPolicy,
      ],
    );
  };

  const finishFailed = async (
    record: MutableUpdateRecord,
    failureCode: string,
    message: string,
  ): Promise<never> => {
    record.status = "FAILED";
    record.failureCode = failureCode;
    record.completedAt = clock.now();
    await pool.query(
      `UPDATE ${UPDATE_HISTORY_TABLE}
       SET status = $2, completed_at = $3, failure_code = $4,
           core_migrations = $5::jsonb, extension_migrations = $6::jsonb,
           validation_summary = $7::jsonb
       WHERE id = $1`,
      [
        record.id,
        record.status,
        record.completedAt,
        record.failureCode,
        JSON.stringify(record.coreMigrations),
        JSON.stringify(record.extensionMigrations),
        JSON.stringify(record.validationSummary),
      ],
    );
    throw new ExtensionError(failureCode, message, {
      details: { update_id: record.id, phases: history },
    });
  };

  return {
    phases: UPDATE_PHASES,
    async apply({ backupConfirmation }) {
      const record: MutableUpdateRecord = {
        id: randomUUID(),
        fromVersion: preflight.current.version,
        toVersion: preflight.target.version,
        actor,
        startedAt: clock.now(),
        completedAt: undefined,
        status: "RUNNING",
        coreMigrations: preflight.plannedCoreMigrations,
        extensionMigrations: preflight.plannedExtensionMigrations,
        validationSummary: {
          preflight_outcome: preflight.outcome,
          issues: preflight.issues.length,
          phase_order: history,
        },
        failureCode: undefined,
        rollbackPolicy: preflight.target.rollbackPolicy,
      };
      await insertRecord(record);

      // Fail closed BEFORE any state change when production adapters are
      // missing — the update must never appear executed.
      const missing = (
        [
          "maintenance",
          "releaseDeployment",
          "serviceRestart",
          "postflightDoctor",
          "migrations",
        ] as const
      ).filter((key) => ports[key] === undefined);
      if (missing.length > 0) {
        return finishFailed(
          record,
          "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE",
          `update apply requires M15 Operations adapters; missing: ${missing.join(", ")}`,
        );
      }

      // Preflight must be clean.
      const blocking = preflight.issues.filter((issue) => issue.blocking);
      if (preflight.outcome === "BLOCKED" || blocking.length > 0) {
        return finishFailed(
          record,
          "UPDATE_COMPATIBILITY_BLOCKED",
          `preflight is blocked: ${blocking.map((issue) => issue.code).join(", ")}`,
        );
      }

      // Backup gate: explicit operator confirmation when the release
      // requires a backup; no --force bypass exists by design.
      if (target.backup_required && backupConfirmation !== target.version) {
        return finishFailed(
          record,
          "UPDATE_BACKUP_REQUIRED",
          `target ${target.version} requires a backup; confirm with the target version as the backup proof`,
        );
      }
      try {
        await ports.backupGate.confirm(preflight);
        record.validationSummary.backup_warnings = ports.backupGate.warnings?.() ?? [];
      } catch (error) {
        return finishFailed(
          record,
          "UPDATE_BACKUP_REQUIRED",
          `backup gate vetoed the update: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      transition("PREFLIGHT_PASSED");
      transition("BACKUP_CONFIRMED");

      try {
        transition("MAINTENANCE");
        await ports.maintenance?.enter(preflight);
        transition("DEPLOYING");
        await ports.releaseDeployment?.deploy(preflight);
        transition("MIGRATING");
        const appliedCore = await ports.migrations?.applyCore(preflight.plannedCoreMigrations);
        const appliedExtension = await ports.migrations?.applyExtensionMigrations(
          preflight.plannedExtensionMigrations,
        );
        // History records what the migrator ACTUALLY executed (M17-T006),
        // not the plan: a partially-applied or no-op run must be visible.
        if (appliedCore !== undefined) record.coreMigrations = appliedCore;
        if (appliedExtension !== undefined) record.extensionMigrations = appliedExtension;
        transition("VALIDATING");
        // VALIDATING phase is the compatibility validation seam; the
        // postflight doctor after restart is the authoritative gate.
        transition("RESTARTING");
        await ports.serviceRestart?.restart(preflight);
        const doctor = await ports.postflightDoctor?.run(preflight);
        if (doctor === undefined || !doctor.ok) {
          return finishFailed(
            record,
            "UPDATE_POSTFLIGHT_FAILED",
            "postflight doctor reported the updated installation as unhealthy",
          );
        }
        transition("SUCCEEDED");
        await ports.maintenance?.exit(preflight);
      } catch (error) {
        // Keep maintenance enabled after any mid-flight failure; an operator
        // must verify recovery before reopening the site.
        return finishFailed(
          record,
          "UPDATE_POSTFLIGHT_FAILED",
          `update failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      record.status = "SUCCEEDED";
      record.completedAt = clock.now();
      record.validationSummary = {
        ...record.validationSummary,
        phase_order: history,
        final_phase: phase,
      };
      await pool.query(
        `UPDATE ${UPDATE_HISTORY_TABLE}
         SET status = $2, completed_at = $3, validation_summary = $4::jsonb,
             core_migrations = $5::jsonb, extension_migrations = $6::jsonb
         WHERE id = $1`,
        [
          record.id,
          record.status,
          record.completedAt,
          JSON.stringify(record.validationSummary),
          JSON.stringify(record.coreMigrations),
          JSON.stringify(record.extensionMigrations),
        ],
      );
      return record;
    },

    async history(limit = 50) {
      const result = await pool.query<HistoryRow>(
        `SELECT * FROM ${UPDATE_HISTORY_TABLE} ORDER BY started_at DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map(rowToRecord);
    },
  };
}
