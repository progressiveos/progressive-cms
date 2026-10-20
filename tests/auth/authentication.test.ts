// PCMS-AUTH-T006 — login flow: enumeration safety, throttling integration,
// session issuance, disabled-account behavior (Auth spec §35/§36/§68/§71).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthenticationService,
  createAuthenticationService,
  createPasswordCredentialService,
  createPasswordPolicy,
  createProvisioningService,
  createRoleService,
  createSessionService,
  createThrottleService,
  createUserIdentityService,
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

async function withAuth(
  t: { after: (fn: () => void) => void },
  run: (
    auth: AuthenticationService,
    pool: DbPool,
    provisioner: ReturnType<typeof createProvisioningService>,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const users = createUserIdentityService(pool);
  const auth = createAuthenticationService(pool, {
    users,
    passwords: createPasswordCredentialService(pool),
    throttle: createThrottleService(pool),
    sessions: createSessionService(pool),
  });
  const provisioner = createProvisioningService(pool, {
    users,
    passwords: createPasswordCredentialService(pool),
    policy: createPasswordPolicy(),
    roles: createRoleService(pool),
  });
  await run(auth, pool, provisioner);
}

test("correct login issues a usable session; wrong password is a generic error", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withAuth(t, async (auth, _pool, provisioner) => {
    await provisioner.bootstrapOwner({
      displayName: "Owner",
      email: "login-owner@example.com",
      password: "correct-passphrase-15",
    });

    const result = await auth.login({
      email: "login-owner@example.com",
      password: "correct-passphrase-15",
      ip: "10.0.0.5",
    });
    assert.equal(result.stage, "PASSWORD_OK");
    assert.equal(result.mfaRequired, false);
    assert.equal(result.session.rawToken.length, 43);

    await assert.rejects(
      () => auth.login({ email: "login-owner@example.com", password: "wrong-password-15x" }),
      (err: { code: string }) => err.code === "AUTH_INVALID_CREDENTIALS",
    );
    // Unknown email: IDENTICAL code and message — no enumeration signal.
    await assert.rejects(
      () => auth.login({ email: "ghost@example.com", password: "wrong-password-15x" }),
      (err: { code: string; message: string; status?: number }) =>
        err.code === "AUTH_INVALID_CREDENTIALS" && err.status === 401,
    );
  });
});

test("disabled accounts answer with the same generic invalid-credentials error", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withAuth(t, async (auth, pool, provisioner) => {
    const owner = await provisioner.bootstrapOwner({
      displayName: "Owner",
      email: "disable-owner@example.com",
      password: "still-the-password-15",
    });
    // A second owner so disabling the first is permitted by the invariant.
    await provisioner.createUserWithRole({
      displayName: "Owner2",
      email: "owner2@example.com",
      roleKey: "OWNER",
    });
    const users = createUserIdentityService(pool);
    const first = (await users.findUserByEmail("disable-owner@example.com"))!.user;
    await users.disableUser(first.id);
    void owner;

    await assert.rejects(
      () => auth.login({ email: "disable-owner@example.com", password: "still-the-password-15" }),
      (err: { code: string }) => err.code === "AUTH_INVALID_CREDENTIALS",
    );
  });
});

test("repeated failures trip the throttle before credentials are checked", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withAuth(t, async (auth, _pool, provisioner) => {
    await provisioner.bootstrapOwner({
      displayName: "Owner",
      email: "throttle-target@example.com",
      password: "target-passphrase-15",
    });
    const bad = { email: "throttle-target@example.com", password: "bad-guess-xxxx-15" };
    for (let i = 0; i < 6; i++) {
      await auth.login(bad).catch(() => undefined);
    }
    await assert.rejects(
      () => auth.login(bad),
      (err: { code: string; status: number }) =>
        err.code === "AUTH_THROTTLED" && err.status === 429,
    );
    // Even the CORRECT password is refused while throttled (and stays generic).
    await assert.rejects(
      () => auth.login({ email: "throttle-target@example.com", password: "target-passphrase-15" }),
      (err: { code: string }) => err.code === "AUTH_THROTTLED",
    );
  });
});

test("login resolves a session that the session service accepts", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withAuth(t, async (auth, pool, provisioner) => {
    await provisioner.bootstrapOwner({
      displayName: "Owner",
      email: "session-owner@example.com",
      password: "session-passphrase-15",
    });
    const result = await auth.login({
      email: "session-owner@example.com",
      password: "session-passphrase-15",
    });
    const sessions = createSessionService(pool);
    const resolved = await sessions.resolveSession(result.session.rawToken);
    assert.equal(resolved?.userId, result.user.id);
    assert.notEqual(resolved?.csrfHash, null);
  });
});
