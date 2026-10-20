// PCMS-API-T003..T007 — REST /api/v1 skeleton, bearer + session auth with
// CSRF, OpenAPI contract surface, pagination + idempotency conventions.
// Real Fastify injection tests (owner instruction #106): headers, cookies,
// status codes and envelopes are exercised through the HTTP stack.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApplicationServices } from "@pcms/api";
import { type ApiRoute, createApiFastify, createApiV1, pageOf, parsePageRequest } from "@pcms/api";
import { createProvisioningService, createRoleService } from "@pcms/auth";
import type { FastifyInstance } from "fastify";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

interface ProbeState {
  counter: number;
}

/**
 * A probe transport route exercising the idempotency + pagination
 * conventions end-to-end before the domain routes land.
 */
function probeRoutes(state: ProbeState): ApiRoute[] {
  const items = Array.from({ length: 7 }, (_, index) => ({ id: `0000000${index}` }));
  return [
    {
      spec: {
        method: "POST",
        url: "/test/echo",
        operationId: "test_echo",
        summary: "probe: idempotency contract",
        tag: "server",
        auth: "authenticated",
        idempotency: "required",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["v"],
          properties: { v: { type: "number" } },
        },
      },
      async handle() {
        state.counter += 1;
        return { status: 200, body: { accepted: true, executions: state.counter } };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/test/items",
        operationId: "test_list_items",
        summary: "probe: pagination contract",
        tag: "server",
        auth: "authenticated",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "string", pattern: "^[0-9]+$" },
            cursor: { type: "string" },
          },
        },
      },
      async handle(_app: ApplicationServices, _ctx, request) {
        const query = request.query as Record<string, unknown>;
        const page = parsePageRequest(query);
        const start =
          page.cursor === null ? 0 : Number(Buffer.from(page.cursor, "base64url").toString("utf8"));
        const fetched = items.slice(start, start + page.limit + 1);
        const result = pageOf(fetched, page.limit, (item) => [String(items.indexOf(item) + 1)]);
        return { status: 200, body: result };
      },
    },
  ];
}

interface TestServer {
  readonly fastify: FastifyInstance;
  readonly bearerToken: string;
  readonly ownerEmail: string;
  readonly ownerPassword: string;
}

async function startApi(
  t: { after: (fn: () => void) => void },
  extraRoutes: readonly ApiRoute[] = [],
): Promise<TestServer> {
  const { app, pool } = await createApiFixture(t);

  // Machine actor: a real service account + access token through M08.
  const account = await app.machineIdentity.createServiceAccount({
    name: "m09-rest-test",
    purpose: "REST integration tests",
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [],
    ttlMilliseconds: 3_600_000,
  });

  // Human actor: provisioned owner with a password (M08 provisioning).
  const provisioning = createProvisioningService(pool, {
    users: app.users,
    passwords: app.passwords,
    policy: app.passwordPolicy,
    roles: createRoleService(pool),
  });
  const ownerEmail = "owner@m09.test";
  const ownerPassword = "correct-horse-battery-staple-9!";
  await provisioning.bootstrapOwner({
    displayName: "M09 Owner",
    email: ownerEmail,
    password: ownerPassword,
  });

  const fastify = createApiFastify(() => "req_test_fixed");
  await fastify.register(createApiV1([...extraRoutes]), {
    application: app,
    logger: silentLogger,
    cookieSecure: false, // plain-HTTP test server
  });
  return { fastify, bearerToken: token.rawSecret, ownerEmail, ownerPassword };
}

test("REST skeleton: unauthenticated request gets the machine envelope (T003)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const server = await startApi(t);
  const response = await server.fastify.inject({ method: "GET", url: "/api/v1/server" });
  assert.equal(response.statusCode, 401);
  const body = response.json() as {
    error: { code: string; request_id: string; retryable: boolean; details: unknown[] };
  };
  assert.equal(body.error.code, "AUTH_UNAUTHENTICATED");
  assert.equal(body.error.request_id, "req_test_fixed");
  assert.equal(typeof body.error.retryable, "boolean");
  assert.deepEqual(body.error.details, []);
  // Correlation header matches the envelope request id (spec §9).
  assert.equal(response.headers["x-request-id"], "req_test_fixed");
});

test("REST skeleton: unknown route gets a stable 404 envelope (T003)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const server = await startApi(t);
  const response = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/definitely/not/here",
  });
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as { error: { code: string } }).error.code, "API_NOT_FOUND");
});

test("bearer service token resolves to one ActorContext (T004)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const server = await startApi(t);
  const ok = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/actor",
    headers: { authorization: `Bearer ${server.bearerToken}` },
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json() as { actor_type: string; transport: string; permissions: string[] };
  assert.equal(body.actor_type, "SERVICE_ACCOUNT");
  assert.equal(body.transport, "rest");

  // Revoked/malformed/absent tokens fail closed with stable codes.
  const bad = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/actor",
    headers: { authorization: "Bearer pcms_deadbeef_notreal" },
  });
  assert.equal(bad.statusCode, 401);
  assert.equal((bad.json() as { error: { code: string } }).error.code, "AUTH_TOKEN_INVALID");

  const garbage = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/actor",
    headers: { authorization: `Basic ${Buffer.from("u:p").toString("base64")}` },
  });
  assert.equal(garbage.statusCode, 401);
});

test("OpenAPI 3.1 document: authenticated, deterministic, complete (T003)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const server = await startApi(t);
  const denied = await server.fastify.inject({ method: "GET", url: "/api/v1/openapi.json" });
  assert.equal(denied.statusCode, 401, "contract document is not anonymous");

  const first = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/openapi.json",
    headers: { authorization: `Bearer ${server.bearerToken}` },
  });
  assert.equal(first.statusCode, 200);
  const second = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/openapi.json",
    headers: { authorization: `Bearer ${server.bearerToken}` },
  });
  assert.equal(first.body, second.body, "contract output is deterministic");

  const document = first.json() as {
    openapi: string;
    info: { version: string };
    components: { securitySchemes: Record<string, unknown> };
    paths: Record<string, Record<string, { operationId?: string; responses: unknown }>>;
  };
  assert.equal(document.openapi, "3.1.0");
  assert.ok(document.components.securitySchemes.bearerAuth);
  assert.ok(document.components.securitySchemes.cookieAuth);
  assert.ok(document.paths["/server"]);
  assert.ok(document.paths["/openapi.json"]);
  const operationIds = Object.values(document.paths)
    .flatMap((methods) => Object.values(methods))
    .map((operation) => operation.operationId)
    .filter((id) => typeof id === "string");
  assert.equal(new Set(operationIds).size, operationIds.length, "operationIds are unique");
});

test("browser session: login sets cookie + CSRF, mutations enforce the token (T005)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const server = await startApi(t);

  // Enumeration safety: unknown user and wrong password are indistinguishable.
  for (const credentials of [
    { email: server.ownerEmail, password: "totally-wrong-password-9!" },
    { email: "nobody@m09.test", password: "totally-wrong-password-9!" },
  ]) {
    const failed = await server.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: credentials,
    });
    assert.equal(failed.statusCode, 401);
    assert.equal(
      (failed.json() as { error: { code: string } }).error.code,
      "AUTH_INVALID_CREDENTIALS",
    );
  }

  const login = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: server.ownerEmail, password: server.ownerPassword },
  });
  assert.equal(login.statusCode, 200);
  const loginBody = login.json() as { stage: string; csrf_token: string; mfa_required: boolean };
  assert.equal(loginBody.stage, "PASSWORD_OK");
  assert.ok(loginBody.csrf_token.length > 20);
  const setCookieRaw = login.headers["set-cookie"];
  const setCookie = Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw as string];
  assert.ok(setCookie.some((value) => value.startsWith("pcms_session=")));
  const cookieEntry = setCookie.find((value) => value.startsWith("pcms_session="));
  assert.ok(cookieEntry !== undefined);
  const cookie = cookieEntry.split(";")[0]!;

  // Session read needs no CSRF.
  const sessions = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/auth/sessions",
    headers: { cookie },
  });
  assert.equal(sessions.statusCode, 200);
  const listed = sessions.json() as { items: { session_id: string; current: boolean }[] };
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.current, true);

  // Mutation without the synchronizer token is rejected (SameSite is not the
  // control, owner instruction #17).
  const missingCsrf = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie },
  });
  assert.equal(missingCsrf.statusCode, 403);
  assert.equal(
    (missingCsrf.json() as { error: { code: string } }).error.code,
    "AUTH_CSRF_TOKEN_MISSING",
  );

  const wrongCsrf = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie, "x-pcms-csrf": "not-the-token" },
  });
  assert.equal(wrongCsrf.statusCode, 403);
  assert.equal(
    (wrongCsrf.json() as { error: { code: string } }).error.code,
    "AUTH_CSRF_TOKEN_INVALID",
  );

  // Correct token: logout revokes the session and clears the cookie.
  const logout = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { cookie, "x-pcms-csrf": loginBody.csrf_token },
  });
  assert.equal(logout.statusCode, 200);
  const clearedRaw = logout.headers["set-cookie"];
  const cleared = Array.isArray(clearedRaw) ? clearedRaw.join(";") : String(clearedRaw);
  assert.ok(cleared.includes("Max-Age=0"));

  // The session is really gone.
  const after = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/auth/sessions",
    headers: { cookie },
  });
  assert.equal(after.statusCode, 401);
});

test("write schemas reject unknown fields (fail-secure, owner instruction #78)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const server = await startApi(t);
  const response = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "a@b.test", password: "x", is_admin: true },
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as { error: { code: string; details: unknown[] } };
  assert.equal(body.error.code, "API_REQUEST_INVALID");
  assert.ok(body.error.details.length > 0);
});

test("oversized bodies are bounded with a stable code (owner instruction #69)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const server = await startApi(t);
  const big = "x".repeat(1_100_000);
  const response = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "a@b.test", password: big },
  });
  assert.equal(response.statusCode, 413);
  assert.equal(
    (response.json() as { error: { code: string } }).error.code,
    "API_PAYLOAD_TOO_LARGE",
  );
});

test("idempotency: same key replays deterministically, key reuse conflicts (T007)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const state: ProbeState = { counter: 0 };
  const server = await startApi(t, probeRoutes(state));
  const headers = {
    authorization: `Bearer ${server.bearerToken}`,
    "idempotency-key": "probe-key-0001",
  };

  const first = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/test/echo",
    headers,
    payload: { v: 1 },
  });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as { executions: number }).executions, 1);

  // Same key + same body: stored result replayed, no second execution.
  const replay = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/test/echo",
    headers,
    payload: { v: 1 },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal((replay.json() as { executions: number }).executions, 1);

  // Same key + different body: explicit conflict, never silent reuse.
  const conflict = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/test/echo",
    headers,
    payload: { v: 2 },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(
    (conflict.json() as { error: { code: string } }).error.code,
    "IDEMPOTENCY_KEY_CONFLICT",
  );

  // Missing key on a required route: rejected up front.
  const missing = await server.fastify.inject({
    method: "POST",
    url: "/api/v1/test/echo",
    headers: { authorization: `Bearer ${server.bearerToken}` },
    payload: { v: 3 },
  });
  assert.equal(missing.statusCode, 400);
});

test("pagination: bounded pages with stable keyset cursors (T006)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const server = await startApi(t, probeRoutes({ counter: 0 }));
  const headers = { authorization: `Bearer ${server.bearerToken}` };

  const page1 = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/test/items?limit=3",
    headers,
  });
  assert.equal(page1.statusCode, 200);
  const body1 = page1.json() as { items: { id: string }[]; next_cursor: string; has_more: boolean };
  assert.equal(body1.items.length, 3);
  assert.equal(body1.has_more, true);
  assert.ok(body1.next_cursor);

  const page2 = await server.fastify.inject({
    method: "GET",
    url: `/api/v1/test/items?limit=3&cursor=${encodeURIComponent(body1.next_cursor)}`,
    headers,
  });
  const body2 = page2.json() as { items: { id: string }[]; has_more: boolean };
  const seen = new Set([...body1.items, ...body2.items].map((item) => item.id));
  assert.equal(seen.size, body1.items.length + body2.items.length, "no duplicates across pages");

  // limit bounds are enforced (no unbounded endpoints).
  const unbounded = await server.fastify.inject({
    method: "GET",
    url: "/api/v1/test/items?limit=10000",
    headers,
  });
  assert.equal(unbounded.statusCode, 400);
});
