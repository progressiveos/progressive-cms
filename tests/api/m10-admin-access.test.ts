// PCMS-ADMIN-T020/T021/T022 — users/roles/service-accounts/audit contracts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

async function fixture(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {});
  const { createProvisioningService, createRoleService } = await import("@pcms/auth");
  const provisioning = createProvisioningService(app.pool, {
    users: app.users,
    passwords: app.passwords,
    policy: app.passwordPolicy,
    roles: createRoleService(app.pool),
  });
  await provisioning.bootstrapOwner({
    displayName: "Owner",
    email: "owner@access.test",
    password: "access-owner-password-1!",
  });
  return { app, provisioning };
}

const PERM = [
  "users.read",
  "users.manage",
  "roles.read",
  "roles.manage",
  "tokens.manage",
  "audit.read",
];

test("users: list, create with invite (secret once), roles assign/remove, MFA reset, sessions revoke", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, provisioning } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const ops = await import("@pcms/api");

  const created = await ops.createUserOp(app, ctx, {
    display_name: "Редактор",
    email: "editor@access.test",
    role_key: "EDITOR",
  });
  assert.ok(created.invite_token.length > 20);
  await provisioning.acceptInvite({
    inviteToken: created.invite_token,
    password: "editor-password-9!",
  });

  const direct = await ops.createUserWithPasswordOp(app, ctx, {
    display_name: "Администратор создал",
    email: "direct@access.test",
    role_key: "AUTHOR",
    password: "direct-user-initial-passphrase-15",
  });
  assert.ok(direct.user_id);
  assert.equal((await app.users.findUserByEmail("direct@access.test"))?.email.verifiedAt, null);
  assert.equal(
    (
      await app.passwords.verifyAndRehash(
        direct.user_id as never,
        "direct-user-initial-passphrase-15",
      )
    ).ok,
    true,
  );
  await assert.rejects(
    () =>
      ops.createUserWithPasswordOp(app, ctx, {
        display_name: "Weak password",
        email: "weak@access.test",
        role_key: "AUTHOR",
        password: "password123!",
      }),
    (error: { code?: string }) => error.code === "AUTH_PASSWORD_BLOCKLISTED",
  );
  assert.equal(await app.users.findUserByEmail("weak@access.test"), null);

  const listed = await ops.listUsersOp(app, ctx, {});
  const editor = listed.items.find(
    (user) => (user as { primary_email?: string }).primary_email === "editor@access.test",
  );
  assert.ok(editor !== undefined);
  const editorTyped = editor as { roles: string[]; has_confirmed_mfa: boolean; user_id: string };
  assert.deepEqual(editorTyped.roles, ["EDITOR"]);
  assert.equal(editorTyped.has_confirmed_mfa, false);
  const directRow = listed.items.find(
    (user) => (user as { primary_email?: string }).primary_email === "direct@access.test",
  ) as { roles: string[] } | undefined;
  assert.deepEqual(directRow?.roles, ["AUTHOR"]);

  // role swap + last-OWNER protection via role removal on the owner
  await ops.assignRoleOp(app, ctx, { user_id: editorTyped.user_id, role_key: "AUTHOR" });
  await ops.assignRoleOp(app, ctx, {
    user_id: editorTyped.user_id,
    role_key: "EDITOR",
    remove: true,
  });
  const ownerRow = listed.items.find(
    (user) => (user as { primary_email?: string }).primary_email === "owner@access.test",
  ) as { user_id: string } | undefined;
  assert.ok(ownerRow);
  await assert.rejects(
    () =>
      ops.assignRoleOp(app, ctx, { user_id: ownerRow.user_id, role_key: "OWNER", remove: true }),
    (error: { readonly code?: string }) => error?.code === "AUTH_LAST_OWNER_PROTECTED",
  );

  // MFA reset on a user without MFA is a no-op but permitted; sessions revoke counts 0
  await ops.resetUserMfaOp(app, ctx, { user_id: editorTyped.user_id });
  const revoked = await ops.revokeUserSessionsOp(app, ctx, { user_id: editorTyped.user_id });
  assert.equal(revoked.revoked, 0);

  // disable blocks login-classified status; enable restores
  await ops.disableEnableUserOp(app, ctx, { user_id: editorTyped.user_id, disable: true });
  const disabled = (await ops.listUsersOp(app, ctx, {})).items.find(
    (user) => (user as { user_id?: string }).user_id === editorTyped.user_id,
  );
  assert.equal((disabled as { status?: string } | undefined)?.status, "DISABLED");
  await ops.disableEnableUserOp(app, ctx, { user_id: editorTyped.user_id, disable: false });
});

test("roles: registry + presets exposed; custom role CRUD with registry validation", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const ops = await import("@pcms/api");

  const roles = await ops.listRolesOp(app, ctx);
  assert.ok(roles.roles.some((role) => role.key === "OWNER"));
  assert.ok(roles.permissions.some((permission) => permission.key === "publication.publish"));
  const presets = roles.presets as { site_development: string[] };
  assert.ok(presets.site_development.length > 0);

  // Delete removes the account and every token it issued, without residue.
  const doomed = await ops.createServiceAccountOp(app, ctx, {
    name: "doomed",
    purpose: "delete flow",
  });
  await ops.createAccessTokenOp(app, ctx, {
    account_id: doomed.id,
    scopes: ["content.read"],
    ttl_hours: 1,
  });
  await ops.deleteServiceAccountOp(app, ctx, { account_id: doomed.id, reason: "test" });
  const leftovers = await ops.listAccessTokensOp(app, ctx, { account_id: doomed.id });
  assert.equal(leftovers.items.length, 0);
  await assert.rejects(
    () => ops.deleteServiceAccountOp(app, ctx, { account_id: doomed.id, reason: "again" }),
    /not found/,
  );

  await ops.createUpdateDeleteRoleOp(app, ctx, {
    action: "create",
    role_key: "SEOBOT",
    name: "SEO-редактор",
    permissions: ["seo.read", "seo.edit"],
  });
  await assert.rejects(
    () =>
      ops.createUpdateDeleteRoleOp(app, ctx, {
        action: "create",
        role_key: "BAD",
        name: "Bad",
        permissions: ["not_a_permission"],
      }),
    /cannot be granted/,
  );
  await ops.createUpdateDeleteRoleOp(app, ctx, {
    action: "update",
    role_key: "SEOBOT",
    permissions: ["seo.read", "seo.validate"],
  });
  await ops.createUpdateDeleteRoleOp(app, ctx, { action: "delete", role_key: "SEOBOT" });
});

test("service accounts + tokens: secret shown once, revoke honored", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const ops = await import("@pcms/api");

  const account = await ops.createServiceAccountOp(app, ctx, {
    name: "content-agent",
    purpose: "Контент-агент",
    allowed_scopes: [
      "content.read",
      "content.create",
      "content.edit",
      "preview.create",
      "revision.seal",
    ],
  });
  const token = await ops.createAccessTokenOp(app, ctx, {
    account_id: account.id,
    scopes: ["content.read", "content.create"],
    description: "wizard",
    ttl_hours: 24,
  });
  assert.match(token.raw_secret, /^pcms_[0-9a-f]{8}_/);
  assert.notEqual(token.raw_secret, token.prefix);

  const listed = await ops.listAccessTokensOp(app, ctx, { account_id: account.id });
  const row = listed.items.find(
    (candidate) => (candidate as { id?: string }).id === token.token_id,
  ) as
    | {
        revoked_at: string | null;
        scopes: string[];
      }
    | undefined;
  assert.equal(row?.revoked_at, null);
  assert.equal(JSON.stringify(row?.scopes), JSON.stringify(["content.read", "content.create"]));

  await ops.revokeAccessTokenOp(app, ctx, { token_id: token.token_id, reason: "rotate" });
  const after = (await ops.listAccessTokensOp(app, ctx, { account_id: account.id })).items.find(
    (candidate) => (candidate as { id?: string }).id === token.token_id,
  ) as { revoked_at: string | null } | undefined;
  assert.notEqual(after?.revoked_at, null);

  // the revoked token no longer authenticates (fail-closed, distinct code)
  await assert.rejects(
    () => app.actorResolver.authenticateToken(token.raw_secret),
    (error: { readonly code?: string }) => error?.code === "AUTH_TOKEN_REVOKED",
  );

  await ops.disableServiceAccountOp(app, ctx, { account_id: account.id, reason: "offboarding" });
});

test("audit: events listed with filters; permission denial without audit.read", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, provisioning } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const ops = await import("@pcms/api");

  await provisioning.createUserWithRole({
    displayName: "Audit bait",
    email: "bait@access.test",
    roleKey: "AUTHOR",
  });

  const events = await ops.listAuditOp(app, ctx, { event_type: "USER_CREATED" });
  assert.ok(events.items.length > 0);
  assert.equal((events.items[0] as { event_type?: string }).event_type, "USER_CREATED");

  const mine = await ops.listAuditOp(app, ctx, { actor_type: "OPERATOR" });
  assert.ok(Array.isArray(mine.items));

  const limited = apiContextOf(scopedActor(PERM.slice(0, 5)));
  await assert.rejects(
    () => ops.listAuditOp(app, limited, {}),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );
});
