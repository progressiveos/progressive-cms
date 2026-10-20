// ServiceAccounts + scoped AccessTokens (PCMS-AUTH-T020/T021; Auth spec
// §49–§59).
//
// Token lifecycle: random high-entropy secret shown exactly once, only its
// SHA-256 hash stored, prefix surfaced for logs/UI. Rotation = create new +
// revoke old (never re-display a secret). Revocation and the ENABLED check
// are evaluated on every resolution (lookup is the DB itself — no cache to
// invalidate, so revocation takes effect immediately, spec §58). Expiry is
// server-authoritative; a permanent token demands the explicit
// allowPermanent policy flag (spec §53).
import { createHash, randomBytes } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import { AuthError } from "./errors.js";
import { assertAllRegistered, isRegisteredPermission } from "./permissions.js";
import { recordSecurityEvent, type SecurityEventSink } from "./security-events.js";

/** Raw bearer format: pcms_<8-hex-prefix>_<43-char-base64url-secret>. */
export const TOKEN_PREFIX_RE = /^pcms_([0-9a-f]{8})_([\w-]{43})$/;

export interface ServiceAccountRecord {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly status: "ENABLED" | "DISABLED";
  readonly allowedScopes: readonly string[] | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}

export interface AccessTokenRecord {
  readonly id: string;
  readonly serviceAccountId: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly siteKey: string | null;
  readonly environment: string | null;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

export interface MachineIdentityService {
  createServiceAccount(input: {
    name: string;
    purpose: string;
    allowedScopes?: readonly string[] | null;
    createdBy?: string | null;
  }): Promise<ServiceAccountRecord>;
  listServiceAccounts(): Promise<ServiceAccountRecord[]>;
  findServiceAccount(id: string): Promise<ServiceAccountRecord | null>;
  disableServiceAccount(id: string, reason: string): Promise<void>;
  /** Irreversible: the account and every access token it issued are removed
   * in one transaction (owner request: cleanup without residue). */
  deleteServiceAccount(id: string, reason: string): Promise<void>;

  createAccessToken(input: {
    serviceAccountId: string;
    scopes: readonly string[];
    siteKey?: string | null;
    environment?: string | null;
    description?: string | null;
    ttlMilliseconds?: number;
    /** Explicit policy decision required for a token without expiry (§53). */
    allowPermanent?: boolean;
    createdBy?: string | null;
  }): Promise<{ token: AccessTokenRecord; rawSecret: string }>;

  listAccessTokens(serviceAccountId: string): Promise<AccessTokenRecord[]>;
  revokeAccessToken(tokenId: string, reason: string): Promise<void>;
}

type AccountRow = {
  id: string;
  name: string;
  purpose: string;
  status: string;
  allowed_scopes: string[] | null;
  created_by: string | null;
  created_at: Date;
  disabled_at: Date | null;
};

type TokenRow = {
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

export function hashTokenSecret(rawSecret: string): string {
  return createHash("sha256").update(rawSecret, "utf8").digest("hex");
}

export function formatRawToken(prefix: string, secret: string): string {
  return `pcms_${prefix}_${secret}`;
}

function toAccountRecord(row: AccountRow): ServiceAccountRecord {
  if (row.status !== "ENABLED" && row.status !== "DISABLED") {
    throw new AuthError("AUTH_VALIDATION", `unknown service account status "${row.status}"`);
  }
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    status: row.status,
    allowedScopes: row.allowed_scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

function toTokenRecord(row: TokenRow): AccessTokenRecord {
  return {
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
}

export function createMachineIdentityService(
  pool: DbPool,
  deps: { securitySink?: SecurityEventSink | null } = {},
): MachineIdentityService {
  return {
    async createServiceAccount(input) {
      const name = input.name.trim();
      const purpose = input.purpose.trim();
      if (name.length === 0 || name.length > 200) {
        throw new AuthError("AUTH_VALIDATION", "service account name must be 1–200 characters");
      }
      if (purpose.length === 0 || purpose.length > 2000) {
        throw new AuthError("AUTH_VALIDATION", "service account purpose must be 1–2000 characters");
      }
      let allowedScopes: string[] | null = null;
      if (input.allowedScopes !== undefined && input.allowedScopes !== null) {
        allowedScopes = [...new Set(input.allowedScopes)];
        assertAllRegistered(allowedScopes); // ceiling may only name registered keys
      }
      const id = newStableId();
      await pool.query(
        `INSERT INTO service_accounts (id, name, purpose, allowed_scopes, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, purpose, allowedScopes, input.createdBy ?? null],
      );
      const record = await this.findServiceAccount(id);
      if (record === null) throw new AuthError("AUTH_VALIDATION", "creation failed");
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "SERVICE_ACCOUNT_CREATED",
        actorType: "OPERATOR",
        actorId: input.createdBy ?? null,
        subjectType: "service_account",
        subjectId: id,
        metadata: { name },
      });
      return record;
    },

    async listServiceAccounts() {
      const result = await pool.query<AccountRow>(
        "SELECT * FROM service_accounts ORDER BY created_at DESC",
      );
      return result.rows.map(toAccountRecord);
    },

    async findServiceAccount(id) {
      const result = await pool.query<AccountRow>("SELECT * FROM service_accounts WHERE id = $1", [
        id,
      ]);
      return result.rows[0] === undefined ? null : toAccountRecord(result.rows[0]);
    },

    async disableServiceAccount(id, reason) {
      const result = await pool.query(
        "UPDATE service_accounts SET status = 'DISABLED', disabled_at = now() WHERE id = $1 AND status = 'ENABLED'",
        [id],
      );
      if (result.rowCount === 0) {
        throw new AuthError(
          "AUTH_VALIDATION",
          "service account not found or already disabled",
          404,
        );
      }
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "SERVICE_ACCOUNT_DISABLED",
        actorType: "OPERATOR",
        actorId: null,
        subjectType: "service_account",
        subjectId: id,
        metadata: { reason },
      });
    },

    async deleteServiceAccount(id, reason) {
      const deleted = await pool.withTransaction(async (tx) => {
        // Tokens first: the FK from access_tokens has no ON DELETE cascade —
        // explicit order keeps the delete total or not at all.
        await tx.query("DELETE FROM access_tokens WHERE service_account_id = $1", [id]);
        const gone = await tx.query<{ name: string }>(
          "DELETE FROM service_accounts WHERE id = $1 RETURNING name",
          [id],
        );
        return gone.rows[0]?.name ?? null;
      });
      if (deleted === null) {
        throw new AuthError("AUTH_VALIDATION", "service account not found", 404);
      }
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "SERVICE_ACCOUNT_DELETED",
        actorType: "OPERATOR",
        actorId: null,
        subjectType: "service_account",
        subjectId: id,
        metadata: { name: deleted, reason },
      });
    },

    async createAccessToken(input) {
      const account = await this.findServiceAccount(input.serviceAccountId);
      if (account === null) {
        throw new AuthError("AUTH_VALIDATION", "service account not found", 404);
      }
      if (account.status !== "ENABLED") {
        throw new AuthError("AUTH_SERVICE_ACCOUNT_DISABLED", "service account is disabled", 403);
      }
      const scopes = [...new Set(input.scopes)];
      assertAllRegistered(scopes);
      // Token scopes may never exceed the account ceiling (spec §29 chain).
      if (account.allowedScopes !== null) {
        const outside = scopes.filter((scope) => !account.allowedScopes!.includes(scope));
        if (outside.length > 0) {
          throw new AuthError(
            "AUTH_TOKEN_SCOPE_DENIED",
            `scopes outside the account allowance: ${outside.join(", ")}`,
            403,
          );
        }
      }
      let expiresAt: Date | null = null;
      if (input.ttlMilliseconds !== undefined) {
        if (!Number.isInteger(input.ttlMilliseconds) || input.ttlMilliseconds < 1000) {
          throw new AuthError("AUTH_VALIDATION", "token TTL must be at least 1 second");
        }
        expiresAt = new Date(Date.now() + input.ttlMilliseconds);
      } else if (input.allowPermanent !== true) {
        throw new AuthError(
          "AUTH_VALIDATION",
          "tokens require an expiry; pass allowPermanent=true only as an explicit policy decision",
        );
      }

      const prefix = randomBytes(4).toString("hex");
      const secret = randomBytes(32).toString("base64url");
      const rawToken = formatRawToken(prefix, secret);
      const id = newStableId();
      await pool.query(
        `INSERT INTO access_tokens
           (id, service_account_id, prefix, token_hash, scopes, site_key, environment,
            description, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          input.serviceAccountId,
          prefix,
          hashTokenSecret(rawToken),
          scopes,
          input.siteKey ?? null,
          input.environment ?? null,
          input.description ?? null,
          input.createdBy ?? null,
          expiresAt,
        ],
      );
      const rows = await pool.query<TokenRow>("SELECT * FROM access_tokens WHERE id = $1", [id]);
      const token = toTokenRecord(rows.rows[0]!);
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "TOKEN_CREATED",
        actorType: "OPERATOR",
        actorId: input.createdBy ?? null,
        subjectType: "token",
        subjectId: id,
        metadata: {
          prefix,
          serviceAccountId: input.serviceAccountId,
          scopes,
          permanent: expiresAt === null,
        },
      });
      return { token, rawSecret: rawToken };
    },

    async listAccessTokens(serviceAccountId) {
      const result = await pool.query<TokenRow>(
        "SELECT * FROM access_tokens WHERE service_account_id = $1 ORDER BY created_at DESC",
        [serviceAccountId],
      );
      return result.rows.map(toTokenRecord);
    },

    async revokeAccessToken(tokenId, reason) {
      const result = await pool.query(
        "UPDATE access_tokens SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL",
        [tokenId, reason],
      );
      if (result.rowCount === 0) {
        throw new AuthError("AUTH_VALIDATION", "token not found or already revoked", 404);
      }
      await recordSecurityEvent(pool, deps.securitySink, {
        type: "TOKEN_REVOKED",
        actorType: "OPERATOR",
        actorId: null,
        subjectType: "token",
        subjectId: tokenId,
        metadata: { reason },
      });
    },
  };
}

/** Registered-key filter applied at resolution (fail-secure against DB drift). */
export function filterRegisteredScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => isRegisteredPermission(scope));
}
