// Layered authentication throttling (PCMS-AUTH-T010; Auth spec §35/§36).
//
// Buckets: account/email, IP/network, global — checked together, so an
// attacker rotating IPs still trips the account bucket and a victim's
// scattered attackers trip the IP bucket. Lockout is progressive
// (doubles per extra failure) with a hard cap: frustrating but never a
// permanent denial-of-service. Windows and locks expire lazily — no cron.
// Throttling must not enable user enumeration: the AUTH_THROTTLED error
// never reveals whether the throttled account exists.
import type { DbPool } from "@pcms/core";
import { AuthError } from "./errors.js";

export interface ThrottleConfig {
  /** Failures inside the counting window before any lockout applies. */
  maxFailures: number;
  /** Failure counting window (expired windows reset lazily). */
  windowMilliseconds: number;
  /** First lockout duration; doubles per additional failure. */
  baseLockoutMilliseconds: number;
  /** Hard ceiling — no permanent lockout (spec §35). */
  maxLockoutMilliseconds: number;
}

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  maxFailures: 5,
  windowMilliseconds: 15 * 60 * 1000,
  baseLockoutMilliseconds: 30 * 1000,
  maxLockoutMilliseconds: 60 * 60 * 1000,
};

/** Canonical bucket keys for the layered login throttle. */
export function loginBucketKeys(emailNormalized: string | null, ip: string | null): string[] {
  const keys: string[] = ["login:global"];
  if (emailNormalized !== null) keys.push(`login:email:${emailNormalized}`);
  if (ip !== null) keys.push(`login:ip:${ip}`);
  return keys;
}

export interface ThrottleService {
  /**
   * Throws AUTH_THROTTLED (with retry metadata) when any bucket is locked.
   * `buckets` are the layered keys, e.g. loginBucketKeys(email, ip).
   */
  assertNotLocked(buckets: readonly string[], now?: Date): Promise<void>;
  /** Records one failure against every bucket; returns the applied lockout. */
  recordFailure(buckets: readonly string[], now?: Date): Promise<number>;
  /** Clears the counters (successful authentication). */
  recordSuccess(buckets: readonly string[]): Promise<void>;
  /** Remaining lockout for the most-restrictive bucket, 0 if unlocked. */
  lockedForMilliseconds(buckets: readonly string[], now?: Date): Promise<number>;
}

export function createThrottleService(
  pool: DbPool,
  config: Partial<ThrottleConfig> = {},
): ThrottleService {
  const limits: ThrottleConfig = { ...DEFAULT_THROTTLE_CONFIG, ...config };

  function lockoutFor(failCount: number): number {
    if (failCount <= limits.maxFailures) return 0;
    // The (maxFailures+1)-th failure locks for the base duration; every
    // further failure doubles it, up to the cap.
    const extra = failCount - limits.maxFailures - 1;
    const ms = limits.baseLockoutMilliseconds * 2 ** extra;
    return Math.min(ms, limits.maxLockoutMilliseconds);
  }

  return {
    async assertNotLocked(buckets, now) {
      const lockedMs = await this.lockedForMilliseconds(buckets, now);
      if (lockedMs > 0) {
        throw new AuthError("AUTH_THROTTLED", "too many attempts; try again later", 429);
      }
    },

    async recordFailure(buckets, now) {
      const at = now ?? new Date();
      let longestLock = 0;
      await pool.withTransaction(async (tx) => {
        for (const bucket of buckets) {
          const existing = await tx.query<{
            fail_count: number;
            window_started_at: Date;
          }>(
            "SELECT fail_count, window_started_at FROM auth_throttle_buckets WHERE bucket = $1 FOR UPDATE",
            [bucket],
          );
          const row = existing.rows[0];
          let failCount: number;
          if (
            row === undefined ||
            at.getTime() - row.window_started_at.getTime() > limits.windowMilliseconds
          ) {
            failCount = 1; // window expired (or first failure) — restart counting
            await tx.query(
              `INSERT INTO auth_throttle_buckets (bucket, fail_count, window_started_at, updated_at, locked_until)
               VALUES ($1, 1, $2, $2, NULL)
               ON CONFLICT (bucket) DO UPDATE SET
                 fail_count = 1, window_started_at = $2, updated_at = $2, locked_until = NULL`,
              [bucket, at],
            );
          } else {
            failCount = row.fail_count + 1;
            const lockMs = lockoutFor(failCount);
            const lockedUntil = lockMs > 0 ? new Date(at.getTime() + lockMs) : null;
            await tx.query(
              "UPDATE auth_throttle_buckets SET fail_count = $2, updated_at = $3, locked_until = $4 WHERE bucket = $1",
              [bucket, failCount, at, lockedUntil],
            );
            longestLock = Math.max(longestLock, lockMs);
          }
        }
      });
      return longestLock;
    },

    async recordSuccess(buckets) {
      await pool.query("DELETE FROM auth_throttle_buckets WHERE bucket = ANY($1)", [buckets]);
    },

    async lockedForMilliseconds(buckets, now) {
      const at = now ?? new Date();
      const result = await pool.query<{ locked_until: Date | null }>(
        "SELECT locked_until FROM auth_throttle_buckets WHERE bucket = ANY($1) AND locked_until IS NOT NULL",
        [buckets],
      );
      let remaining = 0;
      for (const row of result.rows) {
        if (row.locked_until === null) continue;
        const left = row.locked_until.getTime() - at.getTime();
        if (left > remaining) remaining = left;
      }
      return remaining;
    },
  };
}
