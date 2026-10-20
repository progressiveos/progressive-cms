// Remote diagnostics (2026-09-29): doctor/info are server-local (config +
// DB) and unreachable for token-only agents — GET /diagnostics answers the
// same operational questions over the API under site.validate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFastify, createApiV1 } from "@pcms/api";
import type { FastifyInstance } from "fastify";
import { type ApiTestFixture, createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

async function startApi(
  t: { after: (fn: () => void) => void },
  scopes: readonly string[],
): Promise<{ fastify: FastifyInstance; bearer: string }> {
  const fixture: ApiTestFixture = await createApiFixture(t);
  const account = await fixture.app.machineIdentity.createServiceAccount({
    name: "diagnostics-test",
    purpose: "remote diagnostics regression",
  });
  const token = await fixture.app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [...scopes],
    ttlMilliseconds: 3_600_000,
  });
  const fastify = createApiFastify(() => "req_test_fixed");
  await fastify.register(createApiV1([]), {
    application: fixture.app,
    logger: silentLogger,
    cookieSecure: false,
  });
  return { fastify, bearer: token.rawSecret };
}

test("diagnostics: full report for site.validate, permission-denied otherwise", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const granted = await startApi(t, ["site.validate"]);
  const ok = await granted.fastify.inject({
    method: "GET",
    url: "/api/v1/diagnostics",
    headers: { authorization: `Bearer ${granted.bearer}` },
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json() as {
    release: { version: string };
    db: { ok: boolean; migration_head: string | null };
    worker: { queue: unknown; recent_errors: unknown[] };
    media_providers: unknown[];
    registry: { configured: boolean };
  };
  assert.equal(typeof body.release.version, "string");
  assert.notEqual(body.release.version, "");
  assert.equal(body.db.ok, true);
  assert.equal(typeof body.db.migration_head, "string");
  assert.ok(Array.isArray(body.worker.recent_errors));
  assert.ok(Array.isArray(body.media_providers));
  assert.equal(body.registry.configured, false);
  // No secret-shaped keys leak into the report.
  assert.match(ok.body, /"version"/);
  assert.doesNotMatch(ok.body, /token|password|secret"/i);

  const denied = await startApi(t, []);
  const forbidden = await denied.fastify.inject({
    method: "GET",
    url: "/api/v1/diagnostics",
    headers: { authorization: `Bearer ${denied.bearer}` },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(
    (forbidden.json() as { error: { code: string } }).error.code,
    "AUTH_PERMISSION_DENIED",
  );
});
