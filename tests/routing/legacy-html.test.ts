// PCMS-NAV-T017 — legacy `.html` preservation/migration support (Navigation
// spec §26/§61). Acceptance: fixture resolves correctly. A migrated site
// declares the extensions it preserves in its Routing Policy; new content on
// the same site still follows the extensionless trailing-slash baseline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  type CanonicalUrlService,
  createCanonicalUrlService,
  createDomainService,
  createRequestResolver,
  createRouteHistoryService,
  createRouteService,
  DEFAULT_ROUTE_POLICY,
  type DomainService,
  LEGACY_HTML_ROUTE_POLICY,
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
const ENTRY_B = "01900000-0000-7000-8000-000000000002";
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

async function withLegacySite(
  t: { after: (fn: () => void) => void },
  run: (
    resolver: RequestResolver,
    canonical: CanonicalUrlService,
    routes: RouteService,
    history: RouteHistoryService,
    domains: DomainService,
    siteId: string,
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
  const canonical = createCanonicalUrlService(pool);

  // A migrated MODX-era site keeps its original URL shapes (spec §61).
  const site = await routes.ensureSite("default", "Migrated Corp");
  await routes.setPolicy(site.id, LEGACY_HTML_ROUTE_POLICY);
  await routes.setHomeEntry(site.id, ENTRY_HOME);
  await routes.activateRoute({
    siteId: site.id,
    path: "/about.html",
    targetType: "entry",
    targetId: ENTRY_A,
  });
  await routes.activateRoute({
    siteId: site.id,
    path: "/news/bar.html",
    targetType: "entry",
    targetId: ENTRY_B,
  });
  // New content created after migration simply uses the extensionless
  // baseline — the legacy policy permits it (no extension → trailing slash).
  await routes.activateRoute({
    siteId: site.id,
    path: "/services/audit/",
    targetType: "entry",
    targetId: "01900000-0000-7000-8000-000000000003",
  });
  await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });

  await run(createRequestResolver(pool), canonical, routes, history, domains, site.id);
}

test("legacy .html routes are stored verbatim and resolve directly", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withLegacySite(t, async (resolver, _canonical, routes, _history, _domains, siteId) => {
    const stored = await routes.findActiveRoute(siteId, "/about.html");
    assert.equal(stored?.path, "/about.html");
    assert.equal(stored?.targetId, ENTRY_A);

    const resolution = await resolver.resolve({ siteId, path: "/news/bar.html" });
    assert.equal(resolution.kind, "route");

    // The slash-appended variant redirects back to the legacy form.
    assert.deepEqual(await resolver.resolve({ siteId, path: "/about.html/" }), {
      kind: "redirect",
      statusCode: 301,
      location: "/about.html",
    });
    // The extensionless variant of a legacy page does not exist — plain 404,
    // never a silent alias.
    assert.equal((await resolver.resolve({ siteId, path: "/about" })).kind, "not_found");
  });
});

test("canonical URLs preserve the legacy extension", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withLegacySite(t, async (_resolver, canonical, _routes, _history, _domains) => {
    assert.equal(await canonical.getCanonicalUrl(ENTRY_A), "https://example.ru/about.html");
    assert.equal(await canonical.getCanonicalUrl(ENTRY_B), "https://example.ru/news/bar.html");
    assert.equal(await canonical.getCanonicalUrl(ENTRY_HOME), "https://example.ru/");
  });
});

test("mixed-site coexistence: legacy and baseline paths live side by side", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withLegacySite(t, async (resolver, canonical, routes, history, _domains, siteId) => {
    const resolution = await resolver.resolve({ siteId, path: "/services/audit/" });
    assert.equal(resolution.kind, "route");

    // A legacy page can be renamed; its extension shape is preserved by the
    // policy used for activation, and the old URL keeps working.
    await history.changeRoute({
      siteId,
      entryId: ENTRY_A,
      fromPath: "/about.html",
      toPath: "/company.html",
    });
    assert.deepEqual(await resolver.resolve({ siteId, path: "/about.html" }), {
      kind: "redirect",
      statusCode: 301,
      location: "/company.html",
    });
    assert.equal(await canonical.getCanonicalUrl(ENTRY_A), "https://example.ru/company.html");
    assert.ok((await routes.listRoutes(siteId)).length >= 3);
  });
});
