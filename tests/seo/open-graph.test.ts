// PCMS-SEO-T007 — Open Graph baseline + image metadata (spec §23/§24/§25).
// OG is a projection of the one social model; image metadata only carries
// facts the Media provider actually supplied; hostile strings stay data.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSeoHeadModel,
  DEFAULT_SITE_SEO_DEFAULTS,
  emptySeoDocument,
  resolveOgType,
  type SocialImageViewModel,
} from "@pcms/seo";
import { assembleHeadHtml, type HeadViewModel } from "@pcms/themes";

const IMAGE: SocialImageViewModel = {
  asset_id: "0195fdc0-7a5e-7000-8000-000000000001",
  version: 2,
  url: "https://cdn.example.ru/media/a/0195fdc0/v2/social-display-abc123.jpeg",
  width: 1200,
  height: 630,
  mime_type: "image/jpeg",
  alt: "Фото офиса",
};

function tagsOf(input: Parameters<typeof buildSeoHeadModel>[0]): Map<string, string> {
  const { head } = buildSeoHeadModel(input);
  return new Map(
    head.core_meta.filter((m) => m.property != null).map((m) => [m.property as string, m.content]),
  );
}

test("required OG baseline is present when a page is public", () => {
  const tags = tagsOf({
    document: null,
    facts: { page_title: "Услуги", intro: "Intro", hero_image: null },
    site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "Example" },
    routeCanonicalUrl: "https://example.ru/services/",
    openGraph: true,
    locale: "ru-RU",
  });
  assert.equal(tags.get("og:title"), "Услуги");
  assert.equal(tags.get("og:type"), "website");
  assert.equal(tags.get("og:url"), "https://example.ru/services/");
  assert.equal(tags.get("og:description"), "Intro");
  assert.equal(tags.get("og:site_name"), "Example");
  assert.equal(tags.get("og:locale"), "ru-RU");
  // No image facts → no og:image* tags at all.
  assert.ok(![...tags.keys()].some((k) => k.startsWith("og:image")));
});

test("og:image metadata carries exactly the media provider facts (§24)", () => {
  const tags = tagsOf({
    document: { ...emptySeoDocument(), social_image: { asset_id: IMAGE.asset_id } },
    facts: { page_title: "T", intro: null, hero_image: null },
    site: DEFAULT_SITE_SEO_DEFAULTS,
    routeCanonicalUrl: "https://example.ru/a/",
    openGraph: true,
    socialImage: IMAGE,
  });
  assert.equal(tags.get("og:image"), IMAGE.url);
  assert.equal(tags.get("og:image:secure_url"), IMAGE.url);
  assert.equal(tags.get("og:image:type"), "image/jpeg");
  assert.equal(tags.get("og:image:width"), "1200");
  assert.equal(tags.get("og:image:height"), "630");
  // Alt comes from Media alt semantics, never from the social description.
  assert.equal(tags.get("og:image:alt"), "Фото офиса");
});

test("unresolvable social image references surface SEO_SOCIAL_IMAGE_INVALID", () => {
  const { head } = buildSeoHeadModel({
    document: { ...emptySeoDocument(), social_image: { asset_id: IMAGE.asset_id } },
    facts: { page_title: "T", intro: null, hero_image: null },
    site: DEFAULT_SITE_SEO_DEFAULTS,
    routeCanonicalUrl: "https://example.ru/a/",
    openGraph: true,
    socialImage: null,
  });
  assert.ok(
    head.diagnostics.some((d) => d.code === "SEO_SOCIAL_IMAGE_INVALID" && d.severity === "warning"),
  );
});

test("og:url equals the canonical by construction (§10)", () => {
  const tags = tagsOf({
    document: null,
    facts: { page_title: "T", intro: null, hero_image: null },
    site: DEFAULT_SITE_SEO_DEFAULTS,
    routeCanonicalUrl: "https://example.ru/canonical/",
    openGraph: true,
  });
  assert.equal(tags.get("og:url"), "https://example.ru/canonical/");
});

test("OG type mapping follows the hint, not the theme (§25)", () => {
  assert.equal(resolveOgType({ structuredDataHint: "news_article" }), "article");
  assert.equal(resolveOgType({ structuredDataHint: null, contentTypeKey: "news" }), "website");
  assert.equal(
    resolveOgType({
      structuredDataHint: null,
      contentTypeKey: "news",
      articleContentTypes: ["news", "post"],
    }),
    "article",
  );
});

test("hostile social strings render as escaped data through the themes boundary", () => {
  const { head } = buildSeoHeadModel({
    document: { ...emptySeoDocument(), social_title: '"><script>alert(1)</script>' },
    facts: { page_title: "T", intro: null, hero_image: null },
    site: DEFAULT_SITE_SEO_DEFAULTS,
    routeCanonicalUrl: "https://example.ru/a/",
    openGraph: true,
    socialImage: IMAGE,
  });
  const viewModel: HeadViewModel = {
    title: head.title,
    core_meta: head.core_meta,
    canonical: head.canonical,
    robots: head.robots,
    json_ld: head.json_ld,
    theme_slots: [],
  };
  const html = assembleHeadHtml(viewModel);
  assert.ok(html.includes('<meta property="og:title" content="&quot;&gt;&lt;script&gt;'));
  assert.ok(!html.includes("<script>alert(1)"), "raw script must not appear");
});
