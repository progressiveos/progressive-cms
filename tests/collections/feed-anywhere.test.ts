// CORE-FEED-ANYWHERE — feed scope/order/exclusions, card projection, batched
// media and seal-time option validation (Theme Contract §43).
//
// Runs on the existing test database through a private schema (no new DB):
// rollbackApiFixture applies migrations, creates the fixture and rolls back.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ApiRoute,
  archiveEntry,
  createApiFastify,
  createApiV1,
  createDraft,
  makeCollectionsRoutes,
  moveEntryOp,
  publishRevision,
  queryCollectionFeed,
  sealRevision,
  setEntryTemplateOp,
  uploadMediaOp,
  validateRevision,
} from "@pcms/api";
import { registerFirstPartyBlocksV1 } from "@pcms/blocks";
import { LocalMediaStorage } from "@pcms/media";
import sharp from "sharp";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const skip = testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL is not set";

test("SQL fixture observer includes transaction control in both modes", { skip }, async (t) => {
  for (const mode of ["rollback", "committed"] as const) {
    await t.test(mode, async (child) => {
      const statements: string[] = [];
      const options =
        mode === "committed"
          ? {
              transactionMode: "committed" as const,
              onQuery: (sql: string) => statements.push(sql),
            }
          : { onQuery: (sql: string) => statements.push(sql) };
      const { pool } = await rollbackApiFixture(child, {}, options);
      statements.length = 0;
      await pool.withTransaction((client) => client.query("SELECT 1"));
      const transaction = statements.filter((sql) =>
        /^(BEGIN|COMMIT|SAVEPOINT |RELEASE SAVEPOINT |SELECT 1$)/.test(sql),
      );
      assert.equal(transaction.length, 3);
      assert.match(transaction[0]!, mode === "committed" ? /^BEGIN$/ : /^SAVEPOINT /);
      assert.equal(transaction[1], "SELECT 1");
      assert.match(transaction[2]!, mode === "committed" ? /^COMMIT$/ : /^RELEASE SAVEPOINT /);
    });
  }
});

test("localized navigation follows publish, unpublish and rollback immediately", {
  skip,
}, async (t) => {
  const { app, ctx, site, themeDir } = await feedFixture(t);
  writeFileSync(
    join(themeDir, "templates", "plain_page.liquid"),
    `<!doctype html><html><head>{{ head_html }}</head><body>{% for item in nav["header.primary"].items %}<a href="{{ item.href }}">{{ item.title }}</a>{% endfor %}</body></html>`,
  );
  await app.domains.addDomainBinding({
    siteId: site.id,
    hostname: "locale.example",
    isPrimary: true,
  });
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru-RU",
    locales: ["ru-RU", "en-US"],
    updatedBy: "test",
  });
  async function draft(title: string, locale?: string) {
    const result = await createDraft(app, ctx, {
      content_type: "page",
      ...(locale === undefined ? {} : { locale }),
      payload: { fields: { title }, blocks: { schema_version: 1, blocks: [] } },
    });
    await setEntryTemplateOp(app, ctx, { entry_id: result.entry_id, template_key: "plain_page" });
    return result;
  }
  async function publish(item: Awaited<ReturnType<typeof draft>>, context?: string) {
    await sealRevision(app, ctx, { revision_id: item.revision_id });
    await publishRevision(app, ctx, {
      entity_type: "entry",
      entity_id: item.entry_id,
      target_revision_id: item.revision_id,
      expected_generation: 0,
      ...(context === undefined ? {} : { context }),
    });
  }
  const page = await draft("Page");
  const target = await draft("Target");
  await publish(page);
  await publish(target);
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/page/",
    targetType: "entry",
    targetId: page.entry_id,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/target/",
    targetType: "entry",
    targetId: target.entry_id,
  });
  const enPage = await draft("Page EN", "en-US");
  const enTarget = await draft("Target EN", "en-US");
  await app.pool.query("UPDATE entries SET translation_group_id = $2 WHERE id = $1", [
    enPage.entry_id,
    page.entry_id,
  ]);
  await app.pool.query("UPDATE entries SET translation_group_id = $2 WHERE id = $1", [
    enTarget.entry_id,
    target.entry_id,
  ]);
  await publish(enPage, "en-US");
  await sealRevision(app, ctx, { revision_id: enTarget.revision_id });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/page/",
    locale: "en-US",
    targetType: "entry",
    targetId: enPage.entry_id,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/target/",
    locale: "en-US",
    targetType: "entry",
    targetId: enTarget.entry_id,
  });
  const set = await app.navigation.createSet({ key: "localized-nav", title: "Localized" });
  await app.navigation.insertItem({
    setId: set.id,
    type: "internal_entry",
    label: "Target link",
    target: { entry_id: target.entry_id },
  });
  await app.placements.bindPlacement({ placementKey: "header.primary", navigationSetId: set.id });
  const fastify = createApiFastify(() => "req_localized_nav");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  t.after(() => fastify.close());
  const before = await fastify.inject({ method: "GET", url: "/en/page/" });
  assert.equal(before.statusCode, 200, before.body);
  assert.doesNotMatch(before.body, /Target link/);
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: enTarget.entry_id,
    target_revision_id: enTarget.revision_id,
    context: "en-US",
    expected_generation: 0,
  });
  const published = await fastify.inject({
    method: "GET",
    url: "/en/page/",
    headers: { cookie: "irrelevant=test" },
  });
  assert.equal(published.statusCode, 200, published.body);
  assert.match(published.body, /href="\/en\/target\/">Target link/);
  assert.equal(
    published.body.match(/<head>[\s\S]*?<\/head>/)?.[0],
    before.body.match(/<head>[\s\S]*?<\/head>/)?.[0],
  );
  await app.publications.unpublish({
    entityType: "entry",
    entityId: enTarget.entry_id as never,
    context: "en-US",
    expectedGeneration: 1,
    actor: { actorClass: "operator", actorId: "test" },
    reason: "test",
  });
  const unpublished = await fastify.inject({ method: "GET", url: "/en/page/" });
  assert.doesNotMatch(unpublished.body, /Target link/);
  await app.publications.rollback({
    entityType: "entry",
    entityId: enTarget.entry_id as never,
    context: "en-US",
    expectedGeneration: 2,
    targetRevisionId: enTarget.revision_id as never,
    actor: { actorClass: "operator", actorId: "test" },
  });
  const rolledBack = await fastify.inject({ method: "GET", url: "/en/page/" });
  assert.match(rolledBack.body, /href="\/en\/target\/">Target link/);
  const defaultPage = await fastify.inject({ method: "GET", url: "/page/" });
  assert.match(defaultPage.body, /href="\/target\/">Target link/);
});

test("public navigation resolves many published links with bounded SQL", { skip }, async (t) => {
  let queryCount = 0;
  const { app, pool, ctx, site, themeDir } = await feedFixture(t, () => queryCount++);
  writeFileSync(
    join(themeDir, "templates", "plain_page.liquid"),
    `{% for item in nav["header.primary"].items %}<a href="{{ item.href }}">{{ item.title }}</a>{% endfor %}{% for item in nav["header.mobile"].items %}<span>{{ item.title }}</span>{% endfor %}`,
  );
  await app.domains.addDomainBinding({
    siteId: site.id,
    hostname: "example.test",
    isPrimary: true,
  });
  const set = await app.navigation.createSet({ key: "perf-nav", title: "Performance" });
  await app.placements.bindPlacement({ placementKey: "header.primary", navigationSetId: set.id });
  await app.placements.bindPlacement({ placementKey: "header.mobile", navigationSetId: set.id });
  const entries: string[] = [];
  for (let i = 0; i < 200; i++) {
    const draft = await createDraft(app, ctx, {
      content_type: "page",
      payload: { fields: { title: `Page ${i}` }, blocks: { schema_version: 1, blocks: [] } },
    });
    await setEntryTemplateOp(app, ctx, { entry_id: draft.entry_id, template_key: "plain_page" });
    await sealRevision(app, ctx, { revision_id: draft.revision_id });
    await publishRevision(app, ctx, {
      entity_type: "entry",
      entity_id: draft.entry_id,
      target_revision_id: draft.revision_id,
      expected_generation: 0,
    });
    await app.routes.activateRoute({
      siteId: site.id,
      path: `/perf-${i}/`,
      targetType: "entry",
      targetId: draft.entry_id,
    });
    entries.push(draft.entry_id);
  }
  await app.navigation.insertItem({
    setId: set.id,
    type: "internal_entry",
    label: "Link 0",
    target: { entry_id: entries[0]! },
  });
  const { resolveNavigationPaths } = await import("@pcms/routing");
  await resolveNavigationPaths(pool, [entries[0]!], { locale: "x-default" });
  const fastify = createApiFastify(() => "req_perf_nav");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  t.after(() => fastify.close());
  const counter = {
    get count() {
      return queryCount;
    },
    reset() {
      queryCount = 0;
    },
  };
  const warm = await fastify.inject({ method: "GET", url: "/perf-0/" });
  assert.equal(warm.statusCode, 200, warm.body);
  counter.reset();
  const first = await fastify.inject({ method: "GET", url: "/perf-0/" });
  const one = counter.count;
  assert.equal(first.statusCode, 200, first.body);
  for (let i = 1; i < entries.length; i++) {
    await app.navigation.insertItem({
      setId: set.id,
      type: "internal_entry",
      label: `Link ${i}`,
      target: { entry_id: entries[i]! },
    });
  }
  counter.reset();
  const many = await fastify.inject({ method: "GET", url: "/perf-0/" });
  const manyCount = counter.count;
  assert.equal(many.statusCode, 200);
  assert.match(many.body, /href="\/perf-199\/">Link 199/);
  assert.match(many.body, /<span>Link 199<\/span>/);
  assert.ok(manyCount - one <= 10, `navigation SQL grew from ${one} to ${manyCount}`);
  t.diagnostic(`one link: ${one} SQL; 200 links in two placements: ${manyCount} SQL`);

  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Draft target" }, blocks: { schema_version: 1, blocks: [] } },
  });
  const sealed = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Sealed target" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: sealed.revision_id });
  for (const [entryId, label] of [
    [draft.entry_id, "Private working"],
    [sealed.entry_id, "Private sealed"],
  ] as const) {
    await app.routes.activateRoute({
      siteId: site.id,
      path: `/${label.replace(" ", "-").toLowerCase()}/`,
      targetType: "entry",
      targetId: entryId,
    });
    await app.navigation.insertItem({
      setId: set.id,
      type: "internal_entry",
      label,
      target: { entry_id: entryId },
    });
  }
  await app.publications.unpublish({
    entityType: "entry",
    entityId: entries[1] as never,
    expectedGeneration: 1,
    actor: { actorClass: "operator", actorId: "test" },
    reason: "test",
  });
  await archiveEntry(app, ctx, { entry_id: entries[4]! });
  await app.routes.retireRoute({ siteId: site.id, path: "/perf-2/" });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/new-perf-2/",
    targetType: "entry",
    targetId: entries[2]!,
  });
  const changed = await fastify.inject({ method: "GET", url: "/perf-0/" });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.doesNotMatch(changed.body, /Link 1<\/a>/);
  assert.doesNotMatch(changed.body, /Link 4<\/a>/);
  assert.doesNotMatch(changed.body, /Private working|Private sealed/);
  assert.match(changed.body, /href="\/new-perf-2\/">Link 2/);
  if (process.env.PCMS_NAV_BROWSER === "1") {
    const { chromium } = await import("@playwright/test");
    const address = await fastify.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        const response = await page.goto(`${address}/perf-0/`);
        assert.equal(response?.status(), 200);
        assert.equal(await page.locator('a[href="/new-perf-2/"]').textContent(), "Link 2");
        assert.equal(await page.getByText("Private working").count(), 0);
        assert.equal(await page.getByText("Private sealed").count(), 0);
      }
    } finally {
      await browser.close();
    }
  }

  const other = await app.routes.ensureSite("other", "Other");
  await app.domains.addDomainBinding({
    siteId: other.id,
    hostname: "other.example.test",
    isPrimary: true,
  });
  await app.routes.activateRoute({
    siteId: other.id,
    path: "/other-2/",
    targetType: "entry",
    targetId: entries[2]!,
  });
  const [firstSite, secondSite] = await Promise.all([
    resolveNavigationPaths(pool, [entries[2]!], { hostname: "example.test", locale: "x-default" }),
    resolveNavigationPaths(pool, [entries[2]!], {
      hostname: "other.example.test",
      locale: "x-default",
    }),
  ]);
  assert.equal(firstSite.get(entries[2]!), "/new-perf-2/");
  assert.equal(secondSite.get(entries[2]!), "/other-2/");
  const oldAction = await app.actionUrls.resolveAction(
    { kind: "internal_entry", entry_id: entries[2]! },
    { hostname: "example.test", locale: "x-default" },
  );
  assert.deepEqual(oldAction, { kind: "url", href: firstSite.get(entries[2]!) });
  assert.equal(
    (await resolveNavigationPaths(pool, [entries[2]!], { hostname: "example.test", locale: "fr" }))
      .size,
    0,
  );
  await pool.query("UPDATE entries SET locale = 'en', translation_group_id = $2 WHERE id = $1", [
    entries[3],
    entries[2],
  ]);
  const { resolveNavigationEntries } = await import("@pcms/content");
  const translated = await resolveNavigationEntries(pool, [entries[2]!], "en");
  assert.equal(translated.get(entries[2]!), entries[3]);
  assert.equal((await app.entries.findTranslation(entries[2] as never, "en"))?.id, entries[3]);
  assert.equal((await resolveNavigationEntries(pool, [entries[2]!], "fr")).size, 0);

  const { publishedEntryIds } = await import("@pcms/publication");
  const visible = await publishedEntryIds(pool, entries, "default");
  for (const id of entries) {
    const previous = await app.publications.getPublishedRevision(
      pool,
      "entry",
      id as never,
      "default",
    );
    assert.equal(visible.has(id), previous !== null, `published visibility for ${id}`);
  }
  assert.equal(visible.has(entries[1]!), false);
  assert.equal(visible.has(entries[4]!), true); // Archive is enforced by the entry resolver.
  assert.equal((await resolveNavigationEntries(pool, [entries[4]!], "default")).size, 0);
  await app.routes.setHomeEntry(site.id, entries[0]!);
  assert.equal(
    (
      await resolveNavigationPaths(pool, [entries[0]!], {
        hostname: "example.test",
        locale: "x-default",
      })
    ).get(entries[0]!),
    "/",
  );
  const { newStableId } = await import("@pcms/core");
  const boundedIds = [...entries, ...Array.from({ length: 301 }, () => newStableId())];
  counter.reset();
  await resolveNavigationEntries(pool, boundedIds, "default");
  await publishedEntryIds(pool, boundedIds, "default");
  await resolveNavigationPaths(pool, boundedIds, { hostname: "example.test", locale: "x-default" });
  assert.ok(counter.count <= 10, `501 ids used ${counter.count} SQL statements`);
});

/** Reference types with the two card fields the feed options need. */
const DEFINITIONS = (() => {
  const parsed = JSON.parse(
    readFileSync("fixtures/content/reference-content-types.json", "utf8"),
  ) as {
    contentTypes: Record<string, unknown>[];
  };
  return parsed.contentTypes.map((type) =>
    type.key === "news"
      ? {
          ...type,
          fields: {
            ...(type.fields as Record<string, unknown>),
            rank: { id: "rank", type: "integer" },
            hero_image: { id: "hero_image", type: "media" },
          },
        }
      : type,
  );
})();

const FEED_TEMPLATE = `<!doctype html>
<html lang="ru"><head>{{ head_html }}</head><body><main>
<h1>{{ entry.fields.title }}</h1>
{% for item in collections.news_all.items %}
<article class="card" data-entry-id="{{ item.entry_id }}">
<a class="card__link" href="{{ item.href }}">{{ item.title }}</a>
<span class="card__description">{{ item.description }}</span>
<span class="card__teaser">{{ item.teaser }}</span>
<span class="card__date">{{ item.date }}</span>
<img class="card__image" src="{{ item.image }}" alt="{{ item.image_alt }}">
<span class="card__rank">{{ item.fields.rank }}</span>
<span class="card__hero">{{ item.fields.hero_image.url }}</span>
<span class="card__published">{{ item.fields.published_at }}</span>
</article>
{% endfor %}
<p class="feed__total">{{ collections.news_all.total }}</p>
{{ blocks_html }}
</main></body></html>`;

const PLAIN_TEMPLATE = `<!doctype html>
<html lang="ru"><head>{{ head_html }}</head><body><main>
<h1>{{ entry.fields.title }}</h1>{{ blocks_html }}
</main></body></html>`;

/** Related-card renderer printing every documented card surface. */
const RELATED_BLOCK_TEMPLATE = `<section class="block block-related" data-block="{{ block.id }}">
{% for card in related_cards %}
<li class="card" data-entry-id="{{ card.entry_id }}">
<a class="card__link" href="{{ card.href }}">{{ card.title }}</a>
<span class="card__description">{{ card.description }}</span>
<span class="card__note">{{ card.note }}</span>
<span class="card__tag">{{ card.tag }}</span>
<span class="card__date">{{ card.date }}</span>
<img class="card__image" src="{{ card.image }}" alt="{{ card.image_alt }}">
<span class="card__field-title">{{ card.fields.title }}</span>
<span class="card__field-description">{{ card.fields.description }}</span>
<span class="card__field-image">{{ card.fields.image.url }}</span>
<span class="card__field-published">{{ card.fields.published_at }}</span>
<span class="card__field-rank">{{ card.fields.rank }}</span>
</li>
{% endfor %}
</section>`;

/** Container block: renders its children, so nesting is visible in HTML. */
const CONTAINER_BLOCK_TEMPLATE = `<div class="container" data-block="{{ block.id }}">{{ children }}</div>`;

async function feedFixture(t: import("node:test").TestContext, onQuery?: (sql: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pcms-feed-anywhere-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = join(root, "themes", "reference-theme-v1");
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });
  const manifestPath = join(themeDir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.cms_compatibility = ">=1.0.0-rc.1 <2.0.0";
  // One card preset keeps the fixture's derivative generation cheap.
  manifest.media_presets = [
    { id: "card", width: 32, fit: "cover", formats: ["webp"], quality: 70 },
  ];
  manifest.collections = {
    news_all: { content_types: ["news"], page_size: 20, templates: ["feed_page"], section: "site" },
    news_subtree: { content_types: ["news"], section: "subtree" },
    news_rank: {
      content_types: ["news"],
      page_size: 20,
      section: "site",
      order: { by: "field", field: "rank", direction: "asc" },
    },
    news_bad_order: {
      content_types: ["news"],
      section: "site",
      order: { by: "field", field: "teaser", direction: "asc" },
    },
    cards_all: { content_types: ["news", "page"], page_size: 20, section: "site" },
  };
  manifest.block_renderers = [
    ...(manifest.block_renderers as unknown[]).filter(
      (renderer) => (renderer as { block?: string }).block !== "related_content@1",
    ),
    { block: "related_content@1", file: "blocks/related_content.liquid" },
    { block: "test_container@1", file: "blocks/test-container.liquid" },
  ];
  manifest.templates = [
    ...(manifest.templates as unknown[]),
    {
      id: "feed_page",
      file: "templates/feed_page.liquid",
      accepts_content_types: ["page@1"],
      required_fields: ["title"],
    },
    {
      id: "plain_page",
      file: "templates/plain_page.liquid",
      accepts_content_types: ["page@1"],
      required_fields: ["title"],
    },
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(themeDir, "templates", "feed_page.liquid"), FEED_TEMPLATE);
  writeFileSync(join(themeDir, "templates", "plain_page.liquid"), PLAIN_TEMPLATE);
  writeFileSync(join(themeDir, "blocks", "related_content.liquid"), RELATED_BLOCK_TEMPLATE);
  writeFileSync(join(themeDir, "blocks", "test-container.liquid"), CONTAINER_BLOCK_TEMPLATE);

  const { app, pool } = await rollbackApiFixture(
    t,
    {
      themeDir,
      mediaPresets: manifest.media_presets as readonly unknown[],
      contentTypeDefinitions: DEFINITIONS as never,
      seoEnvironment: "production",
      mediaStorage: new LocalMediaStorage({ root: join(root, "media") }),
      mediaQuarantine: new LocalMediaStorage({ root: join(root, "quarantine") }),
    },
    onQuery === undefined ? undefined : { onQuery },
  );
  const ctx = apiContextOf(ownerActor("feed-anywhere"));
  const site = await app.routes.ensureSite("default");
  return { app, pool, ctx, site, themeDir };
}

function richText(text: string): unknown {
  return {
    schema_version: 2,
    type: "document",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/**
 * Counts every SQL statement the application actually issues: the pool's own
 * query plus any client handed to withClient/withTransaction. Each client is
 * wrapped once, so a nested wrapper cannot double-count.
 */
function countSqlPort(pool: object) {
  const target = pool as unknown as Record<string, unknown>;
  const original = {
    query: target.query as (sql: string, params?: readonly unknown[]) => Promise<unknown>,
    withClient: target.withClient as (
      work: (client: unknown) => Promise<unknown>,
    ) => Promise<unknown>,
    withTransaction: target.withTransaction as (
      work: (client: unknown) => Promise<unknown>,
    ) => Promise<unknown>,
  };
  // original client → its ONE wrapper. A pool that hands the same client back
  // (the rollback fixture does) must keep getting the counting wrapper, not
  // the raw original.
  const wrappers = new WeakMap<object, object>();
  const state = { count: 0 };
  const wrapClient = <T extends object>(client: T): T => {
    const existing = wrappers.get(client);
    if (existing !== undefined) return existing as T;
    const query = (
      client as { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> }
    ).query;
    const wrapper = Object.assign(Object.create(client as object) as T, {
      query: (sql: string, params?: readonly unknown[]) => {
        state.count += 1;
        return query.call(client, sql, params);
      },
    });
    wrappers.set(client, wrapper);
    return wrapper;
  };
  target.query = (sql: string, params?: readonly unknown[]) => {
    state.count += 1;
    return original.query(sql, params);
  };
  target.withClient = (work: (client: unknown) => Promise<unknown>) =>
    original.withClient((client) => work(wrapClient(client as object)));
  target.withTransaction = (work: (client: unknown) => Promise<unknown>) =>
    original.withTransaction((client) => work(wrapClient(client as object)));
  return {
    get count() {
      return state.count;
    },
    reset() {
      state.count = 0;
    },
    restore() {
      target.query = original.query;
      target.withClient = original.withClient;
      target.withTransaction = original.withTransaction;
    },
  };
}

test("G1.1: the SQL counter keeps counting a REUSED client and never double-counts", async () => {
  // The rollback fixture hands the same client to every withClient/
  // withTransaction call; a WeakSet-based wrapper returned the raw original
  // on the second call and silently stopped counting.
  let actual = 0;
  const reused = {
    async query() {
      actual += 1;
      return { rows: [], rowCount: 0 };
    },
  };
  const pool = {
    async query() {
      actual += 1;
      return { rows: [], rowCount: 0 };
    },
    async withClient<T>(work: (client: typeof reused) => Promise<T>): Promise<T> {
      return work(reused);
    },
    async withTransaction<T>(work: (client: typeof reused) => Promise<T>): Promise<T> {
      return work(reused);
    },
  };
  const counter = countSqlPort(pool);
  const observed: number[] = [];
  await pool.withTransaction((client) => client.query());
  observed.push(counter.count);
  await pool.withTransaction((client) => client.query());
  observed.push(counter.count);
  await pool.withClient((client) => client.query());
  observed.push(counter.count);
  // Warmup, then reset: counting continues at the same client.
  await pool.withTransaction((client) => client.query());
  counter.reset();
  await pool.withTransaction((client) => client.query());
  observed.push(counter.count);
  counter.restore();
  assert.deepEqual(observed, [1, 2, 3, 1], "a reused client keeps being counted");
  assert.equal(actual, 5, "each statement is counted exactly once");
  assert.equal(counter.count, 1, "reset only clears the counter, not the wrapper");
});

type Fixture = Awaited<ReturnType<typeof feedFixture>>;

/** Publishes one entry with a canonical route; returns its entry id. */
async function publishEntry(
  fixture: Fixture,
  input: {
    readonly key: string;
    readonly contentType: "news" | "page";
    readonly fields: Record<string, unknown>;
    readonly blocks?: unknown[];
    readonly template?: string;
    readonly parent?: string;
  },
): Promise<string> {
  const { app, ctx, site } = fixture;
  const draft = await createDraft(app, ctx, {
    content_type: input.contentType,
    payload: {
      fields: input.fields,
      blocks: { schema_version: 1, blocks: input.blocks ?? [] },
    },
  });
  if (input.template !== undefined) {
    await setEntryTemplateOp(app, ctx, { entry_id: draft.entry_id, template_key: input.template });
  }
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: `/${input.key}/`,
    targetType: "entry",
    targetId: draft.entry_id,
  });
  if (input.parent !== undefined) {
    await moveEntryOp(app, ctx, { entry_id: draft.entry_id, parent_entry_id: input.parent });
  }
  return draft.entry_id;
}

const blockId = (suffix: string) => `01980000-0000-7000-8000-0000000000${suffix}`;

function relatedBlock(props: Record<string, unknown>, suffix: string): Record<string, unknown> {
  return {
    id: blockId(suffix),
    type: "related_content",
    schema_version: 1,
    variant: null,
    props,
    children: [],
  };
}

/** Card entry ids in the order the related renderer emitted them. */
function relatedCardIds(html: string, blockSuffix: string): string[] {
  const start = html.indexOf(`data-block="01980000-0000-7000-8000-0000000000${blockSuffix}"`);
  if (start < 0) return [];
  const section = html.slice(start);
  const end = section.indexOf("</section>");
  return [...section.slice(0, end).matchAll(/data-entry-id="([0-9a-f-]+)"/g)].map(
    (match) => match[1]!,
  );
}

test("feed options: structural schema accepts new keys and rejects bad shapes", async () => {
  const { createBlockRegistry } = await import("@pcms/blocks");
  const { validateBlockDocument } = await import("@pcms/blocks");
  const { validateThemeManifest } = await import("@pcms/themes");
  const blocks = createBlockRegistry();
  registerFirstPartyBlocksV1(blocks);
  const doc = (props: Record<string, unknown>) => ({
    schema_version: 1,
    blocks: [
      {
        id: "01980000-0000-7000-8000-000000000001",
        type: "related_content",
        schema_version: 1,
        variant: null,
        props,
        children: [],
      },
    ],
  });
  // Historical block stays valid.
  assert.equal(validateBlockDocument(doc({ mode: "manual", entry_ids: [] }), blocks).ok, true);
  // Every new option, at its bounds.
  const full = validateBlockDocument(
    doc({
      mode: "collection",
      collection_key: "news_all",
      scope: "subtree",
      content_types: ["news"],
      fields: ["rank", "hero_image"],
      image_preset: "card",
      image_field: "hero_image",
      exclude_entry_ids: ["01980000-0000-7000-8000-000000000002"],
      order: { by: "field", field: "rank", direction: "asc" },
    }),
    blocks,
  );
  assert.equal(full.ok, true);
  // Structural rejections.
  for (const props of [
    { mode: "collection", collection_key: "news_all", scope: "everything" },
    { mode: "collection", collection_key: "news_all", order: { by: "field" } },
    { mode: "collection", collection_key: "news_all", order: { by: "rank" } },
    { mode: "collection", collection_key: "news_all", content_types: [] },
    { mode: "collection", collection_key: "news_all", fields: ["../etc/passwd"] },
    { mode: "manual", entry_ids: [], exclude_entry_ids: ["not-an-id"] },
  ]) {
    assert.equal(validateBlockDocument(doc(props), blocks).ok, false, JSON.stringify(props));
  }
  // Theme binding: section + order are additive and strictly typed.
  const base = JSON.parse(readFileSync("themes/reference-theme-v1/theme.json", "utf8")) as Record<
    string,
    unknown
  >;
  const withBinding = (collection: Record<string, unknown>) =>
    validateThemeManifest({
      ...base,
      collections: { news: { content_types: ["news"], ...collection } },
    }).ok;
  assert.equal(withBinding({}), true);
  assert.equal(withBinding({ section: "subtree" }), true);
  assert.equal(
    withBinding({ section: "site", order: { by: "published_at", direction: "asc" } }),
    true,
  );
  assert.equal(withBinding({ section: "everything" }), false);
  assert.equal(withBinding({ order: { by: "field" } }), false);
  assert.equal(withBinding({ order: { by: "field", field: "rank" }, extra: 1 }), false);
});

test("card projection: aliases, 0/false, rich text, media lists and unknown presets", async () => {
  const { buildFeedCards } = await import("../../apps/web/src/feed-cards.js");
  const { createBlockRegistry } = await import("@pcms/blocks");
  const blocksRegistry = () => {
    const registry = createBlockRegistry();
    registerFirstPartyBlocksV1(registry);
    return registry;
  };
  const asset = (id: string, alt: string) => ({
    id,
    kind: "image",
    alt,
    caption: null,
    width: 32,
    height: 24,
    derivatives: [
      { preset: "card", url: `/media/${id}.webp`, width: 32, height: 24, mime: "image/webp" },
    ],
    download: null,
  });
  const mediaA = "01980000-0000-7000-8000-0000000000a1";
  const mediaB = "01980000-0000-7000-8000-0000000000a2";
  const missing = "01980000-0000-7000-8000-0000000000a3";
  const type = {
    key: "news",
    version: 1,
    title: "News",
    bodyPolicy: "rich_text",
    defaultTemplateHint: undefined,
    fieldSchema: {
      id: "root",
      type: "object",
      fields: {
        title: { id: "title", type: "string" },
        teaser: { id: "teaser", type: "rich_text" },
        body: { id: "body", type: "rich_text" },
        tags: { id: "tags", type: "list", item: { id: "tag", type: "string" } },
        rank: { id: "rank", type: "integer" },
        featured: { id: "featured", type: "boolean" },
        hero_image: { id: "hero_image", type: "media" },
        gallery: { id: "gallery", type: "media_list" },
        meta: {
          id: "meta",
          type: "object",
          fields: { note: { id: "note", type: "string" }, cover: { id: "cover", type: "media" } },
        },
      },
    },
  };
  const rows = [
    {
      entry_id: "01980000-0000-7000-8000-0000000000b1",
      content_type: "news",
      published_at: "2026-05-01T00:00:00.000Z",
      fields: {
        title: "Card title",
        teaser: richText("Teaser text"),
        body: richText("B".repeat(900)),
        tags: ["alpha", 7],
        rank: 0,
        featured: false,
        hero_image: mediaA,
        gallery: [mediaA, missing],
        meta: { note: "inner", cover: mediaB, extra: "dropped" },
      },
      blocks: undefined,
      route_path: "/card/",
      route_locale: "x-default",
    },
  ];
  const cards = await buildFeedCards(
    rows,
    {
      fields: [
        "rank",
        "featured",
        "unknown_field",
        "title",
        "description",
        "image",
        "published_at",
        "body",
        "gallery",
        "meta",
      ],
      imageField: "hero_image",
      imagePreset: "card",
      tagField: "tags",
    },
    {
      blocks: createBlockRegistry(),
      contentType: (key) => (key === "news" ? (type as never) : null),
      assets: async () => ({
        [mediaA]: asset(mediaA, "Asset A"),
        [mediaB]: asset(mediaB, "Asset B"),
        [missing]: null,
      }),
      presets: [{ id: "card", width: 32 }],
    },
  );
  const card = cards[0]!;
  assert.equal(card.description, "Teaser text");
  assert.deepEqual(card.tags, ["alpha"]);
  assert.equal(card.image, `/media/${mediaA}.webp`);
  assert.equal(card.image_alt, "Asset A");
  assert.equal(card.fields.rank, 0, "zero is a value, not an absence");
  assert.equal(card.fields.featured, false, "false is a value, not an absence");
  assert.ok(!("unknown_field" in card.fields));
  assert.equal(card.fields.title, "Card title");
  assert.equal(card.fields.description, "Teaser text");
  // Alias vs content field of the same name: the alias owns its documented
  // meaning inside card.fields (the stored field and legacy date are intact).
  assert.equal(card.fields.published_at, "2026-05-01T00:00:00.000Z");
  assert.equal((card.fields.image as { url: string }).url, `/media/${mediaA}.webp`);
  assert.equal((card.fields.body as string).length, 500, "rich text is plain and bounded");
  // media_list keeps declared order; a missing derivative stays a null slot.
  const gallery = card.fields.gallery as ({ media_id: string } | null)[];
  assert.equal(gallery.length, 2);
  assert.equal(gallery[0]?.media_id, mediaA);
  assert.equal(gallery[1], null);
  assert.deepEqual(Object.keys(card.fields.meta as object).sort(), ["cover", "note"]);
  // An unknown preset at render time degrades to no image, never a fallback.
  const noPreset = await buildFeedCards(
    rows,
    { fields: [], imageField: "hero_image", imagePreset: "gone", tagField: "tags" },
    {
      blocks: createBlockRegistry(),
      contentType: (key) => (key === "news" ? (type as never) : null),
      assets: async () => ({ [mediaA]: asset(mediaA, "Asset A") }),
      presets: [],
    },
  );
  assert.equal(noPreset[0]!.image, null);
  assert.equal(noPreset[0]!.fields.image, undefined);
  // A published payload may carry no `fields` object at all — never a throw.
  const emptyFields = await buildFeedCards(
    [{ ...rows[0]!, fields: null as never }],
    { fields: ["rank"], imageField: "hero_image", imagePreset: "card", tagField: "tags" },
    {
      blocks: createBlockRegistry(),
      contentType: (key) => (key === "news" ? (type as never) : null),
      assets: async () => ({}),
      presets: [{ id: "card", width: 32 }],
    },
  );
  assert.equal(emptyFields[0]!.title, rows[0]!.entry_id);
  assert.deepEqual(emptyFields[0]!.tags, []);

  // A content field literally named published_at never overrides the alias.
  const collided = await buildFeedCards(
    [
      {
        ...rows[0]!,
        fields: { ...rows[0]!.fields, published_at: "2000-01-01T00:00:00.000Z" },
      },
    ],
    { fields: ["published_at"], imageField: "hero_image", imagePreset: "card", tagField: "tags" },
    {
      blocks: createBlockRegistry(),
      contentType: (key) => (key === "news" ? (type as never) : null),
      assets: async () => ({}),
      presets: [{ id: "card", width: 32 }],
    },
  );
  assert.equal(collided[0]!.fields.published_at, "2026-05-01T00:00:00.000Z");

  // No hero, but a document image block: the image alias uses the SAME
  // candidate as the top-level card image (fallback included).
  const fallback = await buildFeedCards(
    [
      {
        ...rows[0]!,
        fields: { ...rows[0]!.fields, hero_image: null },
        blocks: {
          schema_version: 1,
          blocks: [
            {
              id: "01980000-0000-7000-8000-0000000000e1",
              type: "image",
              schema_version: 1,
              variant: null,
              props: { media_id: mediaB, alt_override: "Block alt" },
              children: [],
            },
          ],
        },
      },
    ],
    { fields: ["image"], imageField: "hero_image", imagePreset: "card", tagField: "tags" },
    {
      blocks: blocksRegistry(),
      contentType: (key) => (key === "news" ? (type as never) : null),
      assets: async () => ({ [mediaB]: asset(mediaB, "Asset B") }),
      presets: [{ id: "card", width: 32 }],
    },
  );
  assert.equal(fallback[0]!.image, `/media/${mediaB}.webp`);
  assert.equal(fallback[0]!.image_alt, "Block alt");
  const fallbackAlias = fallback[0]!.fields.image as { url: string; alt: string };
  assert.equal(fallbackAlias.url, `/media/${mediaB}.webp`);
  assert.equal(
    fallbackAlias.alt,
    "Block alt",
    "the alias model carries the usage alt, not the asset default",
  );

  // An empty override is decorative and stays empty in both surfaces.
  const decorative = await buildFeedCards(
    [
      {
        ...rows[0]!,
        fields: { ...rows[0]!.fields, hero_image: null },
        blocks: {
          schema_version: 1,
          blocks: [
            {
              id: "01980000-0000-7000-8000-0000000000e3",
              type: "image",
              schema_version: 1,
              variant: null,
              props: { media_id: mediaB, alt_override: "" },
              children: [],
            },
          ],
        },
      },
    ],
    { fields: ["image"], imageField: "hero_image", imagePreset: "card", tagField: "tags" },
    {
      blocks: blocksRegistry(),
      contentType: (key) => (key === "news" ? (type as never) : null),
      assets: async () => ({ [mediaB]: asset(mediaB, "Asset B") }),
      presets: [{ id: "card", width: 32 }],
    },
  );
  assert.equal(decorative[0]!.image_alt, "");
  assert.equal((decorative[0]!.fields.image as { alt: string }).alt, "");

  // Two cards over the SAME asset with different overrides stay independent.
  const shared = await buildFeedCards(
    [
      {
        ...rows[0]!,
        fields: { ...rows[0]!.fields, hero_image: null },
        blocks: {
          schema_version: 1,
          blocks: [
            {
              id: "01980000-0000-7000-8000-0000000000e4",
              type: "image",
              schema_version: 1,
              variant: null,
              props: { media_id: mediaB, alt_override: "First" },
              children: [],
            },
          ],
        },
      },
      {
        ...rows[0]!,
        entry_id: "01980000-0000-7000-8000-0000000000b2",
        fields: { ...rows[0]!.fields, hero_image: null },
        blocks: {
          schema_version: 1,
          blocks: [
            {
              id: "01980000-0000-7000-8000-0000000000e5",
              type: "image",
              schema_version: 1,
              variant: null,
              props: { media_id: mediaB, alt_override: "Second" },
              children: [],
            },
          ],
        },
      },
    ],
    { fields: ["image"], imageField: "hero_image", imagePreset: "card", tagField: "tags" },
    {
      blocks: blocksRegistry(),
      contentType: (key) => (key === "news" ? (type as never) : null),
      assets: async () => ({ [mediaB]: asset(mediaB, "Asset B") }),
      presets: [{ id: "card", width: 32 }],
    },
  );
  assert.deepEqual(
    shared.map((card) => (card.fields.image as { alt: string }).alt),
    ["First", "Second"],
  );
  assert.deepEqual(
    shared.map((card) => card.image_alt),
    ["First", "Second"],
  );

  // An explicitly different image_field is never replaced by a document image.
  const explicit = await buildFeedCards(
    [
      {
        ...rows[0]!,
        fields: { ...rows[0]!.fields, hero_image: mediaA, gallery: [mediaB] },
        blocks: {
          schema_version: 1,
          blocks: [
            {
              id: "01980000-0000-7000-8000-0000000000e2",
              type: "image",
              schema_version: 1,
              variant: null,
              props: { media_id: mediaB },
              children: [],
            },
          ],
        },
      },
    ],
    { fields: ["image"], imageField: "gallery", imagePreset: "card", tagField: "tags" },
    {
      blocks: blocksRegistry(),
      contentType: (key) => (key === "news" ? (type as never) : null),
      assets: async () => ({
        [mediaA]: asset(mediaA, "Asset A"),
        [mediaB]: asset(mediaB, "Asset B"),
      }),
      presets: [{ id: "card", width: 32 }],
    },
  );
  assert.equal(explicit[0]!.image, null, "a media_list field is not a single image");
});

test("feed source: section/subtree/site scope, ordering, exclusions and archive cut", {
  skip,
}, async (t) => {
  const { app, ctx, site } = await feedFixture(t);
  const deps = {
    pool: app.pool,
    isKnownContentType: (key: string) => app.contentTypes.getLatestContentType(key) !== null,
  };
  const published: Record<string, string> = {};
  async function publishNews(
    key: string,
    fields: Record<string, unknown>,
    parent?: string,
  ): Promise<string> {
    const draft = await createDraft(app, ctx, {
      content_type: "news",
      payload: { fields: { title: key, teaser: `teaser ${key}`, ...fields } },
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
      path: `/${key}/`,
      targetType: "entry",
      targetId: draft.entry_id,
    });
    if (parent !== undefined)
      await moveEntryOp(app, ctx, { entry_id: draft.entry_id, parent_entry_id: parent });
    published[key] = draft.entry_id;
    return draft.entry_id;
  }
  const sectionId = (
    await createDraft(app, ctx, {
      content_type: "page",
      payload: { fields: { title: "Section" }, blocks: { schema_version: 1, blocks: [] } },
    })
  ).entry_id;
  const sectionDraft = await app.pool.query<{ id: string }>(
    "SELECT id FROM revisions WHERE entity_id = $1",
    [sectionId],
  );
  await sealRevision(app, ctx, { revision_id: sectionDraft.rows[0]!.id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: sectionId,
    target_revision_id: sectionDraft.rows[0]!.id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/section/",
    targetType: "entry",
    targetId: sectionId,
  });

  await publishNews("rank-five", { rank: 5 }, sectionId);
  await publishNews("rank-one", { rank: 1 }, sectionId);
  await publishNews("no-rank", {}, sectionId);
  const malformed = await publishNews("rank-malformed", { rank: 4 }, sectionId);
  // Historical malformed JSON: a published revision whose sort value is a
  // string (SEALED rows are immutable, so the row is inserted as history).
  const malformedRevision = "01980000-0000-7000-8000-0000000000ff";
  await app.pool.query(
    `INSERT INTO revisions (id, entity_type, entity_id, revision_no, parent_revision_id, state,
       payload, schema_version, locale, origin, created_by_type, created_by, sealed_at,
       edit_generation, payload_hash)
     SELECT $2::uuid, entity_type, entity_id, revision_no + 1, id, state,
       jsonb_set(payload, '{fields,rank}', '"oops"'), schema_version, locale, origin,
       created_by_type, created_by, sealed_at, edit_generation, payload_hash
     FROM revisions WHERE id = (SELECT current_revision_id FROM publications WHERE entity_id = $1)`,
    [malformed, malformedRevision],
  );
  await app.pool.query(
    "UPDATE publications SET current_revision_id = $2::uuid WHERE entity_id = $1",
    [malformed, malformedRevision],
  );
  await publishNews("rank-zero", { rank: 0 }, sectionId);
  await publishNews("rank-negative", { rank: -3 }, sectionId);
  const deep = await publishNews("deep-child", { rank: 9 }, published["rank-five"]!);
  // Archived branch: the parent is archived, its published child must vanish.
  const archivedParent = await publishNews("archived-parent", {}, sectionId);
  await publishNews("archived-child", {}, archivedParent);
  await archiveEntry(app, ctx, { entry_id: archivedParent });
  const foreign = await publishNews("foreign", { rank: 7 });

  const ids = (result: { items: readonly { entry_id: string }[] }) =>
    result.items.map((item) => item.entry_id);
  const base = {
    context: "default",
    contentTypes: ["news"],
    tagField: "tags",
    tag: null,
    page: 1,
    pageSize: 100,
    siteId: site.id,
  } as const;

  const section = await queryCollectionFeed(deps, { ...base, sectionEntryId: sectionId });
  assert.deepEqual(
    ids(section).sort(),
    [
      published["no-rank"]!,
      published["rank-five"]!,
      published["rank-malformed"]!,
      published["rank-negative"]!,
      published["rank-one"]!,
      published["rank-zero"]!,
    ].sort(),
  );
  // Default order: published_at DESC (creation order) with entry_id ties.
  assert.deepEqual(ids(section), [
    published["rank-negative"]!,
    published["rank-zero"]!,
    published["rank-malformed"]!,
    published["no-rank"]!,
    published["rank-one"]!,
    published["rank-five"]!,
  ]);

  const subtree = await queryCollectionFeed(deps, {
    ...base,
    sectionEntryId: sectionId,
    scope: "subtree",
  });
  assert.equal(subtree.total, 7, "subtree adds the deeper descendant only");
  assert.ok(ids(subtree).includes(deep));
  assert.ok(!ids(subtree).includes(published["archived-child"]!));
  assert.ok(!ids(subtree).includes(archivedParent));

  const siteWide = await queryCollectionFeed(deps, {
    ...base,
    sectionEntryId: null,
    scope: "site",
  });
  // "site" has no tree filter: a published entry whose parent was archived is
  // still its own published page, while the archived node itself never is.
  assert.equal(siteWide.total, 9, "site scope spans the whole site, archive still excluded");
  assert.ok(ids(siteWide).includes(foreign));
  assert.ok(ids(siteWide).includes(published["archived-child"]!));
  assert.ok(!ids(siteWide).includes(archivedParent));

  const ascending = await queryCollectionFeed(deps, {
    ...base,
    sectionEntryId: sectionId,
    order: { by: "field", field: "rank", direction: "asc" },
  });
  assert.deepEqual(
    ids(ascending),
    [
      published["rank-negative"]!,
      published["rank-zero"]!,
      published["rank-one"]!,
      published["rank-five"]!,
      published["no-rank"]!,
      published["rank-malformed"]!,
    ],
    "integer asc, missing and malformed values last, entry_id tie-break",
  );

  const descending = await queryCollectionFeed(deps, {
    ...base,
    sectionEntryId: sectionId,
    order: { by: "field", field: "rank", direction: "desc" },
  });
  assert.deepEqual(ids(descending).slice(0, 4), [
    published["rank-five"]!,
    published["rank-one"]!,
    published["rank-zero"]!,
    published["rank-negative"]!,
  ]);

  const excluded = await queryCollectionFeed(deps, {
    ...base,
    sectionEntryId: sectionId,
    excludeEntryIds: [published["rank-one"]!],
  });
  assert.equal(excluded.total, 5, "exclusions apply before counting");
  assert.ok(!ids(excluded).includes(published["rank-one"]!));

  // Offset paging over fixed data: pages never overlap.
  const firstPage = await queryCollectionFeed(deps, {
    ...base,
    sectionEntryId: sectionId,
    pageSize: 2,
  });
  const secondPage = await queryCollectionFeed(deps, {
    ...base,
    sectionEntryId: sectionId,
    pageSize: 2,
    page: 2,
  });
  assert.equal(firstPage.pageCount, 3);
  assert.equal(ids(firstPage).filter((id) => ids(secondPage).includes(id)).length, 0);

  // A historical cycle must terminate (UNION dedup) and never return the root.
  await app.pool.query("UPDATE entries SET parent_entry_id = $2 WHERE id = $1", [
    published["rank-five"]!,
    deep,
  ]);
  const cyclic = await queryCollectionFeed(deps, {
    ...base,
    sectionEntryId: sectionId,
    scope: "subtree",
  });
  // A parent cycle in historical data terminates (UNION, not UNION ALL) and
  // yields only what is still reachable from the root — never the root itself.
  assert.ok(!ids(cyclic).includes(sectionId), "the subtree root is never a member");
  assert.equal(cyclic.total, 5, "the cycled branch leaves the root's subtree");
  assert.ok(!ids(cyclic).includes(deep));

  // Locale isolation: the same scopes never widen when a translation is
  // missing — a context without publications yields nothing, not the default
  // locale's entries.
  const otherLocale = await queryCollectionFeed(deps, {
    ...base,
    context: "de-DE",
    sectionEntryId: null,
    scope: "site",
    excludeEntryIds: [published["rank-one"]!],
  });
  assert.equal(otherLocale.total, 0);
  assert.deepEqual(ids(otherLocale), []);

  // Explicit subtree without a root fails closed instead of widening to site.
  await assert.rejects(
    queryCollectionFeed(deps, { ...base, sectionEntryId: null, scope: "subtree" }),
    /subtree scope requires a section/,
  );
});

test("feed cards: projection, batching and the REST contract", { skip }, async (t) => {
  const { app, ctx, site } = await feedFixture(t);
  const image = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  const assets: string[] = [];
  for (let index = 0; index < 20; index++) {
    const accepted = await uploadMediaOp(app, ctx, {
      bytes: image,
      filename: `card-${index}.jpg`,
    });
    assets.push(accepted.asset.id);
  }
  async function publish(key: string, index: number, parent?: string): Promise<string> {
    const draft = await createDraft(app, ctx, {
      content_type: "news",
      payload: {
        fields: {
          title: key,
          teaser: `teaser ${key}`,
          published_at: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
          rank: index,
          hero_image: assets[index],
        },
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
      path: `/${key}/`,
      targetType: "entry",
      targetId: draft.entry_id,
    });
    if (parent !== undefined)
      await moveEntryOp(app, ctx, { entry_id: draft.entry_id, parent_entry_id: parent });
    return draft.entry_id;
  }
  const pageDraft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Feed" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await setEntryTemplateOp(app, ctx, { entry_id: pageDraft.entry_id, template_key: "feed_page" });
  await sealRevision(app, ctx, { revision_id: pageDraft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: pageDraft.entry_id,
    target_revision_id: pageDraft.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/feed/",
    targetType: "entry",
    targetId: pageDraft.entry_id,
  });
  const plainDraft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Plain" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await setEntryTemplateOp(app, ctx, { entry_id: plainDraft.entry_id, template_key: "plain_page" });
  await sealRevision(app, ctx, { revision_id: plainDraft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: plainDraft.entry_id,
    target_revision_id: plainDraft.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/plain/",
    targetType: "entry",
    targetId: plainDraft.entry_id,
  });
  const publishedIds: string[] = [];
  for (let index = 0; index < 20; index++) {
    publishedIds.push(await publish(`news-${String(index).padStart(2, "0")}`, index));
  }
  // Archived asset must not appear on a card even though the entry is live.
  const archivedAsset = assets[3]!;
  await app.pool.query("UPDATE media_assets SET archived_at = now() WHERE id = $1", [
    archivedAsset,
  ]);

  const fastify = createApiFastify(() => "req_feed_anywhere");
  const routes: ApiRoute[] = [...makeCollectionsRoutes()];
  await fastify.register(createApiV1(routes), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    cookieSecure: false,
  });
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });

  // --- statement counting at the SQL port the production code uses ---
  // Counting only pool.query would miss every client.query inside
  // withClient/withTransaction; the wrapper therefore sits on all three entry
  // points and on the client handed to the callback.
  const counter = countSqlPort(app.pool);
  // Warm both routes first: per-request caches (site, localization, theme
  // state) would otherwise make the FIRST request look more expensive.
  await fastify.inject({ method: "GET", url: "/plain/" });
  await fastify.inject({ method: "GET", url: "/feed/" });
  counter.reset();
  const plain = await fastify.inject({ method: "GET", url: "/plain/" });
  const baseline = counter.count;
  counter.reset();
  const page = await fastify.inject({ method: "GET", url: "/feed/" });
  const feedStatements = counter.count;
  assert.equal(plain.statusCode, 200);
  assert.equal(page.statusCode, 200);
  assert.ok(baseline > 0 && feedStatements > baseline, "the counter sees real statements");
  assert.ok(
    feedStatements - baseline <= 5,
    `feed page issued ${feedStatements} statements vs ${baseline} baseline`,
  );
  // Measured numbers for the handoff (deterministic: same fixture, same pages).
  assert.equal(baseline, 44, "baseline page statements");
  assert.equal(feedStatements, 48, "page with a 20-card feed");

  // --- projection: description, aliases, image preset, tags ---
  const cards = [...page.body.matchAll(/data-entry-id="([0-9a-f-]+)"/g)].map((match) => match[1]!);
  assert.equal(cards.length, 20);
  assert.match(page.body, /card__description">teaser news-19</);
  assert.match(page.body, /card__teaser">teaser news-19</);
  assert.match(page.body, /card__date">\d{4}-\d{2}-\d{2}T/);
  assert.match(page.body, /class="card__image" src="\/media\/a\//);
  assert.match(page.body, /class="feed__total">20</);
  // The archived asset's card keeps its text but loses the image.
  const archivedCard = page.body.slice(
    page.body.indexOf(`data-entry-id="${publishedIds[3]!}"`),
    page.body.indexOf("</article>", page.body.indexOf(`data-entry-id="${publishedIds[3]!}"`)),
  );
  assert.match(archivedCard, /news-03/);
  assert.match(archivedCard, /class="card__image" src=""/);

  // --- REST keeps its response shape and honours the binding order ---
  const rest = await fastify.inject({ method: "GET", url: "/api/v1/collections/news_rank/items" });
  assert.equal(rest.statusCode, 200);
  const body = rest.json() as {
    total: number;
    items: { entry_id: string; teaser: string | null; image_asset_id: string | null }[];
  };
  assert.equal(body.total, 20);
  assert.equal(body.items[0]!.entry_id, publishedIds[0]);
  assert.equal(body.items[0]!.teaser, "teaser news-00");
  assert.ok(body.items[0]!.image_asset_id);
  assert.deepEqual(Object.keys(rest.json() as Record<string, unknown>).sort(), [
    "collection",
    "has_next",
    "has_prev",
    "items",
    "page",
    "page_count",
    "page_size",
    "tag",
    "tags",
    "total",
  ]);
  // A foreign-site route never enters the response. The entry below has NO
  // default-site route at all, so it disappears exactly because of the site
  // predicate (the previous fixture's entry already had a home route and
  // proved nothing: LATERAL LIMIT 1 would pick that one anyway).
  const other = await app.routes.ensureSite("other");
  const foreignOnly = await createDraft(app, ctx, {
    content_type: "news",
    payload: { fields: { title: "foreign only", rank: 99 } },
  });
  await sealRevision(app, ctx, { revision_id: foreignOnly.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: foreignOnly.entry_id,
    target_revision_id: foreignOnly.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: other.id,
    path: "/foreign-only/",
    targetType: "entry",
    targetId: foreignOnly.entry_id,
  });
  const afterForeign = await fastify.inject({
    method: "GET",
    url: "/api/v1/collections/news_rank/items",
  });
  const foreignBody = afterForeign.json() as { total: number; items: { entry_id: string }[] };
  assert.equal(foreignBody.total, 20, "a foreign-site-only entry is not published here");
  assert.ok(!foreignBody.items.some((item) => item.entry_id === foreignOnly.entry_id));

  // 20 cards reference 20 distinct assets — the batch is not re-reading one.
  assert.equal(new Set(assets).size, 20);
  assert.equal(
    new Set(
      [...page.body.matchAll(/class="card__image" src="\/media\/a\/([0-9a-f-]+)\//g)].map(
        (match) => match[1],
      ),
    ).size,
    19,
    "19 live assets are rendered (one was archived)",
  );

  // Statement count is bounded by a constant, not by item count: the same
  // page with a single remaining item issues the same number of queries.
  await app.pool.query("UPDATE entries SET archived_at = now() WHERE id = ANY($1::uuid[])", [
    publishedIds.slice(1),
  ]);
  await fastify.inject({ method: "GET", url: "/feed/" });
  counter.reset();
  const single = await fastify.inject({ method: "GET", url: "/feed/" });
  const singleStatements = counter.count;
  assert.match(single.body, /class="feed__total">1</);
  assert.equal(singleStatements, feedStatements, "1 item and 20 items cost the same");
  counter.restore();
});

test("seal: feed options are validated once, with paths, and legacy blocks stay untouched", {
  skip,
}, async (t) => {
  const { app, ctx, themeDir } = await feedFixture(t);
  const containerId = "01980000-0000-7000-8000-0000000000aa";
  // A container that accepts children lets the walker prove nested coverage.
  app.blocks.registerBlockType({
    typeId: "test_container",
    schemaVersion: 1,
    propsSchema: { type: "object", additionalProperties: false, properties: {} },
    childrenPolicy: "blocks",
  });
  const block = (props: Record<string, unknown>, id: string, children: unknown[] = []) => ({
    id,
    type: "related_content",
    schema_version: 1,
    variant: null,
    props,
    children,
  });
  type FeedIssue = { code: string; path?: string | undefined };
  async function issuesFor(blocks: unknown[]): Promise<FeedIssue[]> {
    const draft = await createDraft(app, ctx, {
      content_type: "page",
      payload: { fields: { title: "Seal" }, blocks: { schema_version: 1, blocks } },
    });
    const validated = await validateRevision(app, ctx, { revision_id: draft.revision_id });
    const validationIssues: FeedIssue[] = (
      validated.issues as { code: string; path?: string | undefined }[]
    ).map((issue) => ({ code: issue.code, path: issue.path }));
    let sealIssues: FeedIssue[] = [];
    try {
      await sealRevision(app, ctx, { revision_id: draft.revision_id });
    } catch (error) {
      sealIssues = (
        (error as { details?: { issues?: { code: string; path?: string | undefined }[] } }).details
          ?.issues ?? []
      ).map((issue) => ({ code: issue.code, path: issue.path }));
    }
    assert.deepEqual(sealIssues, validationIssues, "validate and seal report the same issues");
    return validationIssues;
  }

  const unknownField = await issuesFor([
    block(
      { mode: "collection", collection_key: "news_all", fields: ["does_not_exist"] },
      containerId,
    ),
  ]);
  assert.deepEqual(unknownField, [
    { code: "RELATED_FIELD_UNKNOWN", path: "/blocks/blocks/0/props/fields/0" },
  ]);

  assert.deepEqual(
    (
      await issuesFor([
        block(
          { mode: "collection", collection_key: "news_all", image_preset: "nope" },
          containerId,
        ),
      ])
    ).map((issue) => issue.code),
    ["RELATED_PRESET_UNKNOWN"],
  );
  assert.deepEqual(
    (
      await issuesFor([
        block(
          { mode: "collection", collection_key: "news_all", image_field: "title" },
          containerId,
        ),
      ])
    ).map((issue) => issue.code),
    ["RELATED_IMAGE_FIELD_INVALID"],
  );
  assert.deepEqual(
    await issuesFor([
      block(
        {
          mode: "collection",
          collection_key: "news_all",
          order: { by: "field", field: "teaser" },
        },
        containerId,
      ),
    ]),
    [{ code: "RELATED_ORDER_FIELD_INVALID", path: "/blocks/blocks/0/props/order/field" }],
  );
  assert.deepEqual(
    (
      await issuesFor([
        block(
          {
            mode: "manual",
            entry_ids: ["01980000-0000-7000-8000-0000000000bb"],
            content_types: ["news"],
          },
          containerId,
        ),
      ])
    ).map((issue) => issue.code),
    ["BLOCK_PROPS_INVALID"],
  );
  assert.deepEqual(
    (
      await issuesFor([
        block(
          { mode: "collection", collection_key: "no_such_collection", scope: "site" },
          containerId,
        ),
      ])
    ).map((issue) => issue.code),
    ["COLLECTION_UNKNOWN"],
  );
  // Nested renderable block: same checks, deeper pointer.
  const nested = await issuesFor([
    {
      id: containerId,
      type: "test_container",
      schema_version: 1,
      variant: null,
      props: {},
      children: [
        block(
          { mode: "collection", collection_key: "news_all", fields: ["does_not_exist"] },
          "01980000-0000-7000-8000-0000000000cc",
        ),
      ],
    },
  ]);
  assert.deepEqual(nested, [
    { code: "RELATED_FIELD_UNKNOWN", path: "/blocks/blocks/0/children/0/props/fields/0" },
  ]);
  // The preset check does not depend on resolvable content types.
  assert.deepEqual(
    (
      await issuesFor([block({ mode: "manual", entry_ids: [], image_preset: "nope" }, containerId)])
    ).map((issue) => issue.code),
    ["RELATED_PRESET_UNKNOWN"],
  );
  // History is never re-judged: sealing with the current theme, then dropping
  // the preset from the theme, must not flag the SEALED revision.
  const sealedDraft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: { title: "Sealed" },
      blocks: {
        schema_version: 1,
        blocks: [
          block(
            { mode: "collection", collection_key: "news_all", image_preset: "card" },
            containerId,
          ),
        ],
      },
    },
  });
  await sealRevision(app, ctx, { revision_id: sealedDraft.revision_id });
  const manifestFile = join(themeDir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  writeFileSync(
    manifestFile,
    JSON.stringify(
      { ...manifest, media_presets: [{ id: "other", width: 32, formats: ["webp"] }] },
      null,
      2,
    ),
  );
  const sealedIssues = await validateRevision(app, ctx, { revision_id: sealedDraft.revision_id });
  assert.deepEqual(
    (sealedIssues.issues as { code: string }[]).map((issue) => issue.code),
    [],
    "a SEALED revision is not re-judged against the current theme",
  );

  // Legacy block: no new options, no new validation, seals cleanly.
  assert.deepEqual(
    await issuesFor([
      block({ mode: "manual", entry_ids: ["01980000-0000-7000-8000-0000000000bb"] }, containerId),
    ]),
    [],
  );
  // A removed pinned id never invalidates the block.
  assert.deepEqual(
    await issuesFor([
      block(
        { mode: "manual", entry_ids: ["01980000-0000-7000-8000-0000000000dd"], image_field: "x" },
        containerId,
      ),
    ]),
    [],
  );
});

test("R2: related blocks inherit the binding order and validate the effective one", {
  skip,
}, async (t) => {
  const fixture = await feedFixture(t);
  const { app, ctx, site } = fixture;
  // Published in ascending rank order: default (published_at DESC) is reversed.
  const low = await publishEntry(fixture, {
    key: "low",
    contentType: "news",
    fields: { title: "low", rank: 1 },
  });
  const mid = await publishEntry(fixture, {
    key: "mid",
    contentType: "news",
    fields: { title: "mid", rank: 2 },
  });
  const high = await publishEntry(fixture, {
    key: "high",
    contentType: "news",
    fields: { title: "high", rank: 3 },
  });
  await publishEntry(fixture, {
    key: "host",
    contentType: "page",
    template: "plain_page",
    fields: { title: "Host" },
    blocks: [
      // No props.order: the binding's rank asc must apply.
      relatedBlock(
        {
          mode: "collection",
          collection_key: "news_rank",
          scope: "site",
          limit: 3,
          title: "Inherit",
        },
        "f1",
      ),
      // Explicit block override wins over the binding.
      relatedBlock(
        {
          mode: "collection",
          collection_key: "news_rank",
          scope: "site",
          limit: 3,
          title: "Override",
          order: { by: "field", field: "rank", direction: "desc" },
        },
        "f2",
      ),
    ],
  });
  const fastify = createApiFastify(() => "req_feed_order");
  await fastify.register(createApiV1([...makeCollectionsRoutes()]), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    cookieSecure: false,
  });
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  const page = await fastify.inject({ method: "GET", url: "/host/" });
  assert.equal(page.statusCode, 200);
  assert.deepEqual(relatedCardIds(page.body, "f1"), [low, mid, high], "binding order is inherited");
  assert.deepEqual(relatedCardIds(page.body, "f2"), [high, mid, low], "block order overrides");

  // The EFFECTIVE order is validated: a binding that orders by a non-integer
  // field fails seal on the block that inherits it, at the collection ref.
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: { title: "Bad order" },
      blocks: {
        schema_version: 1,
        blocks: [
          relatedBlock(
            { mode: "collection", collection_key: "news_bad_order", scope: "site" },
            "f3",
          ),
        ],
      },
    },
  });
  const validated = await validateRevision(app, ctx, { revision_id: draft.revision_id });
  const issues = (validated.issues as { code: string; path?: string }[]).map((issue) => ({
    code: issue.code,
    path: issue.path,
  }));
  assert.deepEqual(issues, [
    {
      code: "RELATED_ORDER_FIELD_INVALID",
      path: "/blocks/blocks/0/props/collection_key",
    },
  ]);
  await assert.rejects(sealRevision(app, ctx, { revision_id: draft.revision_id }), (error) => {
    const details = (error as { details?: { issues?: { code: string }[] } }).details;
    assert.deepEqual(
      details?.issues?.map((issue) => issue.code),
      ["RELATED_ORDER_FIELD_INVALID"],
    );
    return true;
  });
  // REST and template collections already used the binding order: the same
  // declaration cannot yield two different orders for one key.
  const rest = await fastify.inject({ method: "GET", url: "/api/v1/collections/news_rank/items" });
  const restIds = (rest.json() as { items: { entry_id: string }[] }).items.map(
    (item) => item.entry_id,
  );
  assert.deepEqual(restIds.slice(0, 3), [low, mid, high]);
});

test("R3: projection aliases survive validate → seal → publish → render", { skip }, async (t) => {
  const fixture = await feedFixture(t);
  const { app, ctx } = fixture;
  const image = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 90, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  const accepted = await uploadMediaOp(app, ctx, { bytes: image, filename: "card.jpg" });

  // A news entry whose CONTENT field published_at differs from the publication
  // instant, and a page whose image only exists as a block reference.
  const newsId = await publishEntry(fixture, {
    key: "alias-news",
    contentType: "news",
    fields: {
      title: "Alias news",
      teaser: "Alias teaser",
      published_at: "2000-01-01T00:00:00.000Z",
      rank: 1,
    },
  });
  const pageId = await publishEntry(fixture, {
    key: "alias-page",
    contentType: "page",
    fields: { title: "Alias page", intro: "Page intro" },
    blocks: [
      {
        id: blockId("a1"),
        type: "image",
        schema_version: 1,
        variant: null,
        props: { media_id: accepted.asset.id, alt_override: "Block alt" },
        children: [],
      },
    ],
  });
  const hostId = await publishEntry(fixture, {
    key: "alias-host",
    contentType: "page",
    template: "plain_page",
    fields: { title: "Alias host" },
    blocks: [
      // Aliases are valid even though the content types declare no such
      // fields: validate/seal must accept this document.
      relatedBlock(
        {
          mode: "collection",
          collection_key: "cards_all",
          scope: "site",
          limit: 5,
          fields: ["title", "description", "image", "published_at"],
          exclude_entry_ids: [blockId("b0")],
          title: "Aliases",
        },
        "b1",
      ),
      // Pinned (manual) path: its rows come from a direct timestamptz read,
      // not from the collection JSON aggregation.
      relatedBlock(
        {
          mode: "manual",
          entry_ids: [newsId],
          fields: ["published_at"],
          title: "Pinned alias",
        },
        "b2",
      ),
    ],
  });
  const fastify = createApiFastify(() => "req_feed_alias");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  const page = await fastify.inject({ method: "GET", url: "/alias-host/" });
  assert.equal(page.statusCode, 200, "the document with alias fields seals and publishes");
  const ids = relatedCardIds(page.body, "b1");
  assert.equal(ids.length, 3, "news + page + host card");

  const cardOf = (entryId: string): string => {
    const start = page.body.indexOf(`data-entry-id="${entryId}"`);
    return page.body.slice(start, page.body.indexOf("</li>", start));
  };
  const newsCard = cardOf(newsId);
  // The alias is the Publication instant; the stored content field is intact.
  assert.match(newsCard, /card__field-published">\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(newsCard, /2000-01-01/);

  // Pinned cards read the timestamp directly: the alias must still be the ISO
  // Publication string (a Date object used to vanish as "blank").
  const pinnedIds = relatedCardIds(page.body, "b2");
  assert.deepEqual(pinnedIds, [newsId]);
  const pinnedCard = page.body.slice(
    page.body.indexOf(`data-block="01980000-0000-7000-8000-0000000000b2"`),
  );
  const pinnedAlias = /card__field-published">([^<]*)</.exec(pinnedCard)?.[1];
  assert.ok(pinnedAlias !== undefined && pinnedAlias !== "", "pinned alias is present");
  assert.match(pinnedAlias, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(pinnedAlias, /2000-01-01/);
  const publication = await app.pool.query<{ instant: string }>(
    `SELECT to_jsonb(published_at) #>> '{}' AS instant FROM publications
     WHERE entity_id = $1 AND state = 'PUBLISHED'`,
    [newsId],
  );
  assert.equal(
    pinnedAlias,
    publication.rows[0]!.instant,
    "pinned alias equals the stored Publication instant",
  );
  // The legacy related-card date keeps the CONTENT field (localized), which
  // is exactly the difference the two surfaces are supposed to have.
  assert.equal(/card__date">([^<]*)</.exec(pinnedCard)?.[1], "01.01.2000");
  assert.match(newsCard, /card__field-title">Alias news</);
  assert.match(newsCard, /card__field-description">Alias teaser</);
  const pageCard = cardOf(pageId);
  // No hero_image: the image alias uses the same block candidate as `image`.
  assert.match(pageCard, /card__field-image">\/media\/a\/[0-9a-f-]+/);
  assert.match(pageCard, /card__image" src="\/media\/a\//);
  assert.match(pageCard, /alt="Block alt"/);
  assert.match(pageCard, /card__field-description">Page intro</);
  assert.ok(hostId);
});

test("R4: limit bounds the pinned and merged card sets", { skip }, async (t) => {
  const fixture = await feedFixture(t);
  const { app, ctx, site } = fixture;
  const a = await publishEntry(fixture, {
    key: "p-a",
    contentType: "news",
    fields: { title: "p-a", rank: 1 },
  });
  const b = await publishEntry(fixture, {
    key: "p-b",
    contentType: "news",
    fields: { title: "p-b", rank: 2 },
  });
  const c = await publishEntry(fixture, {
    key: "p-c",
    contentType: "news",
    fields: { title: "p-c", rank: 3 },
  });
  // Pinned but unavailable: unpublished (draft only) and removed (random id).
  const draftOnly = await createDraft(app, ctx, {
    content_type: "news",
    payload: { fields: { title: "draft only" } },
  });
  const removed = blockId("c9");
  await publishEntry(fixture, {
    key: "p-host",
    contentType: "page",
    template: "plain_page",
    fields: { title: "Pinned host" },
    blocks: [
      relatedBlock({ mode: "manual", entry_ids: [a, b, c], limit: 1, title: "Manual 1" }, "d1"),
      relatedBlock(
        {
          mode: "manual",
          entry_ids: [removed, draftOnly.entry_id, a, b, c],
          limit: 2,
          title: "Manual 2",
        },
        "d2",
      ),
      relatedBlock(
        { mode: "manual", entry_ids: [a, b], exclude_entry_ids: [a], limit: 1, title: "Manual 3" },
        "d3",
      ),
      relatedBlock(
        {
          mode: "hybrid",
          entry_ids: [a, b, c],
          collection_key: "news_rank",
          scope: "site",
          limit: 2,
          title: "Hybrid 1",
        },
        "d4",
      ),
      relatedBlock(
        {
          mode: "hybrid",
          entry_ids: [a],
          collection_key: "news_rank",
          scope: "site",
          limit: 3,
          title: "Hybrid 2",
        },
        "d5",
      ),
    ],
  });
  const fastify = createApiFastify(() => "req_feed_limit");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  const page = await fastify.inject({ method: "GET", url: "/p-host/" });
  assert.equal(page.statusCode, 200);
  assert.deepEqual(relatedCardIds(page.body, "d1"), [a], "manual pinned is capped by limit");
  assert.deepEqual(
    relatedCardIds(page.body, "d2"),
    [a, b],
    "removed/unpublished pins take no slot",
  );
  assert.deepEqual(relatedCardIds(page.body, "d3"), [b], "excluded pin frees its slot");
  assert.deepEqual(
    relatedCardIds(page.body, "d4"),
    [a, b],
    "hybrid pinned fills the quota, no fill beyond it",
  );
  assert.deepEqual(
    relatedCardIds(page.body, "d5"),
    [a, b, c],
    "hybrid fill continues to the limit without duplicates",
  );
  assert.equal(new Set(relatedCardIds(page.body, "d5")).size, 3);
  assert.ok(site);
});

test("R5: a nested related block renders its cards", { skip }, async (t) => {
  const fixture = await feedFixture(t);
  const { app } = fixture;
  app.blocks.registerBlockType({
    typeId: "test_container",
    schemaVersion: 1,
    propsSchema: { type: "object", additionalProperties: false, properties: {} },
    childrenPolicy: "blocks",
  });
  for (const key of ["n-a", "n-b", "n-c"]) {
    await publishEntry(fixture, {
      key,
      contentType: "news",
      fields: { title: key, rank: 1 },
    });
  }
  await publishEntry(fixture, {
    key: "n-host",
    contentType: "page",
    template: "plain_page",
    fields: { title: "Nested host" },
    blocks: [
      {
        id: blockId("e1"),
        type: "test_container",
        schema_version: 1,
        variant: null,
        props: {},
        children: [
          relatedBlock(
            {
              mode: "collection",
              collection_key: "news_rank",
              scope: "site",
              limit: 3,
              fields: ["title"],
              title: "Nested",
            },
            "e2",
          ),
        ],
      },
    ],
  });
  const fastify = createApiFastify(() => "req_feed_nested");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  const page = await fastify.inject({ method: "GET", url: "/n-host/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /class="container" data-block="01980000-0000-7000-8000-0000000000e1"/);
  const ids = relatedCardIds(page.body, "e2");
  assert.equal(ids.length, 3, "a nested related block renders its published cards");
  assert.match(page.body, /card__field-title">n-a</);
});
