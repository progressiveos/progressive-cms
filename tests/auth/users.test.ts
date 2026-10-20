// PCMS-AUTH-T002 — users + user_emails schema and identity service.
// Acceptance: stable immutable user ID; email is a mutable login identifier,
// not the identity (Auth spec §4–§6). Runs the real migrations on a
// disposable database.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createUserIdentityService,
  InvalidEmailError,
  normalizeEmail,
  type UserIdentityService,
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

async function withUsers(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, users: UserIdentityService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  const migrations = await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  assert.equal(migrations.current, loadMigrations("db/migrations").at(-1)?.name);
  await run(pool, createUserIdentityService(pool));
}

test("normalizeEmail: trim + lowercase, no dot/plus surgery, single-label domains rejected", () => {
  assert.equal(normalizeEmail("  Jane.Doe+news@ExAMPLE.COM "), "jane.doe+news@example.com");
  assert.throws(() => normalizeEmail("no-at-sign"), InvalidEmailError);
  assert.throws(() => normalizeEmail("@example.com"), InvalidEmailError);
  assert.throws(() => normalizeEmail("local@node"), InvalidEmailError); // no dot in domain
  assert.throws(() => normalizeEmail("has space@example.com"), InvalidEmailError);
  assert.throws(() => normalizeEmail("a..b@example.com"), InvalidEmailError);
  assert.throws(() => normalizeEmail(`${"x".repeat(65)}@example.com`), InvalidEmailError);
});

test("created users get an immutable stable ID; emails are the lookup key", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withUsers(t, async (_pool, users) => {
    const created = await users.createUser({
      displayName: "Ada Admin",
      email: "  Ada@Example.COM ",
    });
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.status, "ACTIVE");
    assert.equal(created.disabledAt, null);

    // Lookup by different display casing/spaces still finds the account.
    const found = await users.findUserByEmail("ada@example.com");
    assert.equal(found?.user.id, created.id);
    assert.equal(found?.email.emailDisplay, "Ada@Example.COM");
    assert.equal(found?.email.verifiedAt, null);
    assert.equal(await users.findUserByEmail("missing@example.com"), null);

    // The normalized form is unique — a second account with the same email
    // is rejected at the schema level.
    await assert.rejects(() =>
      users.createUser({ displayName: "Duplicate", email: "ada@example.com" }),
    );
  });
});

test("disable/enable transitions record disabled_at and restore", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withUsers(t, async (_pool, users) => {
    const user = await users.createUser({ displayName: "Eve", email: "eve@example.com" });
    const disabled = await users.disableUser(user.id);
    assert.equal(disabled.status, "DISABLED");
    assert.ok(disabled.disabledAt instanceof Date);

    const enabled = await users.enableUser(user.id);
    assert.equal(enabled.status, "ACTIVE");
    assert.equal(enabled.disabledAt, null);
  });
});

test("primary email verification is recorded once", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withUsers(t, async (_pool, users) => {
    const user = await users.createUser({ displayName: "Grace", email: "grace@example.com" });
    await users.markPrimaryEmailVerified(user.id);
    const email = await users.primaryEmail(user.id);
    assert.ok(email?.verifiedAt instanceof Date);
    // Idempotent-safe: a second verify on an already-verified address is a no-op error surface
    await assert.rejects(() => users.markPrimaryEmailVerified(user.id));
  });
});
