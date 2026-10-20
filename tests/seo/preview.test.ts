// PCMS-SEO-T023 — preview services (spec §59/§60): resolved values with
// provenance, OG/twitter projections and JSON-LD returned without HTML.
// Deterministic for identical inputs; ports are stubs (M07 will provide the
// authoritative publication/media state).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptySeoDocument,
  previewSeo,
  previewStructuredData,
  type SeoFaviconPort,
  type SeoPreviewRequest,
  type SeoSocialImagePort,
} from "@pcms/seo";

const SOCIAL: SeoSocialImagePort = {
  resolveSocialImage: async (ref) => ({
    asset_id: ref.asset_id,
    version: ref.version ?? 1,
    url: `https://cdn.example.ru/media/a/${ref.asset_id.slice(0, 8)}/v${ref.version ?? 1}/social-display-x.jpeg`,
    width: 1200,
    height: 630,
    mime_type: "image/jpeg",
    alt: "Обложка",
  }),
};
const FAVICON: SeoFaviconPort = {
  resolveFavicon: async (ref) => ({
    asset_id: ref.asset_id,
    version: ref.version ?? 1,
    url: "https://cdn.example.ru/media/a/f/v1/favicon-x.png",
    width: 512,
    height: 512,
    mime_type: "image/png",
  }),
};

const ASSET = "0195fdc0-7a5e-7000-8000-000000000001";
const FAVICON_ASSET = "0195fdc0-7a5e-7000-8000-000000000002";

function request(overrides: Partial<SeoPreviewRequest> = {}): SeoPreviewRequest {
  return {
    entryId: "01900000-0000-7000-8000-00000000000a",
    document: {
      ...emptySeoDocument(),
      social_image: { asset_id: ASSET },
    },
    facts: { page_title: "Новость дня", intro: "Интро новости.", hero_image: null },
    identity: {
      site_name: "Пример",
      favicon: { asset_id: FAVICON_ASSET },
    },
    origin: "https://example.ru",
    routeCanonicalUrl: "https://example.ru/news/day/",
    environment: "production",
    locale: "ru-RU",
    openGraph: true,
    twitterCard: true,
    ...overrides,
  };
}

test("preview returns resolved values with provenance and both projections", async () => {
  const result = await previewSeo({ socialImage: SOCIAL, favicon: FAVICON }, request(), {
    breadcrumbs: {
      id: "https://example.ru/news/#breadcrumb",
      items: [
        { name: "Главная", url: "https://example.ru/" },
        { name: "Новости", url: "https://example.ru/news/" },
        { name: "Новость дня", url: null },
      ],
    },
  });
  // Provenance per field (§59).
  assert.deepEqual(result.resolved.title, { value: "Новость дня", source: "page_title" });
  assert.deepEqual(result.resolved.social_image, {
    value: { asset_id: ASSET },
    source: "social_image",
  });
  // Resolved media through the port — absolute, provider-shaped.
  assert.equal(result.social_image?.width, 1200);
  assert.ok(result.social_image?.url.startsWith("https://cdn.example.ru/media/"));
  // Head projections.
  const ogTags = result.head.core_meta.filter((m) => m.property?.startsWith("og:"));
  assert.ok(ogTags.some((t) => t.property === "og:title" && t.content === "Новость дня"));
  assert.ok(ogTags.some((t) => t.property === "og:image"));
  assert.ok(
    result.head.core_meta.some(
      (m) => m.name === "twitter:card" && m.content === "summary_large_image",
    ),
  );
  // JSON-LD returned directly (§60), plus breadcrumb fact from composition.
  const graph = JSON.parse(result.structured_data.json_ld[0] as string) as {
    "@graph": { "@type": string }[];
  };
  assert.ok(graph["@graph"].some((n) => n["@type"] === "WebSite"));
  assert.ok(graph["@graph"].some((n) => n["@type"] === "BreadcrumbList"));
  // Favicon icons travel with the head model.
  assert.ok(result.head.icons.some((i) => i.rel === "icon"));
});

test("preview is deterministic for identical input", async () => {
  const a = await previewSeo({ socialImage: SOCIAL, favicon: FAVICON }, request());
  const b = await previewSeo({ socialImage: SOCIAL, favicon: FAVICON }, request());
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("unresolvable social image degrades to a diagnostic, never a fake URL", async () => {
  const broken: SeoSocialImagePort = { resolveSocialImage: async () => null };
  const result = await previewSeo({ socialImage: broken, favicon: null }, request());
  assert.equal(result.social_image, null);
  assert.ok(result.diagnostics.some((d) => d.code === "SEO_SOCIAL_IMAGE_INVALID"));
  assert.ok(!JSON.stringify(result.structured_data.json_ld).includes("og:image"));
});

test("preview_structured_data returns JSON-LD + validation diagnostics pre-publish", () => {
  const composed = previewStructuredData({
    website: { id: "https://example.ru/#website", name: "Пример", url: "https://example.ru" },
    organization: null,
    webpage: null,
    article: null,
    breadcrumbs: null,
    video: null,
  });
  assert.equal(composed.diagnostics.length, 0);
  const graph = JSON.parse(composed.json_ld[0] as string) as { "@graph": { "@type": string }[] };
  assert.deepEqual(
    graph["@graph"].map((n) => n["@type"]),
    ["WebSite"],
  );
});

// R21 (2026-10-03): the article hint reached og:type but never the JSON-LD
// graph — native discovery and the public page both returned a WebPage-only
// graph. The shared seam is previewSeo: structured_data feeds the discovery
// surfaces and head.json_ld feeds the trusted public head serializer, so one
// test covers both. Sibling hints go through the same adapter here.
test("article hint emits a truthful Article node; sibling hints follow the same adapter", async () => {
  const result = await previewSeo(
    { socialImage: SOCIAL, favicon: FAVICON },
    request({
      document: {
        ...emptySeoDocument(),
        structured_data_type_hint: "article",
        social_image: { asset_id: ASSET },
      },
      facts: {
        page_title: "Новость дня",
        intro: "Интро новости.",
        hero_image: null,
        published_at: "2026-10-01T08:00:00.000Z",
        modified_at: "2026-10-02T09:30:00.000Z",
      },
    }),
  );
  const graph = JSON.parse(result.structured_data.json_ld[0] as string) as {
    "@graph": Record<string, unknown>[];
  };
  const article = graph["@graph"].find((n) => n["@type"] === "Article");
  assert.ok(article, "article hint must produce an Article node");
  assert.equal(article["@id"], "https://example.ru/news/day/#article");
  assert.equal(article.headline, "Новость дня");
  assert.equal(article.url, "https://example.ru/news/day/");
  // Publication-contract facts, mapped verbatim — never invented.
  assert.equal(article.datePublished, "2026-10-01T08:00:00.000Z");
  assert.equal(article.dateModified, "2026-10-02T09:30:00.000Z");
  assert.equal(article.description, "Интро новости.");
  assert.equal(article.inLanguage, "ru-RU");
  assert.deepEqual(article.image, [
    "https://cdn.example.ru/media/a/0195fdc0/v1/social-display-x.jpeg",
  ]);
  assert.deepEqual(article.isPartOf, { "@id": "https://example.ru/news/day/#webpage" });
  // Publisher links the site Organization node by @id, never a new actor.
  assert.deepEqual(article.publisher, {
    "@type": "Organization",
    "@id": "https://example.ru/#organization",
    name: "Пример",
  });
  // The public serializer consumes exactly these strings (no separate path).
  assert.deepEqual(result.head.json_ld, result.structured_data.json_ld);

  const variantGraph = async (
    hint: "web_page" | "article" | "news_article" | "blog_posting" | null,
  ) =>
    JSON.parse(
      (
        await previewSeo(
          { socialImage: SOCIAL, favicon: FAVICON },
          request({
            document: {
              ...emptySeoDocument(),
              ...(hint === null ? {} : { structured_data_type_hint: hint }),
              social_image: { asset_id: ASSET },
            },
          }),
        )
      ).structured_data.json_ld[0] as string,
    ) as { "@graph": Record<string, unknown>[] };

  // Sibling article-family hints select their schema subtypes; without
  // publication facts no dates are invented.
  const newsGraph = await variantGraph("news_article");
  const news = newsGraph["@graph"].find((n) => n["@type"] === "NewsArticle");
  assert.ok(news, "news_article hint must produce a NewsArticle node");
  assert.equal("datePublished" in news, false);
  const blogGraph = await variantGraph("blog_posting");
  assert.ok(blogGraph["@graph"].some((n) => n["@type"] === "BlogPosting"));
  // web_page hint and no hint emit no Article node at all.
  for (const hint of ["web_page", null] as const) {
    const plain = await variantGraph(hint);
    assert.ok(
      !plain["@graph"].some((n) => String(n["@type"]).endsWith("Article")),
      `${hint ?? "no"} hint must not emit an article node`,
    );
  }

  // Site-level classification (§25/§31): identity.article_content_types +
  // the entry's content type key produce a plain Article (and og:type
  // article) without any per-entry hint.
  const classified = await previewSeo(
    { socialImage: SOCIAL, favicon: FAVICON },
    request({
      identity: {
        site_name: "Пример",
        favicon: { asset_id: FAVICON_ASSET },
        article_content_types: ["journal"],
      },
      facts: { page_title: "Пост", intro: null, hero_image: null, content_type_key: "journal" },
    }),
  );
  const classifiedGraph = JSON.parse(classified.structured_data.json_ld[0] as string) as {
    "@graph": Record<string, unknown>[];
  };
  assert.ok(
    classifiedGraph["@graph"].some((n) => n["@type"] === "Article"),
    "classified content type must emit an Article node",
  );
  assert.ok(
    classified.head.core_meta.some((m) => m.property === "og:type" && m.content === "article"),
    "classified content type drives og:type",
  );
});
