// TOTP MFA service (PCMS-AUTH-T011/T012; Auth spec §20–§22).
//
// First-class v1 MFA: enroll (secret shown exactly once, encrypted at rest
// immediately), confirm by presenting a valid first code, verify with a
// small ±1 step window, and replay protection via the last-consumed time
// step. Verification attempts are throttled per user through the layered
// throttle service. TOTP computation is delegated to the pinned `otpauth`
// package (ADR-0007); storage, replay policy and throttling live here.
import { randomBytes } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { Secret, TOTP } from "otpauth";
import { AuthError } from "./errors.js";
import { createSecretBox, type SecretBox } from "./secret-box.js";
import { recordSecurityEvent, type SecurityEventSink } from "./security-events.js";
import type { ThrottleService } from "./throttle.js";

export interface TotpService {
  /**
   * Generates a fresh secret for the user, stores it ENCRYPTED and pending
   * confirmation, returns the raw secret (base32 key + provisioning URI for
   * the QR code) exactly once — later reads never return the value.
   */
  startEnrollment(
    userId: string,
    input: { issuer: string; accountLabel: string },
  ): Promise<{ secretBase32: string; otpauthUri: string }>;
  /** Confirms enrollment by verifying the first code against the pending secret. */
  confirmEnrollment(userId: string, code: string, options?: { now?: Date }): Promise<void>;
  hasConfirmedTotp(userId: string): Promise<boolean>;
  hasPendingTotp(userId: string): Promise<boolean>;
  /**
   * Verifies a login/step-up code: window ±1 step, replay-rejected via the
   * last-consumed step, throttled per user. Failures feed the throttle;
   * successes clear the attempt budget.
   */
  verifyCode(userId: string, code: string, options?: { now?: Date }): Promise<boolean>;
  /** Operator/admin reset (privileged security event, spec §26). */
  disableTotp(userId: string, byDescription: string): Promise<void>;
}

type TotpRow = {
  user_id: string;
  secret_encrypted: Buffer;
  digits: number;
  period_seconds: number;
  algorithm: string;
  pending: boolean;
  confirmed_at: Date | null;
  last_used_step: string | null;
  disabled_at: Date | null;
};

const DIGITS = 6;
const PERIOD_SECONDS = 30;

export function createTotpService(
  pool: DbPool,
  deps: {
    /**
     * Raw encryption key material from the secret channel (spec §67).
     * Required for enrollment/verification; management-only consumers
     * (operator CLI disable) may omit it.
     */
    encryptionKey?: string;
    throttle: ThrottleService;
    securitySink?: SecurityEventSink | null;
  },
): TotpService {
  const box: SecretBox | null =
    deps.encryptionKey === undefined ? null : createSecretBox(deps.encryptionKey);

  function requireBox(): SecretBox {
    if (box === null) {
      throw new AuthError(
        "AUTH_CONFIGURATION",
        "TOTP encryption key is not configured in this process; enrollment/verification unavailable",
      );
    }
    return box;
  }

  function buildTotp(secretBase32: string, issuer: string, label: string): TOTP {
    return new TOTP({
      issuer,
      label,
      algorithm: "SHA1", // authenticator-app compatibility baseline
      digits: DIGITS,
      period: PERIOD_SECONDS,
      secret: Secret.fromBase32(secretBase32),
    });
  }

  async function loadRow(userId: string): Promise<TotpRow | null> {
    const result = await pool.query<TotpRow>("SELECT * FROM auth_totp WHERE user_id = $1", [
      userId,
    ]);
    return result.rows[0] ?? null;
  }

  return {
    async startEnrollment(userId, input) {
      const raw = randomBytes(20); // RFC 4226 recommends >=160 bits
      const secretBase32 = new Secret({
        buffer: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      }).base32;
      const totp = buildTotp(secretBase32, input.issuer, input.accountLabel);
      const encrypted = requireBox().encrypt(secretBase32);
      await pool.withTransaction(async (tx) => {
        // Restarting enrollment replaces any prior record; only a confirmed
        // enrollment is authoritative for verification.
        await tx.query("DELETE FROM auth_totp WHERE user_id = $1", [userId]);
        await tx.query(
          "INSERT INTO auth_totp (user_id, secret_encrypted, pending) VALUES ($1, $2, true)",
          [userId, encrypted],
        );
      });
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "MFA_ENROLLED",
        actorType: "USER",
        actorId: userId,
        subjectType: "user",
        subjectId: userId,
        metadata: { stage: "started" },
      });
      return { secretBase32, otpauthUri: totp.toString() };
    },

    async confirmEnrollment(userId, code, options) {
      const row = await loadRow(userId);
      // A disabled enrollment is gone: it can never be confirmed/reactivated.
      if (row === null || !row.pending || row.disabled_at !== null) {
        throw new AuthError("AUTH_VALIDATION", "no pending TOTP enrollment", 404);
      }
      const secretBase32 = requireBox().decrypt(row.secret_encrypted);
      const totp = buildTotp(secretBase32, "ProgressiveCMS", "");
      const now = options?.now ?? new Date();
      const delta = totp.validate({ token: code, timestamp: now.getTime(), window: 1 });
      if (delta === null) {
        throw new AuthError("AUTH_MFA_INVALID_CODE", "invalid authenticator code", 400);
      }
      const step = Math.floor(now.getTime() / 1000 / PERIOD_SECONDS) + delta;
      await pool.query(
        "UPDATE auth_totp SET pending = false, confirmed_at = now(), last_used_step = $2 WHERE user_id = $1",
        [userId, step],
      );
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "MFA_ENROLLED",
        actorType: "USER",
        actorId: userId,
        subjectType: "user",
        subjectId: userId,
        metadata: { stage: "confirmed" },
      });
    },

    async hasConfirmedTotp(userId) {
      const row = await loadRow(userId);
      return row !== null && !row.pending && row.disabled_at === null;
    },

    async hasPendingTotp(userId) {
      const row = await loadRow(userId);
      return row !== null && row.pending && row.disabled_at === null;
    },

    async verifyCode(userId, code, options) {
      const buckets = [`totp:user:${userId}`];
      await deps.throttle.assertNotLocked(buckets, options?.now);
      const row = await loadRow(userId);
      if (row === null || row.pending || row.disabled_at !== null) {
        return false;
      }
      const secretBase32 = requireBox().decrypt(row.secret_encrypted);
      const totp = buildTotp(secretBase32, "ProgressiveCMS", "");
      const now = options?.now ?? new Date();
      const delta = totp.validate({ token: code, timestamp: now.getTime(), window: 1 });
      if (delta === null) {
        await deps.throttle.recordFailure(buckets, options?.now);
        return false;
      }
      const step = Math.floor(now.getTime() / 1000 / PERIOD_SECONDS) + delta;
      const lastUsed = row.last_used_step === null ? null : Number.parseInt(row.last_used_step, 10);
      // Replay protection (spec §22): a time step is consumed exactly once.
      if (lastUsed !== null && step <= lastUsed) {
        await deps.throttle.recordFailure(buckets, options?.now);
        return false;
      }
      await pool.query("UPDATE auth_totp SET last_used_step = $2 WHERE user_id = $1", [
        userId,
        step,
      ]);
      await deps.throttle.recordSuccess(buckets);
      return true;
    },

    async disableTotp(userId, byDescription) {
      const result = await pool.query(
        "UPDATE auth_totp SET disabled_at = now(), disabled_by = $2 WHERE user_id = $1 AND disabled_at IS NULL",
        [userId, byDescription],
      );
      if (result.rowCount === 0) {
        throw new AuthError("AUTH_VALIDATION", "no active TOTP enrollment", 404);
      }
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "MFA_DISABLED",
        actorType: "OPERATOR",
        actorId: byDescription,
        subjectType: "user",
        subjectId: userId,
        metadata: { reason: "operator_reset" },
      });
    },
  };
}
