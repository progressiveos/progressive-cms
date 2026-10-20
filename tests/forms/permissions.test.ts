// PCMS-FORM-T018 — M12 permission scoping locks (Forms spec §34/§35,
// ADR-0005): definitions are readable by editors/agents; interaction and lead
// PII stays out of built-in bundles and agent default scopes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_ROLE_BUNDLES, builtinRolePermissions, isRegisteredPermission } from "@pcms/auth";

const M12_DEFINITION_KEYS = [
  "forms.read_definition",
  "forms.manage_definition",
  "quizzes.read_definition",
  "quizzes.manage_definition",
];
const M12_PII_KEYS = [
  "interactions.read",
  "interactions.manage",
  "interactions.export",
  "leads.read",
  "leads.manage",
  "leads.export",
];

test("M12 forms/quizzes/interactions/leads permission keys are registered", () => {
  for (const key of [...M12_DEFINITION_KEYS, ...M12_PII_KEYS]) {
    assert.equal(isRegisteredPermission(key), true, key);
  }
});

test("definition management is scoped: ADMIN manages, EDITOR/AUTHOR only read", () => {
  assert.equal(BUILTIN_ROLE_BUNDLES.ADMIN.includes("forms.manage_definition"), true);
  assert.equal(BUILTIN_ROLE_BUNDLES.ADMIN.includes("quizzes.manage_definition"), true);
  for (const role of ["EDITOR", "AUTHOR"] as const) {
    assert.equal(BUILTIN_ROLE_BUNDLES[role].includes("forms.read_definition"), true, role);
    assert.equal(BUILTIN_ROLE_BUNDLES[role].includes("forms.manage_definition"), false, role);
    assert.equal(BUILTIN_ROLE_BUNDLES[role].includes("quizzes.manage_definition"), false, role);
  }
});

test("no built-in role except OWNER holds interaction or lead PII keys", () => {
  for (const role of ["ADMIN", "DEVELOPER", "EDITOR", "AUTHOR"] as const) {
    for (const key of M12_PII_KEYS) {
      assert.equal(BUILTIN_ROLE_BUNDLES[role].includes(key), false, `${role}:${key}`);
      assert.equal(builtinRolePermissions(role).includes(key), false, `${role}:${key}`);
    }
  }
  assert.ok(builtinRolePermissions("OWNER").length > 0);
});
