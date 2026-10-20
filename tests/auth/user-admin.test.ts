// Admin user management (2026-09-30 owner request): edit profile, hard
// delete. The service layer carries the invariants (email uniqueness,
// verification reset on email change, last-active-OWNER, child-row purge);
// the routes/ops layer only gates permissions.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthError,
  createRoleService,
  createUserIdentityService,
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
  run: (users: UserIdentityService, pool: DbPool) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 8 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(createUserIdentityService(pool), pool);
}

test("updateUser renames and re-emails; a changed email loses verification", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withUsers(t, async (users) => {
    const user = await users.createUser({
      displayName: "Old Name",
      email: "old@example.com",
      emailVerified: true,
    });
    const updated = await users.updateUser(user.id, {
      displayName: "New Name",
      primaryEmail: "new@example.com",
    });
    assert.equal(updated.displayName, "New Name");
    const email = await users.primaryEmail(user.id);
    assert.equal(email?.emailNormalized, "new@example.com");
    assert.equal(email?.verifiedAt, null);
  });
});

test("updateUser refuses an email that another user already holds", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withUsers(t, async (users) => {
    await users.createUser({ displayName: "A", email: "taken@example.com" });
    const b = await users.createUser({ displayName: "B", email: "b@example.com" });
    await assert.rejects(
      () => users.updateUser(b.id, { primaryEmail: "taken@example.com" }),
      (err: AuthError) => err.code === "AUTH_VALIDATION" && err.status === 409,
    );
  });
});

test("deleteUser purges the profile and all child rows; last OWNER is protected", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withUsers(t, async (users, pool) => {
    const { createRoleService } = await import("@pcms/auth");
    const roles = createRoleService(pool);
    const victim = await users.createUser({
      displayName: "Victim",
      email: "victim@example.com",
      emailVerified: true,
    });
    await roles.assignRole(victim.id, "EDITOR", null);
    const sole = await users.createUser({ displayName: "Sole", email: "sole@example.com" });
    await roles.assignRole(sole.id, "OWNER", null);

    await users.deleteUser(victim.id);
    assert.equal(await users.findUserById(victim.id), null);
    const leftovers = await pool.query(
      `SELECT
         (SELECT count(*) FROM user_emails WHERE user_id = $1) AS emails,
         (SELECT count(*) FROM auth_credentials WHERE user_id = $1) AS credentials,
         (SELECT count(*) FROM auth_user_roles WHERE user_id = $1) AS roles`,
      [victim.id],
    );
    assert.deepEqual(leftovers.rows[0], { emails: "0", credentials: "0", roles: "0" });

    // The sole OWNER cannot be deleted out of existence.
    await assert.rejects(
      () => users.deleteUser(sole.id),
      (err: AuthError) => err.code === "AUTH_LAST_OWNER_PROTECTED",
    );
  });
});
