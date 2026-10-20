// PCMS-AUTH-T004 — Argon2id credential hashing, verification, rehash.
// Acceptance: hash/rehash tests (Auth spec §15/§16).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARGON2_BASELINE,
  type AuthError,
  assertArgon2Params,
  createPasswordCredentialService,
  createUserIdentityService,
  type PasswordCredentialService,
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

async function withPasswords(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, passwords: PasswordCredentialService, userId: string) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const users = createUserIdentityService(pool);
  const user = await users.createUser({ displayName: "PW User", email: "pw@example.com" });
  await run(pool, createPasswordCredentialService(pool), user.id);
}

test("hash produces a self-describing Argon2id PHC string with baseline parameters", async () => {
  const passwords = createPasswordCredentialService({
    query: async () => ({ rows: [], rowCount: 0 }),
  } as unknown as DbPool);
  const verifier = await passwords.hashPassword("correct horse battery staple 15!!");
  assert.match(verifier, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  assert.equal(await passwords.verifyVerifier(verifier, "correct horse battery staple 15!!"), true);
  assert.equal(await passwords.verifyVerifier(verifier, "wrong password entirely"), false);
  assert.equal(passwords.needsRehash(verifier), false);
});

test("set/verify round-trip against the credential store", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPasswords(t, async (_pool, passwords, userId) => {
    assert.equal(await passwords.hasPassword(userId), false);
    const verifier = await passwords.hashPassword("a-very-long-password-with-unicode-Ω≈ç√");
    await passwords.setPassword(userId, verifier);

    assert.equal(await passwords.hasPassword(userId), true);
    const result = await passwords.verifyAndRehash(
      userId,
      "a-very-long-password-with-unicode-Ω≈ç√",
    );
    assert.equal(result.ok, true);
    assert.equal(result.rehashed, false);

    const wrong = await passwords.verifyAndRehash(userId, "not the password");
    assert.equal(wrong.ok, false);
  });
});

test("replacing the password invalidates the old verifier (single active password)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPasswords(t, async (_pool, passwords, userId) => {
    await passwords.setPassword(userId, await passwords.hashPassword("first-password-15"));
    await passwords.setPassword(userId, await passwords.hashPassword("second-password-15"));
    assert.equal((await passwords.verifyAndRehash(userId, "first-password-15")).ok, false);
    assert.equal((await passwords.verifyAndRehash(userId, "second-password-15")).ok, true);
  });
});

test("login for an account without a password costs the same as a wrong password", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPasswords(t, async (_pool, passwords, userId) => {
    const noPassword = await passwords.verifyAndRehash(userId, "whatever-attempt");
    assert.deepEqual(noPassword, { ok: false, rehashed: false });
  });
});

test("stored parameters below current policy trigger a transparent rehash", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPasswords(t, async (pool, passwords, userId) => {
    // Simulate a hash created under an older, weaker policy.
    const argon2 = (await import("argon2")).default;
    const oldHash = await argon2.hash("legacy-password-15", {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 1,
      parallelism: 1,
    });
    await passwords.setPassword(userId, oldHash);
    assert.equal(passwords.needsRehash(oldHash), true);

    const result = await passwords.verifyAndRehash(userId, "legacy-password-15");
    assert.equal(result.ok, true);
    assert.equal(result.rehashed, true);

    // The upgraded verifier now matches the current policy and still verifies.
    const upgraded = await passwords.getVerifier(userId);
    assert.notEqual(upgraded, null);
    assert.match(upgraded as string, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    const second = await passwords.verifyAndRehash(userId, "legacy-password-15");
    assert.deepEqual(second, { ok: true, rehashed: false });
  });
});

test("configuring parameters below the security baseline is rejected", () => {
  assert.throws(
    () => assertArgon2Params({ memoryKiB: 4096, timeCost: 2, parallelism: 1 }),
    (err: AuthError) => err.code === "AUTH_CONFIGURATION",
  );
  assert.throws(
    () => assertArgon2Params({ memoryKiB: 19456, timeCost: 1, parallelism: 1 }),
    (err: AuthError) => err.code === "AUTH_CONFIGURATION",
  );
  // Baseline itself and any raise are fine.
  assertArgon2Params({ ...ARGON2_BASELINE });
  assertArgon2Params({ memoryKiB: 65536, timeCost: 3, parallelism: 2 });
});
