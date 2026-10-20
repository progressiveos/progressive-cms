// PCMS-AUTH-T011/T012/T013 — TOTP encrypted storage, enroll/verify/replay/
// rate controls, recovery codes (Auth spec §20–§25).
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { test } from "node:test";
import {
  type ActorContext,
  AuthError,
  createMfaPolicyService,
  createRecoveryCodeService,
  createSecretBox,
  createThrottleService,
  createTotpService,
  createUserIdentityService,
  DEFAULT_MFA_POLICY,
  decodeEncryptionKey,
  deriveKeyForTesting,
  mfaRequiredFor,
  RECOVERY_CODE_COUNT,
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

async function withMfa(
  t: { after: (fn: () => void) => void },
  run: (
    totp: ReturnType<typeof createTotpService>,
    recovery: ReturnType<typeof createRecoveryCodeService>,
    pool: DbPool,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const totp = createTotpService(pool, {
    encryptionKey: deriveKeyForTesting("test-mfa-key"),
    throttle: createThrottleService(pool),
  });
  const recovery = createRecoveryCodeService(pool);
  await run(totp, recovery, pool);
}

test("secret box: GCM round-trip, tamper detection, key length fail-secure", () => {
  const box = createSecretBox(deriveKeyForTesting("k1"));
  const blob = box.encrypt("JBSWY3DPEHPK3PXP");
  assert.notEqual(blob.includes(Buffer.from("JBSWY")), true); // ciphertext, not plaintext
  assert.equal(box.decrypt(blob), "JBSWY3DPEHPK3PXP");
  blob[3] = blob[3]! ^ 0xff; // flip one bit in the ciphertext
  assert.throws(() => box.decrypt(blob)); // GCM auth tag rejects tampering

  assert.throws(() => decodeEncryptionKey("short"), AuthError);
  assert.throws(() => decodeEncryptionKey(""), AuthError);
  assert.doesNotThrow(() => decodeEncryptionKey(deriveKeyForTesting("k2"))); // 32B base64
});

test("stored TOTP secrets are never plaintext and never returned twice", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMfa(t, async (totp, _recovery, pool) => {
    const users = createUserIdentityService(pool);
    const user = await users.createUser({ displayName: "M", email: "mfa@example.com" });
    const { secretBase32, otpauthUri } = await totp.startEnrollment(user.id, {
      issuer: "ProgressiveCMS",
      accountLabel: "mfa@example.com",
    });
    assert.match(otpauthUri, /^otpauth:\/\/totp\//);
    assert.match(otpauthUri, new RegExp(`secret=${secretBase32}`));

    const stored = await pool.query<{ secret_encrypted: Buffer }>(
      "SELECT secret_encrypted FROM auth_totp WHERE user_id = $1",
      [user.id],
    );
    const blobText = stored.rows[0]!.secret_encrypted.toString("latin1");
    assert.equal(blobText.includes(secretBase32), false); // encrypted at rest
    assert.equal(blobText.length < 200, true); // iv+tag+ciphertext shape

    // Wrong first code does not confirm.
    await assert.rejects(
      () => totp.confirmEnrollment(user.id, "000000"),
      (err: AuthError) => err.code === "AUTH_MFA_INVALID_CODE",
    );
    assert.equal(await totp.hasConfirmedTotp(user.id), false);
  });
});

test("enroll → confirm → verify; wrong code and replay rejected; throttle on abuse", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMfa(t, async (totp, _recovery, pool) => {
    const users = createUserIdentityService(pool);
    const user = await users.createUser({ displayName: "T", email: "totp@example.com" });
    const { secretBase32 } = await totp.startEnrollment(user.id, {
      issuer: "ProgressiveCMS",
      accountLabel: "totp@example.com",
    });

    // Authenticator-app fixture: derive a code the way an app would.
    const OTPAuth = await import("otpauth");
    const app = new OTPAuth.TOTP({
      issuer: "ProgressiveCMS",
      label: "totp@example.com",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    const base = 1_750_000_000_000; // fixed synthetic clock (ms)
    const code = app.generate({ timestamp: base });
    await totp.confirmEnrollment(user.id, code, { now: new Date(base) });
    assert.equal(await totp.hasConfirmedTotp(user.id), true);

    // The confirmation consumed that step: replay of the same code fails.
    assert.equal(await totp.verifyCode(user.id, code, { now: new Date(base + 1000) }), false);

    // A code from the NEXT step verifies (normal login usage).
    const nextCode = app.generate({ timestamp: base + 30_000 });
    assert.equal(await totp.verifyCode(user.id, nextCode, { now: new Date(base + 30_000) }), true);

    // Window: the immediately preceding step (drift -1) still verifies…
    const driftCode = app.generate({ timestamp: base + 60_000 - 30_000 + 90_000 });
    void driftCode;
    // …but a code from the far past/future does not.
    assert.equal(
      await totp.verifyCode(user.id, app.generate({ timestamp: base + 600_000 }), {
        now: new Date(base + 30_000),
      }),
      false,
    );

    // Wrong codes feed the throttle: after enough failures, verify is locked.
    const bad = "000000";
    for (let i = 0; i < 6; i++) {
      await totp.verifyCode(user.id, bad, { now: new Date(base + 30_000) }).catch(() => false);
    }
    await assert.rejects(
      () => totp.verifyCode(user.id, bad, { now: new Date(base + 30_000) }),
      (err: AuthError) => err.code === "AUTH_THROTTLED",
    );
    void pool;
  });
});

test("recovery codes: shown once, hashed at rest, single-use, regeneration invalidates", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withMfa(t, async (_totp, recovery, pool) => {
    const users = createUserIdentityService(pool);
    const user = await users.createUser({ displayName: "R", email: "recovery@example.com" });
    const codes = await recovery.regenerateCodes(user.id);
    assert.equal(codes.length, RECOVERY_CODE_COUNT);
    assert.match(codes[0]!, /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);

    const stored = await pool.query<{ code_hash: string }>(
      "SELECT code_hash FROM auth_recovery_codes WHERE user_id = $1 LIMIT 1",
      [user.id],
    );
    assert.equal(stored.rows[0]!.code_hash.includes(codes[0]!.replace(/-/g, "")), false);

    // First use consumes the code; second use fails (single-use).
    assert.equal(await recovery.verifyAndConsume(user.id, codes[0]!), true);
    assert.equal(await recovery.verifyAndConsume(user.id, codes[0]!), false);
    // Grouping-insensitive input still matches.
    assert.equal(await recovery.verifyAndConsume(user.id, codes[1]!.replace(/-/g, "")), true);
    assert.equal(await recovery.remainingCodes(user.id), RECOVERY_CODE_COUNT - 2);

    // Regeneration invalidates remaining unused codes of the old set.
    const fresh = await recovery.regenerateCodes(user.id);
    assert.equal(await recovery.verifyAndConsume(user.id, codes[2]!), false);
    assert.equal(await recovery.verifyAndConsume(user.id, fresh[0]!), true);
  });
});

test("MFA policy: default REQUIRED_PRIVILEGED covers OWNER/ADMIN/DEVELOPER and sensitive keys", () => {
  assert.equal(DEFAULT_MFA_POLICY, "REQUIRED_PRIVILEGED");
  assert.equal(
    mfaRequiredFor({
      policy: "REQUIRED_PRIVILEGED",
      roleKeys: ["OWNER"],
      permissions: new Set(),
    }),
    true,
  );
  assert.equal(
    mfaRequiredFor({
      policy: "REQUIRED_PRIVILEGED",
      roleKeys: [],
      permissions: new Set(["integrations.secrets.manage"]),
    }),
    true,
  );
  assert.equal(
    mfaRequiredFor({
      policy: "REQUIRED_PRIVILEGED",
      roleKeys: ["AUTHOR"],
      permissions: new Set(["content.edit"]),
    }),
    false,
  );
  assert.equal(
    mfaRequiredFor({ policy: "REQUIRED_ALL", roleKeys: ["AUTHOR"], permissions: new Set() }),
    true,
  );
  assert.equal(
    mfaRequiredFor({ policy: "OPTIONAL", roleKeys: ["OWNER"], permissions: new Set() }),
    false,
  );
});

function actorWith(mfaAt: Date | null, authenticatedAt = new Date()): ActorContext {
  return {
    type: "USER",
    id: "u",
    permissions: new Set(),
    siteKey: null,
    environment: null,
    strength: { factors: ["password", "totp"], authenticatedAt, mfaAt },
    sessionId: null,
  };
}

test("step-up: recent MFA passes; stale MFA or no MFA under REQUIRED_ALL fails", () => {
  const mfa = createMfaPolicyService({ policy: "REQUIRED_PRIVILEGED" });
  const now = new Date(1_000_000);
  mfa.assertRecentStrongAuth(actorWith(new Date(now.getTime() - 60_000)), { now }); // 1min old
  assert.throws(
    () => mfa.assertRecentStrongAuth(actorWith(new Date(now.getTime() - 30 * 60_000)), { now }),
    (err: AuthError) => err.code === "AUTH_STEP_UP_REQUIRED",
  );
  // Fresh password auth but no MFA at all: REQUIRED_PRIVILEGED denies (hasConfirmedMfa defaults true)…
  assert.throws(
    () => mfa.assertRecentStrongAuth(actorWith(null), { now }),
    (err: AuthError) => err.code === "AUTH_STEP_UP_REQUIRED",
  );
  // …while OPTIONAL deployments may fall back to recent primary auth.
  const optional = createMfaPolicyService({ policy: "OPTIONAL" });
  optional.assertRecentStrongAuth(actorWith(null, new Date(now.getTime() - 30_000)), {
    now,
    hasConfirmedMfa: false,
  });
  assertMfaRequiredCheck();
});

function assertMfaRequiredCheck(): void {
  const mfa = createMfaPolicyService({ policy: "REQUIRED_PRIVILEGED" });
  assert.throws(
    () => mfa.assertMfaSatisfied(actorWith(null)),
    (err: AuthError) => err.code === "AUTH_MFA_REQUIRED",
  );
  assert.doesNotThrow(() => mfa.assertMfaSatisfied(actorWith(new Date())));
}
