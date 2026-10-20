// PCMS-AUTH-T015 — permission registry integrity + default-deny resolution.
// Acceptance: default deny; registry is the only grant source.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAllRegistered,
  BUILTIN_ROLE_BUNDLES,
  BUILTIN_ROLE_KEYS,
  builtinRolePermissions,
  isRegisteredPermission,
  PERMISSION_REGISTRY,
  permissionDefinition,
} from "@pcms/auth";

test("registry keys are unique, well-formed and documented", () => {
  const keys = PERMISSION_REGISTRY.map((definition) => definition.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate permission key");
  const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
  for (const key of keys) assert.match(key, KEY_RE, key);
  for (const definition of PERMISSION_REGISTRY) {
    assert.ok(definition.summary.length > 0, `${definition.key} lacks a summary`);
    assert.equal(definition.since, "1.0");
  }
});

test("reconciliation keys (M12/M13, ADR-0005) are registered", () => {
  for (const key of [
    "forms.read_definition",
    "forms.manage_definition",
    "quizzes.read_definition",
    "quizzes.manage_definition",
    "interactions.read",
    "interactions.manage",
    "interactions.export",
    "leads.read",
    "leads.manage",
    "leads.export",
    "integrations.read",
    "integrations.configure",
    "integrations.test",
    "integrations.deliveries.read",
    "integrations.retry",
    "integrations.inbound.read",
    "integrations.secrets.manage",
    "payments.read",
    "payments.create",
    "payments.configure",
    "payments.cancel",
    "payments.refund",
    "payments.events.read",
  ]) {
    assert.equal(isRegisteredPermission(key), true, key);
  }
});

test("M11 search permission keys are registered and bundle-scoped (Search spec §25)", () => {
  for (const key of ["search.admin", "search.reindex", "search.diagnostics"]) {
    assert.equal(isRegisteredPermission(key), true, key);
  }
  assert.equal(BUILTIN_ROLE_BUNDLES.ADMIN.includes("search.admin"), true);
  assert.equal(BUILTIN_ROLE_BUNDLES.DEVELOPER.includes("search.diagnostics"), true);
  assert.equal(BUILTIN_ROLE_BUNDLES.DEVELOPER.includes("search.admin"), false);
  assert.equal(BUILTIN_ROLE_BUNDLES.EDITOR.includes("search.admin"), false);
  assert.equal(BUILTIN_ROLE_BUNDLES.AUTHOR.includes("search.reindex"), false);
});

test("critical separation keys exist as distinct permissions (content.write ≠ publication.publish)", () => {
  assert.equal(isRegisteredPermission("content.edit"), true);
  assert.equal(isRegisteredPermission("publication.publish"), true);
  assert.equal(isRegisteredPermission("theme.activate"), true);
  assert.equal(isRegisteredPermission("tokens.manage"), true);
  assert.equal(isRegisteredPermission("not.a.permission"), false);
  assert.equal(permissionDefinition("publication.publish")?.summary.includes("Publish"), true);
});

test("every built-in bundle is a subset of the registry", () => {
  for (const role of BUILTIN_ROLE_KEYS) {
    const keys = builtinRolePermissions(role);
    assertAllRegistered(keys); // throws on any unregistered key
    assert.ok(keys.length > 0, role);
  }
});

test("OWNER holds every registered permission, including future appends", () => {
  assert.equal(builtinRolePermissions("OWNER").length, PERMISSION_REGISTRY.length);
  // Bundles explicitly never contain PII/secrets/refunds for non-OWNER roles:
  for (const role of BUILTIN_ROLE_KEYS.filter((r) => r !== "OWNER")) {
    const keys = builtinRolePermissions(role);
    for (const forbidden of ["leads.read", "integrations.secrets.manage", "payments.refund"]) {
      assert.equal(keys.includes(forbidden), false, `${role} must not hold ${forbidden}`);
    }
  }
  // BUILTIN_ROLE_BUNDLES exposes the literal bundles for non-OWNER roles.
  assert.equal(BUILTIN_ROLE_BUNDLES.EDITOR.includes("publication.publish"), true);
  assert.equal(BUILTIN_ROLE_BUNDLES.AUTHOR.includes("publication.publish"), false);
});
