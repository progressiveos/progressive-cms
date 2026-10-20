// PCMS-NAV-T023 — machine discovery services (Navigation spec §63/§64).
// Acceptance: nav/routes inspectable by agents — every §63/§64 operation
// answers with plain serializable data, deterministically ordered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createNavigationDiscovery,
  createNavigationService,
  createPlacementBindingService,
  type NavigationDiscovery,
  type PlacementDescriptor,
} from "@pcms/navigation";
import {
  createDomainService,
  createRequestResolver,
  createRouteHistoryService,
  createRouteService,
  createRoutingDiscovery,
  type RoutingDiscovery,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY_A = "01900000-0000-7000-8000-000000000001";

const DESCRIPTORS: readonly PlacementDescriptor[] = [
  {
    id: "header.primary",
    label: "header.primary",
    description: null,
    required: true,
    maxDepth: 3,
    supportedItemTypes: ["internal_entry", "group"],
    fallback: null,
  },
];

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

test("navigation discovery answers every §63 operation with serializable data", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const nav = createNavigationService(pool);
  const bindings = createPlacementBindingService(pool, nav);
  const discovery: NavigationDiscovery = createNavigationDiscovery(pool, DESCRIPTORS);

  const set = await nav.createSet({ key: "main", title: "Main" });
  await nav.insertItem({ setId: set.id, type: "group", label: "Services" });
  await nav.insertItem({
    setId: set.id,
    type: "internal_entry",
    label: "Audit",
    target: { entry_id: ENTRY_A },
  });
  await nav.sealRevision(set.id);
  await bindings.bindPlacement({ placementKey: "header.primary", navigationSetId: set.id });

  const sets = await discovery.listNavigationSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0]?.key, "main");

  const tree = await discovery.getNavigationTree("main");
  assert.equal(tree.length, 2);
  assert.equal(JSON.stringify(tree).length > 0, true);

  assert.equal((await discovery.getNavigationRevision("main", 1))?.revision, 1);
  assert.equal((await discovery.listNavigationRevisions("main")).length, 1);

  assert.deepEqual(discovery.listPlacements(), DESCRIPTORS);
  const bound = await discovery.getPlacementBindings();
  assert.deepEqual(bound, [{ placementKey: "header.primary", navigationSetId: set.id }]);

  const validation = await discovery.validateNavigation();
  assert.equal(validation.ok, true);

  // describe() is a deterministic snapshot: same question, same answer.
  const first = await discovery.describe();
  const second = await discovery.describe();
  assert.deepEqual(first, second);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test("routing discovery answers every §64 operation with serializable data", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const routes = createRouteService(pool);
  const history = createRouteHistoryService(pool);
  const domains = createDomainService(pool);
  const discovery: RoutingDiscovery = createRoutingDiscovery(pool);

  const site = await routes.ensureSite("default", "Example Corp");
  await routes.setHomeEntry(site.id, ENTRY_A);
  await routes.activateRoute({
    siteId: site.id,
    path: "/services/audit/",
    targetType: "entry",
    targetId: "01900000-0000-7000-8000-000000000009",
  });
  await history.changeRoute({
    siteId: site.id,
    entryId: "01900000-0000-7000-8000-000000000009",
    fromPath: "/services/audit/",
    toPath: "/services/audit-2026/",
  });
  await domains.addDomainBinding({ siteId: site.id, hostname: "example.ru" });

  const policy = await discovery.getRoutePolicy();
  assert.equal(policy.trailingSlash, true);

  const url = await discovery.resolveEntryUrl("01900000-0000-7000-8000-000000000009");
  assert.equal(url, "https://example.ru/services/audit-2026/");

  const resolution = await discovery.resolveUrl("/services/audit/", "example.ru");
  assert.deepEqual(resolution, {
    kind: "redirect",
    statusCode: 301,
    location: "/services/audit-2026/",
  });

  const availability = await discovery.checkRouteAvailable("/brand-new/");
  assert.equal(availability.available, true);

  const redirects = await discovery.listRedirects();
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0]?.oldPath, "/services/audit/");
  assert.deepEqual(await discovery.getRouteHistory(), redirects);

  const graphIssues = await discovery.validateRedirectGraph();
  assert.deepEqual(graphIssues, []);

  assert.equal((await discovery.listRoutes()).length, 1);
  assert.equal((await discovery.listDomainBindings()).length, 1);

  // Typed actions resolve through the same surface.
  const action = await discovery.resolveAction({
    kind: "internal_entry",
    entry_id: "01900000-0000-7000-8000-000000000009",
  });
  assert.deepEqual(action, { kind: "url", href: "/services/audit-2026/" });

  // Nothing above needed source-code knowledge — and everything serializes.
  void createRequestResolver;
  assert.doesNotThrow(() =>
    JSON.stringify({ policy, url, resolution, availability, redirects, graphIssues, action }),
  );
});
