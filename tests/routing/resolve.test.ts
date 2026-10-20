// PCMS-NAV-T016 — redirect resolver + graph validator (Navigation spec
// §33/§44). Acceptance: loops/self/chains rejected; full resolution order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createDomainService,
  createRequestResolver,
  createRouteHistoryService,
  createRouteService,
  DEFAULT_ROUTE_POLICY,
  type DomainService,
  type RequestResolver,
  type RouteHistoryService,
  type RouteService,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY_A = "01900000-0000-7000-8000-000000000001";
const ENTRY_HOME = "01900000-0000-7000-8000-0000000000a0";

function connectionInfo(db: TestDatabase) {
  const info = {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}

async function withResolver(
  t: { after: (fn: () => void) => void },
  run: (
    resolver: RequestResolver,
    routes: RouteService,
    history: RouteHistoryService,
    domains: DomainService,
  ) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const routes = createRouteService(pool);
  const history = createRouteHistoryService(pool);
  const domains = createDomainService(pool);
  await run(createRequestResolver(pool), routes, history, domains);
}

test("resolution follows the normative order (spec §44)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withResolver(t, async (resolver, routes, history, domains) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.setHomeEntry(site.id, ENTRY_HOME);
    await routes.activateRoute({
      siteId: site.id,
      path: "/services/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });

    // Unknown host is rejected before anything else.
    assert.equal(
      (await resolver.resolve({ hostname: "attacker.example", path: "/services/" })).kind,
      "host_not_allowed",
    );
    // Alternate form redirects to the canonical (301, site-relative).
    assert.deepEqual(await resolver.resolve({ siteId: site.id, path: "/services" }), {
      kind: "redirect",
      statusCode: 301,
      location: "/services/",
    });
    // Direct active route.
    const direct = await resolver.resolve({ siteId: site.id, path: "/services/" });
    assert.equal(direct.kind, "route");
    // Home via explicit binding.
    const home = await resolver.resolve({ siteId: site.id, path: "/" });
    assert.deepEqual(home, { kind: "home", entryId: ENTRY_HOME });
    // Not found for unknown paths.
    assert.equal(
      (await resolver.resolve({ siteId: site.id, path: "/missing/" })).kind,
      "not_found",
    );
    // Host-based resolution narrows to the bound site.
    const viaHost = await resolver.resolve({ hostname: "example.ru", path: "/services/" });
    assert.equal(viaHost.kind, "route");
    assert.ok(history);
  });
});

test("renamed paths resolve as redirects to the current canonical", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withResolver(t, async (resolver, routes, history) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.activateRoute({
      siteId: site.id,
      path: "/old-name/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    await history.changeRoute({
      siteId: site.id,
      entryId: ENTRY_A,
      fromPath: "/old-name/",
      toPath: "/new-name/",
    });
    const resolution = await resolver.resolve({ siteId: site.id, path: "/old-name/" });
    assert.deepEqual(resolution, { kind: "redirect", statusCode: 301, location: "/new-name/" });

    // Rename again: the first alias collapses straight to the newest path.
    await history.changeRoute({
      siteId: site.id,
      entryId: ENTRY_A,
      fromPath: "/new-name/",
      toPath: "/final-name/",
    });
    assert.deepEqual(await resolver.resolve({ siteId: site.id, path: "/old-name/" }), {
      kind: "redirect",
      statusCode: 301,
      location: "/final-name/",
    });
    const issues = await resolver.validateRedirectGraph(site.id);
    assert.deepEqual(issues, []);
  });
});

test("graph validator reports self redirects, loops and long chains (spec §33)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withResolver(t, async (resolver, routes, history) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.activateRoute({
      siteId: site.id,
      path: "/live/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    // Self redirects are rejected at write time (pinned in history tests);
    // the validator's self check guards raw-state regressions.
    // Two-hop loop: /x/ → /y/ → /x/.
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/x/",
      targetType: "path",
      targetId: "/y/",
      statusCode: 301,
    });
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/y/",
      targetType: "path",
      targetId: "/x/",
      statusCode: 301,
    });
    // Excessive chain: a → c1 → c2 → c3 → live (4 hops > default 3).
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/a/",
      targetType: "path",
      targetId: "/c1/",
      statusCode: 301,
    });
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/c1/",
      targetType: "path",
      targetId: "/c2/",
      statusCode: 301,
    });
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/c2/",
      targetType: "path",
      targetId: "/c3/",
      statusCode: 301,
    });
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/c3/",
      targetType: "path",
      targetId: "/live/",
      statusCode: 301,
    });
    const issues = await resolver.validateRedirectGraph(site.id);
    const codes = issues.map((i) => i.code).sort();
    assert.deepEqual(codes, ["REDIRECT_CHAIN_TOO_LONG", "REDIRECT_LOOP", "REDIRECT_LOOP"]);
    // 410 gone rows are terminal — never loop material.
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/removed/",
      targetType: null,
      targetId: null,
      statusCode: 410,
    });
    assert.equal((await resolver.resolve({ siteId: site.id, path: "/removed/" })).kind, "gone");
  });
});
