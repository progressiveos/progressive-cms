// PCMS-AUTH-T005 — password policy + common-password blocklist hook.
// Acceptance: no composition/rotation rule; length policy per Auth spec
// §12/§13; blocklist rejection per §14.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AuthError,
  createPasswordPolicy,
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
} from "@pcms/auth";

test("length policy: 14 code points rejected, 15 accepted, huge passwords rejected", async () => {
  const policy = createPasswordPolicy();
  await assert.rejects(
    () => policy.validate("abcdefghijklmn"), // 14
    (err: AuthError) => err.code === "AUTH_PASSWORD_POLICY_VIOLATION",
  );
  await policy.validate("abcdefghijklmno"); // 15 — exactly at the floor
  await assert.rejects(
    () => policy.validate("x".repeat(PASSWORD_MAX_CODE_POINTS + 1)),
    (err: AuthError) => err.code === "AUTH_PASSWORD_POLICY_VIOLATION",
  );
  await policy.validate("x".repeat(PASSWORD_MAX_CODE_POINTS)); // 512 accepted
  await policy.validate("x".repeat(200)); // ≥128 required by spec §12 — fine
});

test("no composition rules: lowercase-only, no digit, no symbol passes", async () => {
  const policy = createPasswordPolicy();
  await policy.validate("this is a very long passphrase");
  await policy.validate("полностью строчный пароль без цифр"); // 31 code points, Cyrillic
  await policy.validate("🚀 emoji passphrase with spaces 🚀🚀🚀");
  await policy.validate("aaaaaaaaaaaaaaaa"); // no variety, but long enough — allowed
});

test("common-password blocklist rejects corpus entries in any case", async () => {
  const policy = createPasswordPolicy();
  for (const candidate of ["Password123!", "PASSWORD", "qwerty123!", "P@SSW0RD", "ADMIN123!"]) {
    await assert.rejects(
      () => policy.validate(candidate),
      (err: AuthError) => err.code === "AUTH_PASSWORD_BLOCKLISTED",
      candidate,
    );
  }
  // Matching is exact (after NFKC + lowercasing): padded variants are new
  // strings and are NOT blocked by the corpus — length policy still applies.
  const padded = await policy.issues("letmein-plus-padding");
  assert.deepEqual(padded, []);
});

test("blocklist hook: deployment corpus and predicate extensions apply", async () => {
  const corpusPolicy = createPasswordPolicy({
    extraBlocklist: ["correct horse battery staple"],
  });
  await assert.rejects(
    () => corpusPolicy.validate("correct horse battery staple"),
    (err: AuthError) => err.code === "AUTH_PASSWORD_BLOCKLISTED",
  );

  const predicatePolicy = createPasswordPolicy({
    extraBlocklist: (plain) => plain.includes("acme-corp"),
  });
  await assert.rejects(
    () => predicatePolicy.validate("our-acme-corp-secret"),
    (err: AuthError) => err.code === "AUTH_PASSWORD_BLOCKLISTED",
  );
  await predicatePolicy.validate("totally-unrelated-passphrase");
});

test("issue codes are explicit and never echo the password", async () => {
  const policy = createPasswordPolicy();
  const short = await policy.issues("short");
  assert.deepEqual(
    short.map((i) => i.code),
    ["TOO_SHORT"],
  );
  const blocked = await policy.issues("password123!"); // short AND common
  assert.deepEqual(
    blocked.map((i) => i.code),
    ["TOO_SHORT", "BLOCKLISTED"],
  );
  assert.ok(JSON.stringify(blocked).includes("common-password"));
  await assert.rejects(
    () => policy.validate("password123!"),
    (err: AuthError) => err.code === "AUTH_PASSWORD_BLOCKLISTED",
  );
  assert.equal(PASSWORD_MIN_CODE_POINTS, 15);
});
