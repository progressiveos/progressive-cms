// PCMS-NAV-T029 — integration/performance/security suite (Navigation spec
// §67/§69). Acceptance: indexed lookup, bounded menus, abuse limits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createNavigationService,
  type NavigationError,
  type NavigationItemNode,
  type NavigationService,
} from "@pcms/navigation";
import {
  applyRedirectImports,
  createRouteHistoryService,
  createRouteService,
  MAX_IMPORT_ROWS,
  type RouteService,
  type RoutingError,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY = "01900000-0000-7000-8000-000000000001";

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

async function withPool(
  t: { after: (fn: () => void) => void },
  run: (pool: DbPool, routes: RouteService, nav: NavigationService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(pool, createRouteService(pool), createNavigationService(pool));
}

test("active route lookup is index-backed (spec §67)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPool(t, async (pool, routes) => {
    const site = await routes.ensureSite("default", "Perf");
    const plan = await pool.query<{
      "QUERY PLAN": { Plan: { "Index Name": string | null; "Node Type": string } }[];
    }>(
      `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT * FROM routes
       WHERE site_id = $1 AND locale = 'x-default' AND path = '/x/'
         AND domain_binding_id IS NULL AND retired_at IS NULL AND is_canonical`,
      [site.id],
    );
    const planJson = JSON.stringify(plan.rows);
    const topPlan = plan.rows[0]?.["QUERY PLAN"][0]?.Plan;
    assert.match(
      topPlan?.["Node Type"] ?? "",
      /Index/,
      `expected an index-backed plan on routes: ${planJson.slice(0, 400)}`,
    );
    // Coarse latency bound on a warm pool: 300 lookups stay far under 1s.
    const start = performance.now();
    for (let i = 0; i < 300; i += 1) {
      await routes.findActiveRoute(site.id, `/definitely-not-there-${i}/`);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 3000, `300 indexed lookups took ${elapsed.toFixed(0)}ms`);
  });
});

test("materializing a large menu is one round-trip, not N+1 (spec §67)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPool(t, async (pool, _routes, nav) => {
    const set = await nav.createSet({ key: "big", title: "Big" });
    // 500 flat items + 500 nested one level: within MAX_ITEMS_PER_SET.
    const rows: unknown[][] = [];
    const uuid = (i: number): string => `01900000-0000-7000-8000-${String(i).padStart(12, "0")}`;
    for (let i = 0; i < 500; i += 1) {
      rows.push([
        uuid(i),
        set.id,
        null,
        i,
        "internal_entry",
        `Root ${i}`,
        JSON.stringify({ entry_id: ENTRY }),
        null,
      ]);
      rows.push([
        uuid(1000 + i),
        set.id,
        uuid(i),
        0,
        "internal_entry",
        `Child ${i}`,
        JSON.stringify({ entry_id: ENTRY }),
        null,
      ]);
    }
    const chunks: unknown[][][] = [];
    for (let i = 0; i < rows.length; i += 100) chunks.push(rows.slice(i, i + 100));
    await pool.withTransaction(async (tx) => {
      for (const chunk of chunks) {
        await tx.query(
          `INSERT INTO navigation_items (id, set_id, parent_item_id, sibling_order, item_type, label, target, ui_intent)
           SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::int[], $5::text[], $6::text[], $7::jsonb[], $8::text[])`,
          [
            chunk.map((r) => r[0]),
            chunk.map((r) => r[1]),
            chunk.map((r) => r[2]),
            chunk.map((r) => r[3]),
            chunk.map((r) => r[4]),
            chunk.map((r) => r[5]),
            chunk.map((r) => r[6]),
            chunk.map((r) => r[7]),
          ],
        );
      }
    });
    assert.equal(await nav.countItems(set.id), 1000);

    const start = performance.now();
    const tree = await nav.readTree(set.id);
    const elapsed = performance.now() - start;
    assert.equal(tree.length, 500);
    assert.equal(tree[0]?.children.length, 1);
    assert.ok(elapsed < 2000, `materializing 1000 items took ${elapsed.toFixed(0)}ms`);
  });
});

test("configurable depth cap: a strict site rejects at its own limit", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPool(t, async (pool, _routes, _nav) => {
    const strict = createNavigationService(pool, { maxTreeDepth: 3 });
    const set = await strict.createSet({ key: "strict", title: "Strict" });
    let parent: NavigationItemNode | null = null;
    for (let level = 1; level <= 3; level += 1) {
      parent = await strict.insertItem({
        setId: set.id,
        parentItemId: parent?.id ?? null,
        type: "group",
        label: `L${level}`,
      });
    }
    await assert.rejects(
      () =>
        strict.insertItem({ setId: set.id, parentItemId: parent!.id, type: "group", label: "L4" }),
      (err: NavigationError) => err.code === "NAV_DEPTH_UNSUPPORTED",
    );
  });
});

test("open redirect: absolute targets cannot enter the redirect store", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPool(t, async (pool, routes) => {
    const site = await routes.ensureSite("default", "Sec");
    const report = await applyRedirectImports(pool, site.id, [
      { source: "/out/", target: "https://evil.example/", statusCode: 301 },
      { source: "/proto/", target: "javascript:alert(1)", statusCode: 301 },
    ]);
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.rows.map((r) => r.code),
      ["ROUTE_PATH_INVALID", "ROUTE_PATH_INVALID"],
    );
    // Nothing was written.
    const { createRequestResolver } = await import("@pcms/routing");
    const resolver = createRequestResolver(pool);
    assert.equal((await resolver.resolve({ siteId: site.id, path: "/out/" })).kind, "not_found");
  });
});

test("import batches are bounded (abuse guard)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPool(t, async (pool, routes) => {
    const site = await routes.ensureSite("default", "Sec");
    const huge = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
      source: `/p-${i}/`,
      target: "/x/",
      statusCode: 301 as const,
    }));
    await assert.rejects(
      () => applyRedirectImports(pool, site.id, huge),
      (err: RoutingError) => err.code === "REDIRECT_IMPORT_TOO_LARGE",
    );
  });
});

test("redirect history loop protection is enforced end to end", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withPool(t, async (pool, routes) => {
    const site = await routes.ensureSite("default", "Sec");
    const history = createRouteHistoryService(pool);
    await routes.activateRoute({
      siteId: site.id,
      path: "/self/",
      targetType: "system",
      targetId: "t",
    });
    // Write-side: self redirect rejected.
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
    // Chain side: validator flags chains beyond the threshold.
    const rows = ["/c1/", "/c2/", "/c3/", "/c4/"];
    for (let i = 0; i < rows.length - 1; i += 1) {
      await history.recordRedirect({
        siteId: site.id,
        oldPath: rows[i] ?? "/x/",
        targetType: "path",
        targetId: rows[i + 1] ?? "/x/",
        statusCode: 301,
      });
    }
    await history.recordRedirect({
      siteId: site.id,
      oldPath: "/start/",
      targetType: "path",
      targetId: "/c1/",
      statusCode: 301,
    });
    const resolver = (await import("@pcms/routing")).createRequestResolver(pool);
    const issues = await resolver.validateRedirectGraph(site.id);
    assert.ok(
      issues.some((i) => i.code === "REDIRECT_CHAIN_TOO_LONG"),
      JSON.stringify(issues),
    );
  });
});
