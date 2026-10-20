// PCMS-AUTH-T015 — role service: seeded built-ins, assignment, permission
// resolution, default deny against the database.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builtinRolePermissions,
  createRoleService,
  createUserIdentityService,
  type RoleService,
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

async function withRoles(
  t: { after: (fn: () => void) => void },
  run: (
    pool: DbPool,
    roles: RoleService,
    users: ReturnType<typeof createUserIdentityService>,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const users = createUserIdentityService(pool);
  await run(pool, createRoleService(pool), users);
}

test("migrations seed the five built-in roles as immutable rows", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoles(t, async (_pool, roles) => {
    const rolesList = await roles.listRoles();
    const keys = rolesList.map((role) => role.key).sort();
    assert.deepEqual(keys, ["ADMIN", "AUTHOR", "DEVELOPER", "EDITOR", "OWNER"]);
    for (const role of rolesList) {
      assert.equal(role.builtin, true);
      assert.equal(role.immutable, true);
      assert.deepEqual(
        [...role.permissions].sort(),
        [...builtinRolePermissions(role.key as never)].sort(),
      );
    }
  });
});

test("assignment and removal are reflected in resolved permissions", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoles(t, async (_pool, roles, users) => {
    const user = await users.createUser({ displayName: "Editor Eve", email: "eve@example.com" });
    assert.equal((await roles.userPermissions(user.id)).size, 0); // default deny

    await roles.assignRole(user.id, "AUTHOR", null);
    const authorPerms = await roles.userPermissions(user.id);
    assert.equal(authorPerms.has("content.create"), true);
    assert.equal(authorPerms.has("publication.publish"), false); // AUTHOR never publishes

    await roles.assignRole(user.id, "EDITOR", null);
    const editorPerms = await roles.userPermissions(user.id);
    assert.equal(editorPerms.has("publication.publish"), true);
    assert.equal(editorPerms.has("users.manage"), false); // editorial roles stay out of admin

    await roles.removeRole(user.id, "EDITOR", null);
    assert.deepEqual(await roles.userRoleKeys(user.id), ["AUTHOR"]);
  });
});

test("removing an unassigned role and unknown roles fail cleanly", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoles(t, async (_pool, roles, users) => {
    const user = await users.createUser({ displayName: "Solo", email: "solo@example.com" });
    await assert.rejects(
      () => roles.removeRole(user.id, "EDITOR", null),
      (err: { code: string }) => err.code === "AUTH_VALIDATION",
    );
    await assert.rejects(
      () => roles.assignRole(user.id, "SUPERGOD", null),
      (err: { code: string }) => err.code === "AUTH_VALIDATION",
    );
  });
});
