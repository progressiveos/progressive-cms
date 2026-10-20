// PCMS-AUTH-T019 — application authorization service: positive/negative
// permission tests, default-deny for unregistered keys, site-context checks
// (Auth spec §38/§48, §72).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActorContext, createAuthorizationService } from "@pcms/auth";

function actorWith(permissions: string[], siteKey: string | null = null): ActorContext {
  return {
    type: "USER",
    id: "u-test",
    permissions: new Set(permissions),
    siteKey,
    environment: null,
    strength: { factors: ["password"], authenticatedAt: new Date(), mfaAt: null },
    sessionId: null,
  };
}

const auth = createAuthorizationService();

test("registered + granted → allow", () => {
  assert.doesNotThrow(() => auth.authorize(actorWith(["content.edit"]), "content.edit"));
});

test("registered + not granted → AUTH_PERMISSION_DENIED (default deny)", () => {
  assert.throws(
    () => auth.authorize(actorWith(["content.edit"]), "publication.publish"),
    (err: { code: string; status: number }) =>
      err.code === "AUTH_PERMISSION_DENIED" && err.status === 403,
  );
  assert.throws(
    () => auth.authorize(actorWith([]), "content.read"),
    (err: { code: string }) => err.code === "AUTH_PERMISSION_DENIED",
  );
});

test("unregistered key → AUTH_UNKNOWN_PERMISSION; never silently allowed", () => {
  assert.throws(
    () => auth.authorize(actorWith(["not.a.permission"]), "not.a.permission"),
    (err: { code: string; status: number }) =>
      err.code === "AUTH_UNKNOWN_PERMISSION" && err.status === 500,
  );
});

test("machine actors: token asking for a scope the account lacks stays denied", () => {
  // The token pipeline precomputes the effective set (account ∩ scopes);
  // here the account did not grant theme.write even though the token asked.
  const token = actorWith(["content.read"]);
  assert.doesNotThrow(() => auth.authorize(token, "content.read"));
  assert.throws(
    () => auth.authorize(token, "theme.write"),
    (err: { code: string }) => err.code === "AUTH_PERMISSION_DENIED",
  );
});

test("site context: bound tokens cannot touch another site", () => {
  const bound = actorWith(["content.edit"], "site-a");
  assert.doesNotThrow(() => auth.authorizeSite(bound, "site-a"));
  assert.throws(
    () => auth.authorizeSite(bound, "site-b"),
    (err: { code: string }) => err.code === "AUTH_TOKEN_SITE_DENIED",
  );
  const unbound = actorWith(["content.edit"], null); // humans: installation scope
  assert.doesNotThrow(() => auth.authorizeSite(unbound, "site-b"));
});
