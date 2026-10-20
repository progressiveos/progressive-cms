// PCMS-AUTH-T016 — built-in role bundles match the spec personas
// (Auth spec §39–§44): OWNER full control, ADMIN editorial/user stack,
// DEVELOPER theme/schema/integration work, EDITOR publishes, AUTHOR doesn't.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_ROLE_BUNDLES, type BuiltinRoleKey, builtinRolePermissions } from "@pcms/auth";

function holds(role: BuiltinRoleKey, key: string): boolean {
  return builtinRolePermissions(role).includes(key);
}

test("OWNER is the full-control role; bundles are code-only templates", () => {
  assert.equal(BUILTIN_ROLE_BUNDLES.OWNER, "ALL");
  assert.equal(holds("OWNER", "users.manage"), true);
  assert.equal(holds("OWNER", "integrations.secrets.manage"), true);
  assert.equal(holds("OWNER", "payments.refund"), true);
});

test("ADMIN: users/roles/site/content/publication/navigation/media/SEO, no PII or refunds", () => {
  for (const key of [
    "users.manage",
    "roles.manage",
    "site.configure",
    "publication.publish",
    "navigation.publish",
    "media.write",
    "seo.edit",
    "audit.read",
    "tokens.manage",
  ]) {
    assert.equal(holds("ADMIN", key), true, `ADMIN must hold ${key}`);
  }
  // Security invariant guardrails (spec §41 "does not automatically bypass
  // every security invariant"): PII exports, payment operations, connector
  // secrets and trusted embedding stay out of the built-in ADMIN bundle.
  for (const key of [
    "leads.read",
    "interactions.export",
    "payments.refund",
    "payments.cancel",
    "integrations.secrets.manage",
    "embed.trusted",
  ]) {
    assert.equal(holds("ADMIN", key), false, `ADMIN must not hold ${key}`);
  }
});

test("DEVELOPER: theme/schema/extensions/integrations, no user or publish power", () => {
  for (const key of [
    "theme.read",
    "theme.write",
    "theme.validate",
    "theme.activate",
    "content_schema.read",
    "content_schema.propose",
    "content_schema.apply",
    "extensions.manage",
    "integrations.configure",
    "site.validate",
  ]) {
    assert.equal(holds("DEVELOPER", key), true, `DEVELOPER must hold ${key}`);
  }
  for (const key of ["users.manage", "publication.publish", "leads.read", "payments.refund"]) {
    assert.equal(holds("DEVELOPER", key), false, `DEVELOPER must not hold ${key}`);
  }
});

test("EDITOR publishes; AUTHOR cannot (content write ≠ publication.publish, spec §16)", () => {
  assert.equal(holds("EDITOR", "publication.publish"), true);
  assert.equal(holds("EDITOR", "publication.schedule"), true);
  assert.equal(holds("EDITOR", "publication.rollback"), true);
  assert.equal(holds("EDITOR", "content.edit"), true);

  assert.equal(holds("AUTHOR", "content.create"), true);
  assert.equal(holds("AUTHOR", "content.edit"), true);
  assert.equal(holds("AUTHOR", "publication.publish"), false);
  assert.equal(holds("AUTHOR", "publication.schedule"), false);
  assert.equal(holds("AUTHOR", "users.manage"), false);
  assert.equal(holds("AUTHOR", "theme.write"), false);
});
