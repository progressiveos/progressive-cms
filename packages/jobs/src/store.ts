// Job queue service (PCMS-PUB-T018/T019): PostgreSQL-backed claiming with
// FOR UPDATE SKIP LOCKED, lease-based crash recovery, retry classification
// (transient auto-retry only; permanent/cancelled never retry), dead-letter
// retention with inspect/retry/cancel, and stable idempotency keys (spec
// §62–§65, §31). This package is generic infrastructure: it never imports
// publication (worker composition registers typed handlers).
import { type Clock, type DbClient, type DbPool, newStableId, type StableId } from "@pcms/core";
import { JobsError } from "./errors.js";

export type JobState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD" | "CANCELLED";

/** Failure classification (spec §64): only transient failures auto-retry. */
export type JobErrorKind = "transient" | "permanent" | "cancelled";

export interface JobRecord {
  readonly id: StableId;
  readonly type: string;
  readonly payload: unknown;
  readonly state: JobState;
  readonly runAt: Date;
  readonly idempotencyKey: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly claimedBy: string | null;
  readonly lastError: string | null;
  readonly errorKind: JobErrorKind | null;
  /** Diagnostic origin label ("plan:...", "manual", ...). */
  readonly origin: string | null;
  /** Schema-generation stamp (extension jobs; null for core jobs). */
  readonly payloadVersion: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface EnqueueJobInput {
  readonly type: string;
  readonly payload: unknown;
  /** Earliest execution instant (defaults to now). */
  readonly runAt?: Date;
  /** Stable idempotency key (spec §31): one active/succeeded job per key. */
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
  readonly origin?: string;
  /** Schema-generation stamp written through for extension jobs. */
  readonly payloadVersion?: number;
}

/** Handler outcome: void = success; a JobErrorKind classifies the failure;
 * object outcomes carry explicit diagnostics — "permanent" dead-letters with
 * `error` verbatim (PREPUBLIC §4), "parked" reschedules WITHOUT burning an
 * attempt (PREPUBLIC §4 lifecycle: a temporarily disabled extension must
 * preserve its queued work and continue after re-enable). */
export type JobHandlerResult =
  | JobErrorKind
  | { readonly outcome: "permanent"; readonly error: unknown }
  | {
      readonly outcome: "parked";
      /** Re-run no earlier than this delay (default 60s). */
      readonly delayMilliseconds?: number;
      /** Human-readable park reason (last_error while PENDING). */
      readonly reason?: string;
    }
  | void;

export interface JobHandler {
  /**
   * Return value classifies the outcome: void = success, "transient" =
   * retryable failure (recorded error), "permanent" = dead-letter now,
   * "cancelled" = job cancelled. Throwing counts as transient.
   */
  (
    payload: unknown,
    context: { readonly job: JobRecord; readonly attempt: number },
  ): Promise<JobHandlerResult>;
}

interface JobRow {
  [column: string]: unknown;
  id: string;
  type: string;
  payload: unknown;
  state: string;
  run_at: Date;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
  claimed_by: string | null;
  last_error: string | null;
  error_kind: string | null;
  origin: string | null;
  payload_version: number | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id as StableId,
    type: row.type,
    payload: row.payload,
    state: row.state as JobState,
    runAt: row.run_at,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimedBy: row.claimed_by,
    lastError: row.last_error,
    errorKind: row.error_kind as JobErrorKind | null,
    origin: row.origin,
    payloadVersion: row.payload_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const COLUMNS = `id, type, payload, state, run_at, idempotency_key, attempts, max_attempts,
  claimed_by, last_error, error_kind, origin, payload_version, created_at, updated_at, completed_at`;

export interface JobsService {
  enqueue(
    input: EnqueueJobInput,
  ): Promise<{ readonly job: JobRecord; readonly duplicate: boolean }>;
  getJob(executor: DbClient, jobId: StableId): Promise<JobRecord | null>;
  /**
   * Claims up to `limit` due jobs for one worker. Concurrent calls never
   * receive the same job (FOR UPDATE SKIP LOCKED), order deterministic by
   * (run_at, id).
   */
  claim(input: {
    readonly workerId: string;
    readonly limit: number;
    readonly leaseMilliseconds: number;
  }): Promise<readonly JobRecord[]>;
  complete(jobId: StableId): Promise<void>;
  /**
   * Heartbeat for running jobs (spec §63): pushes this worker's claim lease
   * forward so a job that legitimately runs longer than one lease window is
   * not recovered as dead and double-claimed by another worker. Only rows
   * still owned by `workerId` and RUNNING are touched.
   */
  extendLeases(input: {
    readonly workerId: string;
    readonly jobIds: readonly string[];
    readonly leaseMilliseconds: number;
  }): Promise<void>;
  /**
   * Records an outcome: "transient" requeues with exponential backoff until
   * maxAttempts, then DEAD; "permanent" goes DEAD immediately; "cancelled"
   * marks the job CANCELLED.
   */
  fail(jobId: StableId, kind: JobErrorKind, error: unknown): Promise<void>;
  /**
   * Parks a claimed job: back to PENDING with a future run_at and the claim
   * attempt COMPENSATED (parking is not a failure — the handler was not in
   * a position to run). Used for temporarily unavailable dependencies
   * (disabled extension, PREPUBLIC §4): the job survives indefinitely until
   * the dependency returns or an operator cancels it.
   */
  park(
    jobId: StableId,
    options?: { readonly delayMilliseconds?: number; readonly reason?: string },
  ): Promise<void>;
  /** Requeues RUNNING jobs whose worker died (expired lease). */
  recoverExpiredLeases(): Promise<number>;
  /** Operator surface for dead letters (spec §65). */
  listDeadLetters(options?: {
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<readonly JobRecord[]>;
  retryDeadLetter(jobId: StableId): Promise<void>;
  cancelPendingJob(jobId: StableId): Promise<boolean>;
  stats(): Promise<Record<JobState, number>>;
  /**
   * Enqueue a RECURRING logical job atomically: one run in flight per `type`,
   * regardless of how old the running one is.
   *
   * Both halves happen inside ONE transaction guarded by a PostgreSQL
   * advisory lock keyed on `type`:
   *  - there is no PENDING/RUNNING job of this type (checked across ALL
   *    windows, so a run longer than several intervals is still visible), and
   *  - the new job is inserted.
   *
   * A concurrent scheduler in another worker either blocks on the lock and
   * then sees the active job, or fails to take the lock and reports "busy" —
   * two workers can never both insert a run of the same logical task.
   */
  enqueueRecurring(input: EnqueueRecurringInput): Promise<EnqueueRecurringResult>;
}

export interface EnqueueRecurringInput {
  readonly type: string;
  readonly payload: unknown;
  /** Idempotency key of this run (typically carries the interval window). */
  readonly idempotencyKey?: string;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
  readonly origin?: string;
  readonly payloadVersion?: number;
}

export type EnqueueRecurringResult =
  /** A new run was inserted. */
  | { readonly outcome: "enqueued"; readonly job: JobRecord }
  /** This logical task already has a PENDING/RUNNING run (any window). */
  | { readonly outcome: "active"; readonly job: JobRecord }
  /** This exact run key already succeeded earlier. */
  | { readonly outcome: "already_completed"; readonly job: JobRecord }
  /** Another scheduler holds the advisory lock right now; retry next tick. */
  | { readonly outcome: "busy" };

export function createJobsService(
  pool: DbPool,
  deps: {
    readonly clock: Clock;
    readonly backoffBaseMilliseconds?: number;
  },
): JobsService {
  const backoffBase = deps.backoffBaseMilliseconds ?? 2_000;

  return {
    async enqueue(input) {
      const id = newStableId();
      const now = deps.clock.now();
      try {
        const inserted = await pool.query<JobRow>(
          `INSERT INTO jobs (id, type, payload, run_at, idempotency_key, max_attempts, origin, payload_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${COLUMNS}`,
          [
            id,
            input.type,
            JSON.stringify(input.payload ?? null),
            input.runAt ?? now,
            input.idempotencyKey ?? null,
            input.maxAttempts ?? 5,
            input.origin ?? null,
            input.payloadVersion ?? null,
          ],
        );
        return { job: toRecord(inserted.rows[0]!), duplicate: false };
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
        // Idempotency key collision: return the existing active/succeeded job.
        const existing = await pool.query<JobRow>(
          `SELECT ${COLUMNS} FROM jobs
           WHERE idempotency_key = $1 AND state IN ('PENDING', 'RUNNING', 'SUCCEEDED')`,
          [input.idempotencyKey!],
        );
        if (existing.rows.length !== 1) throw error;
        const job = toRecord(existing.rows[0]!);
        if (job.state === "SUCCEEDED") {
          throw new JobsError(
            "JOB_ALREADY_COMPLETED",
            `job with idempotency key ${input.idempotencyKey} already succeeded`,
            { details: { jobId: job.id } },
          );
        }
        return { job, duplicate: true };
      }
    },

    async getJob(executor, jobId) {
      const result = await executor.query<JobRow>(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [
        jobId,
      ]);
      return result.rows.length === 1 ? toRecord(result.rows[0]!) : null;
    },

    async claim({ workerId, limit, leaseMilliseconds }) {
      return pool.withTransaction(async (tx) => {
        const now = deps.clock.now();
        const leaseExpires = new Date(now.getTime() + leaseMilliseconds);
        const claimed = await tx.query<JobRow>(
          `UPDATE jobs
           SET state = 'RUNNING', claimed_by = $3, claimed_at = $1,
               claim_expires_at = $4, attempts = attempts + 1, updated_at = $1
           WHERE id IN (
             SELECT id FROM jobs
             WHERE state = 'PENDING' AND run_at <= $1
             ORDER BY run_at, id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           RETURNING ${COLUMNS}`,
          [now, Math.max(1, Math.min(limit, 100)), workerId, leaseExpires],
        );
        return claimed.rows.map(toRecord);
      });
    },

    async complete(jobId) {
      const now = deps.clock.now();
      const result = await pool.query(
        `UPDATE jobs
         SET state = 'SUCCEEDED', completed_at = $2, updated_at = $2,
             claimed_by = NULL, claim_expires_at = NULL
         WHERE id = $1 AND state = 'RUNNING'`,
        [jobId, now],
      );
      if (result.rowCount !== 1) {
        const job = await this.getJob(pool, jobId);
        if (job !== null && (job.state === "SUCCEEDED" || job.state === "DEAD")) {
          throw new JobsError("JOB_ALREADY_COMPLETED", `job ${jobId} is already ${job.state}`, {
            details: { jobId, state: job.state },
          });
        }
        throw new JobsError("JOB_STATE_INVALID", `job ${jobId} is not RUNNING`, {
          details: { jobId, state: job?.state ?? null },
        });
      }
    },

    async fail(jobId, kind, error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      await pool.withTransaction(async (tx) => {
        const current = await tx.query<JobRow>(
          `SELECT ${COLUMNS} FROM jobs WHERE id = $1 FOR UPDATE`,
          [jobId],
        );
        if (current.rows.length !== 1) {
          throw new JobsError("JOB_NOT_FOUND", `job ${jobId} does not exist`);
        }
        const job = toRecord(current.rows[0]!);
        const now = deps.clock.now();
        if (job.state !== "RUNNING") {
          throw new JobsError("JOB_STATE_INVALID", `job ${jobId} is ${job.state}, not RUNNING`);
        }
        if (kind === "cancelled") {
          await tx.query(
            `UPDATE jobs SET state = 'CANCELLED', error_kind = 'cancelled', last_error = $2,
               completed_at = $3, updated_at = $3, claimed_by = NULL, claim_expires_at = NULL
             WHERE id = $1`,
            [jobId, message, now],
          );
          return;
        }
        const exhausted = kind === "permanent" || job.attempts >= job.maxAttempts;
        if (exhausted) {
          await tx.query(
            `UPDATE jobs SET state = 'DEAD', error_kind = $2, last_error = $3, updated_at = $4,
               claimed_by = NULL, claim_expires_at = NULL
             WHERE id = $1`,
            [jobId, kind, message, now],
          );
          return;
        }
        // Transient retry with exponential backoff (bounded exponent).
        const delay = backoffBase * 2 ** Math.min(job.attempts - 1, 16);
        await tx.query(
          `UPDATE jobs SET state = 'PENDING', error_kind = 'transient', last_error = $2,
             run_at = $3, claimed_by = NULL, claim_expires_at = NULL, updated_at = $4
           WHERE id = $1`,
          [jobId, message, new Date(now.getTime() + delay), now],
        );
      });
    },

    async park(jobId, options) {
      const delay = Math.max(0, options?.delayMilliseconds ?? 60_000);
      const reason = (options?.reason ?? "parked").slice(0, 2000);
      await pool.query(
        `UPDATE jobs
         SET state = 'PENDING', run_at = $2, attempts = GREATEST(attempts - 1, 0),
             last_error = $3, error_kind = NULL,
             claimed_by = NULL, claim_expires_at = NULL, updated_at = $4
         WHERE id = $1 AND state = 'RUNNING'`,
        [jobId, new Date(deps.clock.now().getTime() + delay), reason, deps.clock.now()],
      );
    },

    async extendLeases({ workerId, jobIds, leaseMilliseconds }) {
      if (jobIds.length === 0) return;
      const now = deps.clock.now();
      await pool.query(
        `UPDATE jobs
         SET claim_expires_at = $2
         WHERE id = ANY($1::uuid[]) AND claimed_by = $3 AND state = 'RUNNING'`,
        [jobIds, new Date(now.getTime() + leaseMilliseconds), workerId],
      );
    },

    async recoverExpiredLeases() {
      const result = await pool.query<{ id: string }>(
        `UPDATE jobs
         SET state = 'PENDING', claimed_by = NULL, claim_expires_at = NULL, updated_at = $1
         WHERE state = 'RUNNING' AND claim_expires_at < $1
         RETURNING id`,
        [deps.clock.now()],
      );
      return result.rows.length;
    },

    async listDeadLetters(options) {
      const limit = Math.min(options?.limit ?? 100, 1000);
      const offset = Math.max(options?.offset ?? 0, 0);
      const result = await pool.query<JobRow>(
        `SELECT ${COLUMNS} FROM jobs WHERE state = 'DEAD'
         ORDER BY updated_at, id
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows.map(toRecord);
    },

    async retryDeadLetter(jobId) {
      const result = await pool.query(
        `UPDATE jobs
         SET state = 'PENDING', run_at = $2, attempts = 0, last_error = NULL,
             error_kind = NULL, claimed_by = NULL, claim_expires_at = NULL, updated_at = $2
         WHERE id = $1 AND state = 'DEAD'`,
        [jobId, deps.clock.now()],
      );
      if (result.rowCount !== 1) {
        throw new JobsError("JOB_STATE_INVALID", `job ${jobId} is not DEAD`, {
          details: { jobId },
        });
      }
    },

    async cancelPendingJob(jobId) {
      const result = await pool.query(
        `UPDATE jobs
         SET state = 'CANCELLED', error_kind = 'cancelled', completed_at = $2, updated_at = $2
         WHERE id = $1 AND state = 'PENDING'`,
        [jobId, deps.clock.now()],
      );
      return result.rowCount === 1;
    },

    async stats() {
      const result = await pool.query<{ state: string; count: string }>(
        `SELECT state, count(*) AS count FROM jobs GROUP BY state`,
      );
      const stats: Record<JobState, number> = {
        PENDING: 0,
        RUNNING: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        DEAD: 0,
        CANCELLED: 0,
      };
      for (const row of result.rows) {
        if (row.state in stats) stats[row.state as JobState] = Number(row.count);
      }
      return stats;
    },

    async enqueueRecurring(input) {
      return pool.withTransaction(async (tx) => {
        // Serialize all schedulers of this logical task. A transaction-scoped
        // advisory lock is released on commit/rollback; a competing worker
        // that cannot take it simply retries on its next tick.
        const locked = await tx.query<{ ok: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
          [`pcms:schedule:${input.type}`],
        );
        if (locked.rows[0]?.ok !== true) return { outcome: "busy" } as const;

        // Any run of this logical task still in flight — no window filter, so
        // a job running longer than several intervals is never doubled.
        const active = await tx.query<JobRow>(
          `SELECT ${COLUMNS} FROM jobs
           WHERE type = $1 AND state IN ('PENDING', 'RUNNING')
           ORDER BY run_at, id LIMIT 1`,
          [input.type],
        );
        if (active.rows.length === 1) {
          return { outcome: "active", job: toRecord(active.rows[0]!) } as const;
        }

        const id = newStableId();
        const now = deps.clock.now();
        // A duplicate must not abort the transaction before we read its row.
        const inserted = await tx.query<JobRow>(
          `INSERT INTO jobs (id, type, payload, run_at, idempotency_key, max_attempts, origin, payload_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (idempotency_key)
             WHERE idempotency_key IS NOT NULL AND state IN ('PENDING', 'RUNNING', 'SUCCEEDED')
           DO NOTHING
           RETURNING ${COLUMNS}`,
          [
            id,
            input.type,
            JSON.stringify(input.payload ?? null),
            input.runAt ?? now,
            input.idempotencyKey ?? null,
            input.maxAttempts ?? 5,
            input.origin ?? null,
            input.payloadVersion ?? null,
          ],
        );
        if (inserted.rows[0] !== undefined) {
          return { outcome: "enqueued", job: toRecord(inserted.rows[0]) } as const;
        }
        const existing = await tx.query<JobRow>(
          `SELECT ${COLUMNS} FROM jobs
           WHERE idempotency_key = $1 AND state IN ('PENDING', 'RUNNING', 'SUCCEEDED')`,
          [input.idempotencyKey ?? ""],
        );
        const row = existing.rows[0];
        if (row === undefined) {
          throw new JobsError(
            "JOB_IDEMPOTENCY_CONFLICT",
            "conflicting recurring job is no longer available",
          );
        }
        return {
          outcome: row.state === "SUCCEEDED" ? "already_completed" : "active",
          job: toRecord(row),
        } as const;
      });
    },
  };
}
