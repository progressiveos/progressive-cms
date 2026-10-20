import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createApiFastify, enableExtension, installExtension } from "@pcms/api";
import { createExtensionCatalog, defineExtensionArtifact } from "@pcms/extensions/internal";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const EXTENSION_ID = "progressive.test-theme-layout";

test("extension theme overrides and package templates render inside the active theme layout", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");

  const root = mkdtempSync(join(tmpdir(), "pcms-extension-theme-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = join(root, "theme");
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });

  const themeManifestPath = join(themeDir, "theme.json");
  const themeManifest = JSON.parse(readFileSync(themeManifestPath, "utf8")) as {
    templates: Record<string, unknown>[];
  };
  themeManifest.templates.push({
    id: "fixture-product-view",
    file: "templates/fixture-product-view.liquid",
    accepts_content_types: ["page@1"],
    accepts_views: [`${EXTENSION_ID}/product@1`],
    editor_selectable: false,
  });
  writeFileSync(themeManifestPath, JSON.stringify(themeManifest));
  writeFileSync(
    join(themeDir, "templates/fixture-product-view.liquid"),
    "<section data-theme-override>{{ view.name }}</section>",
  );

  const extensionDir = join(root, "extension");
  mkdirSync(join(extensionDir, "templates"), { recursive: true });
  writeFileSync(
    join(extensionDir, "templates/base.liquid"),
    "<article data-package-base>{{ view.name }}</article>",
  );
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      extensionsDir: relative(process.cwd(), extensionDir),
      manifest: {
        id: EXTENSION_ID,
        name: "Theme Layout Fixture",
        version: "1.0.0",
        extension_contract: "2.0",
        cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
        requires: [],
        provides: [],
        permissions: [],
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
              path: "product",
              visibility: "public",
              handler: "productView",
              view: "product",
            },
            {
              route_id: "fallback",
              method: "GET",
              path: "fallback",
              visibility: "public",
              handler: "fallbackView",
              view: "fallback",
            },
          ],
          views: [
            {
              view_id: "product",
              view_model_schema_version: "1.0.0",
              view_model_schema: { type: "object" },
              base_template: "templates/base.liquid",
            },
            {
              view_id: "fallback",
              view_model_schema_version: "1.0.0",
              view_model_schema: { type: "object" },
              base_template: "templates/base.liquid",
            },
          ],
          sitemap_sources: [],
          search_sources: [],
          media_usage_sources: [],
        },
      },
      module: {
        productView: () => ({
          status: 200,
          view: {
            id: "product",
            model: { name: "<script>override</script>" },
            head: { title: "Product" },
          },
        }),
        fallbackView: () => ({
          status: 200,
          view: {
            id: "fallback",
            model: { name: "Package fallback" },
            head: { title: "Fallback" },
          },
        }),
      },
    }),
  );

  const fixture = await createApiFixture(t, { themeDir, extensionCatalog: catalog });
  const ctx = apiContextOf(ownerActor("extension-theme-layout-test"));
  await installExtension(fixture.app, ctx, { extension_id: EXTENSION_ID });
  await enableExtension(fixture.app, ctx, { extension_id: EXTENSION_ID });
  const site = await fixture.app.routes.ensureSite("default");
  await fixture.app.extensionRouteMounts.setMount(site.id, EXTENSION_ID, "/store");

  const fastify = createApiFastify(() => "req_extension_theme_layout");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: fixture.app });

  const override = await fastify.inject({ method: "GET", url: "/store/product/" });
  assert.equal(override.statusCode, 200, override.body);
  assert.ok(override.body.includes('class="site-header'), "active theme header renders");
  assert.ok(override.body.includes('class="site-footer"'), "active theme footer renders");
  assert.ok(
    override.body.includes("data-theme-override"),
    `declared theme view override is selected: ${override.body}`,
  );
  assert.ok(
    override.body.includes("&lt;script&gt;override&lt;/script&gt;"),
    "view data stays escaped",
  );
  assert.equal((override.body.match(/<!doctype html/gi) ?? []).length, 1);

  const fallback = await fastify.inject({ method: "GET", url: "/store/fallback/" });
  assert.equal(fallback.statusCode, 200, fallback.body);
  assert.ok(fallback.body.includes('class="site-header'));
  assert.ok(fallback.body.includes('class="site-footer"'));
  assert.ok(
    fallback.body.includes("data-package-base"),
    "package view renders inside the same layout",
  );
  assert.ok(fallback.body.includes("Package fallback"));
  assert.equal((fallback.body.match(/<!doctype html/gi) ?? []).length, 1);
});
