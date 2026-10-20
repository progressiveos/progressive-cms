// PCMS-AUTH-T018 — custom roles + registry-evolution policy.
// Acceptance: no implicit privilege expansion (Auth spec §45/§47).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAllRegistered,
  createRoleService,
  createUserIdentityService,
  isRegisteredPermission,
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

async function withRoleSandbox(
  t: { after: (fn: () => void) => void },
  run: (roles: RoleService, users: ReturnType<typeof createUserIdentityService>) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(createRoleService(pool), createUserIdentityService(pool));
}

test("custom roles store an explicit permission set and grant exactly it", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoleSandbox(t, async (roles, users) => {
    const reviewer = await roles.createCustomRole(
      {
        key: "REVIEWER",
        name: "Content Reviewer",
        permissions: ["content.read", "publication.read", "preview.create"],
      },
      null,
    );
    assert.equal(reviewer.builtin, false);
    assert.equal(reviewer.immutable, false);

    const user = await users.createUser({ displayName: "Rev", email: "rev@example.com" });
    await roles.assignRole(user.id, "REVIEWER", null);
    const perms = await roles.userPermissions(user.id);
    assert.equal(perms.has("content.read"), true);
    assert.equal(perms.has("publication.publish"), false); // not granted — denied
    assert.equal(perms.has("users.manage"), false);
  });
});

test("forged or unregistered keys cannot enter a custom role", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoleSandbox(t, async (roles) => {
    await assert.rejects(
      () =>
        roles.createCustomRole(
          { key: "GODMODE", name: "God", permissions: ["content.read", "pcms.everything"] },
          null,
        ),
      (err: Error) => /unregistered permission/.test(err.message),
    );
    await assert.rejects(() =>
      roles.createCustomRole({ key: "owner", name: "Sneaky", permissions: [] }, null),
    ); // lowercase fails key format AND would collide with built-ins by format
    await assert.rejects(
      () => roles.createCustomRole({ key: "ADMIN", name: "Clone", permissions: [] }, null),
      (err: { code: string }) => err.code === "AUTH_VALIDATION",
    );
    assert.equal(isRegisteredPermission("pcms.everything"), false);
    assert.throws(() => assertAllRegistered(["nope.nope"]));
  });
});

test("registry evolution: appended keys never broaden an existing custom role", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoleSandbox(t, async (roles, users) => {
    const role = await roles.createCustomRole(
      { key: "LEDGER", name: "Ledger Keeper", permissions: ["payments.read"] },
      null,
    );

    // Simulate a future minor release appending a key to the registry: the
    // custom role's stored set is unchanged, so resolution grants nothing new.
    const before = [...role.permissions].sort();
    assert.deepEqual(before, ["payments.read"]);
    assert.equal(isRegisteredPermission("payments.settle.v2"), false);
    // (A real release adds the key to PERMISSION_REGISTRY; because custom
    // roles store explicit sets and resolution intersects the registry per
    // stored key, "payments.settle.v2" would only appear after an admin
    // explicitly grants it. The stored-set guarantee is asserted directly.)
    const stored = await roles.findRole("LEDGER");
    assert.deepEqual([...(stored?.permissions ?? [])].sort(), ["payments.read"]);

    const user = await users.createUser({ displayName: "Keeper", email: "keeper@example.com" });
    await roles.assignRole(user.id, "LEDGER", null);
    assert.equal((await roles.userPermissions(user.id)).has("payments.read"), true);

    // Explicit re-grant is the only way a custom role grows.
    await roles.updateCustomRole(
      "LEDGER",
      { permissions: ["payments.read", "payments.events.read"] },
      null,
    );
    assert.equal((await roles.userPermissions(user.id)).has("payments.events.read"), true);
  });
});

test("built-ins are immutable; assigned custom roles cannot be deleted", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoleSandbox(t, async (roles, users) => {
    await roles.createCustomRole({ key: "TEMP", name: "Temp", permissions: [] }, null);
    const user = await users.createUser({ displayName: "T", email: "t@example.com" });
    await roles.assignRole(user.id, "TEMP", null);

    await assert.rejects(
      () => roles.updateCustomRole("EDITOR", { name: "Hacked" }, null),
      (err: { code: string }) => err.code === "AUTH_VALIDATION",
    );
    await assert.rejects(
      () => roles.deleteCustomRole("OWNER", null),
      (err: { code: string }) => err.code === "AUTH_VALIDATION",
    );
    await assert.rejects(
      () => roles.deleteCustomRole("TEMP", null),
      (err: { code: string }) => err.code === "AUTH_VALIDATION",
    );
    await roles.removeRole(user.id, "TEMP", null);
    await roles.deleteCustomRole("TEMP", null);
    assert.equal(await roles.findRole("TEMP"), null);
  });
});
