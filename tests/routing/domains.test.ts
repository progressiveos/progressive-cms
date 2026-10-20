// PCMS-NAV-T013 — domain bindings + allowed Host validation (Navigation
// spec §36–§39). Acceptance: host poisoning tests — unconfigured Host
// headers can never produce canonical URLs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createDomainService,
  createRouteService,
  type DomainService,
  normalizeHostname,
  type RouteService,
  type RoutingError,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

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

async function withDomains(
  t: { after: (fn: () => void) => void },
  run: (routes: RouteService, domains: DomainService) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await run(createRouteService(pool), createDomainService(pool));
}

test("first binding becomes primary; aliases carry a redirect policy", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDomains(t, async (routes, domains) => {
    const site = await routes.ensureSite("default", "Example Corp");
    const primary = await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
    assert.equal(primary.isPrimary, true);
    assert.equal(primary.schemePolicy, "https");

    const alias = await domains.addDomainBinding({
      siteId: site.id,
      hostname: "www.example.ru",
    });
    assert.equal(alias.isPrimary, false);
    assert.equal(alias.canonicalRedirectPolicy, "redirect");

    const all = await domains.listDomainBindings(site.id);
    assert.equal(all.length, 2);
    assert.equal(all.filter((d) => d.isPrimary).length, 1);
  });
});

test("host allowlist: unknown hosts throw DOMAIN_NOT_ALLOWED (spec §38)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDomains(t, async (routes, domains) => {
    const site = await routes.ensureSite("default", "Example Corp");
    await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });

    await assert.rejects(
      () => domains.resolveHost("attacker.example"),
      (err: RoutingError) => err.code === "DOMAIN_NOT_ALLOWED",
    );
    // Bound hosts resolve case-insensitively and port/scheme tolerant.
    const binding = await domains.resolveHost("EXAMPLE.ru:443");
    assert.equal(binding.hostname, "example.ru");
  });
});

test("host normalization strips proxy noise and rejects garbage", () => {
  assert.equal(normalizeHostname("Example.RU."), "example.ru");
  assert.equal(normalizeHostname("https://example.ru:8443/path?q=1"), "example.ru");
  assert.equal(normalizeHostname("user@example.ru"), "example.ru");
  for (const bad of ["", "not a host", "exa mple.ru", "host_underscore", "a".repeat(300)]) {
    assert.throws(
      () => normalizeHostname(bad),
      (err: RoutingError) => err.code === "DOMAIN_NOT_ALLOWED",
      bad,
    );
  }
});

test("hostnames are globally unique across sites; primary is reassignable", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDomains(t, async (routes, domains) => {
    const site = await routes.ensureSite("default", "Example Corp");
    const other = await routes.ensureSite("other", "Other Corp");
    await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });
    await assert.rejects(
      () => domains.addDomainBinding({ siteId: other.id, hostname: "example.ru" }),
      (err: RoutingError) => err.code === "DOMAIN_ALREADY_BOUND",
    );
    const alias = await domains.addDomainBinding({ siteId: site.id, hostname: "example.com" });
    const promoted = await domains.setPrimaryDomain(alias.id);
    assert.equal(promoted.isPrimary, true);
    const bindings = await domains.listDomainBindings(site.id);
    assert.equal(bindings.filter((d) => d.isPrimary).length, 1);
    assert.equal(bindings.find((d) => d.hostname === "example.ru")?.isPrimary, false);
  });
});

test("scheme policy defaults to https for canonical origins (spec §39)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  await withDomains(t, async (routes, domains) => {
    const site = await routes.ensureSite("default", "Example Corp");
    const dev = await domains.addDomainBinding({
      siteId: site.id,
      hostname: "example.ru",
      schemePolicy: "http",
    });
    assert.equal(dev.schemePolicy, "http");
    const prod = await domains.addDomainBinding({ siteId: site.id, hostname: "example.org" });
    assert.equal(prod.schemePolicy, "https");
  });
});
