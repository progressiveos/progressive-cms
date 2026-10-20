// Opaque server-side session model (PCMS-AUTH-T007/T008/T027; Auth spec
// §27–§34).
//
// Bearer token: 32 CSPRNG bytes, base64url. The database stores only its
// SHA-256 hash. Rotation issues a fresh random token inside one transaction
// that revokes the old row — fixation is impossible because the token never
// exists before the session row does. Resolution enforces idle + absolute
// expiry and denies sessions of DISABLED users on every lookup, so a
// disabled account cannot keep usable sessions even if a revocation sweep
// has not run yet.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import { hashCsrfToken, newCsrfToken } from "./csrf.js";
import { AuthError } from "./errors.js";
import { recordSecurityEvent, type SecurityEventSink } from "./security-events.js";

export interface SessionTimeouts {
  /** Idle timeout: session dies after this much inactivity. */
  idleTimeoutMilliseconds: number;
  /** Absolute timeout: hard ceiling from authentication. */
  absoluteTimeoutMilliseconds: number;
}

export const DEFAULT_SESSION_TIMEOUTS: SessionTimeouts = {
  // Owner decision (2026-09-28): a session must hold for a month — admins
  // should not be re-prompted during normal use. Rotation on every Admin
  // reload re-issues the absolute window, so absolute and idle only bite
  // after ~a month of complete abandonment.
  idleTimeoutMilliseconds: 30 * 24 * 60 * 60 * 1000, // 30d
  absoluteTimeoutMilliseconds: 30 * 24 * 60 * 60 * 1000, // 30d
};

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly authenticatedAt: Date;
  readonly mfaAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly metadata: Record<string, unknown> | null;
}

export interface ClientSessionMetadata {
  /** Coarse class of the client ("browser", "cli", ...); no fingerprinting. */
  clientClass?: string;
  /** Static OS-family token derived from User-Agent, coarse on purpose. */
  platform?: string;
}

export interface ResolvedSession {
  readonly session: SessionRecord;
  readonly userId: string;
  /**
   * Hash of the session's synchronizer CSRF token; transports verify the
   * raw token presented by the client against it on state changes. Null
   * only for rows created before the CSRF migration — those fail CSRF
   * assertions.
   */
  readonly csrfHash: string | null;
  /** True when this resolution advanced last_seen_at. */
  readonly touched: boolean;
}

export interface SessionService {
  /** Creates a session and returns the raw bearer token exactly once. */
  createSession(
    userId: string,
    input: {
      authenticatedAt?: Date;
      mfaAt?: Date | null;
      metadata?: ClientSessionMetadata;
      now?: Date;
    },
  ): Promise<{ sessionId: string; rawToken: string; csrfToken: string; expiresAt: Date }>;

  /**
   * Resolves a raw token to a live session. Returns null for unknown,
   * revoked, expired (absolute or idle) sessions and for sessions of
   * disabled users. Advances last_seen_at (rate-limited internally).
   */
  resolveSession(rawToken: string, options?: { now?: Date }): Promise<ResolvedSession | null>;

  /**
   * Rotation (spec §31): atomically revokes the old session and issues a
   * fresh token carrying the same authentication strength. Invalidates on
   * any stale/revoked input. Used after login, MFA completion and step-up.
   */
  rotateSession(
    rawToken: string,
    options?: { now?: Date },
  ): Promise<{ sessionId: string; rawToken: string; csrfToken: string; userId: string }>;

  /** Marks the strong factor as satisfied for this session. */
  markMfaSatisfied(sessionId: string, when?: Date): Promise<void>;

  revokeSession(sessionId: string, reason: string): Promise<void>;

  /** Revokes every active session of a user; returns the revoked count. */
  revokeAllForUser(userId: string, reason: string): Promise<number>;

  /** Active (non-revoked, non-expired) sessions for management UI (§33). */
  listActiveSessions(userId: string, options?: { now?: Date }): Promise<SessionRecord[]>;
}

type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  authenticated_at: Date;
  mfa_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  metadata: Record<string, unknown> | null;
};

/** Last-seen writes are collapsed: at most one touch per minute per session. */
const TOUCH_COLLAPSE_MILLISECONDS = 60 * 1000;

export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function timingSafeHashCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createSessionService(
  pool: DbPool,
  options: { timeouts?: Partial<SessionTimeouts>; securitySink?: SecurityEventSink | null } = {},
): SessionService {
  const timeouts: SessionTimeouts = { ...DEFAULT_SESSION_TIMEOUTS, ...options.timeouts };

  function toRecord(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      authenticatedAt: row.authenticated_at,
      mfaAt: row.mfa_at,
      revokedAt: row.revoked_at,
      revokedReason: row.revoked_reason,
      metadata: row.metadata,
    };
  }

  async function insertSession(
    userId: string,
    input: {
      authenticatedAt: Date;
      mfaAt: Date | null;
      metadata?: ClientSessionMetadata;
      now: Date;
    },
  ): Promise<{ sessionId: string; rawToken: string; csrfToken: string; expiresAt: Date }> {
    const rawToken = randomBytes(32).toString("base64url");
    const csrfToken = newCsrfToken();
    const expiresAt = new Date(input.now.getTime() + timeouts.absoluteTimeoutMilliseconds);
    const sessionId = newStableId();
    await pool.query(
      `INSERT INTO auth_sessions
         (id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at,
          authenticated_at, mfa_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
      [
        sessionId,
        userId,
        hashSessionToken(rawToken),
        hashCsrfToken(csrfToken),
        input.now,
        expiresAt,
        input.authenticatedAt,
        input.mfaAt,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
      ],
    );
    return { sessionId, rawToken, csrfToken, expiresAt };
  }

  return {
    async createSession(userId, input) {
      const now = input.now ?? new Date();
      return insertSession(userId, {
        authenticatedAt: input.authenticatedAt ?? now,
        mfaAt: input.mfaAt ?? null,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        now,
      });
    },

    async resolveSession(rawToken, resolveOptions) {
      if (rawToken.length === 0 || rawToken.length > 512) return null;
      const now = resolveOptions?.now ?? new Date();
      const result = await pool.query<
        SessionRow & { user_status: string; csrf_hash: string | null }
      >(
        `SELECT s.*, u.status AS user_status
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1`,
        [hashSessionToken(rawToken)],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (row.user_status !== "ACTIVE") return null; // disabled users: no usable sessions
      if (row.revoked_at !== null) return null;
      if (row.expires_at.getTime() <= now.getTime()) return null;
      if (row.last_seen_at.getTime() + timeouts.idleTimeoutMilliseconds <= now.getTime()) {
        return null; // idle timeout
      }

      let touched = false;
      if (
        now.getTime() - row.last_seen_at.getTime() >= TOUCH_COLLAPSE_MILLISECONDS &&
        now.getTime() - row.created_at.getTime() < timeouts.absoluteTimeoutMilliseconds
      ) {
        await pool.query("UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1", [row.id, now]);
        touched = true;
      }
      return { session: toRecord(row), userId: row.user_id, csrfHash: row.csrf_hash, touched };
    },

    async rotateSession(rawToken, rotateOptions) {
      const now = rotateOptions?.now ?? new Date();
      const oldHash = hashSessionToken(rawToken);
      return pool.withTransaction(async (tx) => {
        // Lock the candidate row so two concurrent rotations serialize; the
        // loser finds the row already revoked and fails (stale token).
        const found = await tx.query<SessionRow>(
          `SELECT * FROM auth_sessions WHERE token_hash = $1 AND revoked_at IS NULL FOR UPDATE`,
          [oldHash],
        );
        const row = found.rows[0];
        if (row === undefined) {
          throw new AuthError("AUTH_SESSION_INVALID", "no active session to rotate", 401);
        }
        if (row.expires_at.getTime() <= now.getTime()) {
          throw new AuthError("AUTH_SESSION_EXPIRED", "session expired", 401);
        }
        await tx.query(
          "UPDATE auth_sessions SET revoked_at = $2, revoked_reason = $3 WHERE id = $1",
          [row.id, now, "rotated"],
        );
        const fresh = await insertSession(row.user_id, {
          authenticatedAt: row.authenticated_at,
          mfaAt: row.mfa_at,
          ...(row.metadata === null ? {} : { metadata: row.metadata as ClientSessionMetadata }),
          now,
        });
        return {
          sessionId: fresh.sessionId,
          rawToken: fresh.rawToken,
          csrfToken: fresh.csrfToken,
          userId: row.user_id,
        };
      });
    },

    async markMfaSatisfied(sessionId, when) {
      const result = await pool.query(
        "UPDATE auth_sessions SET mfa_at = $2 WHERE id = $1 AND revoked_at IS NULL",
        [sessionId, when ?? new Date()],
      );
      if (result.rowCount === 0) {
        throw new AuthError("AUTH_SESSION_INVALID", "no active session", 401);
      }
    },

    async revokeSession(sessionId, reason) {
      const result = await pool.query(
        "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL",
        [sessionId, reason],
      );
      if (result.rowCount === 0) {
        throw new AuthError("AUTH_SESSION_INVALID", "no active session", 401);
      }
      await recordSecurityEvent(pool, options.securitySink, {
        type: "SESSION_REVOKED",
        actorType: "USER",
        actorId: null,
        subjectType: "session",
        subjectId: sessionId,
        metadata: { reason },
      });
    },

    async revokeAllForUser(userId, reason) {
      const result = await pool.query(
        "UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL",
        [userId, reason],
      );
      const count = result.rowCount ?? 0;
      if (count > 0) {
        await recordSecurityEvent(pool, options.securitySink, {
          type: "SESSION_REVOKED",
          actorType: "USER",
          actorId: userId,
          subjectType: "user_sessions",
          subjectId: userId,
          metadata: { reason, count },
        });
      }
      return count;
    },

    async listActiveSessions(userId, listOptions) {
      const now = listOptions?.now ?? new Date();
      const result = await pool.query<SessionRow>(
        `SELECT * FROM auth_sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
           AND last_seen_at > $3
         ORDER BY last_seen_at DESC`,
        [userId, now, new Date(now.getTime() - timeouts.idleTimeoutMilliseconds)],
      );
      return result.rows.map(toRecord);
    },
  };
}

/** Exported for verification in tests: hash equality implies token equality. */
export function sessionHashesEqual(a: string, b: string): boolean {
  return timingSafeHashCompare(a, b);
}
