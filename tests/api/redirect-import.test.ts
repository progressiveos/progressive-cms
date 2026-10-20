// Redirect-import REST surface (Navigation spec §33/§60): validate dry-run
// report, atomic apply, permission gate, end-to-end 301 resolution and the
// duplicate-vs-history collision guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFastify, createApiV1, makeRoutingRoutes } from "@pcms/api";
import { createRequestResolver, createRouteService, LEGACY_HTML_ROUTE_POLICY } from "@pcms/routing";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

async function startRoutingApi(t: { after: (fn: () => void) => void }) {
  const { app, pool } = await createApiFixture(t);
  const routes = createRouteService(pool);
  const site = await routes.ensureSite("default", "Redirect Fixture");
  // Migrated-site profile: legacy .html URLs are valid paths (spec §26).
  await routes.setPolicy(site.id as never, LEGACY_HTML_ROUTE_POLICY);
  const account = await app.machineIdentity.createServiceAccount({
    name: "redirect-import-test",
    purpose: "redirect import surface tests",
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["routing.redirects.import"],
    ttlMilliseconds: 3_600_000,
  });
  const unprivileged = await app.machineIdentity.createServiceAccount({
    name: "redirect-import-no-scope",
    purpose: "permission gate tests",
  });
  const bareToken = await app.machineIdentity
    .createAccessToken({
      serviceAccountId: unprivileged.id,
      scopes: [],
      ttlMilliseconds: 3_600_000,
    })
    .then((minted) => minted.rawSecret);
  const fastify = createApiFastify(() => "req_redirects");
  await fastify.register(createApiV1(makeRoutingRoutes()), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  const auth = (raw: string) => ({ authorization: `Bearer ${raw}` });
  return {
    app,
    pool,
    siteId: site.id as string,
    bearer: token.rawSecret,
    bareToken,
    auth,
    fastify,
  };
}

test("permission gate: an actor without the scope gets 403 on validate", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { bareToken, auth, fastify } = await startRoutingApi(t);
  const response = await fastify.inject({
    method: "POST",
    url: "/api/v1/routing/redirect-imports/validate",
    headers: auth(bareToken),
    payload: { rows: [{ source: "/old/", target: "/new/" }] },
  });
  assert.equal(response.statusCode, 403, response.body);
});

test("validate reports per-row issues and writes nothing", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, bearer, auth, fastify } = await startRoutingApi(t);
  const response = await fastify.inject({
    method: "POST",
    url: "/api/v1/routing/redirect-imports/validate",
    headers: auth(bearer),
    payload: {
      rows: [
        { source: "/old-page.html", target: "/new-page/", status_code: 301 },
        { source: "/gone/", target: null, status_code: 410 },
        { source: "/evil/", target: "https://evil.example/", status_code: 301 },
        { source: "/loop/", target: "/loop/", status_code: 301 },
      ],
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    report: {
      ok: boolean;
      rows: { status: string; code?: string }[];
      issues: { code: string }[];
    };
  };
  assert.equal(body.report.ok, false, response.body);
  assert.equal(body.report.rows[0]?.status, "ok", response.body);
  assert.equal(body.report.rows[1]?.status, "ok");
  assert.equal(body.report.rows[2]?.code, "ROUTE_PATH_INVALID");
  assert.equal(body.report.rows[3]?.code, "REDIRECT_LOOP");
  // Pure: nothing written.
  const history = await pool.query(`SELECT count(*)::int AS n FROM route_history`);
  assert.equal(history.rows[0]?.n, 0);
});

test("apply is atomic end to end: 301 resolves, duplicate re-import collides", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, bearer, auth, fastify } = await startRoutingApi(t);
  const first = await fastify.inject({
    method: "POST",
    url: "/api/v1/routing/redirect-imports/apply",
    headers: auth(bearer),
    payload: {
      rows: [
        { source: "/legacy/about.html", target: "/about/", status_code: 301 },
        { source: "/legacy/dead.html", target: null, status_code: 410 },
      ],
    },
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.json() as { applied: boolean; report: { ok: boolean } };
  assert.equal(firstBody.applied, true);
  assert.equal(firstBody.report.ok, true);

  // Request-time resolution through the public resolver.
  const resolver = createRequestResolver(pool);
  const redirect = await resolver.resolve({
    siteId: (await pool.query(`SELECT id FROM sites LIMIT 1`)).rows[0]?.id as string,
    path: "/legacy/about.html",
  });
  assert.equal(redirect.kind, "redirect");
  assert.equal(redirect.kind === "redirect" ? redirect.statusCode : null, 301);
  const gone = await resolver.resolve({
    siteId: (await pool.query(`SELECT id FROM sites LIMIT 1`)).rows[0]?.id as string,
    path: "/legacy/dead.html",
  });
  assert.equal(gone.kind, "gone");

  // Re-importing the same source collides with the applied history.
  const second = await fastify.inject({
    method: "POST",
    url: "/api/v1/routing/redirect-imports/apply",
    headers: auth(bearer),
    payload: {
      rows: [{ source: "/legacy/about.html", target: "/elsewhere/", status_code: 301 }],
    },
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as {
    applied: boolean;
    report: { ok: boolean; rows: { code?: string }[] };
  };
  assert.equal(secondBody.applied, false);
  assert.equal(secondBody.report.ok, false);
  assert.equal(secondBody.report.rows[0]?.code, "ROUTE_COLLISION");
});

test("graph safety across batches: history /b→/a + batch /a→/b is a refused loop", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { bearer, auth, fastify } = await startRoutingApi(t);
  const first = await fastify.inject({
    method: "POST",
    url: "/api/v1/routing/redirect-imports/apply",
    headers: auth(bearer),
    payload: { rows: [{ source: "/b/", target: "/a/" }] },
  });
  assert.equal((first.json() as { applied: boolean }).applied, true);
  const second = await fastify.inject({
    method: "POST",
    url: "/api/v1/routing/redirect-imports/apply",
    headers: auth(bearer),
    payload: { rows: [{ source: "/a/", target: "/b/" }] },
  });
  const body = second.json() as { applied: boolean; report: { issues: { code: string }[] } };
  assert.equal(body.applied, false);
  assert.ok(body.report.issues.some((issue) => issue.code === "REDIRECT_LOOP"));
});
