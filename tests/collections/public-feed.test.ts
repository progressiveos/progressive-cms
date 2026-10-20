// Public collection feed — focused acceptance scenario (Theme Contract §43;
// Content spec §54–§59; owner acceptance 2026-10-04: 25 published articles,
// page_size 10 → 10/10/5, tag filter over the whole source, bounded pages,
// preview/live parity, related_content collection-mode resolution, no draft
// leakage, typed diagnostics, non-mutating GET).
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
  createThemePreview,
  makeCollectionsRoutes,
  moveEntryOp,
  publishRevision,
  sealRevision,
  setEntryTemplateOp,
} from "@pcms/api";
import { emptySeoDocument, parseSeoSiteIdentity } from "@pcms/seo";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

const NEWS_FEED_TEMPLATE = `<!doctype html>
<html lang="ru">
<head>{{ head_html }}</head>
<body>
<main id="main">
<h1>{{ entry.fields.title }}</h1>
<p class="feed__intro">{{ entry.fields.intro }}</p>
<ul class="feed">
{% for item in collections.news.items %}
<li class="feed__item" data-entry-id="{{ item.entry_id }}">
<a class="feed__link" href="{{ item.href }}">{{ item.title }}</a>
<span class="feed__date">{{ item.date }}</span>
{% for tag in item.tags %}<a class="feed__tag" href="{{ request.path }}?tag={{ tag }}">{{ tag }}</a>{% endfor %}
</li>
{% endfor %}
</ul>
<p class="feed__total">{{ collections.news.total }}</p>
{% for facet in collections.news.tags %}<span class="feed__facet" data-tag="{{ facet.tag }}" data-count="{{ facet.count }}"{% if facet.active %} data-active="true"{% endif %}></span>{% endfor %}
{% if collections.news.prev_url %}<a class="feed__prev" href="{{ collections.news.prev_url }}">Prev</a>{% endif %}
{% if collections.news.next_url %}<a class="feed__next" href="{{ collections.news.next_url }}">Next</a>{% endif %}
{{ blocks_html }}
</main>
</body>
</html>`;

/** Reference theme + a `news` collection bound to a new news_feed template. */
async function feedTheme(t: import("node:test").TestContext): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "pcms-feed-theme-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = join(root, "theme");
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });
  const manifestPath = join(themeDir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.cms_compatibility = ">=1.0.0-rc.1 <2.0.0";
  manifest.collections = {
    news: { content_types: ["article"], page_size: 10, templates: ["news_feed"] },
  };
  manifest.templates = [
    ...(manifest.templates as unknown[]),
    {
      id: "news_feed",
      file: "templates/news_feed.liquid",
      accepts_content_types: ["page@1"],
      required_fields: ["title"],
    },
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(themeDir, "templates", "news_feed.liquid"), NEWS_FEED_TEMPLATE);
  return themeDir;
}

function richText(text: string): unknown {
  return {
    schema_version: 2,
    type: "document",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

test("collection pagination labels are localized for Russian and English", async () => {
  const { paginationPageLabel } = await import("../../apps/web/src/site.js");
  assert.equal(paginationPageLabel("ru-RU", 2), "Страница 2");
  assert.equal(paginationPageLabel("en-US", 3), "Page 3");
});

test("public collection feed: 25 articles paginate 10/10/5 with SEO, tags and preview parity", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: await feedTheme(t),
    seoEnvironment: "production",
  });
  const site = await app.routes.ensureSite("default");
  await app.domains.addDomainBinding({
    siteId: site.id,
    hostname: "news.example",
    schemePolicy: "https",
    isPrimary: true,
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_feed");
  const routes: ApiRoute[] = [...makeCollectionsRoutes()];
  await fastify.register(createApiV1(routes), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    cookieSecure: false,
  });
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });

  const ctx = apiContextOf(ownerActor("feed-seeder"));
  async function publishEntry(input: {
    contentType: "page" | "article";
    fields: Record<string, unknown>;
    blocks?: unknown[];
    template?: string;
  }): Promise<string> {
    const draft = await createDraft(app, ctx, {
      content_type: input.contentType,
      payload: {
        fields: input.fields,
        blocks: { schema_version: 1, blocks: input.blocks ?? [] },
      },
    });
    if (input.template !== undefined) {
      await setEntryTemplateOp(app, ctx, {
        entry_id: draft.entry_id,
        template_key: input.template,
      });
    }
    await sealRevision(app, ctx, { revision_id: draft.revision_id });
    await publishRevision(app, ctx, {
      entity_type: "entry",
      entity_id: draft.entry_id,
      target_revision_id: draft.revision_id,
      expected_generation: 0,
    });
    return draft.entry_id;
  }

  // The section page carries a hybrid + a collection related_content block:
  // collection = self children, hybrid = pinned foreign article + fill.
  const solo = await publishEntry({
    contentType: "article",
    fields: {
      title: "Solo foreign article",
      tags: ["cms"],
      body: richText("Foreign section body"),
    },
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/solo/",
    targetType: "entry",
    targetId: solo,
  });
  const newsPageId = await publishEntry({
    contentType: "page",
    fields: { title: "Новости", intro: "Лента новостей" },
    template: "news_feed",
    blocks: [
      {
        id: "01980000-0000-7000-8000-0000000000c1",
        type: "related_content",
        schema_version: 1,
        variant: null,
        props: { mode: "collection", collection_key: "news", limit: 3, title: "Collection" },
        children: [],
      },
      {
        id: "01980000-0000-7000-8000-0000000000c2",
        type: "related_content",
        schema_version: 1,
        variant: null,
        props: {
          mode: "hybrid",
          entry_ids: [solo],
          collection_key: "news",
          limit: 5,
          title: "Hybrid",
        },
        children: [],
      },
    ],
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/news/",
    targetType: "entry",
    targetId: newsPageId,
  });
  const feedSeo = {
    ...emptySeoDocument(),
    seo_title: "SEO Новости",
    meta_description: "Архив публикаций для проверки SEO пагинации.",
    social_title: "Новости для соцсетей",
    social_description: "Описание новостей для соцсетей.",
  };
  await app.seo.saveDocument(newsPageId, feedSeo);
  await app.seo.saveSiteSettings(
    site.id,
    parseSeoSiteIdentity({ site_name: "Пример", title_pattern: "{page_title} — {site_name}" }),
  );

  const articleIds: string[] = [];
  for (let i = 1; i <= 25; i++) {
    const nn = String(i).padStart(2, "0");
    const id = await publishEntry({
      contentType: "article",
      fields: {
        title: `Article-${nn}`,
        tags: i % 2 === 1 ? ["news"] : ["cms"],
        body: richText(`Body of Article-${nn}`),
      },
    });
    articleIds.push(id);
    await app.routes.activateRoute({
      siteId: site.id,
      path: `/news/story-${nn}/`,
      targetType: "entry",
      targetId: id,
    });
    await moveEntryOp(app, ctx, { entry_id: id, parent_entry_id: newsPageId });
  }
  // Draft (never sealed/published) — must never enter the feed.
  await createDraft(app, ctx, {
    content_type: "article",
    payload: { fields: { title: "Draft article", tags: ["news"], body: richText("Draft body") } },
  });
  // Published then archived — excluded by the projection join.
  const archivedId = await publishEntry({
    contentType: "article",
    fields: { title: "Archived article", tags: ["news"], body: richText("Archived body") },
  });
  await moveEntryOp(app, ctx, { entry_id: archivedId, parent_entry_id: newsPageId });
  await archiveEntry(app, ctx, { entry_id: archivedId });

  const feedIdsOnPage = (html: string): string[] =>
    [...html.matchAll(/data-entry-id="([0-9a-f-]+)"/g)].map((match) => match[1]!);

  // --- Page 1: unchanged SEO values and 10 items, no draft/foreign/archived. ---
  const page1 = await fastify.inject({ method: "GET", url: "/news/" });
  assert.equal(page1.statusCode, 200);
  assert.match(page1.body, /<h1>Новости<\/h1>/);
  assert.match(page1.body, /<title>SEO Новости — Пример<\/title>/);
  assert.match(
    page1.body,
    /name="description" content="Архив публикаций для проверки SEO пагинации\."/,
  );
  assert.match(page1.body, /rel="canonical" href="https:\/\/news\.example\/news\/"/);
  assert.match(page1.body, /property="og:url" content="https:\/\/news\.example\/news\/"/);
  assert.doesNotMatch(page1.body, /Страница 1/);
  const ids1 = feedIdsOnPage(page1.body);
  assert.equal(ids1.length, 10);
  assert.match(page1.body, /class="feed__total">25</);
  assert.match(page1.body, /class="feed__next" href="\/news\/\?page=2"/);
  assert.doesNotMatch(page1.body, /Draft article/);
  // The foreign article is absent from the FEED items themselves (the hybrid
  // block legitimately pins it — proven by the exact id list assertion).
  assert.doesNotMatch(page1.body, /Archived article/);
  // Stable order: entry ids arrive in creation (uuidv7) order — the tie-break.
  const expectedPage1 = articleIds.slice(0, 10);
  assert.deepEqual(ids1, expectedPage1);
  // Facets over the WHOLE collection, active flag on the unfiltered view.
  assert.match(page1.body, /data-tag="cms" data-count="12"/);
  assert.match(page1.body, /data-tag="news" data-count="13"/);
  // related_content collection/hybrid blocks on the same page: collection =
  // first 3 self children; hybrid = pinned foreign article + 4 fill.
  assert.match(page1.body, /<a href="[^"]+">Article-01<\/a>/);
  const cardsOfBlock = (html: string, title: string): string[] => {
    const sections = html.match(/<section class="block block-related">[\s\S]*?<\/section>/g) ?? [];
    const section =
      sections.find((candidate) => candidate.includes(`<h2>${title}</h2>`) === true) ?? "";
    return [...section.matchAll(/<li class="card">\s*<a href="[^"]+">([^<]+)<\/a>/g)].map(
      (match) => match[1]!,
    );
  };
  const collectionCards = cardsOfBlock(page1.body, "Collection");
  assert.deepEqual(collectionCards, ["Article-01", "Article-02", "Article-03"]);
  const hybridCards = cardsOfBlock(page1.body, "Hybrid");
  assert.equal(hybridCards.length, 5);
  assert.equal(hybridCards[0], "Solo foreign article");
  assert.deepEqual(hybridCards.slice(1), ["Article-01", "Article-02", "Article-03", "Article-04"]);
  // Per-item tag links build the filter URL from the request path.
  assert.match(page1.body, /class="feed__tag" href="\/news\/\?tag=news">news</);

  // --- Page 2/3: unique, localized SEO values and no repeated content. ---
  const page2 = await fastify.inject({
    method: "GET",
    url: "/news/?page=2",
    headers: { host: "untrusted.example" },
  });
  assert.equal(page2.statusCode, 200);
  assert.match(page2.body, /<title>SEO Новости — Пример — Страница 2<\/title>/);
  assert.match(
    page2.body,
    /name="description" content="Архив публикаций для проверки SEO пагинации\. — Страница 2"/,
  );
  assert.match(page2.body, /property="og:url" content="https:\/\/news\.example\/news\/\?page=2"/);
  assert.match(page2.body, /property="og:title" content="Новости для соцсетей — Страница 2"/);
  assert.match(
    page2.body,
    /property="og:description" content="Описание новостей для соцсетей\. — Страница 2"/,
  );
  assert.match(page2.body, /name="twitter:title" content="Новости для соцсетей — Страница 2"/);
  assert.match(
    page2.body,
    /name="twitter:description" content="Описание новостей для соцсетей\. — Страница 2"/,
  );
  assert.match(page2.body, /<h1>Новости<\/h1>/);
  assert.doesNotMatch(page2.body, /name="robots" content="noindex/);
  const page2Graph = page2.body.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(page2Graph);
  const page2WebPage = (JSON.parse(page2Graph) as { "@graph": Record<string, unknown>[] })[
    "@graph"
  ].find((node) => node["@type"] === "WebPage");
  assert.equal(page2WebPage?.url, "https://news.example/news/?page=2");
  assert.equal(page2WebPage?.name, "SEO Новости — Пример — Страница 2");
  const ids2 = feedIdsOnPage(page2.body);
  assert.equal(ids2.length, 10);
  assert.deepEqual(ids2, articleIds.slice(10, 20));
  assert.match(page2.body, /class="feed__prev" href="\/news\/"/);
  const page3 = await fastify.inject({ method: "GET", url: "/news/?page=3" });
  assert.match(page3.body, /<title>SEO Новости — Пример — Страница 3<\/title>/);
  assert.match(page3.body, /rel="canonical" href="https:\/\/news\.example\/news\/\?page=3"/);
  const ids3 = feedIdsOnPage(page3.body);
  assert.equal(ids3.length, 5);
  assert.deepEqual(ids3, articleIds.slice(20));
  assert.doesNotMatch(page3.body, /class="feed__next"/);
  const all = [...ids1, ...ids2, ...ids3];
  assert.equal(new Set(all).size, 25);
  assert.deepEqual([...all].sort(), [...articleIds].sort());

  const customCanonical = "https://news.example/editorial-canonical/";
  await app.seo.saveDocument(newsPageId, { ...feedSeo, canonical_override: customCanonical });
  const canonicalOverridePage = await fastify.inject({
    method: "GET",
    url: "/news/?page=2",
    headers: { host: "untrusted.example" },
  });
  assert.match(canonicalOverridePage.body, /<title>SEO Новости — Пример — Страница 2<\/title>/);
  assert.match(canonicalOverridePage.body, new RegExp(`rel="canonical" href="${customCanonical}"`));
  assert.match(
    canonicalOverridePage.body,
    new RegExp(`property="og:url" content="${customCanonical}"`),
  );
  await app.seo.saveDocument(newsPageId, feedSeo);
  await app.seo.saveDocument(newsPageId, {
    ...feedSeo,
    robots_policy: { index: false, follow: false },
  });
  const robotsOverridePage = await fastify.inject({ method: "GET", url: "/news/?page=2" });
  assert.match(robotsOverridePage.body, /name="robots" content="noindex, nofollow"/);
  await app.seo.saveDocument(newsPageId, feedSeo);

  // --- Out-of-range and malformed pages degrade per the declared contract. ---
  const page99 = await fastify.inject({ method: "GET", url: "/news/?page=99" });
  assert.equal(page99.statusCode, 200);
  assert.equal(feedIdsOnPage(page99.body).length, 0);
  assert.match(page99.body, /class="feed__total">25</);
  assert.match(page99.body, /name="robots" content="noindex, follow"/);
  assert.match(page99.body, /rel="canonical" href="https:\/\/news\.example\/news\/\?page=99"/);
  const pageBad = await fastify.inject({ method: "GET", url: "/news/?page=abc" });
  assert.equal(pageBad.statusCode, 200); // lenient on the browsable surface
  assert.equal(feedIdsOnPage(pageBad.body).length, 10);
  assert.match(pageBad.body, /rel="canonical" href="https:\/\/news\.example\/news\/"/);
  const pageOneAlias = await fastify.inject({
    method: "GET",
    url: "/news/?page=1&utm_source=test",
  });
  assert.match(pageOneAlias.body, /rel="canonical" href="https:\/\/news\.example\/news\/"/);
  const trackingPage2 = await fastify.inject({
    method: "GET",
    url: "/news/?utm_source=test&page=2",
  });
  assert.match(
    trackingPage2.body,
    /rel="canonical" href="https:\/\/news\.example\/news\/\?page=2"/,
  );
  assert.match(trackingPage2.body, /<title>SEO Новости — Пример — Страница 2<\/title>/);
  const duplicatePage = await fastify.inject({ method: "GET", url: "/news/?page=2&page=3" });
  assert.equal(feedIdsOnPage(duplicatePage.body).length, 10);
  assert.match(duplicatePage.body, /rel="canonical" href="https:\/\/news\.example\/news\/"/);
  for (const invalid of ["0", "-1"]) {
    const response = await fastify.inject({ method: "GET", url: `/news/?page=${invalid}` });
    assert.equal(feedIdsOnPage(response.body).length, 10);
    assert.match(response.body, /rel="canonical" href="https:\/\/news\.example\/news\/"/);
  }
  const hugePublicPage = await fastify.inject({
    method: "GET",
    url: "/news/?page=999999999999999999999999999999",
  });
  assert.equal(hugePublicPage.statusCode, 200);
  assert.equal(feedIdsOnPage(hugePublicPage.body).length, 0);
  assert.match(hugePublicPage.body, /name="robots" content="noindex, follow"/);

  // --- Tag filter: exact membership over the whole source, preserved in URLs. ---
  const tagged = await fastify.inject({ method: "GET", url: "/news/?tag=news" });
  assert.equal(tagged.statusCode, 200);
  assert.match(tagged.body, /name="robots" content="noindex, follow"/);
  assert.match(tagged.body, /rel="canonical" href="https:\/\/news\.example\/news\/\?tag=news"/);
  const taggedIds = feedIdsOnPage(tagged.body);
  assert.equal(taggedIds.length, 10);
  assert.match(tagged.body, /class="feed__total">13</);
  assert.match(tagged.body, /data-tag="news" data-count="13" data-active="true"/);
  assert.match(tagged.body, /class="feed__next" href="\/news\/\?tag=news&amp;page=2"/);
  assert.match(tagged.body, /class="feed__tag" href="\/news\/\?tag=news">news</);
  const taggedPage2 = await fastify.inject({ method: "GET", url: "/news/?tag=news&page=2" });
  assert.equal(feedIdsOnPage(taggedPage2.body).length, 3);
  assert.match(
    taggedPage2.body,
    /rel="canonical" href="https:\/\/news\.example\/news\/\?tag=news&amp;page=2"/,
  );
  assert.match(taggedPage2.body, /name="robots" content="noindex, follow"/);
  // Changing the tag starts from page 1 (URLs never carry page + other tag).
  const taggedCms = await fastify.inject({ method: "GET", url: "/news/?tag=cms" });
  assert.match(taggedCms.body, /class="feed__total">12</);
  assert.match(taggedCms.body, /class="feed__next" href="\/news\/\?tag=cms&amp;page=2"/);
  assert.match(taggedCms.body, /name="robots" content="noindex, follow"/);
  const taggedCmsPage2 = await fastify.inject({ method: "GET", url: "/news/?tag=cms&page=2" });
  assert.equal(feedIdsOnPage(taggedCmsPage2.body).length, 2);
  assert.match(taggedCms.body, /class="feed__facet" data-tag="news" data-count="13"/);
  const unknownTag = await fastify.inject({ method: "GET", url: "/news/?tag=does-not-exist" });
  assert.equal(unknownTag.statusCode, 200);
  assert.equal(feedIdsOnPage(unknownTag.body).length, 0);
  assert.match(unknownTag.body, /class="feed__total">0</);

  // --- REST: same contract, machine-readable, strict on bad input. ---
  const rest = await fastify.inject({
    method: "GET",
    url: `/api/v1/collections/news/items?section=${newsPageId}`,
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as {
    total: number;
    page: number;
    page_size: number;
    page_count: number;
    has_next: boolean;
    tag: string | null;
    tags: { tag: string; count: number }[];
    items: {
      entry_id: string;
      href: string;
      title: string;
      teaser: string | null;
      date: string;
      tags: string[];
      image_asset_id: string | null;
    }[];
  };
  assert.equal(restBody.total, 25);
  assert.equal(restBody.page, 1);
  assert.equal(restBody.page_size, 10);
  assert.equal(restBody.page_count, 3);
  assert.equal(restBody.has_next, true);
  assert.equal(restBody.tag, null);
  assert.deepEqual(
    restBody.tags.map((facet) => [facet.tag, facet.count]),
    [
      ["news", 13],
      ["cms", 12],
    ],
  );
  assert.equal(restBody.items.length, 10);
  assert.equal(restBody.items[0]!.title, "Article-01");
  assert.deepEqual(restBody.items[0]!.tags, ["news"]);
  assert.match(restBody.items[0]!.href, /^\/news\/story-01\/$/);
  assert.equal(restBody.items[0]!.teaser, "Body of Article-01");
  assert.match(restBody.items[0]!.date, /^\d{4}-\d{2}-\d{2}T/);
  // Unsectioned REST reads the collection site-wide (foreign article in,
  // draft/archived still out) — the declared REST semantics.
  const unsectioned = await fastify.inject({
    method: "GET",
    url: "/api/v1/collections/news/items",
  });
  assert.equal((unsectioned.json() as { total: number }).total, 26);
  // Tag + pagination on REST.
  const restTagged = await fastify.inject({
    method: "GET",
    url: `/api/v1/collections/news/items?section=${newsPageId}&tag=cms&page=2`,
  });
  assert.equal(
    (restTagged.json() as { total: number; has_next: boolean; has_prev: boolean }).total,
    12,
  );
  assert.equal((restTagged.json() as { has_next: boolean }).has_next, false);
  assert.equal((restTagged.json() as { has_prev: boolean }).has_prev, true);
  // Typed boundaries — never a 500. (page=abc never reaches the handler:
  // the route query schema answers API_REQUEST_INVALID first.)
  const badPage = await fastify.inject({
    method: "GET",
    url: "/api/v1/collections/news/items?page=abc",
  });
  assert.equal(badPage.statusCode, 400);
  assert.equal((badPage.json() as { error: { code: string } }).error.code, "API_REQUEST_INVALID");
  const zeroPage = await fastify.inject({
    method: "GET",
    url: "/api/v1/collections/news/items?page=0",
  });
  assert.equal(zeroPage.statusCode, 400);
  assert.equal(
    (zeroPage.json() as { error: { code: string } }).error.code,
    "COLLECTION_PAGE_INVALID",
  );
  const hugeRestPage = await fastify.inject({
    method: "GET",
    url: `/api/v1/collections/news/items?section=${newsPageId}&page=999999999999999999999999999999`,
  });
  assert.equal(hugeRestPage.statusCode, 400);
  assert.equal(
    (hugeRestPage.json() as { error: { code: string } }).error.code,
    "COLLECTION_PAGE_INVALID",
  );
  const badTag = await fastify.inject({
    method: "GET",
    url: "/api/v1/collections/news/items?tag=",
  });
  assert.equal(badTag.statusCode, 400);
  assert.equal((badTag.json() as { error: { code: string } }).error.code, "COLLECTION_TAG_INVALID");
  const badSection = await fastify.inject({
    method: "GET",
    url: "/api/v1/collections/news/items?section=garbage",
  });
  assert.equal(badSection.statusCode, 400);
  const unknownKey = await fastify.inject({ method: "GET", url: "/api/v1/collections/nope/items" });
  assert.equal(unknownKey.statusCode, 404);
  assert.equal((unknownKey.json() as { error: { code: string } }).error.code, "COLLECTION_UNKNOWN");
  // GET never mutates: two identical calls, byte-stable body.
  const again = await fastify.inject({
    method: "GET",
    url: `/api/v1/collections/news/items?section=${newsPageId}`,
  });
  assert.equal(again.body, rest.body);

  // --- Preview parity: same feed semantics, drafts still excluded. ---
  const sealed = await app.pool.query<{ id: string }>(
    "SELECT current_revision_id AS id FROM publications WHERE entity_id = $1 AND state = 'PUBLISHED'",
    [newsPageId],
  );
  const preview = await createThemePreview(app, ctx, {
    scope: {
      kind: "revision",
      entity_type: "entry",
      entity_id: newsPageId,
      revision_id: sealed.rows[0]!.id,
    },
  });
  const previewPage = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${preview.token}`,
  });
  assert.equal(previewPage.statusCode, 200);
  const previewIds = feedIdsOnPage(previewPage.body);
  assert.equal(previewIds.length, 10);
  assert.match(previewPage.body, /class="feed__total">25</);
  assert.doesNotMatch(previewPage.body, /Draft article/);

  const newlyPublished = await publishEntry({
    contentType: "article",
    fields: { title: "Article-26", tags: ["news"], body: richText("Body of Article-26") },
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/news/story-26/",
    targetType: "entry",
    targetId: newlyPublished,
  });
  await moveEntryOp(app, ctx, { entry_id: newlyPublished, parent_entry_id: newsPageId });
  const afterPublish = await fastify.inject({ method: "GET", url: "/news/?page=3" });
  assert.match(afterPublish.body, /class="feed__total">26</);
  assert.equal(feedIdsOnPage(afterPublish.body).length, 6);
  await archiveEntry(app, ctx, { entry_id: newlyPublished });
  const afterArchive = await fastify.inject({ method: "GET", url: "/news/?page=3" });
  assert.match(afterArchive.body, /class="feed__total">25</);
  assert.equal(feedIdsOnPage(afterArchive.body).length, 5);
  const sitemap = await app.seoDiscovery.getSitemapDocument();
  assert.ok(sitemap?.includes("https://news.example/news/"));
  assert.doesNotMatch(sitemap ?? "", /\?(?:page|tag)=/);

  // --- theme/state reports the REAL cms version (THEME_CMS_INCOMPATIBLE fix). ---
  const validation = app.themeDiscovery!.describeTheme().validation as {
    ok: boolean;
    issues: { code: string }[];
  };
  assert.equal(validation.ok, true);
  assert.equal(
    validation.issues.filter((issue) => issue.code === "THEME_CMS_INCOMPATIBLE").length,
    0,
  );
});
