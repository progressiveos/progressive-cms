// PCMS-NAV-T026 — migration fixture preserving MODX legacy URLs (Navigation
// spec §26/§61). Acceptance: zero broken canonical fixtures — every entry's
// original (or renamed) canonical URL resolves, redirects and 410s behave,
// and post-migration content coexists on the new baseline.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  applyRedirectImports,
  type CanonicalUrlService,
  createCanonicalUrlService,
  createDomainService,
  createRequestResolver,
  createRouteService,
  type DomainService,
  LEGACY_HTML_ROUTE_POLICY,
  type RequestResolver,
  type RouteService,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

interface MigrationFixture {
  readonly site: {
    readonly key: string;
    readonly title: string;
    readonly domain: string;
    readonly policy: string;
  };
  readonly entries: readonly {
    readonly id: string;
    readonly role: string;
    readonly modxUrl: string | null;
    readonly canonicalPath: string;
    readonly expectedCanonicalUrl: string;
    readonly expectedRedirect?: {
      readonly source: string;
      readonly statusCode: number;
      readonly location: string;
    };
  }[];
  readonly redirects: readonly {
    readonly source: string;
    readonly target: string | null;
    readonly statusCode: 301 | 302 | 307 | 308 | 410;
  }[];
}

const FIXTURE: MigrationFixture = JSON.parse(
  readFileSync("fixtures/navigation/modx-migration-fixture.json", "utf8"),
);

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

test("MODX migration fixture: zero broken canonicals, redirects and 410 intact", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);

  const routes: RouteService = createRouteService(pool);
  const domains: DomainService = createDomainService(pool);
  const canonical: CanonicalUrlService = createCanonicalUrlService(pool);
  const resolver: RequestResolver = createRequestResolver(pool);

  // 1. Recreate the migrated site: legacy policy, primary domain, home.
  assert.equal(FIXTURE.site.policy, "legacy-html");
  const site = await routes.ensureSite(FIXTURE.site.key, FIXTURE.site.title);
  await routes.setPolicy(site.id, LEGACY_HTML_ROUTE_POLICY);
  const home = FIXTURE.entries.find((e) => e.role === "home");
  assert.ok(home !== undefined);
  await routes.setHomeEntry(site.id, home.id);
  await domains.addDomainBinding({ siteId: site.id, hostname: FIXTURE.site.domain });

  // 2. Canonical routes: MODX URLs preserved verbatim (spec §61). The home
  // entry is not activated as a route — its "/" comes from the binding.
  for (const entry of FIXTURE.entries) {
    if (entry.canonicalPath === "/") continue;
    await routes.activateRoute({
      siteId: site.id,
      path: entry.canonicalPath,
      targetType: "entry",
      targetId: entry.id,
    });
  }

  // 3. Redirect batch from the fixture imports atomically.
  const applied = await applyRedirectImports(pool, site.id, FIXTURE.redirects);
  assert.equal(applied.ok, true, JSON.stringify(applied.rows));

  // 4. Zero broken canonical fixtures.
  for (const entry of FIXTURE.entries) {
    // Direct resolution at the canonical path hits the entry.
    const resolution = await resolver.resolve({ siteId: site.id, path: entry.canonicalPath });
    if (entry.role === "home") {
      assert.deepEqual(resolution, { kind: "home", entryId: entry.id }, entry.canonicalPath);
    } else {
      assert.equal(resolution.kind, "route", entry.canonicalPath);
      assert.equal(
        resolution.kind === "route" ? resolution.route.targetId : null,
        entry.id,
        entry.canonicalPath,
      );
    }
    // Generated canonical URL matches the expectation built from bindings.
    assert.equal(
      await canonical.getCanonicalUrl(entry.id, { siteId: site.id }),
      entry.expectedCanonicalUrl,
    );
  }

  // 5. Renamed page: old MODX URL permanently redirects to the new canonical.
  for (const entry of FIXTURE.entries) {
    if (entry.expectedRedirect === undefined) continue;
    const redirect = await resolver.resolve({
      siteId: site.id,
      path: entry.expectedRedirect.source,
    });
    assert.deepEqual(redirect, {
      kind: "redirect",
      statusCode: entry.expectedRedirect.statusCode,
      location: entry.expectedRedirect.location,
    });
  }

  // 6. Standalone redirects from the fixture (alias + 410 gone).
  const alias = await resolver.resolve({ siteId: site.id, path: "/kontakty.html" });
  assert.deepEqual(alias, { kind: "redirect", statusCode: 301, location: "/about.html" });
  const gone = await resolver.resolve({ siteId: site.id, path: "/old-section/dead-page.html" });
  assert.equal(gone.kind, "gone");

  // 7. Graph safety holds after the migration.
  const graphIssues = await resolver.validateRedirectGraph(site.id);
  assert.deepEqual(graphIssues, []);
});
