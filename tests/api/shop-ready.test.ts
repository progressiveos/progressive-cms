import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApplicationServices, uploadMediaOp } from "@pcms/api";
import { newStableId } from "@pcms/core";
import {
  createExtensionCatalog,
  defineExtensionArtifact,
  type ExtensionHttpCallContext,
} from "@pcms/extensions/internal";
import { hardDeleteAsset, LocalMediaStorage } from "@pcms/media";
import { parseSearchQuery, type SearchDocument } from "@pcms/search";
import sharp from "sharp";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";

const id = "example.catalog";
function catalog() {
  const catalog = createExtensionCatalog();
  const revision = newStableId();
  catalog.register(
    defineExtensionArtifact({
      manifest: {
        id,
        name: "Catalog fixture",
        version: "1.0.0",
        extension_contract: "2.0",
        cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
        requires: [],
        provides: [],
        permissions: [],
        data_policy: "retain",
        entrypoint: { type: "module" },
        registrations: {
          http_routes: [
            {
              route_id: "hidden-item",
              method: "GET",
              path: "items/hidden",
              visibility: "session",
              permission: "content.read",
              handler: "page",
              view: "item",
            },
            {
              route_id: "item",
              method: "GET",
              path: "items/:slug",
              visibility: "public",
              handler: "page",
              view: "item",
            },
            {
              route_id: "private",
              method: "GET",
              path: "private/:slug",
              visibility: "session",
              permission: "content.read",
              handler: "page",
              view: "item",
            },
          ],
          views: [
            {
              view_id: "item",
              view_model_schema_version: "1.0.0",
              view_model_schema: { type: "object" },
              base_template: "item.liquid",
            },
          ],
          search_sources: [{ source_id: "item", handler: "document", page_ids_handler: "ids" }],
          sitemap_sources: [{ source_id: "item", handler: "sitemap" }],
          media_usage_sources: [{ source_id: "item", handler: "media" }],
        },
      },
      module: {
        page: (call: ExtensionHttpCallContext) => ({
          view: {
            id: "item",
            model: {},
            head: { json_ld: [{ "@type": "Product", url: call.canonicalUrl }] },
          },
        }),
        document: async (_ctx: unknown, key: string) => document(key, `${id}/item`, revision),
        ids: async () => ({ ids: ["en", "ru"], cursor: null }),
        sitemap: async () => ({
          items: [
            { path: "/items/en/", locale: "en", lastmod: null, noindex: false },
            { path: "/items/ru/", locale: "ru-RU", lastmod: null, noindex: false },
            { path: "/items/hidden/", locale: "en", lastmod: null, noindex: false },
            { path: "/private/secret", locale: "en", lastmod: null, noindex: false },
            { path: "/items/fr/", locale: "fr", lastmod: null, noindex: false },
          ],
          cursor: null,
        }),
        media: async () => [{ source_id: `${id}/retained-item`, source_path: "/image" }],
      },
      contentSha256: "0".repeat(64),
    }),
  );
  return catalog;
}
function document(key: string, entityType = "entry", revision = newStableId()): SearchDocument {
  return {
    entity_type: entityType,
    entity_id: key,
    context: "default",
    site_id: "default",
    locale: key === "ru" ? "ru-RU" : "en",
    content_type: null,
    revision_id: revision,
    generation: 1,
    title: "Catalog needle",
    summary: "",
    structured_text: "",
    body_text: "needle",
    aux_text: "",
    route: entityType === "entry" ? "/ordinary/" : `/items/${key}/`,
    published_at: new Date(),
    modified_at: null,
  };
}
const query = (locale = "en") => parseSearchQuery({ q: "needle", site: "default", locale });

test("S1 composition: canonical, sources and live Search lifecycle agree", async (t) => {
  assert.ok(process.env.PCMS_TEST_DATABASE_URL, "test database required");
  const { app } = await rollbackApiFixture(t, {
    extensionCatalog: catalog(),
    seoEnvironment: "production",
  });
  const site = await app.routes.ensureSite("default");
  await app.localization.update({
    enabled: true,
    defaultLocale: "en",
    locales: ["en", "ru-RU"],
    updatedBy: "test",
  });
  await app.domains.addDomainBinding({
    siteId: site.id,
    hostname: "catalog.example",
    schemePolicy: "https",
    isPrimary: true,
  });
  await app.extensions.lifecycle.install({ extensionId: id, config: {} });
  await app.extensions.lifecycle.enable(id);
  assert.equal(
    await app.searchSource.buildDocument(`${id}/item`, "en"),
    null,
    "unmounted pages excluded",
  );
  assert.equal((await app.seoDiscovery.getSitemapStatus()).candidates, 0);
  await app.extensionRouteMounts.setMount(site.id, id, "/shop");
  for (const [key, locale, path] of [
    ["en", "en", "/shop/items/en/"],
    ["ru", "ru-RU", "/ru/shop/items/ru/"],
  ] as const) {
    const result = await app.extensionHttp.dispatch(
      app,
      {
        path: `/shop/items/${key}`,
        method: "GET",
        query: {},
        locale,
        mutation: { host: "untrusted.example", ip: "203.0.113.9", headers: {} },
      },
      null,
    );
    assert.equal(result.kind, "view");
    if (result.kind !== "view") throw new Error(JSON.stringify(result));
    assert.equal(result.view.canonicalPath, path);
    assert.equal(result.view.canonicalUrl, `https://catalog.example${path}`);
    assert.deepEqual(result.response.head.json_ld, [
      { "@type": "Product", url: result.view.canonicalUrl },
    ]);
    const doc = await app.searchSource.buildDocument(`${id}/item`, key);
    assert.equal(doc?.route, path);
    assert.ok(doc);
    await app.searchProvider.index(doc);
    assert.deepEqual(
      (await app.searchProvider.query(query(locale))).items.map((item) => item.path),
      [path],
    );
  }
  const sitemap = await app.seoDiscovery.getSitemapDocument();
  assert.ok(sitemap);
  assert.match(sitemap, /https:\/\/catalog.example\/shop\/items\/en\//);
  assert.match(sitemap, /https:\/\/catalog.example\/ru\/shop\/items\/ru\//);
  assert.doesNotMatch(sitemap, /private|hidden|items\/fr/);
  await app.extensionRouteMounts.setMount(site.id, id, "/catalog");
  assert.equal((await app.searchProvider.query(query())).items[0]?.path, "/catalog/items/en/");
  assert.equal(
    (await app.searchProvider.query(query("ru-RU"))).items[0]?.path,
    "/ru/catalog/items/ru/",
  );
  // A rebuild or late writer may still carry the old canonical route.
  // The relative projection path always resolves against the current mount.
  const stale = {
    ...document("en", `${id}/item`),
    route: "/shop/items/en/",
    extension_path: "/items/en/",
    generation: 2,
  };
  await app.searchProvider.index(stale);
  await app.extensionRouteMounts.setMount(site.id, id, "/");
  assert.equal((await app.searchProvider.query(query())).items[0]?.path, "/items/en/");
  await app.extensionRouteMounts.setMount(site.id, id, "/catalog");
  await app.extensions.lifecycle.disable(id);
  assert.equal((await app.searchProvider.query(query())).total, 0);
  assert.equal((await app.seoDiscovery.getSitemapStatus()).candidates, 0);
  await app.extensions.lifecycle.enable(id);
  assert.equal((await app.searchProvider.query(query())).total, 1);
  await app.extensions.lifecycle.disable(id);
  await app.extensions.lifecycle.uninstall({ extensionId: id });
  assert.equal((await app.searchProvider.query(query())).total, 0);
});

test("retained extension media survives disable, uninstall and missing package", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-retained-media-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = catalog();
  const { app, pool } = await rollbackApiFixture(t, {
    extensionCatalog: artifacts,
    mediaStorage: new LocalMediaStorage({ root: join(root, "media") }),
    mediaQuarantine: new LocalMediaStorage({ root: join(root, "quarantine") }),
  });
  const upload = await uploadMediaOp(app, apiContextOf(ownerActor()), {
    filename: "sample.png",
    bytes: await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer(),
  });
  await app.extensions.lifecycle.install({ extensionId: id, config: {} });
  await app.extensions.lifecycle.enable(id);
  const assetId = upload.asset.id;
  for (const state of ["enabled", "disabled", "uninstalled", "re-enabled"] as const) {
    if (state === "disabled") await app.extensions.lifecycle.disable(id);
    if (state === "uninstalled") await app.extensions.lifecycle.uninstall({ extensionId: id });
    if (state === "re-enabled") {
      await app.extensions.lifecycle.install({ extensionId: id, config: {} });
      await app.extensions.lifecycle.enable(id);
    }
    const usage = await app.mediaUsage.getUsage(assetId);
    assert.equal(
      usage.references.filter((reference) => reference.origin === "extension").length,
      1,
      state,
    );
    await assert.rejects(
      () =>
        hardDeleteAsset(
          {
            pool,
            port: {
              listInboundReferences: async (mediaId) =>
                (await app.mediaUsage.getUsage(mediaId)).references,
            },
          },
          { assetId, actor: "test", deleteCapability: "media.delete" },
        ),
      { code: "MEDIA_IN_USE" },
    );
  }
  await app.extensions.lifecycle.disable(id);
  await app.extensions.lifecycle.uninstall({ extensionId: id });
  const withoutPackage = createApplicationServices({
    pool,
    extensionCatalog: createExtensionCatalog(),
  });
  await assert.rejects(() => withoutPackage.mediaUsage.getUsage(assetId), { code: "MEDIA_IN_USE" });
});

test("without Shop: ordinary CMS Search is unchanged with an empty catalog", async (t) => {
  const { app } = await rollbackApiFixture(t, {});
  const ordinary = document(newStableId());
  await app.searchProvider.index(ordinary);
  const result = await app.searchProvider.query(query());
  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.path, ordinary.route);
  assert.deepEqual(await app.searchSource.listPhases(), ["entry"]);
  assert.equal(await app.searchSource.buildDocument(`${id}/item`, "en"), null);
});

test("automatic projection migration preserves Entry paths and old default-locale extension rows", async (t) => {
  const { app, pool } = await rollbackApiFixture(t, { extensionCatalog: catalog() });
  const site = await app.routes.ensureSite("default");
  await app.localization.update({
    enabled: true,
    defaultLocale: "en",
    locales: ["en", "ru-RU"],
    updatedBy: "test",
  });
  await app.extensions.lifecycle.install({ extensionId: id, config: {} });
  await app.extensions.lifecycle.enable(id);
  await app.extensionRouteMounts.setMount(site.id, id, "/shop");
  for (const [key, locale, route] of [
    ["legacy", "en", "/en/shop/items/legacy/"],
    ["sentinel", "default", "/shop/items/sentinel/"],
    ["normalized", "en", "/shop/items/normalized/"],
    ["ru", "ru-RU", "/ru/shop/items/ru/"],
    ["private", "en", "/shop/private/secret/"],
    ["hidden", "en", "/shop/items/hidden/"],
  ] as const) {
    await app.searchProvider.index({ ...document(key, `${id}/item`), locale, route });
  }
  const ordinary = document(newStableId());
  await app.searchProvider.index(ordinary);
  // The fixture has the current schema: recreate only the pre-upgrade column
  // layout inside its private rollback schema, then execute the actual migration.
  await pool.query("ALTER TABLE search_documents DROP COLUMN extension_path");
  await pool.query(readFileSync("db/migrations/0002_extension_search_path.sql", "utf8"));
  const result = await app.searchProvider.query(query());
  assert.deepEqual(result.items.map((item) => item.path).sort(), [
    "/ordinary/",
    "/shop/items/legacy/",
    "/shop/items/normalized/",
    "/shop/items/sentinel/",
  ]);
  assert.equal(
    (await app.searchProvider.query(query("ru-RU"))).items[0]?.path,
    "/ru/shop/items/ru/",
  );
  const row = await pool.query<{ route: string; extension_path: string | null }>(
    "SELECT route, extension_path FROM search_documents WHERE entity_type = 'entry'",
  );
  assert.deepEqual(row.rows, [{ route: ordinary.route, extension_path: null }]);
});

test("extension audit/outbox serialization errors roll back real business SQL together", async (t) => {
  const { buildExtensionCallContext } = await import(
    "../../packages/api/src/extension-platform.js"
  );
  const { app, pool } = await rollbackApiFixture(t, {});
  await pool.query("CREATE TABLE test_extension_business (id text PRIMARY KEY)");
  const call = await buildExtensionCallContext(app, null, { extensionId: id, config: null });
  for (const writer of ["audit", "outbox"] as const) {
    await assert.rejects(
      () =>
        call.platform.transaction(async (tx) => {
          await tx.query("INSERT INTO test_extension_business (id) VALUES ($1)", [writer]);
          tx.audit(
            "ItemChanged",
            { type: "item", id: writer },
            writer === "audit" ? { amount: 1n } : {},
          );
          tx.outbox.append(`${id}/ItemChanged`, writer === "outbox" ? { amount: 1n } : {});
        }),
      /BigInt/,
    );
  }
  for (const table of ["test_extension_business", "auth_security_events", "publication_outbox"]) {
    assert.equal(
      (await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]
        ?.count,
      "0",
      table,
    );
  }
});
