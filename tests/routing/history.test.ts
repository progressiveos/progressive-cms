// PCMS-NAV-T015 — route history model (Navigation spec §31/§32/§59).
// Acceptance: rename preserves the old path as a historical redirect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createRouteHistoryService,
  createRouteService,
  DEFAULT_ROUTE_POLICY,
  type RouteHistoryService,
  type RouteService,
  type RoutingError,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

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

async function withHistory(
  t: { after: (fn: () => void) => void },
  run: (routes: RouteService, history: RouteHistoryService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const routes = createRouteService(pool);
  await run(routes, createRouteHistoryService(pool));
}

async function seedEntry(routes: RouteService, path: string) {
  const site = await routes.ensureSite("default", "Example Corp");
  await routes.activateRoute({ siteId: site.id, path, targetType: "entry", targetId: ENTRY_A });
  return site;
}

test("route change: old path retired, new path active, history row written", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withHistory(t, async (routes, history) => {
    const site = await seedEntry(routes, "/foo/");
    const result = await history.changeRoute({
      siteId: site.id,
      entryId: ENTRY_A,
      fromPath: "/foo/",
      toPath: "/bar/",
      reason: "editor rename",
    });
    assert.deepEqual(result, { oldPath: "/foo/", newPath: "/bar/" });

    // Old path no longer resolves directly; it is a permanent redirect.
    assert.equal(await routes.findActiveRoute(site.id, "/foo/"), null);
    const active = await routes.findActiveRoute(site.id, "/bar/");
    assert.equal(active?.targetId, ENTRY_A);

    const redirect = await history.findActiveRedirect(site.id, "/foo/");
    assert.equal(redirect?.statusCode, 301);
    assert.equal(redirect?.targetType, "path");
    assert.equal(redirect?.targetId, "/bar/");
    assert.equal(redirect?.reason, "editor rename");

    const all = await history.listHistory(site.id);
    assert.equal(all.length, 1);
  });
});

test("renaming twice keeps one redirect per old alias (spec §31)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withHistory(t, async (routes, history) => {
    const site = await seedEntry(routes, "/a/");
    await history.changeRoute({
      siteId: site.id,
      entryId: ENTRY_A,
      fromPath: "/a/",
      toPath: "/b/",
    });
    await history.changeRoute({
      siteId: site.id,
      entryId: ENTRY_A,
      fromPath: "/b/",
      toPath: "/c/",
    });
    const historyRows = await history.listHistory(site.id);
    assert.deepEqual(
      historyRows.map((h) => [h.oldPath, h.targetId]),
      [
        ["/a/", "/c/"], // collapsed: A no longer chains through B (spec §33)
        ["/b/", "/c/"],
      ],
    );
    assert.equal((await routes.findActiveRoute(site.id, "/c/"))?.targetId, ENTRY_A);
  });
});

test("change refuses collisions, foreign paths, self-redirects, reserved paths", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withHistory(t, async (routes, history) => {
    const site = await seedEntry(routes, "/mine/");
    await routes.activateRoute({
      siteId: site.id,
      path: "/taken/",
      targetType: "entry",
      targetId: "01900000-0000-7000-8000-000000000009",
    });
    await assert.rejects(
      () =>
        history.changeRoute({
          siteId: site.id,
          entryId: ENTRY_A,
          fromPath: "/mine/",
          toPath: "/taken/",
        }),
      (err: RoutingError) => err.code === "ROUTE_COLLISION",
    );
    await assert.rejects(
      () =>
        history.changeRoute({
          siteId: site.id,
          entryId: ENTRY_A,
          fromPath: "/taken/",
          toPath: "/other/",
        }),
      (err: RoutingError) => err.code === "ROUTE_COLLISION",
    );
    await assert.rejects(
      () =>
        history.changeRoute({
          siteId: site.id,
          entryId: ENTRY_A,
          fromPath: "/mine/",
          toPath: "/mine/",
        }),
      (err: RoutingError) => err.code === "REDIRECT_LOOP",
    );
    await assert.rejects(
      () =>
        history.changeRoute({
          siteId: site.id,
          entryId: ENTRY_A,
          fromPath: "/mine/",
          toPath: "/api/x/",
        }),
      (err: RoutingError) => err.code === "ROUTE_RESERVED",
    );
  });
});

test("operator redirects: typed status codes are stored verbatim (spec §32)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withHistory(t, async (routes, history) => {
    const site = await seedEntry(routes, "/live/");
    for (const [path, status] of [
      ["/old-301/", 301],
      ["/old-302/", 302],
      ["/old-307/", 307],
      ["/old-308/", 308],
    ] as const) {
      const record = await history.recordRedirect({
        siteId: site.id,
        oldPath: path,
        targetType: "path",
        targetId: "/live/",
        statusCode: status,
      });
      assert.equal(record.statusCode, status);
    }
    // 410 Gone needs no target.
    const gone = await history.recordRedirect({
      siteId: site.id,
      oldPath: "/removed/",
      targetType: null,
      targetId: null,
      statusCode: 410,
    });
    assert.equal(gone.targetType, null);
    // Self redirect rejected.
    await assert.rejects(
      () =>
        history.recordRedirect({
          siteId: site.id,
          oldPath: "/self/",
          targetType: "path",
          targetId: "/self/",
          statusCode: 301,
        }),
      (err: RoutingError) => err.code === "REDIRECT_LOOP",
    );
    // Statuses outside the baseline are rejected.
    await assert.rejects(
      () =>
        history.recordRedirect({
          siteId: site.id,
          oldPath: "/x/",
          targetType: "path",
          targetId: "/live/",
          statusCode: 303 as never,
        }),
      (err: RoutingError) => err.code === "REDIRECT_STATUS_INVALID",
    );
  });
});
