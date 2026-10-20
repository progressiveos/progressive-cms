// PCMS-AUTH-T020/T021/T022/T023/T024 — service accounts, scoped tokens,
// constraint evaluator, ActorContext bridge, agent scope separation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthError,
  createActorResolver,
  createMachineIdentityService,
  createSessionService,
  createThrottleService,
  createTotpService,
  createUserIdentityService,
  deriveKeyForTesting,
  evaluateTokenConstraints,
  type MachineIdentityService,
} from "@pcms/auth";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

function connectionInfo(db: TestDatabase) {
  const info = {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}

async function withMachine(
  t: { after: (fn: () => void) => void },
  run: (
    machines: MachineIdentityService,
    resolver: ReturnType<typeof createActorResolver>,
    pool: DbPool,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const machines = createMachineIdentityService(pool);
  const resolver = createActorResolver(pool, {
    users: createUserIdentityService(pool),
  });
  await run(machines, resolver, pool);
}

test("service accounts are independent machine principals (no user rows)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (machines, _resolver, pool) => {
    const account = await machines.createServiceAccount({
      name: "content-agent-01",
      purpose: "Authoring assistant for the editorial team",
      createdBy: "owner-1",
    });
    assert.match(account.id, /^[0-9a-f-]{36}$/);
    assert.equal(account.status, "ENABLED");
    // No user row was created for this machine identity.
    const users = await pool.query("SELECT * FROM users WHERE id = $1", [account.id]);
    assert.equal(users.rows.length, 0);
  });
});

test("token secrets: shown once, hash-only at rest, prefix-only display", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (machines, _resolver, pool) => {
    const account = await machines.createServiceAccount({ name: "a", purpose: "b" });
    const { token, rawSecret } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.read", "content.edit"],
      ttlMilliseconds: 3_600_000,
      description: "CI job",
    });
    assert.match(rawSecret, /^pcms_[0-9a-f]{8}_/);
    assert.equal(token.prefix, rawSecret.slice(5, 13));

    const stored = await pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM access_tokens WHERE id = $1",
      [token.id],
    );
    assert.equal(stored.rows[0]!.token_hash.includes(rawSecret), false);
    assert.notEqual(stored.rows[0]!.token_hash, rawSecret);
  });
});

test("scope ceiling: token scopes outside the account allowance are refused", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (machines) => {
    const limited = await machines.createServiceAccount({
      name: "limited",
      purpose: "read-only agent",
      allowedScopes: ["content.read", "media.read"],
    });
    await assert.rejects(
      () =>
        machines.createAccessToken({
          serviceAccountId: limited.id,
          scopes: ["content.read", "publication.publish"],
          ttlMilliseconds: 60_000,
        }),
      (err: AuthError) => err.code === "AUTH_TOKEN_SCOPE_DENIED",
    );
  });
});

test("permanent tokens require an explicit policy decision", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (machines) => {
    const account = await machines.createServiceAccount({ name: "p", purpose: "perm" });
    await assert.rejects(
      () => machines.createAccessToken({ serviceAccountId: account.id, scopes: ["content.read"] }),
      (err: AuthError) => /allowPermanent/.test(err.message),
    );
    const granted = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.read"],
      allowPermanent: true,
    });
    assert.equal(granted.token.expiresAt, null);
  });
});

test("expiry and revocation are server-authoritative and immediate", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (machines, resolver) => {
    const account = await machines.createServiceAccount({ name: "e", purpose: "expiry" });
    const { rawSecret } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.read"],
      ttlMilliseconds: 1_000,
    });
    // Valid now…
    const ok = await resolver.authenticateToken(rawSecret);
    assert.equal(ok.actor.type, "SERVICE_ACCOUNT");
    // …expired one hour later: server clock decides.
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000;
    try {
      await assert.rejects(
        () => resolver.authenticateToken(rawSecret),
        (err: AuthError) => err.code === "AUTH_TOKEN_EXPIRED",
      );
    } finally {
      Date.now = realNow;
    }

    // Revocation refuses immediately afterwards.
    const tokens = await machines.listAccessTokens(account.id);
    await machines.revokeAccessToken(tokens[0]!.id, "leaked");
    await assert.rejects(
      () => resolver.authenticateToken(rawSecret),
      (err: AuthError) => err.code === "AUTH_TOKEN_REVOKED",
    );
  });
});

test("disabled service account refuses its tokens", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (machines, resolver) => {
    const account = await machines.createServiceAccount({ name: "d", purpose: "disable" });
    const { rawSecret } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.read"],
      ttlMilliseconds: 60_000,
    });
    await machines.disableServiceAccount(account.id, "compromised");
    await assert.rejects(
      () => resolver.authenticateToken(rawSecret),
      (err: AuthError) => err.code === "AUTH_SERVICE_ACCOUNT_DISABLED",
    );
  });
});

test("site binding: cross-site and context-less usage denied; matching site allowed", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (machines, resolver) => {
    const account = await machines.createServiceAccount({ name: "s", purpose: "bound" });
    const { rawSecret } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.read"],
      siteKey: "site-a",
      ttlMilliseconds: 60_000,
    });

    await assert.rejects(
      () => resolver.authenticateToken(rawSecret, { siteKey: "site-b" }),
      (err: AuthError) => err.code === "AUTH_TOKEN_SITE_DENIED",
    );
    await assert.rejects(
      () => resolver.authenticateToken(rawSecret), // no context at all
      (err: AuthError) => err.code === "AUTH_TOKEN_SITE_DENIED",
    );
    const allowed = await resolver.authenticateToken(rawSecret, { siteKey: "site-a" });
    assert.equal(allowed.actor.siteKey, "site-a");
    assert.deepEqual([...allowed.actor.permissions].sort(), ["content.read"]);
  });
});

test("constraint evaluator unit behavior (unbound passes, bound requires context)", () => {
  const unbound = { siteKey: null, environment: null };
  assert.deepEqual(evaluateTokenConstraints(unbound, { siteKey: "any" }), { allowed: true });

  const bound = { siteKey: "site-a", environment: "preview" };
  assert.equal(
    evaluateTokenConstraints(bound, { siteKey: "site-b", environment: "preview" }).code,
    "AUTH_TOKEN_SITE_DENIED",
  );
  assert.equal(
    evaluateTokenConstraints(bound, { siteKey: "site-a" }).code,
    "AUTH_TOKEN_ENVIRONMENT_DENIED",
  );
  assert.equal(
    evaluateTokenConstraints(bound, { siteKey: "site-a", environment: "preview" }).allowed,
    true,
  );
});

test("human session bridge: role bundles land in the ActorContext with MFA strength", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (_machines, resolver, pool) => {
    const users = createUserIdentityService(pool);
    const user = await users.createUser({ displayName: "H", email: "human@example.com" });
    const sessions = createSessionService(pool);
    const { rawToken } = await sessions.createSession(user.id, { mfaAt: new Date() });
    const resolved = (await sessions.resolveSession(rawToken))!;
    const actor = await resolver.sessionActor(resolved);
    assert.equal(actor.type, "USER");
    assert.equal(actor.sessionId, resolved.session.id);
    assert.equal(actor.permissions.size, 0); // no roles → default deny
    assert.notEqual(actor.strength.mfaAt, null);
    assert.deepEqual([...actor.permissions], []);
  });
});

test("token actors keep MFA strength null but authenticate strongly", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMachine(t, async (machines, resolver) => {
    const account = await machines.createServiceAccount({ name: "m", purpose: "strength" });
    const { rawSecret } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["seo.read"],
      ttlMilliseconds: 60_000,
    });
    void deriveKeyForTesting;
    void createTotpService;
    void createThrottleService;
    const result = await resolver.authenticateToken(rawSecret, { siteKey: null });
    assert.equal(result.actor.strength.mfaAt, null);
    assert.deepEqual(result.actor.strength.factors, ["access_token"]);
    assert.equal(result.actor.permissions.has("seo.read"), true);
  });
});
