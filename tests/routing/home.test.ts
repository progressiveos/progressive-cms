// PCMS-NAV-T012 — homepage/system route bindings (Navigation spec §41/§42).
// Acceptance: `/` resolves through the explicit site.home_entry_id binding —
// never via magic slug "index" or title "Home".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createRouteService,
  DEFAULT_ROUTE_POLICY,
  type RouteService,
  type RoutingError,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY_HOME = "01900000-0000-7000-8000-0000000000a0";
const ENTRY_A = "01900000-0000-7000-8000-000000000001";

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

async function withRoutes(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, routes: RouteService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(pool, createRouteService(pool));
}

test("`/` resolves to the explicitly bound home entry", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    assert.equal((await routes.resolveRoute(site.id, "/")).kind, "not_found");

    const bound = await routes.setHomeEntry(site.id, ENTRY_HOME);
    assert.equal(bound.homeEntryId, ENTRY_HOME);
    assert.deepEqual(await routes.resolveRoute(site.id, "/"), {
      kind: "home",
      entryId: ENTRY_HOME,
    });

    // Rebinding is explicit and immediate; clearing disables the homepage.
    await routes.setHomeEntry(site.id, ENTRY_A);
    assert.deepEqual(await routes.resolveRoute(site.id, "/"), {
      kind: "home",
      entryId: ENTRY_A,
    });
    await routes.setHomeEntry(site.id, null);
    assert.equal((await routes.resolveRoute(site.id, "/")).kind, "not_found");
  });
});

test("content routes cannot claim `/`; system routes go through the registry", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await assert.rejects(
      () =>
        routes.activateRoute({
          siteId: site.id,
          path: "/",
          targetType: "entry",
          targetId: ENTRY_HOME,
        }),
      (err: RoutingError) => err.code === "ROUTE_PATH_INVALID",
    );
    // A system route (e.g. search) resolves through the same lookup.
    await routes.activateRoute({
      siteId: site.id,
      path: "/search/",
      targetType: "system",
      targetId: "search",
    });
    const resolution = await routes.resolveRoute(site.id, "/search/");
    assert.equal(resolution.kind, "route");
    assert.equal(resolution.kind === "route" && resolution.route.targetId, "search");
  });
});

test("an entry living at a deep path is never implicitly the homepage", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.activateRoute({
      siteId: site.id,
      path: "/index/",
      targetType: "entry",
      targetId: ENTRY_HOME,
    });
    // slug "index" confers no homepage magic — `/` stays unbound.
    assert.equal((await routes.resolveRoute(site.id, "/")).kind, "not_found");
    assert.equal((await routes.resolveRoute(site.id, "/index/")).kind, "route");
  });
});
