// IntegrationDelivery + Attempt persistence (PCMS-INT-T004; Integrations
// spec §17/§18). Every outbound action is one server-side Delivery row with
// a complete attempt history — safe diagnostics only, never credentials or
// raw secret headers. The (outbox_event_id, binding_id, action_index)
// unique key is the DB-enforced idempotency identity (spec §11).
import { type Clock, type DbClient, type DbPool, newStableId, type StableId } from "@pcms/core";
import { IntegrationError } from "./errors.js";

export type DeliveryStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_PERMANENT"
  | "CANCELLED";

export interface IntegrationDelivery {
  /** MKT-010: outbound body format pinned at materialization (1 = legacy
   * intake.received, 2 = with data.attribution). Retries replay the pinned
   * revision — flipping the connection flag never changes existing bytes. */
  readonly bodyRevision: number;
  readonly id: StableId;
  readonly outboxEventId: string;
  readonly eventType: string;
  readonly bindingId: string;
  readonly actionIndex: number;
  readonly instanceId: string;
  readonly actionType: string;
  readonly payload: unknown;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly externalId: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface DeliveryAttempt {
  readonly id: StableId;
  readonly deliveryId: string;
  readonly attemptNo: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly result: "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_PERMANENT";
  readonly httpStatus: number | null;
  readonly providerErrorCode: string | null;
  readonly errorSummary: string | null;
}

export interface DeliveryIdentity {
  readonly outboxEventId: string;
  readonly bindingId: string;
  readonly actionIndex: number;
}

interface DeliveryRow {
  [column: string]: unknown;
  id: string;
  outbox_event_id: string;
  event_type: string;
  binding_id: string;
  action_index: number;
  instance_id: string;
  action_type: string;
  payload: unknown;
  body_revision: number;
  status: DeliveryStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | Date | null;
  external_id: string | null;
  last_error_code: string | null;
  created_at: Date;
  completed_at: string | Date | null;
}

interface AttemptRow {
  [column: string]: unknown;
  id: string;
  delivery_id: string;
  attempt_no: number;
  started_at: Date;
  finished_at: Date | null;
  result: "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_PERMANENT";
  http_status: number | null;
  provider_error_code: string | null;
  error_summary: string | null;
}

function asDate(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function rowToDelivery(row: DeliveryRow): IntegrationDelivery {
  return {
    id: row.id as StableId,
    outboxEventId: row.outbox_event_id,
    eventType: row.event_type,
    bindingId: row.binding_id,
    actionIndex: row.action_index,
    instanceId: row.instance_id,
    actionType: row.action_type,
    payload: row.payload,
    bodyRevision: row.body_revision,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: asDate(row.next_attempt_at),
    externalId: row.external_id,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    completedAt: asDate(row.completed_at),
  };
}

function rowToAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    id: row.id as StableId,
    deliveryId: row.delivery_id,
    attemptNo: row.attempt_no,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: row.result,
    httpStatus: row.http_status,
    providerErrorCode: row.provider_error_code,
    errorSummary: row.error_summary,
  };
}

const MAX_BACKOFF_MS = 3_600_000;
const LEASE_MILLISECONDS = 60_000;

export function backoffDelay(baseMs: number, attemptNo: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attemptNo - 1), MAX_BACKOFF_MS);
}

export function createDeliveryService(deps: {
  pool: DbPool;
  clock: Clock;
  privacyGuard?: (executor: DbClient, eventId: string) => Promise<boolean>;
}) {
  const { pool, clock } = deps;

  return {
    /**
     * Idempotent materialization: replays of the same event/binding/action
     * return the existing logical delivery (INSERT ... ON CONFLICT).
     */
    async materialize(delivery: {
      readonly identity: DeliveryIdentity;
      readonly eventType: string;
      readonly instanceId: string;
      readonly actionType: string;
      readonly payload: unknown;
      readonly maxAttempts: number;
      readonly bodyRevision?: number;
    }): Promise<{ readonly delivery: IntegrationDelivery; readonly created: boolean }> {
      return pool.withTransaction(async (tx) => {
        // Serialize late materialization with addressed privacy operations.
        const event = (
          await tx.query<{ privacy_blocked: boolean; privacy_retired: boolean }>(
            "SELECT privacy_blocked,privacy_retired FROM publication_outbox WHERE id=$1 FOR UPDATE",
            [delivery.identity.outboxEventId],
          )
        ).rows[0];
        const retired = event?.privacy_retired === true;
        const blocked =
          retired ||
          event?.privacy_blocked === true ||
          (await deps.privacyGuard?.(tx, delivery.identity.outboxEventId)) === true;
        const result = await tx.query<DeliveryRow>(
          `INSERT INTO integration_delivery
           (id, outbox_event_id, event_type, binding_id, action_index,
            instance_id, action_type, payload, status, max_attempts, next_attempt_at, body_revision,privacy_blocked,privacy_retired)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $13, $9, $10, $11,$12,$14)
         ON CONFLICT (outbox_event_id, binding_id, action_index) DO NOTHING
         RETURNING *`,
          [
            newStableId(),
            delivery.identity.outboxEventId,
            delivery.eventType,
            delivery.identity.bindingId,
            delivery.identity.actionIndex,
            delivery.instanceId,
            delivery.actionType,
            JSON.stringify(retired ? {} : (delivery.payload ?? null)),
            delivery.maxAttempts,
            clock.now(),
            delivery.bodyRevision ?? 1,
            blocked,
            retired ? "CANCELLED" : "PENDING",
            retired,
          ],
        );
        if (result.rows.length === 1) {
          return { delivery: rowToDelivery(result.rows[0]!), created: true };
        }
        const existing = await tx.query<DeliveryRow>(
          `SELECT * FROM integration_delivery
         WHERE outbox_event_id = $1 AND binding_id = $2 AND action_index = $3`,
          [
            delivery.identity.outboxEventId,
            delivery.identity.bindingId,
            delivery.identity.actionIndex,
          ],
        );
        return { delivery: rowToDelivery(existing.rows[0]!), created: false };
      });
    },

    /**
     * Claims due deliveries (PENDING or retryable-failed, lease expired,
     * instance enabled) as PROCESSING. Disabled instances pause their
     * deliveries without cancelling them — re-enabling resumes delivery.
     */
    async claimDue(limit: number): Promise<readonly IntegrationDelivery[]> {
      const now = clock.now();
      await pool.query(
        `UPDATE integration_delivery SET status = 'PENDING', next_attempt_at = $1
         WHERE status = 'PROCESSING' AND next_attempt_at < $1 AND pg_try_advisory_xact_lock(hashtextextended('pcms:privacy:outbox:' || outbox_event_id::text,0))`,
        [new Date(now.getTime() - LEASE_MILLISECONDS)],
      );
      const claimed = await pool.query<DeliveryRow>(
        `UPDATE integration_delivery d
         SET status = 'PROCESSING', next_attempt_at = $1
         WHERE d.id IN (
           SELECT d2.id FROM integration_delivery d2
           JOIN integration_instance i ON i.id = d2.instance_id
           WHERE d2.status IN ('PENDING', 'FAILED_RETRYABLE')
             AND d2.next_attempt_at <= $1 AND i.enabled AND NOT d2.privacy_blocked
           ORDER BY d2.next_attempt_at, d2.id
           LIMIT $2
           FOR UPDATE OF d2 SKIP LOCKED
         )
         RETURNING d.*`,
        [now, Math.max(1, Math.min(limit, 500))],
      );
      return claimed.rows.map(rowToDelivery);
    },

    /** Only the network call holds this session; preparation uses no lease. */
    async withExecution<T>(
      delivery: IntegrationDelivery,
      work: (executor: DbClient) => Promise<T>,
    ): Promise<T | undefined> {
      return pool.withClient(async (executor) => {
        const key = "pcms:privacy:outbox:" + delivery.outboxEventId;
        const lock = await executor.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [key],
        );
        if (lock.rows[0]?.locked !== true) return undefined;
        try {
          const row = (
            await executor.query<DeliveryRow>("SELECT * FROM integration_delivery WHERE id=$1", [
              delivery.id,
            ])
          ).rows[0];
          if (
            !row ||
            row.privacy_blocked === true ||
            row.status !== "PROCESSING" ||
            row.attempt_count !== delivery.attemptCount
          )
            return undefined;
          // A lost DB session can release the lock while HTTP is still in flight.
          // Preserve this uncertainty for addressed external-copy followups.
          await executor.query(
            "UPDATE integration_delivery SET external_copy_possible=true WHERE id=$1",
            [delivery.id],
          );
          return await work(executor);
        } finally {
          try {
            await executor.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
          } catch (error) {
            executor.discard?.(
              error instanceof Error ? error : new Error("dispatch lock cleanup failed"),
            );
            // The outcome is already persisted; do not turn cleanup into a resend.
          }
        }
      });
    },
    async claimOne(id: string): Promise<IntegrationDelivery | null> {
      const row = (
        await pool.query<DeliveryRow>(
          "UPDATE integration_delivery SET status='PROCESSING',next_attempt_at=$2 WHERE id=$1 AND status='PENDING' AND NOT privacy_blocked RETURNING *",
          [id, clock.now()],
        )
      ).rows[0];
      return row ? rowToDelivery(row) : null;
    },

    /** Persists one attempt and folds its result into the delivery state. */
    async recordAttempt(
      delivery: IntegrationDelivery,
      outcome: {
        readonly ok: boolean;
        readonly retryable: boolean;
        readonly backoffBaseMs: number;
        readonly externalId?: string;
        readonly httpStatus?: number;
        readonly providerErrorCode?: string;
        readonly errorMessage?: string;
      },
      executor: DbClient = pool,
    ): Promise<IntegrationDelivery> {
      const attemptNo = delivery.attemptCount + 1;
      const now = clock.now();
      const result = outcome.ok
        ? ("SUCCEEDED" as const)
        : outcome.retryable
          ? ("FAILED_RETRYABLE" as const)
          : ("FAILED_PERMANENT" as const);
      const exhausted = !outcome.ok && outcome.retryable && attemptNo >= delivery.maxAttempts;
      const status: DeliveryStatus = outcome.ok
        ? "SUCCEEDED"
        : outcome.retryable && !exhausted
          ? "FAILED_RETRYABLE"
          : "FAILED_PERMANENT";
      const backoff = backoffDelay(outcome.backoffBaseMs, attemptNo);
      const updated = await executor.query<DeliveryRow>(
        `UPDATE integration_delivery
         SET status = $2,
             attempt_count = $3,
             next_attempt_at = CASE WHEN $2 = 'FAILED_RETRYABLE' THEN $4::timestamptz ELSE NULL END,
             external_id = COALESCE($5, external_id),
             last_error_code = $6,
             completed_at = CASE WHEN $2 IN ('SUCCEEDED', 'FAILED_PERMANENT') THEN $7 ELSE completed_at END
         WHERE id = $1 AND NOT privacy_blocked
         RETURNING *`,
        [
          delivery.id,
          status,
          attemptNo,
          new Date(now.getTime() + backoff),
          outcome.externalId ?? null,
          outcome.ok ? null : (outcome.providerErrorCode ?? "INTEGRATION_DELIVERY_FAILED"),
          now,
        ],
      );
      if (updated.rows.length === 0)
        throw new IntegrationError("INTEGRATION_DELIVERY_STATE", "delivery is privacy-blocked");
      await executor.query(
        `INSERT INTO integration_delivery_attempt
           (id, delivery_id, attempt_no, started_at, finished_at, result,
            http_status, provider_error_code, error_summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newStableId(),
          delivery.id,
          attemptNo,
          now,
          now,
          result,
          outcome.httpStatus ?? null,
          outcome.providerErrorCode ?? null,
          outcome.errorMessage === undefined ? null : outcome.errorMessage.slice(0, 500),
        ],
      );
      return rowToDelivery(updated.rows[0]!);
    },

    async get(id: string): Promise<{
      readonly delivery: IntegrationDelivery;
      readonly attempts: readonly DeliveryAttempt[];
    } | null> {
      const rows = await pool.query<DeliveryRow>(
        `SELECT * FROM integration_delivery WHERE id = $1`,
        [id],
      );
      if (rows.rows.length !== 1) return null;
      const attempts = await pool.query<AttemptRow>(
        `SELECT * FROM integration_delivery_attempt WHERE delivery_id = $1 ORDER BY attempt_no`,
        [id],
      );
      return {
        delivery: rowToDelivery(rows.rows[0]!),
        attempts: attempts.rows.map(rowToAttempt),
      };
    },

    async list(options?: {
      readonly status?: DeliveryStatus;
      readonly eventId?: string;
      readonly instanceId?: string;
      readonly limit?: number;
      readonly before?: string;
    }): Promise<readonly IntegrationDelivery[]> {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options?.status !== undefined) {
        params.push(options.status);
        conditions.push(`status = $${params.length}`);
      }
      if (options?.eventId !== undefined) {
        params.push(options.eventId);
        conditions.push(`outbox_event_id = $${params.length}`);
      }
      if (options?.instanceId !== undefined) {
        params.push(options.instanceId);
        conditions.push(`instance_id = $${params.length}`);
      }
      if (options?.before !== undefined) {
        params.push(options.before);
        conditions.push(
          `(created_at, id) < ((SELECT created_at FROM integration_delivery WHERE id = $${params.length}), $${params.length})`,
        );
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(Math.min(options?.limit ?? 50, 200));
      const rows = await pool.query<DeliveryRow>(
        `SELECT * FROM integration_delivery ${where}
         ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
      return rows.rows.map(rowToDelivery);
    },

    /** Manual retry (permission-gated upstream): re-arm a failed delivery. */
    async retry(id: string): Promise<IntegrationDelivery> {
      const result = await pool.query<DeliveryRow>(
        `UPDATE integration_delivery
         SET status = 'PENDING', next_attempt_at = $2, completed_at = NULL
         WHERE id = $1 AND NOT privacy_blocked AND status IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CANCELLED')
         RETURNING *`,
        [id, clock.now()],
      );
      if (result.rows.length !== 1) {
        throw new IntegrationError(
          "INTEGRATION_DELIVERY_STATE",
          `delivery ${id} is not in a retryable state`,
        );
      }
      return rowToDelivery(result.rows[0]!);
    },

    async cancel(id: string): Promise<IntegrationDelivery> {
      const result = await pool.query<DeliveryRow>(
        `UPDATE integration_delivery
         SET status = 'CANCELLED', next_attempt_at = NULL,
             completed_at = COALESCE(completed_at, $2)
         WHERE id = $1 AND status IN ('PENDING', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')
         RETURNING *`,
        [id, clock.now()],
      );
      if (result.rows.length !== 1) {
        throw new IntegrationError(
          "INTEGRATION_DELIVERY_STATE",
          `delivery ${id} cannot be cancelled from its current state`,
        );
      }
      return rowToDelivery(result.rows[0]!);
    },

    async stats(): Promise<Record<DeliveryStatus, number>> {
      const result = await pool.query<{ status: string; count: string }>(
        `SELECT status, count(*) AS count FROM integration_delivery GROUP BY status`,
      );
      const counts: Record<DeliveryStatus, number> = {
        PENDING: 0,
        PROCESSING: 0,
        SUCCEEDED: 0,
        FAILED_RETRYABLE: 0,
        FAILED_PERMANENT: 0,
        CANCELLED: 0,
      };
      for (const row of result.rows) counts[row.status as DeliveryStatus] = Number(row.count);
      return counts;
    },
  };
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;
