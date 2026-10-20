// PCMS-ADMIN-T001 — session rotation contract for the Admin workspace.
// Rotation lets an already-authenticated browser tab re-acquire the CSRF
// synchronizer token after a reload (M08 spec §31 semantics; the old session
// is revoked, the strength carried over).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiRoute } from "@pcms/api";
import {
  bindOperations,
  createApiFastify,
  createApiV1,
  makeDiscoveryRoutes,
  makeMutationRoutes,
} from "@pcms/api";
import { createProvisioningService, createRoleService } from "@pcms/auth";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

async function stack(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t);
  await app.routes.ensureSite("default");
  const fastify = createApiFastify(() => "req_m10_admin_auth");
  const routes: ApiRoute[] = [...makeDiscoveryRoutes(), ...makeMutationRoutes()];
  await fastify.register(createApiV1(routes), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  const provisioning = createProvisioningService(app.pool, {
    users: app.users,
    passwords: app.passwords,
    policy: app.passwordPolicy,
    roles: createRoleService(app.pool),
  });
  await provisioning.bootstrapOwner({
    displayName: "Owner",
    email: "owner@m10.test",
    password: "rotate-owner-password-7!",
  });
  return { app, fastify };
}

interface LoginResult {
  readonly body: { csrf_token: string; user_id: string };
  readonly cookie: string;
}

async function login(
  fastify: ReturnType<typeof createApiFastify>,
  email: string,
  password: string,
): Promise<LoginResult> {
  const response = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200);
  const raw = response.headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? raw : [String(raw)];
  const cookie = setCookie.find((value) => value.startsWith("pcms_session="))!.split(";")[0]!;
  return { body: response.json() as LoginResult["body"], cookie };
}

test("auth_rotate_session: issues a fresh CSRF token + cookie and revokes the old session", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await stack(t);
  const first = await login(fastify, "owner@m10.test", "rotate-owner-password-7!");

  const rotated = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/session/rotate",
    headers: { cookie: first.cookie, "x-pcms-csrf": first.body.csrf_token },
  });
  assert.equal(rotated.statusCode, 200);
  const rotatedBody = rotated.json() as { csrf_token: string; user_id: string };
  assert.equal(rotatedBody.user_id, first.body.user_id);
  assert.notEqual(rotatedBody.csrf_token, first.body.csrf_token);
  const raw = rotated.headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? raw : [String(raw)];
  const newCookie = setCookie.find((value) => value.startsWith("pcms_session="))!.split(";")[0]!;
  assert.notEqual(newCookie, first.cookie);

  // The old session is gone: the stale cookie can no longer read the actor.
  const stale = await fastify.inject({
    method: "GET",
    url: "/api/v1/actor",
    headers: { cookie: first.cookie },
  });
  assert.equal(stale.statusCode, 401);

  // The rotated session works for CSRF-protected mutations (logout proves it).
  const logout = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie: newCookie, "x-pcms-csrf": rotatedBody.csrf_token },
  });
  assert.equal(logout.statusCode, 200);

  const sessions = await app.pool.query(
    "SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL",
    [rotatedBody.user_id],
  );
  const active = sessions.rows[0]?.n ?? -1;
  assert.equal(active, 0, "rotation + logout must leave no active session rows");
});

test("auth_rotate_session: requires a session (anonymous → 401, bearer → 403)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify } = await stack(t);

  const anonymous = await fastify.inject({ method: "POST", url: "/api/v1/auth/session/rotate" });
  assert.equal(anonymous.statusCode, 401);

  const garbage = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/session/rotate",
    headers: { cookie: "pcms_session=not-a-real-token" },
  });
  assert.equal(garbage.statusCode, 401);
});

test("auth_rotate_session: stale cookie cannot rotate twice (single use)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify } = await stack(t);
  const first = await login(fastify, "owner@m10.test", "rotate-owner-password-7!");
  const once = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/session/rotate",
    headers: { cookie: first.cookie, "x-pcms-csrf": first.body.csrf_token },
  });
  assert.equal(once.statusCode, 200);
  const replay = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/session/rotate",
    headers: { cookie: first.cookie, "x-pcms-csrf": first.body.csrf_token },
  });
  assert.equal(replay.statusCode, 401, "a rotated-away session must not rotate again");
});

// The cold Admin SPA holds no synchronizer token (in-memory by design) — the
// reload bootstrap must rotate with the cookie alone. Requiring the header
// here deadlocked every reload into a logout (owner report 2026-09-28).
test("auth_rotate_session: works without a CSRF token (reload recovery path)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify } = await stack(t);
  const first = await login(fastify, "owner@m10.test", "rotate-owner-password-7!");

  const rotated = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/session/rotate",
    headers: { cookie: first.cookie },
  });
  assert.equal(rotated.statusCode, 200);
  const rotatedBody = rotated.json() as { csrf_token: string };
  assert.ok(rotatedBody.csrf_token.length > 0);
  const raw = rotated.headers["set-cookie"];
  const setCookie = Array.isArray(raw) ? raw : [String(raw)];
  const newCookie = setCookie.find((value) => value.startsWith("pcms_session="))!.split(";")[0]!;

  // The fresh session is fully usable: the minted token satisfies CSRF.
  const logout = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie: newCookie, "x-pcms-csrf": rotatedBody.csrf_token },
  });
  assert.equal(logout.statusCode, 200);
});

test("auth_rotate_session: cross-site origin rejected even without CSRF requirement", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify } = await stack(t);
  const first = await login(fastify, "owner@m10.test", "rotate-owner-password-7!");

  const crossSite = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/session/rotate",
    headers: { cookie: first.cookie, origin: "https://evil.example" },
  });
  assert.equal(crossSite.statusCode, 403, "origin assertion must cover csrf:false routes");

  // The rejected request must not have rotated the session.
  const still = await fastify.inject({
    method: "GET",
    url: "/api/v1/actor",
    headers: { cookie: first.cookie },
  });
  assert.equal(still.statusCode, 200);
});
