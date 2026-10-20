// PCMS-AUTH-T003 — bootstrap/create/invite provisioning flows.
// Acceptance: no public registration; operator bootstrap only before the
// first OWNER; invitations single-use with verified email (Auth spec §9/§10).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPasswordCredentialService,
  createPasswordPolicy,
  createProvisioningService,
  createRoleService,
  createUserIdentityService,
  type ProvisioningService,
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

async function withProvisioning(
  t: { after: (fn: () => void) => void },
  run: (provisioning: ProvisioningService, pool: DbPool) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const users = createUserIdentityService(pool);
  const provisioning = createProvisioningService(pool, {
    users,
    passwords: createPasswordCredentialService(pool),
    policy: createPasswordPolicy(),
    roles: createRoleService(pool),
  });
  await run(provisioning, pool);
}

test("bootstrap creates the first OWNER exactly once", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProvisioning(t, async (provisioning, pool) => {
    const owner = await provisioning.bootstrapOwner({
      displayName: "Site Owner",
      email: "owner@example.com",
      password: "bootstrap-passphrase-15",
    });
    const roles = createRoleService(pool);
    assert.deepEqual(await roles.userRoleKeys(owner.id), ["OWNER"]);

    const passwordService = createPasswordCredentialService(pool);
    const login = await passwordService.verifyAndRehash(owner.id, "bootstrap-passphrase-15");
    assert.equal(login.ok, true);

    // Second bootstrap is refused (spec §10/§11: one OWNER bootstrap).
    await assert.rejects(
      () =>
        provisioning.bootstrapOwner({
          displayName: "Second",
          email: "second@example.com",
          password: "bootstrap-passphrase-15",
        }),
      (err: { code: string }) => err.code === "AUTH_LAST_OWNER_PROTECTED",
    );
  });
});

test("admin create + invite: no public registration, email verified only via invitation", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProvisioning(t, async (provisioning, pool) => {
    const { user, inviteToken, expiresAt } = await provisioning.createUserWithRole({
      displayName: "Editor N",
      email: "editor@example.com",
      roleKey: "EDITOR",
    });
    assert.ok(expiresAt.getTime() > Date.now());
    const email = await createUserIdentityService(pool).primaryEmail(user.id);
    assert.equal(email?.verifiedAt, null); // unverified until invitation acceptance

    const roles = createRoleService(pool);
    assert.deepEqual(await roles.userRoleKeys(user.id), ["EDITOR"]);

    const activated = await provisioning.acceptInvite({
      inviteToken,
      password: "editor-sets-this-15",
    });
    assert.equal(activated.id, user.id);
    const verified = await createUserIdentityService(pool).primaryEmail(user.id);
    assert.ok(verified?.verifiedAt instanceof Date);

    // Token is single-use: replay fails and does not reactivate anything.
    await assert.rejects(
      () => provisioning.acceptInvite({ inviteToken, password: "another-password-15" }),
      (err: { code: string }) => err.code === "AUTH_TOKEN_INVALID",
    );
    const still = await createPasswordCredentialService(pool).verifyAndRehash(
      user.id,
      "editor-sets-this-15",
    );
    assert.equal(still.ok, true);
  });
});

test("weak password rejected at invite acceptance without consuming the token", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProvisioning(t, async (provisioning) => {
    const { user, inviteToken } = await provisioning.createUserWithRole({
      displayName: "Weak",
      email: "weak@example.com",
      roleKey: "AUTHOR",
    });
    await assert.rejects(
      () => provisioning.acceptInvite({ inviteToken, password: "password123!" }),
      (err: { code: string }) => err.code === "AUTH_PASSWORD_BLOCKLISTED",
    );
    // Token still usable after the failed (pre-claim) attempt.
    const activated = await provisioning.acceptInvite({
      inviteToken,
      password: "strong-passphrase-15",
    });
    assert.equal(activated.id, user.id);
  });
});

test("password reset is enumeration-safe and single-use", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withProvisioning(t, async (provisioning, pool) => {
    const users = createUserIdentityService(pool);
    await provisioning.bootstrapOwner({
      displayName: "Owner",
      email: "owner@example.com",
      password: "original-passphrase-15",
    });

    // Unknown and known addresses return the same coarse shape to callers.
    const unknown = await provisioning.issuePasswordReset({ email: "ghost@example.com" });
    const known = await provisioning.issuePasswordReset({ email: "owner@example.com" });
    assert.equal(unknown.resetToken, null);
    assert.ok(known.resetToken !== null);

    const reset = await provisioning.resetPassword({
      resetToken: known.resetToken as string,
      password: "replacement-passphrase-15",
    });
    const owner = await users.findUserByEmail("owner@example.com");
    assert.equal(reset.userId, owner?.user.id);

    await assert.rejects(
      () =>
        provisioning.resetPassword({
          resetToken: known.resetToken as string,
          password: "replay-attack-pass-15",
        }),
      (err: { code: string }) => err.code === "AUTH_TOKEN_INVALID",
    );
    const passwordService = createPasswordCredentialService(pool);
    assert.equal(
      (await passwordService.verifyAndRehash(owner?.user.id ?? "", "replacement-passphrase-15")).ok,
      true,
    );
    assert.equal(
      (await passwordService.verifyAndRehash(owner?.user.id ?? "", "original-passphrase-15")).ok,
      false,
    );
  });
});
