// User provisioning & recovery flows (PCMS-AUTH-T003/T006; Auth spec §9–§19).
//
// There is NO public registration: every account enters through an operator
// (bootstrap), an authorized administrator, or an invitation token issued by
// one of those flows. One-time tokens are stored as SHA-256 hashes, are
// single-use (transactional claim) and expire. Password reset responses are
// enumeration-safe: the issue step returns the same shape whether or not the
// address exists.
import { createHash, randomBytes } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import type { ActorType } from "./actor.js";
import { normalizeEmail } from "./email.js";
import { AuthError } from "./errors.js";
import { assertNoActiveOwner } from "./owner-invariant.js";
import type { PasswordCredentialService } from "./password.js";
import type { PasswordPolicy } from "./password-policy.js";
import type { RoleService } from "./roles.js";
import {
  recordSecurityEvent,
  type SecurityEventSink,
  type SecurityTransport,
} from "./security-events.js";
import type { UserIdentityService, UserRecord } from "./users.js";

export interface ProvisioningOptions {
  /** Invitation token lifetime (spec: one-time, time-limited). */
  inviteTtlMilliseconds?: number;
  /** Password-reset token lifetime. */
  resetTtlMilliseconds?: number;
}

export interface ProvisioningService {
  /**
   * Operator/CLI bootstrap of the first OWNER (spec §10). Fails once any
   * active OWNER exists. Email is operator-verified at creation.
   */
  bootstrapOwner(input: {
    displayName: string;
    email: string;
    password: string;
  }): Promise<UserRecord>;
  /**
   * Admin user creation with an initial role + invitation token (spec §9).
   * The raw token is returned once for delivery through the mail channel;
   * only its hash is stored.
   */
  createUserWithRole(input: {
    displayName: string;
    email: string;
    roleKey: string;
  }): Promise<{ user: UserRecord; inviteToken: string; expiresAt: Date }>;
  /** Admin creates an account with an initial password; email stays unverified. */
  createUserWithPassword(input: {
    displayName: string;
    email: string;
    roleKey: string;
    password: string;
    creator: { actorType: ActorType; actorId: string; transport: SecurityTransport };
  }): Promise<UserRecord>;
  /** Invitation acceptance: sets the first password, verifies the email. */
  acceptInvite(input: { inviteToken: string; password: string }): Promise<UserRecord>;
  /**
   * Password reset request (spec §18). Enumeration-safe: returns null both
   * when the address is unknown and when mail cannot be delivered — callers
   * respond identically. The raw token exists only in the return value for
   * the mail adapter.
   */
  issuePasswordReset(input: { email: string }): Promise<{ resetToken: string | null }>;
  /** Reset acceptance: one-time token, sets password, revokes sessions. */
  resetPassword(input: { resetToken: string; password: string }): Promise<{ userId: string }>;
}

export function createProvisioningService(
  pool: DbPool,
  deps: {
    users: UserIdentityService;
    passwords: PasswordCredentialService;
    policy: PasswordPolicy;
    roles: RoleService;
    securitySink?: SecurityEventSink | null;
    /**
     * Invoked after a password changes (invite acceptance / reset) so the
     * session layer can revoke existing sessions (spec §18; wired by the
     * composition root once sessions exist).
     */
    onPasswordChanged?: (userId: string) => Promise<void>;
  },
  options: ProvisioningOptions = {},
): ProvisioningService {
  const inviteTtl = options.inviteTtlMilliseconds ?? 7 * 24 * 60 * 60 * 1000;
  const resetTtl = options.resetTtlMilliseconds ?? 60 * 60 * 1000;

  async function createOneTimeToken(
    userId: string,
    kind: "invite" | "password_reset",
    ttlMilliseconds: number,
    createdBy: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + ttlMilliseconds);
    await pool.query(
      `INSERT INTO auth_one_time_tokens (id, user_id, kind, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newStableId(), userId, kind, tokenHash, expiresAt, createdBy],
    );
    return { token, expiresAt };
  }

  /** Transactional single-use claim; rejects unknown/expired/replayed tokens. */
  async function claimOneTimeToken(
    token: string,
    kind: "invite" | "password_reset",
  ): Promise<{ id: string; userId: string }> {
    const tokenHash = sha256(token);
    const claimResult = await pool.withTransaction(async (tx) => {
      const found = await tx.query<{ id: string; user_id: string; expires_at: Date }>(
        "SELECT id, user_id, expires_at FROM auth_one_time_tokens WHERE token_hash = $1 AND kind = $2",
        [tokenHash, kind],
      );
      const row = found.rows[0];
      if (row === undefined) {
        throw new AuthError("AUTH_TOKEN_INVALID", "token is not valid", 400);
      }
      if (row.expires_at.getTime() <= Date.now()) {
        throw new AuthError("AUTH_TOKEN_EXPIRED", "token has expired", 400);
      }
      const claimed = await tx.query(
        "UPDATE auth_one_time_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL",
        [row.id],
      );
      if (claimed.rowCount === 0) {
        throw new AuthError("AUTH_TOKEN_INVALID", "token was already used", 400);
      }
      return { id: row.id, userId: row.user_id };
    });
    return claimResult;
  }

  return {
    async bootstrapOwner(input): Promise<UserRecord> {
      await deps.policy.validate(input.password); // before hashing (fail fast)
      const verifier = await deps.passwords.hashPassword(input.password);
      const userId = newStableId();
      // Advisory lock serializes concurrent bootstraps on the same database.
      await pool.withTransaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('pcms:auth:bootstrap-owner'))");
        await assertNoActiveOwner(tx);
        await tx.query("INSERT INTO users (id, display_name, status) VALUES ($1, $2, 'ACTIVE')", [
          userId,
          input.displayName.trim(),
        ]);
        await tx.query(
          `INSERT INTO user_emails (user_id, email_normalized, email_display, verified_at, is_primary)
           VALUES ($1, $2, $3, now(), true)`,
          [userId, normalizeEmail(input.email), input.email.trim()],
        );
        await tx.query(
          "INSERT INTO auth_credentials (id, user_id, kind, verifier) VALUES ($1, $2, 'password', $3)",
          [newStableId(), userId, verifier],
        );
        await tx.query(
          "INSERT INTO auth_user_roles (user_id, role_key, granted_by) VALUES ($1, 'OWNER', $2)",
          [userId, "operator:bootstrap"],
        );
        // Through the tx client: the pool has its single connection busy
        // with this transaction (a pool.query here would deadlock a max:1
        // pool) and the event must commit atomically with the bootstrap.
        await recordSecurityEvent(tx, deps.securitySink, {
          type: "OWNER_BOOTSTRAPPED",
          actorType: "OPERATOR",
          actorId: "operator:bootstrap",
          subjectType: "user",
          subjectId: userId,
          transport: "operator",
        });
      });
      const user = await deps.users.findUserById(userId);
      if (user === null) throw new AuthError("AUTH_VALIDATION", "bootstrap failed");
      return user;
    },

    async createUserWithRole(
      input,
    ): Promise<{ user: UserRecord; inviteToken: string; expiresAt: Date }> {
      const user = await deps.users.createUser({
        displayName: input.displayName,
        email: input.email,
        emailVerified: false,
      });
      await deps.roles.assignRole(user.id, input.roleKey, "provisioning");
      const { token, expiresAt } = await createOneTimeToken(
        user.id,
        "invite",
        inviteTtl,
        "provisioning",
      );
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "USER_CREATED",
        actorType: "USER",
        actorId: "provisioning",
        subjectType: "user",
        subjectId: user.id,
        metadata: { role: input.roleKey },
      });
      return { user, inviteToken: token, expiresAt };
    },

    async createUserWithPassword(input): Promise<UserRecord> {
      const displayName = input.displayName.trim();
      if (displayName.length === 0 || displayName.length > 200) {
        throw new AuthError("AUTH_VALIDATION", "display name must be 1–200 characters");
      }
      const email = normalizeEmail(input.email);
      await deps.policy.validate(input.password);
      const verifier = await deps.passwords.hashPassword(input.password);
      const userId = newStableId();

      await pool.withTransaction(async (tx) => {
        const role = await tx.query("SELECT key FROM auth_roles WHERE key = $1 FOR KEY SHARE", [
          input.roleKey,
        ]);
        if (role.rows.length === 0) {
          throw new AuthError("AUTH_VALIDATION", `unknown role "${input.roleKey}"`, 404);
        }
        await tx.query("INSERT INTO users (id, display_name, status) VALUES ($1, $2, 'ACTIVE')", [
          userId,
          displayName,
        ]);
        await tx.query(
          `INSERT INTO user_emails (user_id, email_normalized, email_display, verified_at, is_primary)
           VALUES ($1, $2, $3, NULL, true)`,
          [userId, email, input.email.trim()],
        );
        await tx.query(
          `INSERT INTO auth_credentials (id, user_id, kind, verifier)
           VALUES ($1, $2, 'password', $3)`,
          [newStableId(), userId, verifier],
        );
        await tx.query(
          "INSERT INTO auth_user_roles (user_id, role_key, granted_by) VALUES ($1, $2, $3)",
          [userId, input.roleKey, input.creator.actorId],
        );
        await recordSecurityEvent(tx, deps.securitySink, {
          type: "USER_CREATED",
          actorType: input.creator.actorType,
          actorId: input.creator.actorId,
          subjectType: "user",
          subjectId: userId,
          transport: input.creator.transport,
          metadata: { role: input.roleKey },
        });
      });

      const user = await deps.users.findUserById(userId);
      if (user === null) throw new AuthError("AUTH_VALIDATION", "user creation failed");
      return user;
    },

    async acceptInvite(input): Promise<UserRecord> {
      await deps.policy.validate(input.password);
      const verifier = await deps.passwords.hashPassword(input.password);
      const claimed = await claimOneTimeToken(input.inviteToken, "invite");
      await deps.passwords.setPassword(claimed.userId, verifier);
      await deps.users.markPrimaryEmailVerified(claimed.userId);
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "USER_ACTIVATED",
        actorType: "USER",
        actorId: claimed.userId,
        subjectType: "user",
        subjectId: claimed.userId,
        transport: "web",
      });
      const user = await deps.users.findUserById(claimed.userId);
      if (user === null) throw new AuthError("AUTH_VALIDATION", "invited user not found");
      return user;
    },

    async issuePasswordReset(input): Promise<{ resetToken: string | null }> {
      const found = await deps.users.findUserByEmail(input.email);
      if (found === null || found.user.status !== "ACTIVE") {
        // Enumeration safety: identical shape, no token, no event that could
        // be observed by the unauthenticated requester.
        return { resetToken: null };
      }
      const { token } = await createOneTimeToken(
        found.user.id,
        "password_reset",
        resetTtl,
        "self-service",
      );
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "PASSWORD_RESET_REQUESTED",
        actorType: "USER",
        actorId: found.user.id,
        subjectType: "user",
        subjectId: found.user.id,
        metadata: { emailKnown: true },
      });
      return { resetToken: token };
    },

    async resetPassword(input): Promise<{ userId: string }> {
      await deps.policy.validate(input.password);
      const verifier = await deps.passwords.hashPassword(input.password);
      const claimed = await claimOneTimeToken(input.resetToken, "password_reset");
      await deps.passwords.setPassword(claimed.userId, verifier);
      await deps.onPasswordChanged?.(claimed.userId);
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "PASSWORD_RESET",
        actorType: "USER",
        actorId: claimed.userId,
        subjectType: "user",
        subjectId: claimed.userId,
        transport: "web",
      });
      return { userId: claimed.userId };
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
