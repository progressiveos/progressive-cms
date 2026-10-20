// Authentication → ActorContext bridge (PCMS-AUTH-T023; Auth spec §60/§61).
//
// One pipeline for every transport (Admin session cookie, API/MCP bearer
// token): raw credential → server-side lookup → ActorContext with the
// effective, precomputed permission set. Machine tokens go through the
// §29 chain (account allowance ∩ token scopes ∩ binding ∩ liveness); human
// sessions resolve role bundles via the role service. There is no
// MCP/API superuser bypass — both paths land in the same authorization
// layer (T019).

import type { DbPool } from "@pcms/core";
import type { ActorContext } from "./actor.js";
import { AuthError } from "./errors.js";
import { createRoleService } from "./roles.js";
import {
  type AccessTokenRecord,
  filterRegisteredScopes,
  formatRawToken,
  hashTokenSecret,
  type ServiceAccountRecord,
  TOKEN_PREFIX_RE,
} from "./service-accounts.js";
import type { ResolvedSession } from "./sessions.js";
import { assertTokenConstraints, type TokenRequestContext } from "./token-constraints.js";
import type { UserIdentityService } from "./users.js";

export interface TokenAuthenticationResult {
  readonly account: ServiceAccountRecord;
  readonly token: AccessTokenRecord;
  readonly actor: ActorContext;
}

export interface ActorResolver {
  /** Bearer token → ActorContext; throws precise machine-readable errors. */
  authenticateToken(
    rawToken: string,
    context?: TokenRequestContext,
  ): Promise<TokenAuthenticationResult>;
  /** Live browser session → USER ActorContext (role bundles resolved). */
  sessionActor(session: ResolvedSession): Promise<ActorContext>;
}

export function createActorResolver(
  pool: DbPool,
  deps: { users: UserIdentityService },
): ActorResolver {
  const roles = createRoleService(pool);

  return {
    async authenticateToken(rawToken, context = {}) {
      const match = TOKEN_PREFIX_RE.exec(rawToken);
      if (match === null) {
        throw new AuthError("AUTH_TOKEN_INVALID", "malformed token", 401);
      }
      const [, prefix, secret] = match as unknown as [string, string, string];
      // Hash the FULL presented credential; the prefix is part of the
      // authenticated value, display-only rows can never authenticate.
      const tokenHash = hashTokenSecret(formatRawToken(prefix, secret));
      const result = await pool.query<AccessTokenRowJoined>(
        `SELECT t.*, a.name AS account_name, a.purpose AS account_purpose,
                a.created_at AS account_created_at,
                a.created_by AS account_created_by,
                a.status AS account_status,
                a.allowed_scopes AS account_allowed_scopes
         FROM access_tokens t JOIN service_accounts a ON a.id = t.service_account_id
         WHERE t.token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new AuthError("AUTH_TOKEN_INVALID", "token not recognized", 401);
      }
      if (row.account_status !== "ENABLED") {
        throw new AuthError("AUTH_SERVICE_ACCOUNT_DISABLED", "service account is disabled", 403);
      }
      if (row.revoked_at !== null) {
        throw new AuthError("AUTH_TOKEN_REVOKED", "token has been revoked", 401);
      }
      if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
        throw new AuthError("AUTH_TOKEN_EXPIRED", "token has expired", 401);
      }

      const token: AccessTokenRecord = {
        id: row.id,
        serviceAccountId: row.service_account_id,
        prefix: row.prefix,
        scopes: row.scopes,
        siteKey: row.site_key,
        environment: row.environment,
        description: row.description,
        createdAt: row.created_at,
        createdBy: row.created_by,
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
        revokedReason: row.revoked_reason,
      };
      // Binding check (§48): bound tokens fail on missing/foreign context.
      assertTokenConstraints(token, context);

      // §29 chain: account ceiling ∩ token scopes ∩ registry (fail-secure).
      const ceiling = row.account_allowed_scopes;
      const effective = filterRegisteredScopes(token.scopes).filter(
        (scope) => ceiling === null || ceiling.includes(scope),
      );
      const account: ServiceAccountRecord = {
        id: row.service_account_id,
        name: row.account_name,
        purpose: row.account_purpose,
        status: "ENABLED",
        allowedScopes: ceiling,
        createdBy: row.account_created_by,
        createdAt: row.account_created_at,
        disabledAt: null,
      };
      await pool.query("UPDATE access_tokens SET last_used_at = now() WHERE id = $1", [row.id]);
      const actor: ActorContext = {
        type: "SERVICE_ACCOUNT",
        id: row.service_account_id,
        permissions: new Set(effective),
        siteKey: token.siteKey,
        environment: token.environment,
        strength: {
          factors: ["access_token"],
          authenticatedAt: token.createdAt,
          mfaAt: null,
        },
        sessionId: null,
      };
      return { account, token, actor };
    },

    async sessionActor(session: ResolvedSession): Promise<ActorContext> {
      const user = await deps.users.findUserById(session.userId);
      if (user === null || user.status !== "ACTIVE") {
        // Disabled/removed users lose session usability on the next request.
        throw new AuthError("AUTH_SESSION_INVALID", "session is not usable", 401);
      }
      const permissions = await roles.userPermissions(session.userId);
      return {
        type: "USER",
        id: session.userId,
        permissions,
        siteKey: null,
        environment: null,
        strength: {
          factors: session.session.mfaAt === null ? ["password"] : ["password", "totp"],
          authenticatedAt: session.session.authenticatedAt,
          mfaAt: session.session.mfaAt,
        },
        sessionId: session.session.id,
      };
    },
  };
}

type AccessTokenRowJoined = AccessTokenRowShape & {
  account_name: string;
  account_purpose: string;
  account_created_at: Date;
  account_created_by: string | null;
  account_status: string;
  account_allowed_scopes: string[] | null;
};

type AccessTokenRowShape = {
  id: string;
  service_account_id: string;
  prefix: string;
  token_hash: string;
  scopes: string[];
  site_key: string | null;
  environment: string | null;
  description: string | null;
  created_at: Date;
  created_by: string | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
};
