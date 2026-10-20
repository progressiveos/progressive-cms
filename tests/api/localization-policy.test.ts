// Owner 2026-10-06 (privacy-page case): entry identity locales must follow
// the declared site localization policy — no freelance locales on a
// single-locale site, declared list only when multilingual is enabled.
import assert from "node:assert/strict";
import { test } from "node:test";
import { entryLocaleAllowed } from "../../packages/api/src/localization-ops.js";

test("single-locale site: only the default sentinel is allowed", () => {
  const policy = { enabled: false, locales: [] as readonly string[] };
  assert.equal(entryLocaleAllowed(policy, "default"), true);
  assert.equal(entryLocaleAllowed(policy, "ru-RU"), false);
  assert.equal(entryLocaleAllowed(policy, "en"), false);
});

test("multilingual enabled: declared list plus the default sentinel", () => {
  const policy = { enabled: true, locales: ["ru-RU", "en"] as readonly string[] };
  assert.equal(entryLocaleAllowed(policy, "ru-RU"), true);
  assert.equal(entryLocaleAllowed(policy, "en"), true);
  assert.equal(entryLocaleAllowed(policy, "default"), true);
  assert.equal(entryLocaleAllowed(policy, "de"), false);
});
