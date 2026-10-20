// Recovery codes (PCMS-AUTH-T013; Auth spec §25).
//
// Generated once, displayed once (the raw codes exist only in the return
// value for the one-time render/download), stored as SHA-256 hashes, each
// single-use via a transactional claim, and usage is audited. Regenerating
// invalidates the previous unused set. A recovery code is an MFA RECOVERY
// factor — it never silently removes MFA (spec §25/§26). Codes are never
// logged by this module; the no-secrets rule applies to events too.
import { createHash, randomBytes } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import { recordSecurityEvent, type SecurityEventSink } from "./security-events.js";

export const RECOVERY_CODE_COUNT = 10;

export interface RecoveryCodeService {
  /** Replaces the user's set; returns the raw codes exactly once. */
  regenerateCodes(userId: string): Promise<string[]>;
  /** Verifies a code and consumes it atomically; false on any mismatch. */
  verifyAndConsume(userId: string, code: string): Promise<boolean>;
  /** Count of unused codes left in the current set. */
  remainingCodes(userId: string): Promise<number>;
}

export function createRecoveryCodeService(
  pool: DbPool,
  deps: { securitySink?: SecurityEventSink | null } = {},
): RecoveryCodeService {
  return {
    async regenerateCodes(userId: string): Promise<string[]> {
      const codes: string[] = [];
      const hashes: string[] = [];
      for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        // 8 bytes → 16 hex chars, grouped for human transcription.
        const hex = randomBytes(8).toString("hex");
        codes.push(
          `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`,
        );
        hashes.push(hashCode(hex));
      }
      await pool.withTransaction(async (tx) => {
        // Regeneration invalidates the previous UNUSED set (spec §25); used
        // rows remain for audit.
        await tx.query("DELETE FROM auth_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [
          userId,
        ]);
        for (const codeHash of hashes) {
          await tx.query(
            "INSERT INTO auth_recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)",
            [newStableId(), userId, codeHash],
          );
        }
      });
      return codes;
    },

    async verifyAndConsume(userId: string, code: string): Promise<boolean> {
      // Codes are stored and matched in ungrouped form; users may type them
      // grouped, so the presented code is normalized first.
      const normalized = code.replace(/[\s-]/g, "").toLowerCase();
      if (normalized.length === 0 || normalized.length > 128) return false;
      const codeHash = hashCode(normalized);
      const consumed = await pool.withTransaction(async (tx) => {
        const candidates = await tx.query<{ id: string }>(
          "SELECT id FROM auth_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL FOR UPDATE",
          [userId, codeHash],
        );
        const row = candidates.rows[0];
        if (row === undefined) return false;
        const result = await tx.query(
          "UPDATE auth_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL",
          [row.id],
        );
        return result.rowCount === 1;
      });
      if (consumed) {
        await recordSecurityEvent(pool, deps.securitySink, {
          type: "MFA_RECOVERY_USED",
          actorType: "USER",
          actorId: userId,
          subjectType: "user",
          subjectId: userId,
        });
      }
      return consumed;
    },

    async remainingCodes(userId: string): Promise<number> {
      const result = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM auth_recovery_codes WHERE user_id = $1 AND used_at IS NULL",
        [userId],
      );
      return Number.parseInt(result.rows[0]?.n ?? "0", 10);
    },
  };
}

function hashCode(normalizedHex: string): string {
  // 64-bit entropy codes: a fast SHA-256 hash is the appropriate verifier
  // (they are not user-chosen secrets); constant-time comparison is not
  // needed for an indexed equality lookup of a high-entropy random value.
  return createHash("sha256").update(normalizedHex, "utf8").digest("hex");
}
