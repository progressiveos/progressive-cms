// PCMS-NAV-T014 — canonical URL resolver (Navigation spec §23/§37–§39/§42).
// Acceptance: stable absolute URLs built only from configured bindings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  type CanonicalUrlService,
  createCanonicalUrlService,
  createDomainService,
  createRouteService,
  DEFAULT_ROUTE_POLICY,
  type DomainService,
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

async function withCanonical(
  t: { after: (fn: () => void) => void },
  run: (
    canonical: CanonicalUrlService,
    routes: RouteService,
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
  const domains = createDomainService(pool);
  await run(createCanonicalUrlService(pool), routes, domains);
}

async function seedSite(routes: RouteService, domains: DomainService) {
  const site = await routes.ensureSite("default", "Example Corp");
  await routes.setHomeEntry(site.id, ENTRY_HOME);
  await routes.activateRoute({
    siteId: site.id,
    path: "/services/audit/",
    targetType: "entry",
    targetId: ENTRY_A,
  });
  await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
  await domains.addDomainBinding({ siteId: site.id, hostname: "www.example.ru" });
  await domains.addDomainBinding({
    siteId: site.id,
    hostname: "legacy.example.ru",
    schemePolicy: "http",
  });
  return site;
}

test("canonical URLs are absolute and stable per entry", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCanonical(t, async (canonical, routes, domains) => {
    const site = await seedSite(routes, domains);
    assert.equal(await canonical.getCanonicalUrl(ENTRY_HOME), "https://example.ru/");
    assert.equal(await canonical.getCanonicalUrl(ENTRY_A), "https://example.ru/services/audit/");
    assert.equal(await canonical.primaryOrigin(site.id), "https://example.ru");
  });
});

test("canonicalization against an alias uses its own binding, same path", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCanonical(t, async (canonical, routes, domains) => {
    await seedSite(routes, domains);
    assert.equal(
      await canonical.getCanonicalUrl(ENTRY_A, { hostname: "www.example.ru" }),
      "https://www.example.ru/services/audit/",
    );
    // The legacy binding keeps its http scheme policy (dev/staging profile).
    assert.equal(
      await canonical.getCanonicalUrl(ENTRY_A, { hostname: "legacy.example.ru" }),
      "http://legacy.example.ru/services/audit/",
    );
  });
});

test("entries without an active route surface a stable missing-target code", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCanonical(t, async (canonical, routes, domains) => {
    await seedSite(routes, domains);
    await assert.rejects(
      () => canonical.getCanonicalUrl(ENTRY_B),
      (err: RoutingError) => {
        assert.equal(err.code, "NAV_TARGET_MISSING");
        return true;
      },
    );
  });
});

test("host poisoning: an unconfigured Host can never enter a canonical URL", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withCanonical(t, async (canonical, routes, domains) => {
    await seedSite(routes, domains);
    await assert.rejects(
      () => canonical.getCanonicalUrl(ENTRY_A, { hostname: "attacker.example" }),
      (err: RoutingError) => err.code === "DOMAIN_NOT_ALLOWED",
    );
    // The legitimate URL is unaffected — nothing about the rejected host lingers.
    assert.equal(await canonical.getCanonicalUrl(ENTRY_A), "https://example.ru/services/audit/");
  });
});
