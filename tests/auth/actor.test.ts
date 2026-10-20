// PCMS-AUTH-T001 — Auth module boundaries + unified ActorContext.
// Acceptance: unified human/machine actor; default-deny permission check;
// stable machine error codes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, actorHasPermission, operatorActor, systemActor } from "@pcms/auth";

function userActor(permissions: string[]) {
  return {
    type: "USER" as const,
    id: "u-1",
    permissions: new Set(permissions),
    siteKey: null,
    environment: null,
    strength: { factors: ["password" as const], authenticatedAt: new Date(), mfaAt: null },
    sessionId: "s-1",
  };
}

test("actor types are explicitly distinguishable (human ≠ machine ≠ operator)", () => {
  const human = userActor(["content.read"]);
  const machine = { ...userActor([]), type: "SERVICE_ACCOUNT" as const, sessionId: null };
  const op = operatorActor("local-admin");
  const sys = systemActor("scheduler");

  assert.equal(human.type, "USER");
  assert.equal(machine.type, "SERVICE_ACCOUNT");
  assert.equal(machine.sessionId, null);
  assert.equal(human.sessionId, "s-1");
  assert.equal(op.type, "OPERATOR");
  assert.equal(sys.type, "SYSTEM");
  assert.deepEqual([...sys.permissions], []);
});

test("actorHasPermission is default-deny, including unknown keys", () => {
  const actor = userActor(["content.read"]);
  assert.equal(actorHasPermission(actor, "content.read"), true);
  assert.equal(actorHasPermission(actor, "publication.publish"), false);
  assert.equal(actorHasPermission(actor, "not.a.registered.key"), false);
});

test("machine actors carry their effective permission set, not raw scopes", () => {
  // The effective set is precomputed by the token pipeline (account ∩ token ∩
  // binding); the actor itself only answers membership questions.
  const token = userActor(["content.read", "content.edit"]);
  const machine = {
    ...token,
    type: "SERVICE_ACCOUNT" as const,
    permissions: new Set(["content.read"]), // token asked for edit, account disallows
    sessionId: null,
  };
  assert.equal(actorHasPermission(machine, "content.edit"), false);
  assert.equal(actorHasPermission(machine, "content.read"), true);
});

test("AuthError exposes stable machine codes", () => {
  const err = new AuthError("AUTH_INVALID_CREDENTIALS", "login failed", 401);
  assert.equal(err.code, "AUTH_INVALID_CREDENTIALS");
  assert.equal(err.status, 401);
  assert.equal(err.name, "AuthError");
  assert.match(err.message, /login failed/);
});
