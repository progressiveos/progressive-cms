// PCMS-SEO-T003 — canonical resolver integration (composition layer).
// The real M04 canonical resolver (configured domain binding + active route)
// is wired into the SEO port; a request Host can never leak into any URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { createCanonicalUrlService, createDomainService, createRouteService } from "@pcms/routing";
import { canonicalConsistencyIssues, resolveCanonical, type SeoCanonicalPort } from "@pcms/seo";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY = "01900000-0000-7000-8000-000000000001";
const UNROUTED = "01900000-0000-7000-8000-000000000002";

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

test("routing canonical resolver feeds the SEO port; OG/schema signals agree", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);

  const routes = createRouteService(pool);
  const domains = createDomainService(pool);
  const site = await routes.ensureSite("default", "Example");
  await routes.activateRoute({
    siteId: site.id,
    path: "/services/audit/",
    targetType: "entry",
    targetId: ENTRY,
  });
  await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });

  // Composition adapter: @pcms/routing → plain SEO port (L1 boundary kept).
  const canonical = createCanonicalUrlService(pool);
  const port: SeoCanonicalPort = {
    canonicalUrl: async (entryId) => {
      try {
        return await canonical.getCanonicalUrl(entryId, { siteId: site.id });
      } catch {
        return null; // unrouted entries have no canonical (preview/draft cases)
      }
    },
  };

  const routeUrl = await port.canonicalUrl(ENTRY);
  assert.equal(routeUrl, "https://example.ru/services/audit/");
  assert.equal(await port.canonicalUrl(UNROUTED), null);

  // Route/OG/schema URL consistency for the routed entry (§10).
  const effective = resolveCanonical(null, routeUrl);
  assert.equal(effective.source, "canonical_route");
  assert.deepEqual(
    canonicalConsistencyIssues({
      canonical: effective.url,
      og_url: effective.url,
      structured_data_url: effective.url,
    }),
    [],
  );

  // Host poisoning cannot enter: the port URL host is the configured binding.
  const url = new URL(effective.url ?? "");
  assert.equal(url.host, "example.ru");
  assert.equal(url.protocol, "https:");
});
