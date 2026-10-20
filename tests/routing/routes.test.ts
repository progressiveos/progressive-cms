// PCMS-NAV-T008 — route/domain schema + active route unique constraint.
// Acceptance: collision prevented (Navigation spec §22/§30) — both by the
// application pre-check (stable ROUTE_COLLISION code) and the partial
// unique indexes as the concurrency backstop.
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

const ENTRY_A = "01900000-0000-7000-8000-000000000001";
const ENTRY_B = "01900000-0000-7000-8000-000000000002";

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
  const migrations = await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  assert.equal(migrations.current, "0001_public_baseline");
  await run(pool, createRouteService(pool));
}

test("routes carry site+locale+path to a target; entry identity is the stable ID", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    const created = await routes.activateRoute({
      siteId: site.id,
      path: "/services/audit/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    assert.equal(created.path, "/services/audit/");
    assert.equal(created.targetType, "entry");
    assert.equal(created.targetId, ENTRY_A);
    assert.equal(created.retiredAt, null);

    const found = await routes.findActiveRoute(site.id, "/services/audit/");
    assert.equal(found?.id, created.id);
  });
});

test("path normalization on activation follows the site policy", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    const created = await routes.activateRoute({
      siteId: site.id,
      path: "/Services/Audit",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    assert.equal(created.path, "/services/audit/");
  });
});

test("colliding active route is rejected with ROUTE_COLLISION before activation", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.activateRoute({
      siteId: site.id,
      path: "/about/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    await assert.rejects(
      () =>
        routes.activateRoute({
          siteId: site.id,
          path: "/about/",
          targetType: "entry",
          targetId: ENTRY_B,
        }),
      (err: RoutingError) => {
        assert.equal(err.code, "ROUTE_COLLISION");
        assert.equal(err.details.existing_route_id !== undefined, true);
        return true;
      },
    );
    // Different locales do not collide (route key includes locale, §40).
    const ru = await routes.activateRoute({
      siteId: site.id,
      path: "/about/",
      locale: "ru",
      targetType: "entry",
      targetId: ENTRY_B,
    });
    assert.equal(ru.locale, "ru");
  });
});

test("retired routes free their path; different sites never collide", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    const other = await routes.ensureSite("other", "Other Corp");
    await routes.activateRoute({
      siteId: site.id,
      path: "/news/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    // Same path in another site — no collision (site context differs).
    await routes.activateRoute({
      siteId: other.id,
      path: "/news/",
      targetType: "entry",
      targetId: ENTRY_B,
    });
    await routes.retireRoute({ siteId: site.id, path: "/news/" });
    const reclaimed = await routes.activateRoute({
      siteId: site.id,
      path: "/news/",
      targetType: "entry",
      targetId: ENTRY_B,
    });
    assert.equal(reclaimed.path, "/news/");
    assert.equal((await routes.listRoutes(site.id)).length, 1);
  });
});

test("unsafe stored paths are rejected before they reach the database", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    for (const path of [
      "/a%2Fb/",
      "/a\\b/",
      "/a//b/",
      "/a/../b/",
      "/a/../",
      "no-slash/",
      "/a\u0000/",
    ]) {
      await assert.rejects(
        () =>
          routes.activateRoute({ siteId: site.id, path, targetType: "entry", targetId: ENTRY_A }),
        (err: RoutingError) =>
          err.code === "ROUTE_INVALID_ENCODING" || err.code === "ROUTE_PATH_INVALID",
        path,
      );
    }
  });
});

test("system routes pass through the same collision registry (spec §41)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await routes.activateRoute({
      siteId: site.id,
      path: "/search/",
      targetType: "system",
      targetId: "search",
    });
    await assert.rejects(
      () =>
        routes.activateRoute({
          siteId: site.id,
          path: "/search/",
          targetType: "entry",
          targetId: ENTRY_A,
        }),
      (err: RoutingError) => err.code === "ROUTE_COLLISION",
    );
  });
});
