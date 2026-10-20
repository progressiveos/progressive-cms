// User identity service (PCMS-AUTH-T002; Auth spec §4–§8).
//
// The immutable opaque user id is the primary identity; emails are mutable
// login identifiers. Creation is restricted to authorized flows (admin,
// operator bootstrap, invitation) — there is no public self-registration
// path in this package (§9). Passwords and tokens are NOT stored here; the
// credential/token columns are managed by their owning services.
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import { normalizeEmail } from "./email.js";
import { AuthError } from "./errors.js";
import { assertNotLastActiveOwner } from "./owner-invariant.js";

export type UserStatus = "ACTIVE" | "DISABLED";

export interface UserRecord {
  readonly id: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}

export interface UserEmailRecord {
  readonly userId: string;
  readonly emailNormalized: string;
  readonly emailDisplay: string;
  readonly verifiedAt: Date | null;
  readonly isPrimary: boolean;
}

export interface CreateUserData {
  displayName: string;
  email: string;
  /** Operator-created users may arrive pre-verified (invite flow verifies separately). */
  emailVerified?: boolean;
}

export interface UpdateUserData {
  displayName?: string;
  primaryEmail?: string;
}

export interface UserIdentityService {
  createUser(data: CreateUserData): Promise<UserRecord>;
  findUserById(userId: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<{ user: UserRecord; email: UserEmailRecord } | null>;
  primaryEmail(userId: string): Promise<UserEmailRecord | null>;
  markPrimaryEmailVerified(userId: string): Promise<void>;
  disableUser(userId: string): Promise<UserRecord>;
  enableUser(userId: string): Promise<UserRecord>;
  updateUser(userId: string, data: UpdateUserData): Promise<UserRecord>;
  /** Hard delete: credentials, sessions, MFA, tokens and profile go with the row. */
  deleteUser(userId: string): Promise<void>;
}

// Type aliases (not interfaces) so the row shapes satisfy the DbClient
// `Row extends Record<string, unknown>` constraint.
type UserRow = {
  id: string;
  display_name: string;
  status: string;
  created_at: Date;
  disabled_at: Date | null;
};

type EmailRow = {
  user_id: string;
  email_normalized: string;
  email_display: string;
  verified_at: Date | null;
  is_primary: boolean;
};

function toUser(row: UserRow): UserRecord {
  if (row.status !== "ACTIVE" && row.status !== "DISABLED") {
    throw new AuthError("AUTH_VALIDATION", `unknown user status "${row.status}"`);
  }
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

function toEmail(row: EmailRow): UserEmailRecord {
  return {
    userId: row.user_id,
    emailNormalized: row.email_normalized,
    emailDisplay: row.email_display,
    verifiedAt: row.verified_at,
    isPrimary: row.is_primary,
  };
}

export function createUserIdentityService(pool: DbPool): UserIdentityService {
  return {
    async createUser(data: CreateUserData): Promise<UserRecord> {
      const displayName = data.displayName.trim();
      if (displayName.length === 0 || displayName.length > 200) {
        throw new AuthError("AUTH_VALIDATION", "display name must be 1–200 characters");
      }
      const normalized = normalizeEmail(data.email); // throws on invalid syntax
      const id = newStableId();
      const user = await pool.withTransaction(async (tx) => {
        await tx.query("INSERT INTO users (id, display_name, status) VALUES ($1, $2, 'ACTIVE')", [
          id,
          displayName,
        ]);
        await tx.query(
          `INSERT INTO user_emails (user_id, email_normalized, email_display, verified_at, is_primary)
           VALUES ($1, $2, $3, $4, true)`,
          [id, normalized, data.email.trim(), data.emailVerified ? new Date() : null],
        );
        const found = await tx.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
        return toUser(found.rows[0] as UserRow);
      });
      return user;
    },

    async findUserById(userId: string): Promise<UserRecord | null> {
      const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
      const row = result.rows[0];
      return row === undefined ? null : toUser(row);
    },

    async findUserByEmail(
      email: string,
    ): Promise<{ user: UserRecord; email: UserEmailRecord } | null> {
      let normalized: string;
      try {
        normalized = normalizeEmail(email);
      } catch {
        return null; // syntactically invalid input can never match an account
      }
      const result = await pool.query<UserRow & EmailRow>(
        `SELECT u.id, u.display_name, u.status, u.created_at, u.disabled_at,
                e.user_id, e.email_normalized, e.email_display, e.verified_at, e.is_primary
         FROM user_emails e JOIN users u ON u.id = e.user_id
         WHERE e.email_normalized = $1 AND e.is_primary`,
        [normalized],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return { user: toUser(row), email: toEmail(row) };
    },

    async primaryEmail(userId: string): Promise<UserEmailRecord | null> {
      const result = await pool.query<EmailRow>(
        "SELECT * FROM user_emails WHERE user_id = $1 AND is_primary",
        [userId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toEmail(row);
    },

    async markPrimaryEmailVerified(userId: string): Promise<void> {
      const result = await pool.query(
        "UPDATE user_emails SET verified_at = now() WHERE user_id = $1 AND is_primary AND verified_at IS NULL",
        [userId],
      );
      if (result.rowCount === 0) {
        throw new AuthError("AUTH_VALIDATION", "no unverified primary email for user");
      }
    },

    async disableUser(userId: string): Promise<UserRecord> {
      // The last-active-OWNER invariant is enforced in the same transaction
      // as the status flip (owner-invariant.ts); locking makes concurrent
      // disable/role-removal paths serialize instead of racing.
      return pool.withTransaction(async (tx) => {
        await assertNotLastActiveOwner(tx, userId);
        const result = await tx.query<UserRow>(
          "UPDATE users SET status = 'DISABLED', disabled_at = now() WHERE id = $1 RETURNING *",
          [userId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new AuthError("AUTH_VALIDATION", "user not found", 404);
        return toUser(row);
      });
    },

    async enableUser(userId: string): Promise<UserRecord> {
      const result = await pool.query<UserRow>(
        "UPDATE users SET status = 'ACTIVE', disabled_at = NULL WHERE id = $1 RETURNING *",
        [userId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new AuthError("AUTH_VALIDATION", "user not found", 404);
      return toUser(row);
    },

    async updateUser(userId: string, data: UpdateUserData): Promise<UserRecord> {
      const displayName = data.displayName?.trim();
      if (displayName !== undefined && (displayName.length === 0 || displayName.length > 200)) {
        throw new AuthError("AUTH_VALIDATION", "display name must be 1–200 characters");
      }
      const normalized =
        data.primaryEmail === undefined ? undefined : normalizeEmail(data.primaryEmail);
      return pool.withTransaction(async (tx) => {
        if (displayName !== undefined) {
          await tx.query("UPDATE users SET display_name = $2 WHERE id = $1", [userId, displayName]);
        }
        if (normalized !== undefined) {
          const clash = await tx.query(
            `SELECT user_id FROM user_emails WHERE email_normalized = $1 AND user_id <> $2 LIMIT 1`,
            [normalized, userId],
          );
          if (clash.rows.length > 0) {
            throw new AuthError("AUTH_VALIDATION", "email is already in use", 409);
          }
          // A changed email is unproven ownership: drop the verification mark.
          const updated = await tx.query(
            `UPDATE user_emails SET email_normalized = $2, email_display = $3, verified_at = NULL
             WHERE user_id = $1 AND is_primary`,
            [userId, normalized, data.primaryEmail?.trim() ?? ""],
          );
          if (updated.rowCount === 0) {
            throw new AuthError("AUTH_VALIDATION", "user not found", 404);
          }
        }
        const found = await tx.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
        const row = found.rows[0];
        if (row === undefined) throw new AuthError("AUTH_VALIDATION", "user not found", 404);
        return toUser(row);
      });
    },

    async deleteUser(userId: string): Promise<void> {
      await pool.withTransaction(async (tx) => {
        // Same invariant as disable: the last active OWNER cannot be deleted
        // out of existence (owner-invariant.ts locks against role removals).
        await assertNotLastActiveOwner(tx, userId);
        // No referencing table carries ON DELETE CASCADE except user roles,
        // so the credential/session/MFA/token rows go explicitly, then the
        // profile row (roles cascade with it).
        for (const table of [
          "auth_recovery_codes",
          "auth_totp",
          "auth_sessions",
          "auth_one_time_tokens",
          "auth_credentials",
          "user_emails",
        ]) {
          await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
        }
        const result = await tx.query("DELETE FROM users WHERE id = $1", [userId]);
        if (result.rowCount === 0) throw new AuthError("AUTH_VALIDATION", "user not found", 404);
      });
    },
  };
}

export interface UserListRecord {
  readonly id: string;
  readonly displayName: string;
  readonly status: "ACTIVE" | "DISABLED";
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
  readonly primaryEmail: string | null;
}

/** Admin user listing (PCMS-ADMIN-T020; users.read gates the route). */
export async function listUsers(pool: DbPool, limit = 100, offset = 0): Promise<UserListRecord[]> {
  const cappedLimit = Math.min(Math.max(limit, 1), 100);
  const result = await pool.query<{
    id: string;
    display_name: string;
    status: string;
    created_at: Date;
    disabled_at: Date | null;
    email: string | null;
  }>(
    `SELECT u.id, u.display_name, u.status, u.created_at, u.disabled_at, e.email_normalized AS email
     FROM users u
     LEFT JOIN user_emails e ON e.user_id = u.id AND e.is_primary
     ORDER BY u.created_at ASC
     LIMIT $1 OFFSET $2`,
    [cappedLimit, Math.max(offset, 0)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    status: row.status === "DISABLED" ? "DISABLED" : "ACTIVE",
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    primaryEmail: row.email,
  }));
}
