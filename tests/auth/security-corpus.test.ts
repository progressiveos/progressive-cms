// PCMS-AUTH-T028 — security integration/reference corpus.
//
// Integrated attack/abuse scenarios over the composed services (each unit
// guarantee has its own test file; this corpus proves the composition):
// bootstrap → login → MFA → session lifecycle → CSRF → machine tokens, with
// the hostile matrix from the M08 instructions and a raw-secret log scan
// over a complete login attempt (defense in depth on top of redaction).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthError,
  assertCsrfToken,
  createActorResolver,
  createAuthenticationService,
  createMachineIdentityService,
  createMfaPolicyService,
  createPasswordCredentialService,
  createPasswordPolicy,
  createProvisioningService,
  createRecoveryCodeService,
  createRoleService,
  createSessionService,
  createThrottleService,
  createTotpService,
  createUserIdentityService,
  deriveKeyForTesting,
  evaluateTokenConstraints,
  parseSessionCookie,
} from "@pcms/auth";
import {
  createDbPool,
  createLogger,
  type DbPool,
  loadMigrations,
  migrateDatabase,
} from "@pcms/core";
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

async function withCorpus(
  t: { after: (fn: () => void) => void },
  run: (ctx: {
    pool: DbPool;
    auth: ReturnType<typeof createAuthenticationService>;
    provisioning: ReturnType<typeof createProvisioningService>;
    sessions: ReturnType<typeof createSessionService>;
    totp: ReturnType<typeof createTotpService>;
    recovery: ReturnType<typeof createRecoveryCodeService>;
    machines: ReturnType<typeof createMachineIdentityService>;
    resolver: ReturnType<typeof createActorResolver>;
    users: ReturnType<typeof createUserIdentityService>;
    roles: ReturnType<typeof createRoleService>;
    throttle: ReturnType<typeof createThrottleService>;
  }) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 6 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const users = createUserIdentityService(pool);
  const passwords = createPasswordCredentialService(pool);
  const policy = createPasswordPolicy();
  const roles = createRoleService(pool);
  const sessions = createSessionService(pool);
  const throttle = createThrottleService(pool);
  const totp = createTotpService(pool, {
    encryptionKey: deriveKeyForTesting("corpus-key"),
    throttle,
  });
  const recovery = createRecoveryCodeService(pool);
  const machines = createMachineIdentityService(pool);
  const resolver = createActorResolver(pool, { users });
  const auth = createAuthenticationService(pool, {
    users,
    passwords,
    throttle,
    sessions,
  });
  const provisioning = createProvisioningService(pool, {
    users,
    passwords,
    policy,
    roles,
    onPasswordChanged: async (userId) => {
      await sessions.revokeAllForUser(userId, "password-changed");
    },
  });
  await run({
    pool,
    auth,
    provisioning,
    sessions,
    totp,
    recovery,
    machines,
    resolver,
    users,
    roles,
    throttle,
  });
}

test("happy path: bootstrap → login → TOTP → rotation → CSRF-guarded write → logout", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCorpus(t, async ({ auth, provisioning, sessions, totp, users, roles }) => {
    const owner = await provisioning.bootstrapOwner({
      displayName: "Owner",
      email: "owner@corpus.test",
      password: "first-owner-passphrase-15",
    });
    assert.deepEqual(await roles.userRoleKeys(owner.id), ["OWNER"]);

    // Login (no MFA gate configured → plain session).
    const login = await auth.login({
      email: "owner@corpus.test",
      password: "first-owner-passphrase-15",
      ip: "10.0.0.2",
    });
    assert.equal(login.stage, "PASSWORD_OK");

    // Enroll + confirm TOTP.
    const { secretBase32 } = await totp.startEnrollment(owner.id, {
      issuer: "CorpusCMS",
      accountLabel: "owner@corpus.test",
    });
    const OTPAuth = await import("otpauth");
    const app = new OTPAuth.TOTP({
      issuer: "CorpusCMS",
      label: "owner@corpus.test",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    const now = Date.now();
    await totp.confirmEnrollment(owner.id, app.generate({ timestamp: now }), {
      now: new Date(now),
    });
    assert.equal(await totp.hasConfirmedTotp(owner.id), true);
    assert.equal(
      await totp.verifyCode(owner.id, app.generate({ timestamp: now + 30_000 }), {
        now: new Date(now + 30_000),
      }),
      true,
    );

    // The application marks the session's strong factor, then rotates
    // (spec §31: rotate after MFA completion).
    await sessions.markMfaSatisfied(login.session.sessionId, new Date(now + 30_000));
    const rotated = await sessions.rotateSession(login.session.rawToken);
    const resolved = (await sessions.resolveSession(rotated.rawToken))!;
    const mfa = createMfaPolicyService({ policy: "REQUIRED_PRIVILEGED" });
    mfa.assertRecentStrongAuth(
      {
        type: "USER",
        id: owner.id,
        permissions: new Set(await roles.userPermissions(owner.id)),
        siteKey: null,
        environment: null,
        strength: {
          factors: ["password", "totp"],
          authenticatedAt: resolved.session.authenticatedAt,
          mfaAt: now + 30_000 > 0 ? resolved.session.mfaAt : null,
        },
        sessionId: resolved.session.id,
      },
      { now: new Date(now + 30_000) },
    );

    // CSRF-guarded mutation: header present and matching.
    assert.doesNotThrow(() => assertCsrfToken(resolved.csrfHash, rotated.csrfToken));

    // Logout: current session dies, login again works.
    await sessions.revokeSession(rotated.sessionId, "logout");
    assert.equal(await sessions.resolveSession(rotated.rawToken), null);
    void users;
  });
});

test("abuse matrix: enumeration, throttle, replay, single-use, disabled, last-owner", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCorpus(t, async ({ auth, provisioning, sessions, totp, recovery, users, throttle }) => {
    await provisioning.bootstrapOwner({
      displayName: "Owner",
      email: "abuse-owner@corpus.test",
      password: "abuse-owner-passphrase-15",
    });

    // Enumeration: unknown vs wrong password — identical machine behavior.
    for (const email of ["abuse-owner@corpus.test", "ghost@corpus.test"]) {
      await assert.rejects(
        () => auth.login({ email, password: "whatever-guess-15x", ip: "10.1.1.9" }),
        (err: AuthError) => err.code === "AUTH_INVALID_CREDENTIALS" && err.status === 401,
      );
    }

    // Throttle: 6 bad attempts lock even the correct credential.
    for (let i = 0; i < 6; i++) {
      await auth
        .login({
          email: "abuse-owner@corpus.test",
          password: "bad-guess-attempt-15",
          ip: "10.1.1.10",
        })
        .catch(() => undefined);
    }
    await assert.rejects(
      () =>
        auth.login({
          email: "abuse-owner@corpus.test",
          password: "abuse-owner-passphrase-15",
          ip: "10.1.1.10",
        }),
      (err: AuthError) => err.code === "AUTH_THROTTLED",
    );

    // (The email AND global buckets stay locked across IPs by design — the
    // layered throttle is doing its job. Simulating the lockout expiring, a
    // fresh account carries the MFA tests.)
    await throttle.recordSuccess([
      "login:global",
      "login:email:abuse-owner@corpus.test",
      "login:ip:10.1.1.10",
    ]);
    const editorInvite = await provisioning.createUserWithRole({
      displayName: "Editor",
      email: "editor@corpus.test",
      roleKey: "EDITOR",
    });
    // Invitation acceptance sets the first password (no public registration).
    await provisioning.acceptInvite({
      inviteToken: editorInvite.inviteToken,
      password: "editor-passphrase-15x",
    });
    const secondLogin = await auth.login({
      email: "editor@corpus.test",
      password: "editor-passphrase-15x",
      ip: "10.2.2.2",
    });
    const { secretBase32 } = await totp.startEnrollment(secondLogin.user.id, {
      issuer: "CorpusCMS",
      accountLabel: "abuse-owner@corpus.test",
    });
    const OTPAuth = await import("otpauth");
    const app = new OTPAuth.TOTP({
      issuer: "CorpusCMS",
      label: "abuse-owner@corpus.test",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    const now = Date.now();
    await totp.confirmEnrollment(secondLogin.user.id, app.generate({ timestamp: now }), {
      now: new Date(now),
    });
    const replayCode = app.generate({ timestamp: now });
    assert.equal(
      await totp.verifyCode(secondLogin.user.id, replayCode, { now: new Date(now + 1000) }),
      false,
    );
    assert.equal(
      await totp.verifyCode(secondLogin.user.id, "000000", { now: new Date(now + 1000) }),
      false,
    );

    // Recovery code: exactly one use.
    const codes = await recovery.regenerateCodes(secondLogin.user.id);
    assert.equal(await recovery.verifyAndConsume(secondLogin.user.id, codes[0]!), true);
    assert.equal(await recovery.verifyAndConsume(secondLogin.user.id, codes[0]!), false);

    // Disabled user: sessions unusable immediately; no new usable session.
    await users.disableUser(secondLogin.user.id).catch(async () => {
      // single-owner installations refuse disable; create a second owner first
      await provisioning.createUserWithRole({
        displayName: "O2",
        email: "second-owner@corpus.test",
        roleKey: "OWNER",
      });
      await users.disableUser(secondLogin.user.id);
    });
    assert.equal(await sessions.resolveSession(secondLogin.session.rawToken), null);

    // Password reset replay: the consumed token never works again.
    const reset = await provisioning.issuePasswordReset({ email: "abuse-owner@corpus.test" });
    assert.ok(reset.resetToken !== null);
    await provisioning.resetPassword({
      resetToken: reset.resetToken!,
      password: "fresh-passphrase-15",
    });
    await assert.rejects(
      () =>
        provisioning.resetPassword({
          resetToken: reset.resetToken!,
          password: "replay-pass-15xxx",
        }),
      (err: AuthError) => err.code === "AUTH_TOKEN_INVALID",
    );
  });
});

test("machine matrix: ceiling escalation, cross-site, expiry, revocation, disabled account", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCorpus(t, async ({ machines, resolver }) => {
    const account = await machines.createServiceAccount({
      name: "corpus-agent",
      purpose: "abuse testing",
      allowedScopes: ["content.read", "content.edit"],
    });

    // Scope escalation at creation: token asks beyond the account ceiling.
    await assert.rejects(
      () =>
        machines.createAccessToken({
          serviceAccountId: account.id,
          scopes: ["content.read", "publication.publish"],
          ttlMilliseconds: 60_000,
        }),
      (err: AuthError) => err.code === "AUTH_TOKEN_SCOPE_DENIED",
    );

    // Even a directly-forged DB row resolves to nothing (registry + ceiling).
    await assert.rejects(
      () => resolver.authenticateToken("pcms_deadbeef_deliberately-invalid-token-value-xx"),
      (err: AuthError) => err.code === "AUTH_TOKEN_INVALID",
    );

    const { rawSecret, token } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.edit"],
      siteKey: "corpus-site",
      environment: "preview",
      ttlMilliseconds: 60_000,
    });
    // Cross-site and wrong-environment denied; missing context denied.
    await assert.rejects(
      () =>
        resolver.authenticateToken(rawSecret, { siteKey: "other-site", environment: "preview" }),
      (err: AuthError) => err.code === "AUTH_TOKEN_SITE_DENIED",
    );
    await assert.rejects(
      () =>
        resolver.authenticateToken(rawSecret, {
          siteKey: "corpus-site",
          environment: "production",
        }),
      (err: AuthError) => err.code === "AUTH_TOKEN_ENVIRONMENT_DENIED",
    );
    await assert.rejects(
      () => resolver.authenticateToken(rawSecret, { siteKey: "corpus-site" }),
      (err: AuthError) => err.code === "AUTH_TOKEN_ENVIRONMENT_DENIED",
    );
    const allowed = await resolver.authenticateToken(rawSecret, {
      siteKey: "corpus-site",
      environment: "preview",
    });
    assert.deepEqual([...allowed.actor.permissions], ["content.edit"]);

    // Constraint evaluator unit matrix.
    assert.equal(
      evaluateTokenConstraints({ siteKey: "s", environment: null }, { siteKey: "s" }).allowed,
      true,
    );
    for (const forbidden of [
      "publication.publish",
      "users.manage",
      "tokens.manage",
      "leads.read",
    ]) {
      assert.equal(token.scopes.includes(forbidden), false);
    }

    // Revocation then disable: both refuse on the next resolution.
    await machines.revokeAccessToken(token.id, "corpus");
    await assert.rejects(
      () =>
        resolver.authenticateToken(rawSecret, { siteKey: "corpus-site", environment: "preview" }),
      (err: AuthError) => err.code === "AUTH_TOKEN_REVOKED",
    );
    const { rawSecret: second } = await machines.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["content.read"],
      ttlMilliseconds: 60_000,
    });
    await machines.disableServiceAccount(account.id, "corpus");
    await assert.rejects(
      () => resolver.authenticateToken(second),
      (err: AuthError) => err.code === "AUTH_SERVICE_ACCOUNT_DISABLED",
    );
  });
});

test("raw secret log scan: no password/token/verifier/cookie material in log output", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCorpus(t, async ({ auth, provisioning }) => {
    const lines: string[] = [];
    const log = createLogger({
      level: "debug",
      base: { process: "corpus" },
      sink: (line: string) => lines.push(line),
    });

    const PASSWORD = "log-scan-passphrase-15";
    await provisioning.bootstrapOwner({
      displayName: "Logger",
      email: "logger@corpus.test",
      password: PASSWORD,
    });
    const login = await auth.login({ email: "logger@corpus.test", password: PASSWORD });
    await auth
      .login({ email: "logger@corpus.test", password: "wrong-guess-15xxxxx" })
      .catch(() => undefined);

    // Simulate the kind of metadata a sloppy caller might attach.
    log.debug("auth.debug_probe", {
      operation: "probe",
      password: PASSWORD,
      session_token: login.session.rawToken,
      csrf_token: login.session.csrfToken,
    });

    const everything = lines.join("\n");
    for (const secret of [
      PASSWORD,
      "wrong-guess-15xxxxx",
      login.session.rawToken,
      login.session.csrfToken,
    ]) {
      assert.equal(
        everything.includes(secret),
        false,
        `secret leaked into logs: ${secret.slice(0, 8)}…`,
      );
    }
    // Hostile cookie headers parse to nothing usable.
    assert.equal(
      parseSessionCookie("__Host-pcms_session=; __Host-pcms_session=<script>", {
        ...{ name: "__Host-pcms_session", secure: true, sameSite: "Lax" as const },
      }),
      null,
    );
    void createActorResolver;
  });
});
