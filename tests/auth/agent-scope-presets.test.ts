// Operator-facing scope presets (owner directive 2026-09-28): generous
// scenario presets must only name registered keys, and the explicit
// identity/PII/money ceiling of the site-development preset stays pinned so
// a registry append cannot silently widen it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_SCOPE_PRESETS,
  ALL_PERMISSION_SCOPES,
  isRegisteredPermission,
  PERMISSION_REGISTRY,
  SITE_DEVELOPMENT_SCOPES,
} from "@pcms/auth";

test("every operator preset names only registered keys and is non-empty", () => {
  assert.ok(Object.keys(AGENT_SCOPE_PRESETS).length >= 5);
  for (const [key, scopes] of Object.entries(AGENT_SCOPE_PRESETS)) {
    assert.ok(scopes.length > 0, `preset ${key} is empty`);
    for (const scope of scopes) {
      assert.ok(isRegisteredPermission(scope), `preset ${key} grants unregistered "${scope}"`);
    }
  }
});

test("all-permissions preset mirrors the registry", () => {
  assert.deepEqual(
    [...ALL_PERMISSION_SCOPES].sort(),
    PERMISSION_REGISTRY.map((definition) => definition.key).sort(),
  );
});

test("site-development preset never grants identity, PII or refunds", () => {
  const forbidden = [
    "users.read",
    "users.manage",
    "roles.read",
    "roles.manage",
    "tokens.manage",
    "interactions.read",
    "interactions.manage",
    "interactions.export",
    "leads.read",
    "leads.manage",
    "leads.export",
    "payments.refund",
  ];
  for (const scope of forbidden) {
    assert.equal(
      SITE_DEVELOPMENT_SCOPES.includes(scope),
      false,
      `site_development must not grant "${scope}"`,
    );
  }
});
