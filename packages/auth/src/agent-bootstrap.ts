// Fixed operator-authorized creator profiles; callers never choose account ids or scopes.
import type { DbClient, DbPool } from "@pcms/core";
import type { ActorContext } from "./actor.js";
import { AuthError } from "./errors.js";
import { assertAllRegistered, PERMISSION_REGISTRY } from "./permissions.js";
import { recordSecurityEvent } from "./security-events.js";
import { createMachineIdentityService } from "./service-accounts.js";
import { assertTokenConstraints } from "./token-constraints.js";

const PRIMARY_KEY = "agent.bootstrap.v1";
const CHILD_ISSUER = "operator:shop-creator:";
const YEAR = 8760 * 3_600_000;
const RESERVED = new Set([
  "users.manage",
  "roles.manage",
  "payments.refund",
  "privacy.manage",
  "skills.manage",
]);
export const isReservedAgentScope = (key: string): boolean =>
  RESERVED.has(key) || /^(tokens|leads|interactions)\./.test(key);
export const cmsCreatorScopes = (): readonly string[] =>
  PERMISSION_REGISTRY.map((permission) => permission.key).filter(
    (key) => !isReservedAgentScope(key),
  );

export interface ShopCreatorManifest {
  readonly id: string;
  readonly permission_namespace?: string;
  readonly permissions: readonly string[];
  readonly registrations: { readonly operations: readonly { readonly permission: string }[] };
}
export function deriveShopCreatorScopes(manifest: ShopCreatorManifest): readonly string[] {
  if (manifest.id !== "progressive.shop" || manifest.permission_namespace !== "shop")
    throw new AuthError(
      "AUTH_TOKEN_SCOPE_DENIED",
      "Shop-Creator requires the trusted progressive.shop namespace",
      403,
    );
  const scopes = new Set(cmsCreatorScopes());
  for (const key of manifest.permissions) {
    if (!scopes.has(key) && !key.startsWith("shop."))
      throw new AuthError("AUTH_TOKEN_SCOPE_DENIED", `creator profile cannot grant ${key}`, 403);
    scopes.add(key);
  }
  assertAllRegistered([...scopes]);
  for (const operation of manifest.registrations.operations)
    if (!scopes.has(operation.permission))
      throw new AuthError(
        "AUTH_TOKEN_SCOPE_DENIED",
        `Shop operation needs an undeclared creator permission: ${operation.permission}`,
        403,
      );
  return [...scopes].sort();
}
export interface AgentCredential {
  readonly profile: "cms-creator/1" | "shop-creator/1";
  readonly account_id: string;
  readonly token_id: string | null;
  readonly created: boolean;
  readonly raw_secret?: string;
  readonly expires_at: string | null;
  readonly scopes: readonly string[];
}
interface Grant {
  account_id: string;
  token_id: string;
  package_digest?: string;
}
function txPool(pool: DbPool, tx: DbClient): DbPool {
  return {
    ...pool,
    query: tx.query.bind(tx),
    withClient: (work) => work(tx),
    withTransaction: (work) => work(tx),
  };
}
async function readGrant(tx: DbClient, key: string): Promise<Grant | null> {
  const result = await tx.query<{ value: string }>(
    "SELECT value FROM pcms_kernel_metadata WHERE key=$1",
    [key],
  );
  if (!result.rows[0]) return null;
  const grant = JSON.parse(result.rows[0].value) as Grant;
  if (typeof grant.account_id !== "string" || typeof grant.token_id !== "string")
    throw new AuthError("AUTH_VALIDATION", "invalid creator bootstrap receipt");
  return grant;
}
async function saveGrant(tx: DbClient, key: string, value: Grant): Promise<void> {
  await tx.query(
    "INSERT INTO pcms_kernel_metadata(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",
    [key, JSON.stringify(value)],
  );
}
async function issueWithin(
  pool: DbPool,
  tx: DbClient,
  input: {
    key: string;
    profile: AgentCredential["profile"];
    name: string;
    issuer: string;
    actor: Pick<ActorContext, "type" | "id">;
    scopes: readonly string[];
    ttl: number;
    siteKey?: string;
    environment?: string;
    digest?: string;
    rotate?: boolean;
  },
): Promise<AgentCredential> {
  const machines = createMachineIdentityService(txPool(pool, tx), { actor: input.actor });
  const previous = await readGrant(tx, input.key);
  let account = previous ? await machines.findServiceAccount(previous.account_id) : null;
  if (previous && (!account || account.status !== "ENABLED"))
    throw new AuthError(
      "AUTH_SERVICE_ACCOUNT_DISABLED",
      "creator account was disabled or removed; operator recovery is required",
      403,
    );
  if (!account)
    account = await machines.createServiceAccount({
      name: input.name,
      purpose: input.profile,
      allowedScopes: input.scopes,
      createdBy: input.issuer,
    });
  const existing = previous
    ? (await machines.listAccessTokens(account.id)).find((token) => token.id === previous.token_id)
    : undefined;
  const sameScopes =
    JSON.stringify([...(account.allowedScopes ?? [])].sort()) ===
    JSON.stringify([...input.scopes].sort());
  const live =
    existing &&
    existing.revokedAt === null &&
    existing.expiresAt !== null &&
    existing.expiresAt.getTime() > Date.now();
  if (
    previous &&
    live &&
    sameScopes &&
    existing.createdBy === input.issuer &&
    previous.package_digest === input.digest &&
    !input.rotate
  )
    return {
      profile: input.profile,
      account_id: account.id,
      token_id: existing.id,
      created: false,
      expires_at: existing.expiresAt!.toISOString(),
      scopes: input.scopes,
    };
  if (previous && (!live || !sameScopes) && input.profile === "cms-creator/1" && !input.rotate)
    throw new AuthError(
      "AUTH_TOKEN_EXPIRED",
      "primary creator credential needs explicit operator rotation",
      403,
    );
  if (!sameScopes)
    await tx.query("UPDATE service_accounts SET allowed_scopes=$2 WHERE id=$1", [
      account.id,
      input.scopes,
    ]);
  const issued = await machines.createAccessToken({
    serviceAccountId: account.id,
    scopes: input.scopes,
    ttlMilliseconds: input.ttl,
    createdBy: input.issuer,
    ...(input.siteKey === undefined ? {} : { siteKey: input.siteKey }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  });
  for (const old of await machines.listAccessTokens(account.id))
    if (old.id !== issued.token.id && old.revokedAt === null)
      await machines.revokeAccessToken(old.id, "creator profile rotated");
  await saveGrant(tx, input.key, {
    account_id: account.id,
    token_id: issued.token.id,
    ...(input.digest === undefined ? {} : { package_digest: input.digest }),
  });
  await recordSecurityEvent(tx, null, {
    type: "AGENT_PROFILE_GRANTED",
    actorType: input.actor.type,
    actorId: input.actor.id,
    subjectType: "service_account",
    subjectId: account.id,
    metadata: {
      profile: input.profile,
      package_digest: input.digest ?? null,
      scopes: input.scopes,
    },
  });
  return {
    profile: input.profile,
    account_id: account.id,
    token_id: issued.token.id,
    created: true,
    raw_secret: issued.rawSecret,
    expires_at: issued.token.expiresAt!.toISOString(),
    scopes: input.scopes,
  };
}
export async function bootstrapAgentAccess(
  pool: DbPool,
  options: { rotate?: boolean; ttlHours?: number } = {},
): Promise<AgentCredential> {
  const hours = options.ttlHours ?? 8760;
  if (!Number.isInteger(hours) || hours < 1 || hours > 8760)
    throw new AuthError("AUTH_VALIDATION", "TTL must be 1..8760 hours");
  return pool.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PRIMARY_KEY]);
    const owner = await tx.query(
      "SELECT 1 FROM users u JOIN auth_user_roles r ON r.user_id=u.id WHERE u.status='ACTIVE' AND r.role_key='OWNER' LIMIT 1",
    );
    if (!owner.rowCount)
      throw new AuthError("AUTH_VALIDATION", "create the initial OWNER before agent bootstrap");
    return issueWithin(pool, tx, {
      key: PRIMARY_KEY,
      profile: "cms-creator/1",
      name: "Site-Creator",
      issuer: "operator:bootstrap",
      actor: { type: "OPERATOR", id: "operator:bootstrap" },
      scopes: cmsCreatorScopes(),
      ttl: hours * 3_600_000,
      ...(options.rotate === undefined ? {} : { rotate: options.rotate }),
    });
  });
}
export async function provisionShopCreatorAccess(
  pool: DbPool,
  input: {
    actor: ActorContext;
    manifest: ShopCreatorManifest;
    packageDigest: string;
    siteKey: string;
    environment: string;
    rotate?: boolean;
  },
): Promise<AgentCredential> {
  if (
    input.actor.type !== "SERVICE_ACCOUNT" ||
    !input.actor.accessTokenId ||
    !input.actor.permissions.has("extensions.manage")
  )
    throw new AuthError(
      "AUTH_TOKEN_SCOPE_DENIED",
      "only the bootstrap creator can request Shop-Creator",
      403,
    );
  if (
    !input.siteKey.trim() ||
    !input.environment.trim() ||
    !/^[a-f0-9]{64}$/.test(input.packageDigest)
  )
    throw new AuthError(
      "AUTH_VALIDATION",
      "explicit site/environment and verified package identity are required",
    );
  const scopes = deriveShopCreatorScopes(input.manifest);
  return pool.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PRIMARY_KEY]);
    const grant = await readGrant(tx, PRIMARY_KEY);
    if (grant?.account_id !== input.actor.id || grant.token_id !== input.actor.accessTokenId)
      throw new AuthError(
        "AUTH_TOKEN_SCOPE_DENIED",
        "this account has no bootstrap delegation",
        403,
      );
    const result = await tx.query<{
      expires_at: Date | null;
      site_key: string | null;
      environment: string | null;
      scopes: string[];
      allowed_scopes: string[] | null;
    }>(
      "SELECT t.expires_at,t.site_key,t.environment,t.scopes,a.allowed_scopes FROM access_tokens t JOIN service_accounts a ON a.id=t.service_account_id WHERE t.id=$1 AND a.id=$2 AND a.status='ENABLED' AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) FOR UPDATE OF t,a",
      [input.actor.accessTokenId, input.actor.id],
    );
    const parent = result.rows[0];
    if (
      !parent ||
      !parent.scopes.includes("extensions.manage") ||
      (parent.allowed_scopes !== null && !parent.allowed_scopes.includes("extensions.manage"))
    )
      throw new AuthError(
        "AUTH_TOKEN_SCOPE_DENIED",
        "bootstrap credential is revoked, expired or restricted",
        403,
      );
    assertTokenConstraints(
      { siteKey: parent.site_key, environment: parent.environment },
      { siteKey: input.siteKey, environment: input.environment },
    );
    const ttl = Math.min(YEAR, (parent.expires_at?.getTime() ?? Date.now() + YEAR) - Date.now());
    if (ttl < 1000)
      throw new AuthError("AUTH_TOKEN_EXPIRED", "bootstrap credential is expiring", 403);
    return issueWithin(pool, tx, {
      key: `agent.shop-creator.v1:${JSON.stringify([input.actor.id, input.siteKey, input.environment])}`,
      profile: "shop-creator/1",
      name: "Shop-Creator",
      issuer: `${CHILD_ISSUER}${input.actor.id}:${input.actor.accessTokenId}`,
      actor: input.actor,
      scopes,
      ttl,
      siteKey: input.siteKey,
      environment: input.environment,
      digest: input.packageDigest,
      ...(input.rotate === undefined ? {} : { rotate: input.rotate }),
    });
  });
}
/** The parent identity remains revocable even after a child credential was issued. */
export async function assertCreatorParentEnabled(
  pool: DbPool,
  createdBy: string | null,
): Promise<void> {
  if (!createdBy?.startsWith(CHILD_ISSUER)) return;
  const [parentId, parentTokenId] = createdBy.slice(CHILD_ISSUER.length).split(":");
  const grant = await readGrant(pool, PRIMARY_KEY);
  if (!parentTokenId || !grant || grant.account_id !== parentId || grant.token_id !== parentTokenId)
    throw new AuthError("AUTH_TOKEN_REVOKED", "bootstrap creator credential was replaced", 401);
  const parent = await pool.query(
    "SELECT 1 FROM access_tokens t JOIN service_accounts a ON a.id=t.service_account_id WHERE t.id=$1 AND a.id=$2 AND a.status='ENABLED' AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) AND 'extensions.manage'=ANY(t.scopes) AND (a.allowed_scopes IS NULL OR 'extensions.manage'=ANY(a.allowed_scopes))",
    [parentTokenId, parentId],
  );
  if (!parent.rowCount)
    throw new AuthError("AUTH_TOKEN_REVOKED", "bootstrap creator credential is inactive", 401);
}
