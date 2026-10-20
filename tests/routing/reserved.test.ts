// PCMS-NAV-T011 — reserved route registry (Navigation spec §29).
// Acceptance: content cannot claim system paths.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createReservedRouteRegistry,
  createRouteService,
  DEFAULT_RESERVED_PREFIXES,
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

test("registry rejects every Core system namespace (spec §29)", () => {
  const registry = createReservedRouteRegistry();
  assert.deepEqual([...registry.listReserved()].sort(), [...DEFAULT_RESERVED_PREFIXES].sort());
  for (const path of [
    "/admin/",
    "/admin",
    "/admin/users",
    "/API/foo",
    "/api",
    "/mcp/x",
    "/assets/logo.svg",
    "/health",
    "/metrics/",
    "/preview/t",
  ]) {
    assert.equal(registry.isReserved(path), true, path);
  }
  for (const path of ["/", "/administer/", "/apiary/", "/healthy/", "/admin-extras/"]) {
    assert.equal(registry.isReserved(path), false, path);
  }
});

test("custom deployment prefixes extend, never shrink, the reserved set", () => {
  const registry = createReservedRouteRegistry(["/sso/", "/.well-known/"]);
  assert.equal(registry.isReserved("/sso/callback"), true);
  assert.equal(registry.isReserved("/.well-known/security.txt"), true);
  for (const path of ["/admin/", "/api/"]) {
    assert.equal(registry.isReserved(path), true, path);
  }
  assert.throws(
    () => createReservedRouteRegistry(["admin"]),
    (err: RoutingError) => err.code === "ROUTE_RESERVED_PREFIX_INVALID",
  );
});

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
  await run(pool, createRouteService(pool, { reservedPrefixes: ["/sso/"] }));
}

test("route activation refuses reserved paths with a stable code", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withRoutes(t, async (_pool, routes) => {
    const site = await routes.ensureSite("default", "Example Corp");
    for (const path of ["/admin/", "/api", "/preview/landing", "/sso/login"]) {
      await assert.rejects(
        () =>
          routes.activateRoute({ siteId: site.id, path, targetType: "entry", targetId: ENTRY_A }),
        (err: RoutingError) => {
          assert.equal(err.code, "ROUTE_RESERVED");
          return true;
        },
        path,
      );
    }
    // Non-reserved lookalikes are fine.
    await routes.activateRoute({
      siteId: site.id,
      path: "/healthy-living/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
  });
});
