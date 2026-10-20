// PCMS-NAV-T022 — bulk redirect import validator (Navigation spec §60/§33).
// Acceptance: loop/collision report before apply; atomic apply.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  applyRedirectImports,
  createDomainService,
  createRequestResolver,
  createRouteService,
  DEFAULT_ROUTE_POLICY,
  type DomainService,
  LEGACY_HTML_ROUTE_POLICY,
  type RouteService,
  validateRedirectImports,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY_A = "01900000-0000-7000-8000-000000000001";
const ENTRY_B = "01900000-0000-7000-8000-000000000002";

async function withImport(
  t: { after: (fn: () => void) => void },
  run: (routes: RouteService, pool: DbPool, domains: DomainService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const domains = createDomainService(pool);
  await run(createRouteService(pool), pool, domains);
}

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

test("valid batches report per-row ok and apply atomically", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withImport(t, async (routes, pool, domains) => {
    const site = await routes.ensureSite("default", "Migrated");
    // Migration imports preserve legacy shapes — allow .html in the policy.
    await routes.setPolicy(site.id, LEGACY_HTML_ROUTE_POLICY);
    const report = await validateRedirectImports(pool, site.id, [
      { source: "/stara-stranica.html", target: "/services/", statusCode: 301 },
      { source: "/novosti-2024/", target: "/news/", statusCode: 301 },
      { source: "/deleted-form/", target: null, statusCode: 410 },
      { source: "/to-entry/", target: ENTRY_A },
    ]);
    assert.equal(report.ok, true, JSON.stringify(report.rows));
    assert.equal(report.rows.filter((r) => r.status === "ok").length, 4);

    await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
    const applied = await applyRedirectImports(pool, site.id, [
      { source: "/stara-stranica.html", target: "/services/", statusCode: 301 },
      { source: "/novosti-2024/", target: "/news/", statusCode: 301 },
      { source: "/deleted-form/", target: null, statusCode: 410 },
      { source: "/to-entry/", target: ENTRY_A },
    ]);
    assert.equal(applied.ok, true);

    // The imported redirects actually resolve.
    const resolver = createRequestResolver(pool);
    assert.deepEqual(await resolver.resolve({ siteId: site.id, path: "/stara-stranica.html" }), {
      kind: "redirect",
      statusCode: 301,
      location: "/services/",
    });
    assert.equal(
      (await resolver.resolve({ siteId: site.id, path: "/deleted-form/" })).kind,
      "gone",
    );
    // Entry-targeted redirects resolve to the entry's current path.
    await routes.activateRoute({
      siteId: site.id,
      path: "/live-entry/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    assert.deepEqual(await resolver.resolve({ siteId: site.id, path: "/to-entry/" }), {
      kind: "redirect",
      statusCode: 301,
      location: "/live-entry/",
    });
  });
});

test("invalid rows produce a precise report; apply is refused", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withImport(t, async (routes, pool, domains) => {
    const site = await routes.ensureSite("default", "Migrated");
    await routes.activateRoute({
      siteId: site.id,
      path: "/live/",
      targetType: "entry",
      targetId: ENTRY_A,
    });
    const report = await validateRedirectImports(pool, site.id, [
      { source: "/good/", target: "/live/", statusCode: 301 },
      { source: "/live/", target: "/x/", statusCode: 301 }, // active route
      { source: "/api/x/", target: "/y/", statusCode: 301 }, // reserved
      { source: "/self/", target: "/self/", statusCode: 301 }, // self
      { source: "/bad%2Fpath", target: "/y/", statusCode: 301 }, // encoding
      { source: "/dup/", target: "/a/", statusCode: 301 }, // duplicate pair
      { source: "/dup/", target: "/b/", statusCode: 301 },
      { source: "/no-target/", target: null, statusCode: 301 }, // missing target
    ]);
    assert.equal(report.ok, false);
    const failed = report.rows.filter((r) => r.status === "error");
    assert.deepEqual(
      failed.map((r) => r.code),
      [
        "ROUTE_COLLISION",
        "ROUTE_RESERVED",
        "REDIRECT_LOOP",
        "ROUTE_INVALID_ENCODING",
        "ROUTE_COLLISION",
        "ROUTE_TARGET_INVALID",
      ],
    );

    // Apply refuses the whole batch — the good row is NOT written.
    await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
    const applied = await applyRedirectImports(pool, site.id, [
      { source: "/good/", target: "/live/", statusCode: 301 },
      { source: "/self/", target: "/self/", statusCode: 301 },
    ]);
    assert.equal(applied.ok, false);
    const check = await validateRedirectImports(pool, site.id, [
      { source: "/good/", target: "/live/", statusCode: 301 },
    ]);
    assert.equal(check.ok, true, "good row must not have been applied by the refused batch");
  });
});

test("imports creating loops or long chains are rejected before apply (spec §33)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withImport(t, async (routes, pool, domains) => {
    const site = await routes.ensureSite("default", "Migrated");
    const loop = await validateRedirectImports(pool, site.id, [
      { source: "/x/", target: "/y/", statusCode: 301 },
      { source: "/y/", target: "/x/", statusCode: 301 },
    ]);
    assert.equal(loop.ok, false);
    assert.deepEqual(
      loop.issues.map((i) => i.code),
      ["REDIRECT_LOOP", "REDIRECT_LOOP"],
    );

    const chain = await validateRedirectImports(pool, site.id, [
      { source: "/a/", target: "/c1/", statusCode: 301 },
      { source: "/c1/", target: "/c2/", statusCode: 301 },
      { source: "/c2/", target: "/c3/", statusCode: 301 },
      { source: "/c3/", target: "/live/", statusCode: 301 },
    ]);
    assert.equal(chain.ok, false);
    assert.deepEqual(
      chain.issues.map((i) => i.code),
      ["REDIRECT_CHAIN_TOO_LONG"],
    );

    // Applied imports must not exist after the refusal.
    const resolver = createRequestResolver(pool);
    assert.equal((await resolver.resolve({ siteId: site.id, path: "/x/" })).kind, "not_found");
    assert.equal((await resolver.resolve({ siteId: site.id, path: "/a/" })).kind, "not_found");
  });
});
