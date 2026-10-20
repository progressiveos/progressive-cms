// Local login flow (PCMS-AUTH-T006; Auth spec §18/§35/§36/§68).
//
// Enumeration safety: unknown email and wrong password take the identical
// code path (the same Argon2 dummy verify burns the same CPU time) and end
// in the same AUTH_INVALID_CREDENTIALS error. A DISABLED account also
// reports generic invalid credentials to the unauthenticated caller — the
// real reason lands only in the security event log. Throttling runs before
// any credential work; a successful login clears the layered counters and
// issues the post-password session (MFA completion rotates it, spec §31).
import type { DbPool } from "@pcms/core";
import type { ActorType } from "./actor.js";
import { normalizeEmail } from "./email.js";
import { AuthError } from "./errors.js";
import type { PasswordCredentialService } from "./password.js";
import {
  recordSecurityEvent,
  type SecurityEventSink,
  type SecurityTransport,
} from "./security-events.js";
import type { ClientSessionMetadata, SessionService } from "./sessions.js";
import { loginBucketKeys, type ThrottleService } from "./throttle.js";
import type { UserIdentityService, UserRecord } from "./users.js";

/** Fallback gate until the MFA policy module (T014) is composed in. */
export type MfaRequirementGate = (user: UserRecord) => Promise<boolean>;

export interface LoginInput {
  email: string;
  password: string;
  /** Client address for the IP throttle bucket (transport-supplied). */
  ip?: string | null;
  transport?: SecurityTransport;
  metadata?: ClientSessionMetadata;
}

export interface LoginResult {
  stage: "PASSWORD_OK" | "PASSWORD_OK_PENDING_MFA";
  user: UserRecord;
  mfaRequired: boolean;
  session: { sessionId: string; rawToken: string; csrfToken: string };
}

export interface AuthenticationService {
  /** Verifies credentials against the throttle + policy, issues a session. */
  login(input: LoginInput): Promise<LoginResult>;
  /** Session → ActorContext building lives in the bridge (T023). */
}

export function createAuthenticationService(
  pool: DbPool,
  deps: {
    users: UserIdentityService;
    passwords: PasswordCredentialService;
    throttle: ThrottleService;
    sessions: SessionService;
    securitySink?: SecurityEventSink | null;
    /** Returns whether this login must complete MFA before privileged use. */
    isMfaRequired?: MfaRequirementGate;
  },
): AuthenticationService {
  async function emit(
    type: "LOGIN_SUCCESS" | "LOGIN_FAILURE" | "LOGIN_THROTTLED",
    userId: string | null,
    metadata: Record<string, unknown>,
    transport: SecurityTransport,
  ): Promise<void> {
    await recordSecurityEvent(pool, deps.securitySink, {
      type,
      actorType: "USER" as ActorType,
      actorId: userId,
      subjectType: "user",
      subjectId: userId,
      transport,
      metadata,
    });
  }

  return {
    async login(input: LoginInput): Promise<LoginResult> {
      let normalized: string | null = null;
      try {
        normalized = normalizeEmail(input.email);
      } catch {
        normalized = null;
      }
      const buckets = loginBucketKeys(normalized, input.ip ?? null);
      const transport = input.transport ?? "web";

      try {
        await deps.throttle.assertNotLocked(buckets);
      } catch (error) {
        await emit("LOGIN_THROTTLED", null, { ip: input.ip ?? null }, transport);
        throw error;
      }

      const found = normalized === null ? null : await deps.users.findUserByEmail(normalized);
      let ok = false;
      let rehashed = false;
      if (found !== null) {
        const verify = await deps.passwords.verifyAndRehash(found.user.id, input.password);
        ok = verify.ok;
        rehashed = verify.rehashed;
      } else {
        // Unknown account: burn the same Argon2 verify so the timing matches.
        await deps.passwords.verifyAndRehash(
          "00000000-0000-0000-0000-000000000000",
          input.password,
        );
      }

      if (!ok) {
        await deps.throttle.recordFailure(buckets);
        await emit(
          "LOGIN_FAILURE",
          found?.user.id ?? null,
          { reason: "invalid_credentials", ip: input.ip ?? null },
          transport,
        );
        throw new AuthError("AUTH_INVALID_CREDENTIALS", "invalid credentials", 401);
      }
      // ok=true means the password matched; `found` must exist at this point.
      const user = found!.user;
      if (user.status !== "ACTIVE") {
        // Authenticated-quality signal only: the caller proved the password,
        // yet the response stays generic (spec §68); audit sees the reason.
        await deps.throttle.recordFailure(buckets);
        await emit(
          "LOGIN_FAILURE",
          user.id,
          { reason: "account_disabled", ip: input.ip ?? null },
          transport,
        );
        throw new AuthError("AUTH_INVALID_CREDENTIALS", "invalid credentials", 401);
      }

      await deps.throttle.recordSuccess(buckets);
      const session = await deps.sessions.createSession(user.id, {
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      const mfaRequired = deps.isMfaRequired === undefined ? false : await deps.isMfaRequired(user);
      await emit(
        "LOGIN_SUCCESS",
        user.id,
        { ip: input.ip ?? null, rehashed, mfaRequired },
        transport,
      );
      return {
        stage: mfaRequired ? "PASSWORD_OK_PENDING_MFA" : "PASSWORD_OK",
        user,
        mfaRequired,
        session: {
          sessionId: session.sessionId,
          rawToken: session.rawToken,
          csrfToken: session.csrfToken,
        },
      };
    },
  };
}
