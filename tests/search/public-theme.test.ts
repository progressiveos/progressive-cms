import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createApiFastify,
  createApiV1,
  createDraft,
  makeSearchRoutes,
  publishRevision,
  sealRevision,
} from "@pcms/api";
import { newStableId } from "@pcms/core";
import { createAssetWithFirstVersion, ensureBlobRow, updateAssetMetadata } from "@pcms/media";
import { emptySeoDocument } from "@pcms/seo";
import { collectFieldMediaIds, registerSiteRoute } from "../../apps/web/src/site.js";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true },
      intro: { id: "intro", type: "text" },
      price: { id: "price", type: "integer" },
      hero_image: { id: "hero_image", type: "media" },
      internal_note: { id: "internal_note", type: "text" },
    },
  },
] as const;

const skip = testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset";

test("public theme search: default language, full published metadata, media, safety and pagination", {
  skip,
}, async (t) => {
  const themeDir = mkdtempSync(join(tmpdir(), "pcms-search-theme-"));
  t.after(() => rmSync(themeDir, { recursive: true, force: true }));
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });
  // A developer places selected custom fields and SEO wherever they choose.
  const file = join(themeDir, "components/search-result.liquid");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      '<li class="search__result">',
      '<li class="search__result"><span class="price">{{ item.fields.price }}</span><span>{{ item.seo.seo_title }}</span>',
    ),
  );
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
    themeDir,
    seoEnvironment: "production",
  });
  const ctx = apiContextOf(ownerActor());
  const site = await app.routes.ensureSite("default");
  const blob = (
    await ensureBlobRow(app.pool, {
      sha256: "a".repeat(64),
      sizeBytes: 10,
      storageKey: "private-storage-key",
    })
  ).blob;
  const assetId = newStableId();
  const version = {
    blobId: blob.id,
    filenameOriginal: "cover.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 10,
    sha256: blob.sha256,
    width: 96,
    height: 96,
    createdBy: "test",
  };
  await createAssetWithFirstVersion(
    app.pool,
    {
      id: assetId,
      kind: "image",
      originalBlobId: blob.id,
      ...version,
    },
    version,
  );
  await updateAssetMetadata(app.pool, assetId, { altDefault: "Обложка <script>bad()</script>" });
  await app.pool.query(
    `INSERT INTO media_variants
    (id, asset_id, version_no, preset_id, format, width, height, size_bytes, blob_id, variant_key)
    VALUES ($1, $2, 1, 'thumbnail', 'webp', 96, 96, 10, $3, $4)`,
    [newStableId(), assetId, blob.id, "1234567890abcdef"],
  );

  const revisions: string[] = [];
  for (let i = 0; i < 22; i++) {
    const draft = await createDraft(app, ctx, {
      content_type: "page",
      payload: {
        fields: {
          title: `Монтаж ангара ${i}`,
          intro: "Описание <script>bad()</script>",
          price: 12345,
          hero_image: assetId,
          internal_note: "INTERNAL_ONLY",
        },
        blocks: { schema_version: 1, blocks: [] },
      },
    });
    await sealRevision(app, ctx, { revision_id: draft.revision_id });
    await publishRevision(app, ctx, {
      entity_type: "entry",
      entity_id: draft.entry_id,
      target_revision_id: draft.revision_id,
      expected_generation: 0,
    });
    await app.routes.activateRoute({
      siteId: site.id,
      path: `/hangars/${i}/`,
      targetType: "entry",
      targetId: draft.entry_id,
    });
    await app.seo.saveDocument(draft.entry_id, {
      ...emptySeoDocument(),
      seo_title: "SEO материала",
    });
    const document = await app.searchSource.buildDocument("entry", draft.entry_id);
    assert.ok(document);
    assert.equal(document.locale, (await app.localization.get()).defaultLocale);
    await app.searchProvider.index(document);
    revisions.push(draft.revision_id);
  }
  const fastify = createApiFastify(() => "req_theme_search");
  t.after(() => fastify.close());
  await fastify.register(createApiV1(makeSearchRoutes()), {
    application: app,
    cookieSecure: false,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
  });
  await registerSiteRoute(fastify, { application: app });

  const landing = await fastify.inject("/search/");
  assert.equal(landing.statusCode, 200);
  assert.match(String(landing.headers["content-type"]), /text\/html/);
  assert.match(landing.body, /site-header/);
  assert.match(landing.body, /Enter a search query/);
  const page = await fastify.inject("/search/?q=ангары&sort=date&content_type=page");
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /site-header/);
  assert.match(page.body, /site-footer/);
  assert.match(page.body, /Results found: 22/);
  assert.equal((page.body.match(/class="search__result"/g) ?? []).length, 20);
  assert.match(page.body, /12345/);
  assert.match(page.body, /SEO материала/);
  assert.match(page.body, /\/media\/a\/.+\/v1\/thumbnail-/);
  assert.match(page.body, /&lt;script&gt;/);
  assert.ok(!page.body.includes("<script>bad()</script>"));
  assert.ok(!page.body.includes("INTERNAL_ONLY"));
  assert.ok(!page.body.includes("private-storage-key"));
  assert.equal(page.headers["x-robots-tag"], "noindex, follow");
  const style = page.body.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(style);
  const { createHash } = await import("node:crypto");
  assert.ok(
    String(page.headers["content-security-policy"]).includes(
      createHash("sha256").update(style).digest("base64"),
    ),
  );
  const next = page.body.match(/href="([^"<>]*cursor=[^"<>]+)"/)?.[1];
  assert.ok(next);
  assert.match(next, /sort=date/);
  assert.match(next, /content_type=page/);
  const second = await fastify.inject(next.replaceAll("&amp;", "&"));
  assert.equal((second.body.match(/class="search__result"/g) ?? []).length, 2);

  const api = await fastify.inject("/api/v1/search?q=ангары");
  assert.equal(api.statusCode, 200, api.body);
  assert.equal(api.json().total, 22);
  assert.ok(!api.body.includes("internal_note"));
  assert.ok(!api.body.includes("INTERNAL_ONLY"));
  const firstRevision = revisions[0];
  assert.ok(firstRevision);
  const metadata = await app.searchResultMetadata([{ revision_id: firstRevision }]);
  assert.equal(
    metadata[firstRevision]?.fields.internal_note,
    "INTERNAL_ONLY",
    "all fields are available server-side",
  );
  await app.pool.query(
    "UPDATE publications SET state = 'UNPUBLISHED' WHERE current_revision_id = $1",
    [firstRevision],
  );
  assert.deepEqual(
    await app.searchResultMetadata([{ revision_id: firstRevision }]),
    {},
    "stale published metadata is never hydrated",
  );
  const empty = await fastify.inject("/search/?q=несуществующее");
  assert.match(empty.body, /nothing found/i);
});

test("declared media references: nested object, repeater, list and media_list; relation is not media", () => {
  const ids = Array.from({ length: 5 }, () => newStableId());
  const result = new Set<string>();
  collectFieldMediaIds(
    {
      cover: ids[0],
      gallery: [ids[1]],
      group: { photo: ids[2] },
      rows: [{ photo: ids[3] }],
      list: [ids[4]],
      relation: newStableId(),
    },
    {
      cover: { id: "cover", type: "media" },
      gallery: { id: "gallery", type: "media_list" },
      group: { id: "group", type: "object", fields: { photo: { id: "photo", type: "media" } } },
      rows: {
        id: "rows",
        type: "repeater",
        item: { fields: { photo: { id: "photo", type: "media" } } },
      },
      list: { id: "list", type: "list", item: { id: "photo", type: "media" } },
      relation: { id: "relation", type: "relation" },
    },
    result,
  );
  assert.deepEqual([...result], ids);
});
