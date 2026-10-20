// PCMS-AUTH-T026 — local operator recovery CLI: bootstrap owner, password
// reset with session revocation, user disable, MFA reset, session/token
// revocation. Every action is audited with the OPERATOR actor (Auth spec
// §62/§63; no HTTP surface, no master password).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createMachineIdentityService,
  createPasswordCredentialService,
  createSessionService,
  createThrottleService,
  createTotpService,
  createUserIdentityService,
  deriveKeyForTesting,
} from "@pcms/auth";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  sessionAdmin,
  tokenAdmin,
  type UserAdminResult,
  userAdmin,
} from "../../packages/cli/src/commands/user-admin.js";
import { cmsProcessEnv } from "../helpers/process-env.js";
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

async function withCli(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, env: Record<string, string | undefined>, configPath: string) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const dir = mkdtempSync(join(tmpdir(), "pcms-cli-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, "pcms.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      nodeEnv: "test",
      db: {
        host: db.connection.host,
        port: db.connection.port,
        database: db.connection.database,
        user: db.connection.user,
        sslMode: "disable",
        passwordSecretRef: "db.password",
      },
      secrets: { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
    }),
  );
  const password = db.connection.password ?? "";
  const env: Record<string, string | undefined> = cmsProcessEnv({
    PCMS_SECRET_DB_PASSWORD: password,
  });
  await run(pool, env, configPath);
}

test("create-owner bootstraps once; the second attempt is refused", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCli(t, async (_pool, env, configPath) => {
    const base = ["--config", configPath];
    const first: UserAdminResult = await userAdmin({
      args: ["create-owner", "--email", "root@example.com", "--name", "Root", ...base],
      env,
      stdin: "the-first-owner-passphrase",
    });
    assert.equal(first.exitCode, 0, first.stderr);

    const second = await userAdmin({
      args: ["create-owner", "--email", "root2@example.com", "--name", "Root2", ...base],
      env,
      stdin: "another-passphrase-here",
    });
    assert.equal(second.exitCode, 1);
    assert.match(second.stderr, /OWNER/);
  });
});

test("reset-password replaces the credential and revokes sessions", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCli(t, async (pool, env, configPath) => {
    const users = createUserIdentityService(pool);
    await users.createUser({ displayName: "Victim", email: "victim@example.com" });
    const passwords = createPasswordCredentialService(pool);
    const victim = (await users.findUserByEmail("victim@example.com"))!.user.id;
    await passwords.setPassword(victim, await passwords.hashPassword("before-reset-passphrase"));
    const sessions = createSessionService(pool);
    const { rawToken } = await sessions.createSession(victim, {});

    const result = await userAdmin({
      args: ["reset-password", "--email", "victim@example.com", "--config", configPath, "--json"],
      env,
      stdin: "after-reset-passphrase",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await sessions.resolveSession(rawToken), null);

    const found = (await users.findUserByEmail("victim@example.com"))!.user;
    assert.equal((await passwords.verifyAndRehash(found.id, "after-reset-passphrase")).ok, true);
    assert.equal((await passwords.verifyAndRehash(found.id, "before-reset-passphrase")).ok, false);
  });
});

test("user disable refuses the last OWNER and works for everyone else", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCli(t, async (pool, env, configPath) => {
    const provisioningPool = pool;
    void provisioningPool;
    // Bootstrap an owner, then create a regular user.
    await userAdmin({
      args: ["create-owner", "--email", "own@example.com", "--name", "Own", "--config", configPath],
      env,
      stdin: "owner-passphrase-15",
    });
    const users = createUserIdentityService(pool);
    await users.createUser({ displayName: "Staff", email: "staff@example.com" });

    const bad = await userAdmin({
      args: ["disable", "--email", "own@example.com", "--config", configPath],
      env,
    });
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /OWNER/);

    const good = await userAdmin({
      args: ["disable", "--email", "staff@example.com", "--config", configPath, "--json"],
      env,
    });
    assert.equal(good.exitCode, 0, good.stderr);
    assert.equal((await users.findUserByEmail("staff@example.com"))?.user.status, "DISABLED");
  });
});

test("disable-mfa resets TOTP and revokes sessions", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCli(t, async (pool, env, configPath) => {
    const users = createUserIdentityService(pool);
    await users.createUser({ displayName: "Mfa", email: "mfauser@example.com" });
    const userId = (await users.findUserByEmail("mfauser@example.com"))!.user.id;
    const totp = createTotpService(pool, {
      encryptionKey: deriveKeyForTesting("cli-test-key"),
      throttle: createThrottleService(pool),
    });
    await totp.startEnrollment(userId, { issuer: "T", accountLabel: "mfauser@example.com" });
    assert.equal(await totp.hasPendingTotp(userId), true);

    const result = await userAdmin({
      args: ["disable-mfa", "--email", "mfauser@example.com", "--config", configPath, "--json"],
      env,
    });
    assert.equal(result.exitCode, 0, result.stdout);
    assert.equal(await totp.hasPendingTotp(userId), false);
    assert.equal(await totp.hasConfirmedTotp(userId), false);
  });
});

test("session revoke-all and token revoke close machine access", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCli(t, async (pool, env, configPath) => {
    const users = createUserIdentityService(pool);
    await users.createUser({ displayName: "S", email: "sessions@example.com" });
    const sessions = createSessionService(pool);
    const sessionsUser = (await users.findUserByEmail("sessions@example.com"))!.user.id;
    const { rawToken } = await sessions.createSession(sessionsUser, {});

    const revoked = await sessionAdmin({
      args: ["revoke-all", "--email", "sessions@example.com", "--config", configPath, "--json"],
      env,
    });
    assert.equal(revoked.exitCode, 0, revoked.stderr);
    assert.equal(await sessions.resolveSession(rawToken), null);

    const machines = createMachineIdentityService(pool);
    const account = await machines.createServiceAccount({ name: "cli", purpose: "t" });
    const { rawSecret } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.read"],
      ttlMilliseconds: 60_000,
    });
    const tokens = await machines.listAccessTokens(account.id);
    const result = await tokenAdmin({
      args: ["revoke", "--token-id", tokens[0]!.id, "--config", configPath, "--json"],
      env,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const resolver = (await import("@pcms/auth")).createActorResolver(pool, { users });
    await assert.rejects(
      () => resolver.authenticateToken(rawSecret),
      (err: { code: string }) => err.code === "AUTH_TOKEN_REVOKED",
    );
  });
});

test("usage errors exit 2; operator actions are audited", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCli(t, async (pool, env, configPath) => {
    const unknown = await userAdmin({ args: ["frobnicate"], env });
    assert.equal(unknown.exitCode, 2);

    await userAdmin({
      args: ["create-owner", "--email", "audit@example.com", "--name", "A", "--config", configPath],
      env,
      stdin: "audit-passphrase-15",
    });
    const events = await pool.query<{ event_type: string; actor_type: string }>(
      "SELECT event_type, actor_type FROM auth_security_events ORDER BY created_at DESC LIMIT 3",
    );
    assert.ok(
      events.rows.some((r) => r.event_type === "OWNER_BOOTSTRAPPED" && r.actor_type === "OPERATOR"),
    );
  });
});
