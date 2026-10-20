// Model picker query contract (2026-09-29 prod incident): the Admin model
// picker used to call GET /media/providers/:id/models/:modelId?sync=1, but
// the route's querySchema declares sync as a strict boolean. Ajv coerces
// "true" → true but NOT "1" → true, so the pick failed framework validation
// before the handler ("request does not satisfy the API contract") and no
// model could be added. Pins the pairing both ways through the HTTP stack.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFastify, createApiV1, makeMediaProviderRoutes } from "@pcms/api";
import type { FastifyInstance } from "fastify";
import { type ApiTestFixture, createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

/** App fixture + HTTP stack + a zero-scope machine token (auth: yes, perms: none). */
async function startApi(t: {
  after: (fn: () => void) => void;
}): Promise<{ fastify: FastifyInstance; bearer: string }> {
  const fixture: ApiTestFixture = await createApiFixture(t);
  const account = await fixture.app.machineIdentity.createServiceAccount({
    name: "model-query-contract-test",
    purpose: "model query contract regression",
  });
  const token = await fixture.app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [],
    ttlMilliseconds: 3_600_000,
  });
  const fastify = createApiFastify(() => "req_test_fixed");
  await fastify.register(createApiV1([...makeMediaProviderRoutes()]), {
    application: fixture.app,
    logger: silentLogger,
    cookieSecure: false, // plain-HTTP test server
  });
  return { fastify, bearer: token.rawSecret };
}

test("model query contract: ?sync=1 is a framework rejection before the handler", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify, bearer } = await startApi(t);
  const response = await fastify.inject({
    method: "GET",
    url: "/api/v1/media/providers/runware/models/runware%3Az-image%40turbo?sync=1",
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, "API_REQUEST_INVALID");
  assert.equal(body.error.message, "request does not satisfy the API contract");
});

test("model query contract: ?sync=true passes validation and reaches the op", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify, bearer } = await startApi(t);
  // Zero-scope token: the op's own permission gate (media.providers.manage)
  // answers 403 — a domain error proves schema validation let it through.
  const response = await fastify.inject({
    method: "GET",
    url: "/api/v1/media/providers/runware/models/runware%3Az-image%40turbo?sync=true",
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert.equal(response.statusCode, 403);
  const body = response.json() as { error: { code: string } };
  assert.equal(body.error.code, "AUTH_PERMISSION_DENIED");
});
