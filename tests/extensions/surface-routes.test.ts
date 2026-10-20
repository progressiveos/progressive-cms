// Extension Contract 2.0 dispatch regression (CORE-SHOP-01 P0-b; ADR-0018):
// mounts, the /x/<id> technical space, visibility gates, R3 withdrawal,
// view/json/redirect contracts, and mount collision preflights.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, loadMigrations, migrateDatabase, newStableId } from "@pcms/core";
import {
  createExtensionCatalog,
  defineExtensionArtifact,
  type ExtensionCatalog,
} from "@pcms/extensions/internal";
import { createExtensionHttpRouter } from "../../packages/api/src/extension-http.js";
import { createExtensionRouteService } from "../../packages/api/src/extension-routes.js";
import { connectionInfoOf } from "../helpers/api-composition.js";
import { createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const MANIFEST = {
  id: "progressive.test-surface",
  name: "Surface fixture",
  version: "1.0.0",
  extension_contract: "2.0",
  cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
  requires: [],
  provides: [],
  permissions: ["shop.catalog.read"],
  config_schema: undefined,
  migrations: undefined,
  data_policy: "retain",
  entrypoint: { type: "module" },
  registrations: {
    blocks: [],
    field_types: [],
    routes: [],
    event_subscriptions: [],
    validators: [],
    providers: [],
    operations: [],
    http_routes: [
      {
        route_id: "product",
        method: "GET",
        path: "catalog/:slug",
        visibility: "public",
        handler: "productPage",
        view: "product",
      },
      {
        route_id: "admin-stats",
        method: "GET",
        path: "stats",
        visibility: "admin",
        permission: "shop.catalog.read",
        handler: "stats",
      },
      {
        route_id: "api-item",
        method: "GET",
        path: "api/:id",
        visibility: "public",
        handler: "itemJson",
      },
      {
        route_id: "go",
        method: "GET",
        path: "go",
        visibility: "public",
        handler: "redirectOut",
      },
    ],
    views: [
      {
        view_id: "product",
        view_model_schema_version: "1.0.0",
        view_model_schema: { type: "object" },
        base_template: "templates/base.liquid",
      },
    ],
    sitemap_sources: [],
    search_sources: [],
    media_usage_sources: [],
  },
};

function fixtureCatalog(): ExtensionCatalog {
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: MANIFEST,
      module: {
        productPage: (call: { params: { slug: string } }) => ({
          status: 200,
          view: { id: "product", model: { slug: call.params.slug }, head: { title: "P" } },
        }),
        stats: () => ({ status: 200, json: { orders: 0 } }),
        itemJson: (call: { params: { id: string } }) => ({
          status: 200,
          json: { id: call.params.id },
        }),
        redirectOut: () => ({ status: 302, location: "https://example.com/" }),
      },
      contentSha256: "0".repeat(64),
    }),
  );
  return catalog;
}

async function harness() {
  const db = await createTestDatabase({ after: () => {} } as never);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 2,
    connectionTimeoutMilliseconds: 5000,
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const extensionRoutes = createExtensionRouteService({
    pool,
    reserved: {
      isReserved: (path) => path.startsWith("/admin/") || path.startsWith("/x/"),
      assertNotReserved: () => {},
      listReserved: () => [],
    },
    activeEntryRoutes: async () => ["/shop-sale/"],
  });
  const enabled = { ids: ["progressive.test-surface"], revision: "rev-1" };
  const router = createExtensionHttpRouter({
    catalog: fixtureCatalog(),
    lifecycle: {
      enabledIds: async () => enabled.ids,
      revision: async () => enabled.revision,
    },
    resolveRuntime: async (extensionId) => ({ id: extensionId, config: {} }),
    extensionRoutes,
  });
  const app = { defaultSiteKey: "default" } as never;
  return {
    pool,
    extensionRoutes,
    router,
    app,
    setEnabled: (ids: readonly string[], revision: string) => {
      enabled.ids = [...ids];
      enabled.revision = revision;
    },
  };
}

test("dispatch: technical /x/<id> space serves routes without any mount", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const h = await harness();
  t.after(() => void h.pool.end());

  // SEO policy (CORE-SHOP-SEO-01): a public HTML view without an ACTIVE
  // mount does not exist in the technical space — 404, not duplicate HTML.
  const unmounted = await h.router.dispatch(
    h.app,
    { path: "/x/progressive.test-surface/catalog/super-widget", method: "GET", query: {} },
    null,
  );
  assert.equal(unmounted.kind, "failure");
  assert.equal((unmounted as { code: string }).code, "EXTENSION_ROUTE_NOT_MOUNTED");

  // JSON routes are not indexable HTML: the technical mirror still serves them.
  const json = await h.router.dispatch(
    h.app,
    { path: "/x/progressive.test-surface/api/42", method: "GET", query: {} },
    null,
  );
  assert.deepEqual(json, { kind: "json", status: 200, body: { id: "42" } });

  const redirect = await h.router.dispatch(
    h.app,
    { path: "/x/progressive.test-surface/go", method: "GET", query: {} },
    null,
  );
  assert.deepEqual(redirect, { kind: "redirect", status: 302, location: "https://example.com/" });

  const unknown = await h.router.dispatch(
    h.app,
    { path: "/x/progressive.unknown/catalog/x", method: "GET", query: {} },
    null,
  );
  assert.equal(unknown.kind, "failure");
});

test("dispatch: active mount — canonical 200, technical space 308 (no duplicate HTML)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const h = await harness();
  t.after(() => void h.pool.end());
  const siteId = newStableId();
  await h.pool.query("INSERT INTO sites (id, key, title) VALUES ($1, $2, $3)", [
    siteId,
    "default",
    "t",
  ]);
  await h.extensionRoutes.setMount(siteId, "progressive.test-surface", "/shop");

  const canonical = await h.router.dispatch(
    h.app,
    { path: "/shop/catalog/super-widget", method: "GET", query: {} },
    null,
  );
  assert.equal(canonical.kind, "view", `RESULT=${JSON.stringify(canonical)}`);
  assert.equal(
    (canonical as unknown as { view: { canonicalPath: string } }).view.canonicalPath,
    "/shop/catalog/super-widget/",
    `RESULT=${JSON.stringify(canonical)}`,
  );

  // technical space: permanent redirect to canonical, no second HTML render
  const technical = await h.router.dispatch(
    h.app,
    { path: "/x/progressive.test-surface/catalog/super-widget", method: "GET", query: {} },
    null,
  );
  assert.deepEqual(technical, {
    kind: "redirect",
    status: 308,
    location: "/shop/catalog/super-widget/",
  });
});

test("dispatch: mount move — old published URL answers 308 once, no chains", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const h = await harness();
  t.after(() => void h.pool.end());
  const siteId = newStableId();
  await h.pool.query("INSERT INTO sites (id, key, title) VALUES ($1, $2, $3)", [
    siteId,
    "default",
    "t",
  ]);
  await h.extensionRoutes.setMount(siteId, "progressive.test-surface", "/shop");
  await h.extensionRoutes.setMount(siteId, "progressive.test-surface", "/boutique");

  // old mount path: one permanent hop to the new mount (suffix preserved)
  const moved = await h.extensionRoutes.resolveRedirect("/shop/catalog/super-widget");
  assert.deepEqual(moved, {
    extensionId: "progressive.test-surface",
    mount: "/boutique",
    rest: "/catalog/super-widget",
  });

  // no duplicate 200: the old mount serves nothing itself (retired)
  const direct = await h.router.dispatch(
    h.app,
    { path: "/shop/catalog/super-widget", method: "GET", query: {} },
    null,
  );
  assert.equal(direct.kind, "miss");
});

test("dispatch: mount-based canonical URL, entry-route collision, entry publication guard", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const h = await harness();
  t.after(() => void h.pool.end());

  // collision with the seeded active entry route
  await assert.rejects(
    () => h.extensionRoutes.setMount(newStableId(), "progressive.test-surface", "/shop-sale"),
    (error: unknown) => (error as { code?: string }).code === "EXTENSION_MOUNT_COLLISION",
  );

  const siteId = newStableId();
  await h.pool.query("INSERT INTO sites (id, key, title) VALUES ($1, $2, $3)", [
    siteId,
    "default",
    "t",
  ]);
  const mount = await h.extensionRoutes.setMount(siteId, "progressive.test-surface", "/shop");
  assert.equal(mount.mountPath, "/shop");

  const canonical = await h.router.dispatch(
    h.app,
    { path: "/shop/catalog/super-widget/", method: "GET", query: {} },
    null,
  );
  assert.equal(canonical.kind, "view", `RESULT=${JSON.stringify(canonical)}`);
  assert.equal(
    (canonical as unknown as { view: { canonicalPath: string } }).view.canonicalPath,
    "/shop/catalog/super-widget/",
  );

  // reserved namespace refused
  await assert.rejects(
    () => h.extensionRoutes.setMount(siteId, "progressive.test-surface", "/admin"),
    (error: unknown) => (error as { code?: string }).code === "EXTENSION_MOUNT_COLLISION",
  );
  await assert.rejects(
    () => h.extensionRoutes.setMount(siteId, "progressive.test-surface", "/x"),
    (error: unknown) => (error as { code?: string }).code === "EXTENSION_MOUNT_COLLISION",
  );

  // entry publication guard
  await assert.rejects(
    () => h.extensionRoutes.assertEntryRouteActivatable("/shop/cart/"),
    (error: unknown) => (error as { code?: string }).code === "EXTENSION_MOUNT_COLLISION",
  );
});

test("dispatch: session/admin visibility gates and R3 withdrawal", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const h = await harness();
  t.after(() => void h.pool.end());

  const denied = await h.router.dispatch(
    h.app,
    { path: "/x/progressive.test-surface/stats", method: "GET", query: {} },
    null,
  );
  assert.equal(denied.kind, "failure");
  assert.equal((denied as { status: number }).status, 401);

  const withdrawn = h.setEnabled([], "rev-2");
  void withdrawn;
  const gone = await h.router.dispatch(
    h.app,
    { path: "/x/progressive.test-surface/stats", method: "GET", query: {} },
    null,
  );
  assert.equal(gone.kind, "failure");
  assert.equal((gone as { code: string }).code, "EXTENSION_ROUTE_NOT_FOUND");
});
