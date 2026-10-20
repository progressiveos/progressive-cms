// PCMS-AUTH-T017 — last-active-OWNER invariants incl. concurrency race
// (Auth spec §11/§40). Acceptance: cannot lock out ownership.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthError,
  assertNoActiveOwner,
  createRoleService,
  createUserIdentityService,
  hasActiveOwner,
  type RoleService,
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

async function withOwners(
  t: { after: (fn: () => void) => void },
  run: (users: UserIdentityService, roles: RoleService, pool: DbPool) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 8 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(createUserIdentityService(pool), createRoleService(pool), pool);
}

async function makeOwner(users: UserIdentityService, roles: RoleService, email: string) {
  const user = await users.createUser({ displayName: `Owner ${email}`, email });
  await roles.assignRole(user.id, "OWNER", null);
  return user;
}

test("cannot remove the OWNER role from the last active OWNER", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withOwners(t, async (users, roles, pool) => {
    const sole = await makeOwner(users, roles, "sole@example.com");
    await assert.rejects(
      () => roles.removeRole(sole.id, "OWNER", null),
      (err: AuthError) => err.code === "AUTH_LAST_OWNER_PROTECTED" && err.status === 409,
    );
    assert.deepEqual(await roles.userRoleKeys(sole.id), ["OWNER"]);
    assert.equal(await hasActiveOwner(pool), true);
  });
});

test("cannot disable the last active OWNER; non-OWNER users disable freely", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withOwners(t, async (users, roles) => {
    const sole = await makeOwner(users, roles, "sole@example.com");
    const peon = await users.createUser({ displayName: "Peon", email: "peon@example.com" });

    await users.disableUser(peon.id); // not an OWNER — invariant not applicable
    await users.enableUser(peon.id);

    await assert.rejects(
      () => users.disableUser(sole.id),
      (err: AuthError) => err.code === "AUTH_LAST_OWNER_PROTECTED",
    );
    assert.equal((await users.findUserById(sole.id))?.status, "ACTIVE");
  });
});

test("with two OWNERs one can be demoted/disabled, then the last one is locked", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withOwners(t, async (users, roles) => {
    const first = await makeOwner(users, roles, "first@example.com");
    const second = await makeOwner(users, roles, "second@example.com");

    await roles.removeRole(first.id, "OWNER", null);
    assert.deepEqual(await roles.userRoleKeys(first.id), []);

    await users.disableUser(first.id); // demoted, non-owner — disable freely

    await assert.rejects(
      () => users.disableUser(second.id),
      (err: AuthError) => err.code === "AUTH_LAST_OWNER_PROTECTED",
    );
  });
});

test("bootstrap guard: create-owner only before the first active OWNER", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withOwners(t, async (users, roles, pool) => {
    await assertNoActiveOwner(pool); // fresh installation
    await makeOwner(users, roles, "boot@example.com");
    await assert.rejects(
      () => assertNoActiveOwner(pool),
      (err: AuthError) => err.code === "AUTH_LAST_OWNER_PROTECTED",
    );
  });
});

test("RACE: two concurrent demotions of the two only OWNERs — one must lose", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withOwners(t, async (users, roles, pool) => {
    const a = await makeOwner(users, roles, "race-a@example.com");
    const b = await makeOwner(users, roles, "race-b@example.com");

    const attempts = await Promise.allSettled([
      roles.removeRole(a.id, "OWNER", null),
      roles.removeRole(b.id, "OWNER", null),
    ]);

    const fulfilled = attempts.filter((r) => r.status === "fulfilled").length;
    const rejected = attempts.filter((r) => r.status === "rejected").length;
    assert.equal(fulfilled, 1, "exactly one concurrent demotion may succeed");
    assert.equal(rejected, 1);

    // The installation is never left without an active OWNER.
    assert.equal(await hasActiveOwner(pool), true);
  });
});
