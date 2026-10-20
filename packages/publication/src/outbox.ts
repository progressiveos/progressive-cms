// Transactional Outbox service (PCMS-PUB-T009). `writeOutboxEvent` is called
// inside the publishing transaction; the OutboxService delivers events
// at-least-once with bounded retries and dead-lettering (spec §55/§56).
// Claiming uses FOR UPDATE SKIP LOCKED so multiple workers never deliver the
// same event concurrently; expired claims are recovered (worker death).
import { type Clock, type DbClient, type DbPool, newStableId, type StableId } from "@pcms/core";

export interface OutboxEventInput {
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

/** Write inside the caller's transaction — atomicity boundary (spec §19). */
export function writeOutboxEvent(executor: DbClient, event: OutboxEventInput): Promise<void> {
  return executor
    .query(
      `INSERT INTO publication_outbox (id, aggregate, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5)`,
      [
        newStableId(),
        event.aggregate,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload ?? null),
      ],
    )
    .then(() => undefined);
}

export interface OutboxEvent {
  readonly id: StableId;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly createdAt: Date;
}

interface OutboxRow {
  [column: string]: unknown;
  id: string;
  aggregate: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
}

export interface OutboxStats {
  readonly pending: number;
  readonly processing: number;
  readonly dead: number;
  readonly done: number;
}

export interface OutboxService {
  /** Deterministic FIFO batch claim (available_at, id order). */
  claimBatch(limit: number): Promise<OutboxEvent[]>;
  complete(eventId: StableId): Promise<void>;
  /** Retry with exponential backoff; DEAD after maxAttempts. */
  fail(eventId: StableId, error: unknown): Promise<void>;
  /** Requeue events whose worker died mid-delivery (expired claim lease). */
  recoverExpiredClaims(): Promise<number>;
  /** Bounded, deterministic inspection for operators (spec §65). */
  listDeadLetters(options?: {
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<readonly (OutboxEvent & { readonly lastError: string | null })[]>;
  retryDeadLetter(eventId: StableId): Promise<void>;
  stats(): Promise<OutboxStats>;
}

/**
 * Consumer contract (PCMS-PUB-T026, spec §55/§56): handlers receive events
 * at-least-once and MUST be idempotent — dedupe on `event.id`. Suitable for
 * cache invalidation, sitemap refresh, search indexing, webhooks, media
 * prewarm and notifications; M07 ships no concrete consumers of those kinds
 * (M11/M13 own them).
 */
export type OutboxDeliveryHandler = (event: OutboxEvent) => Promise<void>;

export interface OutboxConsumer {
  /** Delivers up to `limit` due events; returns the delivered count. */
  processBatch(limit: number): Promise<number>;
}

/** Match by exact event type; `"*"` handles the rest (deterministic order:
 * exact match first). */
export function createOutboxConsumer(
  outbox: OutboxService,
  handlers: Readonly<Record<string, OutboxDeliveryHandler>>,
  options?: { readonly fallback?: OutboxDeliveryHandler; readonly deadLetterUnknown?: boolean },
): OutboxConsumer {
  return {
    async processBatch(limit) {
      const events = await outbox.claimBatch(limit);
      for (const event of events) {
        const handler = handlers[event.eventType] ?? options?.fallback;
        if (handler === undefined) {
          // No consumer registered: without a fallback the event dead-letters
          // instead of spinning in requeue forever.
          await outbox.fail(event.id, new Error(`no outbox consumer for "${event.eventType}"`));
          continue;
        }
        try {
          await handler(event);
        } catch (error) {
          await outbox.fail(event.id, error);
          continue;
        }
        await outbox.complete(event.id);
      }
      return events.length;
    },
  };
}

const CLAIM_LEASE_MILLISECONDS = 60_000;

export function createOutboxService(
  pool: DbPool,
  deps: {
    readonly clock: Clock;
    readonly maxAttempts?: number;
    readonly backoffBaseMilliseconds?: number;
  },
): OutboxService {
  const maxAttempts = deps.maxAttempts ?? 10;
  const backoffBase = deps.backoffBaseMilliseconds ?? 1_000;

  return {
    async claimBatch(limit) {
      return pool.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE publication_outbox SET state = 'PENDING', claimed_at = NULL,
             claim_expires_at = NULL
           WHERE state = 'PROCESSING' AND claim_expires_at < $1`,
          [deps.clock.now()],
        );
        const claimed = await tx.query<OutboxRow>(
          `UPDATE publication_outbox
           SET state = 'PROCESSING', claimed_at = $1,
               claim_expires_at = $1 + interval '60000 milliseconds',
               attempts = attempts + 1
           WHERE id IN (
             SELECT id FROM publication_outbox
             WHERE state = 'PENDING' AND available_at <= $1 AND NOT privacy_blocked
             ORDER BY available_at, id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           RETURNING id, aggregate, aggregate_id, event_type, payload, attempts, created_at`,
          [deps.clock.now(), Math.max(1, Math.min(limit, 1000))],
        );
        return claimed.rows.map((row) => ({
          id: row.id as StableId,
          aggregate: row.aggregate,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          attempts: row.attempts,
          createdAt: row.created_at,
        }));
      });
    },

    async complete(eventId) {
      await pool.query(
        `UPDATE publication_outbox
         SET state = 'DONE', processed_at = $2, claim_expires_at = NULL
         WHERE id = $1`,
        [eventId, deps.clock.now()],
      );
    },

    async fail(eventId, error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = await pool.query<{ attempts: number }>(
        `SELECT attempts FROM publication_outbox WHERE id = $1`,
        [eventId],
      );
      if (current.rows.length !== 1) return;
      const attempts = current.rows[0]!.attempts;
      const dead = attempts >= maxAttempts;
      const delayMs = backoffBase * 2 ** Math.min(attempts - 1, 16);
      const availableAt = new Date(deps.clock.now().getTime() + delayMs);
      await pool.query(
        `UPDATE publication_outbox
         SET state = (CASE WHEN $3::boolean THEN 'DEAD' ELSE 'PENDING' END),
             available_at = $4,
             last_error = $5,
             claimed_at = NULL,
             claim_expires_at = NULL,
             processed_at = (CASE WHEN $3::boolean THEN $2 ELSE processed_at END)
         WHERE id = $1`,
        [eventId, deps.clock.now(), dead, availableAt, message.slice(0, 2000)],
      );
    },

    async recoverExpiredClaims() {
      const result = await pool.query<{ id: string }>(
        `UPDATE publication_outbox
         SET state = 'PENDING', claimed_at = NULL, claim_expires_at = NULL
         WHERE state = 'PROCESSING' AND claim_expires_at < $1
         RETURNING id`,
        [deps.clock.now()],
      );
      return result.rows.length;
    },

    async listDeadLetters(options) {
      const limit = Math.min(options?.limit ?? 100, 1000);
      const offset = Math.max(options?.offset ?? 0, 0);
      const result = await pool.query<OutboxRow & { last_error: string | null }>(
        `SELECT id, aggregate, aggregate_id, event_type, payload, attempts, created_at, last_error
         FROM publication_outbox WHERE state = 'DEAD'
         ORDER BY created_at, id
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows.map((row) => ({
        id: row.id as StableId,
        aggregate: row.aggregate,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        attempts: row.attempts,
        createdAt: row.created_at,
        lastError: row.last_error,
      }));
    },

    async retryDeadLetter(eventId) {
      const result = await pool.query<{ id: string }>(
        `UPDATE publication_outbox
         SET state = 'PENDING', available_at = $2, attempts = 0, last_error = NULL
         WHERE id = $1 AND state = 'DEAD' AND NOT privacy_blocked
         RETURNING id`,
        [eventId, deps.clock.now()],
      );
      return result.rows.length === 1 ? undefined : Promise.reject(new Error("not dead"));
    },

    async stats() {
      const result = await pool.query<{ state: string; count: string }>(
        `SELECT state, count(*) AS count FROM publication_outbox GROUP BY state`,
      );
      const byState = new Map(result.rows.map((row) => [row.state, Number(row.count)]));
      return {
        pending: byState.get("PENDING") ?? 0,
        processing: byState.get("PROCESSING") ?? 0,
        dead: byState.get("DEAD") ?? 0,
        done: byState.get("DONE") ?? 0,
      };
    },
  };
}
