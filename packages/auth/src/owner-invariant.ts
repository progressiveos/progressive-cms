// Last-active-OWNER invariant (PCMS-AUTH-T017; Auth spec §11, §40).
//
// One shared check routes every destructive path: removing the OWNER role,
// disabling a user who holds it, or any future "delete" flow. It must run
// INSIDE the transaction that performs the mutation, after taking row locks
// on the remaining active OWNER rows — two concurrent attempts serialize on
// those locks, so the second one observes the mutated state and aborts.
// (The dedicated race test in tests/auth/owner-invariant.test.ts proves the
// concurrent case against a real database.)
import type { DbClient } from "@pcms/core";
import { AuthError } from "./errors.js";

/**
 * Throws AUTH_LAST_OWNER_PROTECTED when excluding `excludingUserId` would
 * leave the installation without an active OWNER. Callers pass the id whose
 * OWNER-ness is about to be removed (role revoke or disable).
 */
export async function assertNotLastActiveOwner(
  tx: DbClient,
  excludingUserId: string,
): Promise<void> {
  // Only users who actually hold the active-OWNER role can be "the last
  // OWNER" — disabling/revoking anyone else can never orphan ownership.
  const held = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM auth_user_roles r
     JOIN users u ON u.id = r.user_id
     WHERE r.role_key = 'OWNER' AND u.status = 'ACTIVE' AND u.id = $1`,
    [excludingUserId],
  );
  if (Number.parseInt(held.rows[0]?.n ?? "0", 10) === 0) return;

  // Lock the user rows of ALL active OWNERs (target included): two
  // concurrent removals of different owners must serialize on the SAME lock
  // set, otherwise each would lock only the other's row and both could
  // commit, leaving zero owners. After acquiring the locks, the count sees
  // the winning mutation and the loser aborts.
  await tx.query(
    `SELECT u.id FROM auth_user_roles r
     JOIN users u ON u.id = r.user_id
     WHERE r.role_key = 'OWNER' AND u.status = 'ACTIVE'
     FOR UPDATE OF u`,
  );
  const result = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM auth_user_roles r
     JOIN users u ON u.id = r.user_id
     WHERE r.role_key = 'OWNER' AND u.status = 'ACTIVE' AND u.id <> $1`,
    [excludingUserId],
  );
  const remaining = Number.parseInt(result.rows[0]?.n ?? "0", 10);
  if (remaining === 0) {
    throw new AuthError(
      "AUTH_LAST_OWNER_PROTECTED",
      "cannot remove or disable the last active OWNER",
      409,
    );
  }
}

/** True when at least one ACTIVE user holds the OWNER role. */
export async function hasActiveOwner(db: DbClient): Promise<boolean> {
  const result = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM auth_user_roles r
     JOIN users u ON u.id = r.user_id
     WHERE r.role_key = 'OWNER' AND u.status = 'ACTIVE'`,
  );
  return Number.parseInt(result.rows[0]?.n ?? "0", 10) > 0;
}

/**
 * Guard for bootstrap: `create-owner` is only permitted while the
 * installation has no active OWNER yet (spec §10).
 */
export async function assertNoActiveOwner(db: DbClient): Promise<void> {
  if (await hasActiveOwner(db)) {
    throw new AuthError(
      "AUTH_LAST_OWNER_PROTECTED",
      "an active OWNER already exists; use the normal user-management flows",
      409,
    );
  }
}
