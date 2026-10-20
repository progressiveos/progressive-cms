// Durable idempotency (PCMS-API-T007; API spec §10–§11, owner instructions
// #29–#31). PostgreSQL-backed — retries survive process restarts; never
// in-memory. Protocol per key+scope:
//   BEGIN: insert (key,scope) row status=PENDING + request fingerprint.
//     - row exists, same fingerprint, COMPLETED → replay stored response.
//     - row exists, different fingerprint → IDEMPOTENCY_KEY_CONFLICT (409).
//     - row exists, PENDING → another execution is in flight (or crashed
//       before expiry): IDEMPOTENCY_IN_PROGRESS, retryable.
//   run(): the operation executes; on success the row becomes COMPLETED with
//   the response snapshot in the same transaction window; on failure the
//   PENDING row is released so an honest retry can run.
import { createHash } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { ApiError } from "../errors.js";

export const IDEMPOTENCY_TTL_MILLISECONDS = 24 * 3_600_000;

export interface IdempotencyRun<T> {
  readonly operation: string;
  readonly key: string;
  readonly scope: string;
  /** Canonical request payload; hashed into the replay-conflict check. */
  readonly fingerprint: unknown;
  readonly run: () => Promise<T>;
  readonly ttlMilliseconds?: number;
}

export interface IdempotencyOutcome<T> {
  readonly result: T;
  readonly replayed: boolean;
}

interface Row {
  [column: string]: unknown;
  status: string;
  request_hash: string;
  response: unknown;
}

function fingerprintHash(fingerprint: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(fingerprint ?? null), "utf8")
    .digest("hex");
}

function assertKey(key: string): void {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new ApiError(
      "API_REQUEST_INVALID",
      "Idempotency-Key must be 8..200 chars of [A-Za-z0-9._:-]",
      { status: 400 },
    );
  }
}

export function createIdempotencyService(pool: DbPool) {
  return {
    /** Purges expired rows; safe to call opportunistically. */
    async purgeExpired(): Promise<void> {
      await pool.query(`DELETE FROM api_idempotency WHERE expires_at < now()`);
    },

    async run<T>(spec: IdempotencyRun<T>): Promise<IdempotencyOutcome<T>> {
      assertKey(spec.key);
      const hash = fingerprintHash(spec.fingerprint);
      const scopeHash = fingerprintHash(spec.scope);
      const inserted = await pool.query(
        `INSERT INTO api_idempotency (key, scope, operation, request_hash, status, expires_at)
         VALUES ($1, $2, $3, $4, 'PENDING', now() + make_interval(secs => $5))
         ON CONFLICT (key, scope) DO NOTHING`,
        [
          spec.key,
          scopeHash,
          spec.operation,
          hash,
          (spec.ttlMilliseconds ?? IDEMPOTENCY_TTL_MILLISECONDS) / 1000,
        ],
      );
      if ((inserted.rowCount ?? 0) === 1) {
        try {
          const result = await spec.run();
          await pool.query(
            `UPDATE api_idempotency SET status = 'COMPLETED', response = $3
             WHERE key = $1 AND scope = $2 AND status = 'PENDING'`,
            [spec.key, scopeHash, JSON.stringify(result) as never],
          );
          return { result, replayed: false };
        } catch (error) {
          // Release the claim: a failed operation may be honestly retried.
          await pool.query(
            `DELETE FROM api_idempotency WHERE key = $1 AND scope = $2 AND status = 'PENDING'`,
            [spec.key, scopeHash],
          );
          throw error;
        }
      }

      const existing = await pool.query<Row>(
        `SELECT status, request_hash, response FROM api_idempotency
         WHERE key = $1 AND scope = $2 AND expires_at > now()`,
        [spec.key, scopeHash],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        // The expired claim was purged between insert and select; let the
        // caller retry the whole thing.
        throw new ApiError("IDEMPOTENCY_IN_PROGRESS", "idempotency key expired; retry", {
          status: 409,
          retryable: true,
        });
      }
      if (row.request_hash !== hash) {
        throw new ApiError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "Idempotency-Key was already used with a different request body",
          { status: 409 },
        );
      }
      if (row.status === "COMPLETED") {
        // jsonb arrives already parsed from the driver.
        return { result: row.response as T, replayed: true };
      }
      throw new ApiError("IDEMPOTENCY_IN_PROGRESS", "an identical request is in flight", {
        status: 409,
        retryable: true,
      });
    },
  };
}

export type IdempotencyService = ReturnType<typeof createIdempotencyService>;
