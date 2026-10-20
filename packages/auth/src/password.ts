// Argon2id password credentials (PCMS-AUTH-T004; Auth spec §15–§17).
//
// Hashing is delegated to the pinned `argon2` package (native, PHC format);
// parameters ride in the PHC string itself, so every stored hash carries its
// own cost parameters. "Stored alongside hash" is therefore structural, and
// rehash-needed detection is a direct comparison of stored parameters against
// the current policy (§16). The parameter floor is the project security
// baseline — an operator may raise it, never silently lower it.

import type { DbPool } from "@pcms/core";
import argon2 from "argon2";
import { AuthError } from "./errors.js";

/** OWASP Password Storage Cheat Sheet floor for Argon2id (reviewed 2026-09). */
export interface Argon2Params {
  /** Memory cost in KiB. */
  memoryKiB: number;
  /** Time cost (iterations). */
  timeCost: number;
  /** Parallelism (lanes). */
  parallelism: number;
}

export const ARGON2_BASELINE: Argon2Params = {
  memoryKiB: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/** Operational sanity ranges; the security floor is checked separately. */
const ARGON2_LIMITS = {
  memoryKiB: { min: 8192, max: 2_097_152 }, // 8 MiB … 2 GiB
  timeCost: { min: 1, max: 32 },
  parallelism: { min: 1, max: 16 },
} as const;

export function assertArgon2Params(params: Argon2Params): Argon2Params {
  for (const key of ["memoryKiB", "timeCost", "parallelism"] as const) {
    const value = params[key];
    const limit = ARGON2_LIMITS[key];
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      throw new AuthError(
        "AUTH_CONFIGURATION",
        `argon2 ${key} must be an integer in [${limit.min}, ${limit.max}], got ${String(value)}`,
      );
    }
  }
  // Security floor (spec §15): below-baseline configuration is a startup
  // error, not a warning — weakening requires an explicit security decision.
  if (
    params.memoryKiB < ARGON2_BASELINE.memoryKiB ||
    params.timeCost < ARGON2_BASELINE.timeCost ||
    params.parallelism < ARGON2_BASELINE.parallelism
  ) {
    throw new AuthError(
      "AUTH_CONFIGURATION",
      `argon2 parameters below the project security baseline (m>=${ARGON2_BASELINE.memoryKiB}, t>=${ARGON2_BASELINE.timeCost}, p>=${ARGON2_BASELINE.parallelism}) are rejected`,
    );
  }
  return params;
}

function toArgon2Options(params: Argon2Params) {
  return {
    type: argon2.argon2id,
    memoryCost: params.memoryKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  } as const;
}

export interface PasswordVerifyResult {
  readonly ok: boolean;
  /** True when the stored verifier was below policy and has been rehashed. */
  readonly rehashed: boolean;
}

export interface PasswordCredentialService {
  /** Hashes a plaintext with the configured Argon2id parameters (PHC out). */
  hashPassword(plain: string): Promise<string>;
  /** Creates or replaces the user's password verifier (single active password). */
  setPassword(userId: string, phcVerifier: string): Promise<void>;
  hasPassword(userId: string): Promise<boolean>;
  /** Raw verifier lookup — callers must not log it. */
  getVerifier(userId: string): Promise<string | null>;
  /** Constant-time verification of a PHC string (vetted library primitive). */
  verifyVerifier(phcVerifier: string, plain: string): Promise<boolean>;
  /**
   * Verifies and, when the stored parameters are below the current policy,
   * transparently rehashes in place (spec §16). ok=false carries no
   * distinction between unknown user and wrong password.
   */
  verifyAndRehash(userId: string, plain: string): Promise<PasswordVerifyResult>;
  /** True when the PHC string's parameters are below the current policy. */
  needsRehash(phcVerifier: string): boolean;
}

export function createPasswordCredentialService(
  pool: DbPool,
  options: { argon2?: Partial<Argon2Params> } = {},
): PasswordCredentialService {
  const params = assertArgon2Params({ ...ARGON2_BASELINE, ...options.argon2 });

  return {
    async hashPassword(plain: string): Promise<string> {
      return argon2.hash(plain, toArgon2Options(params));
    },

    async setPassword(userId: string, phcVerifier: string): Promise<void> {
      await pool.withTransaction(async (tx) => {
        // Single active password per user: replace any existing row of the
        // kind (application-level rule; the schema stays provider-neutral
        // per Auth spec §64 — no UNIQUE(user_id, kind)).
        await tx.query("DELETE FROM auth_credentials WHERE user_id = $1 AND kind = 'password'", [
          userId,
        ]);
        await tx.query(
          `INSERT INTO auth_credentials (id, user_id, kind, verifier)
           VALUES (gen_random_uuid(), $1, 'password', $2)`,
          [userId, phcVerifier],
        );
      });
    },

    async hasPassword(userId: string): Promise<boolean> {
      const result = await pool.query(
        "SELECT 1 FROM auth_credentials WHERE user_id = $1 AND kind = 'password'",
        [userId],
      );
      return result.rows.length > 0;
    },

    async getVerifier(userId: string): Promise<string | null> {
      const result = await pool.query<{ verifier: string }>(
        "SELECT verifier FROM auth_credentials WHERE user_id = $1 AND kind = 'password'",
        [userId],
      );
      return result.rows[0]?.verifier ?? null;
    },

    verifyVerifier(phcVerifier: string, plain: string): Promise<boolean> {
      return argon2.verify(phcVerifier, plain);
    },

    async verifyAndRehash(userId: string, plain: string): Promise<PasswordVerifyResult> {
      const verifier = await this.getVerifier(userId);
      if (verifier === null) {
        // Same cost path as a real verify so unknown accounts are not
        // timing-distinguishable from wrong passwords (spec §36).
        await argon2.verify(DUMMY_VERIFIER, plain);
        return { ok: false, rehashed: false };
      }
      const ok = await argon2.verify(verifier, plain);
      if (!ok) return { ok: false, rehashed: false };
      if (argon2.needsRehash(verifier, toArgon2Options(params))) {
        const upgraded = await argon2.hash(plain, toArgon2Options(params));
        await pool.query(
          "UPDATE auth_credentials SET verifier = $2, updated_at = now() WHERE user_id = $1 AND kind = 'password'",
          [userId, upgraded],
        );
        return { ok: true, rehashed: true };
      }
      return { ok: true, rehashed: false };
    },

    needsRehash(phcVerifier: string): boolean {
      return argon2.needsRehash(phcVerifier, toArgon2Options(params));
    },
  };
}

/**
 * A real Argon2id hash of an unguessable random string, used to equalize the
 * login timing for accounts that have no password row. Generated once per
 * process; its parameters do not matter for the equality argument beyond
 * being Argon2id.
 */
const DUMMY_VERIFIER = await argon2.hash("not a credential — timing equalization dummy", {
  type: argon2.argon2id,
  memoryCost: ARGON2_BASELINE.memoryKiB,
  timeCost: ARGON2_BASELINE.timeCost,
  parallelism: ARGON2_BASELINE.parallelism,
});
