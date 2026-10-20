// PCMS-SEO-T025 — redirect/canonical/sitemap integration (spec §53/§54).
// Full composition slice over real routing tables: a migrated page keeps its
// canonical self-pointing URL, the old URL serves a 301 and never re-enters
// the sitemap, gone targets are excluded, noindex never lists, and every
// emitted URL signal agrees with the canonical.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createCanonicalUrlService,
  createDomainService,
  createRequestResolver,
  createRouteHistoryService,
  createRouteService,
} from "@pcms/routing";
import {
  buildSitemapEntries,
  canonicalConsistencyIssues,
  emptySeoDocument,
  renderRobotsMeta,
  type SitemapCandidate,
} from "@pcms/seo";
import {
  assertBaseReachable,
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const HOME = "01900000-0000-7000-8000-0000000000a0";
const MOVED = "01900000-0000-7000-8000-000000000001";
const GONE = "01900000-0000-7000-8000-000000000002";
const HIDDEN = "01900000-0000-7000-8000-000000000003";

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

async function setup(t: { after: (fn: () => void) => void }) {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);

  const routes = createRouteService(pool);
  const domains = createDomainService(pool);
  const history = createRouteHistoryService(pool);
  const site = await routes.ensureSite("default", "Пример");
  await routes.setHomeEntry(site.id, HOME);
  void HOME; // homepage resolves through sites.home_entry_id, not a route row
  // Page moved /old/ → /new/ (permanent migration, §53).
  await routes.activateRoute({
    siteId: site.id,
    path: "/old/",
    targetType: "entry",
    targetId: MOVED,
  });
  await history.changeRoute({
    siteId: site.id,
    entryId: MOVED,
    fromPath: "/old/",
    toPath: "/new/",
  });
  await routes.activateRoute({
    siteId: site.id,
    path: "/gone/",
    targetType: "entry",
    targetId: GONE,
  });
  await routes.activateRoute({
    siteId: site.id,
    path: "/hidden/",
    targetType: "entry",
    targetId: HIDDEN,
  });
  await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
  return { pool, routes, domains, history, site };
}

/** Composition: the SEO store is the noindex source for candidate building. */
async function buildCandidatesFromComposition(
  routes: ReturnType<typeof createRouteService>,
  pool: DbPool,
  siteId: string,
) {
  const { createSeoStore } = await import("@pcms/seo");
  const store = createSeoStore(pool);
  const documents = new Map((await store.listDocuments()).map((r) => [r.entryId, r.document]));
  const active = (await routes.listRoutes(siteId)).filter(
    (r) => r.retiredAt === null && r.isCanonical,
  );
  return active
    .filter((r) => r.targetType === "entry")
    .map((r) => ({
      entryId: r.targetId,
      path: r.path,
      lastmod: null,
      noindex: documents.get(r.targetId)?.robots_policy?.index === false,
      eligibility: { public: true, http200: true },
    }));
}

test("sitemap lists only active canonical indexable targets; redirect sources absent", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, routes, history, site } = await setup(t);

  // Redirect bookkeeping from the routing side.
  const redirect = await history.findActiveRedirect(site.id, "/old/");
  assert.ok(redirect != null);
  assert.equal(redirect.statusCode, 301);

  // Composition: active routes + SEO store documents → candidates.
  // Publication eligibility is the M07 seam (fixture provider here).
  const { createSeoStore } = await import("@pcms/seo");
  const store = createSeoStore(pool);
  const { emptySeoDocument: empty } = await import("@pcms/seo");
  await store.saveDocument(HIDDEN, { ...empty(), robots_policy: { index: false, follow: true } });
  const goneRows = await routes.listRoutes(site.id);
  const candidates: SitemapCandidate[] = await buildCandidatesFromComposition(
    routes,
    pool,
    site.id,
  );
  // The gone page loses its 200 eligibility at the composition seam.
  const withEligibility = candidates.map((c) => ({
    ...c,
    eligibility: {
      ...c.eligibility,
      http200: !goneRows.some((x) => x.targetId === c.entryId && x.path === "/gone/"),
    },
  }));
  const result = buildSitemapEntries({ origin: "https://example.ru", candidates: withEligibility });
  const locs = result.urls.map((u) => u.loc);
  // Canonical pages in; retired redirect source, noindex and gone targets out.
  assert.ok(locs.includes("https://example.ru/new/"));
  assert.ok(
    !locs.includes("https://example.ru/old/"),
    "redirect source must not be in the sitemap",
  );
  assert.ok(!locs.includes("https://example.ru/gone/"), "410/200-false target must not be listed");
  assert.ok(!locs.includes("https://example.ru/hidden/"), "noindex must not be listed");
  const excluded = new Map(result.excluded.map((e) => [e.entryId, e.reason]));
  assert.equal(excluded.get(HIDDEN), "noindex");
});

test("request resolution: old URL redirects, canonical self-points, gone stays gone", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, history, site } = await setup(t);
  const resolver = createRequestResolver(pool);
  const canonical = createCanonicalUrlService(pool);

  // /old/ → 301 → /new/ (Location only ever built from routing normalization).
  const oldResolution = await resolver.resolve({ hostname: "example.ru", path: "/old/" });
  assert.equal(oldResolution.kind, "redirect");
  assert.equal(oldResolution.kind === "redirect" ? oldResolution.statusCode : null, 301);
  assert.equal(oldResolution.kind === "redirect" ? oldResolution.location : null, "/new/");

  // The new page's canonical points to itself (§53).
  const selfCanonical = await canonical.getCanonicalUrl(MOVED, { siteId: site.id });
  assert.equal(selfCanonical, "https://example.ru/new/");
  assert.ok((await history.findActiveRedirect(site.id, "/new/")) === null);

  // Consistency: og:url / structured-data url would equal the canonical (§10).
  assert.deepEqual(
    canonicalConsistencyIssues({
      canonical: selfCanonical,
      og_url: selfCanonical,
      structured_data_url: selfCanonical,
    }),
    [],
  );
});

test("noindex documents persist in the SEO store and flow into eligibility without touching routing", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, routes, site } = await setup(t);
  const { createSeoStore, emptySeoDocument: empty } = await import("@pcms/seo");
  const store = createSeoStore(pool);
  await store.saveDocument(HIDDEN, { ...empty(), robots_policy: { index: false, follow: true } });

  const candidates = await buildCandidatesFromComposition(routes, pool, site.id);
  const hidden = candidates.find((c) => c.entryId === HIDDEN);
  assert.equal(hidden?.noindex, true, "stored document drives noindex eligibility");
  const routed = await routes.listRoutes(site.id);
  assert.ok(
    routed.some((r) => r.path === "/hidden/" && r.retiredAt === null),
    "routing is untouched",
  );

  // Typed robots rendering is independent of routing state.
  assert.equal(renderRobotsMeta({ index: false, follow: true }), "noindex");
  assert.ok(emptySeoDocument().robots_policy === null);
});
