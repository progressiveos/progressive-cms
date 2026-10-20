// PCMS-SEO-T027 — agent discovery hooks/scopes contract (spec §61/§71).
// Agents inspect the SEO schema without guesses, validate and preview before
// publish, and every operation names its required scope.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSeoDiscovery,
  defaultRobotsTxtPolicy,
  emptySeoDocument,
  SEO_AGENT_SCOPES,
  SEO_DIAGNOSTIC_CODES,
  type SeoCanonicalPort,
  type SeoDiscoveryDeps,
  type SeoFaviconPort,
  type SeoSocialImagePort,
} from "@pcms/seo";

const ENTRY = "01900000-0000-7000-8000-000000000001";
const FAVICON_ASSET = "0195fdc0-7a5e-7000-8000-000000000002";
const ASSET = "0195fdc0-7a5e-7000-8000-000000000003";

const SOCIAL: SeoSocialImagePort = {
  resolveSocialImage: async (ref) => ({
    asset_id: ref.asset_id,
    version: ref.version ?? 1,
    url: `https://cdn.example.ru/m/a/x/v1/social-x.jpeg`,
    width: 1200,
    height: 630,
    mime_type: "image/jpeg",
    alt: "обложка",
  }),
};
const FAVICON: SeoFaviconPort = {
  resolveFavicon: async (ref) => ({
    asset_id: ref.asset_id,
    version: 1,
    url: "https://cdn.example.ru/m/f/v1/favicon.png",
    width: 512,
    height: 512,
    mime_type: "image/png",
  }),
};

function makeDeps(overrides: Partial<SeoDiscoveryDeps> = {}): SeoDiscoveryDeps {
  const documents = new Map([[ENTRY, { ...emptySeoDocument(), seo_title: "Заголовок записи" }]]);
  return {
    store: {
      getDocument: async (id) => documents.get(id) ?? null,
      saveDocument: async () => {},
      saveDocumentWithinTx: async () => {},
      deleteDocument: async () => {},
      listDocuments: async () => [],
      getSiteSettings: async () => null,
      saveSiteSettings: async () => {},
    },
    environment: "production",
    getSiteIdentity: async () => ({ site_name: "Пример", favicon: { asset_id: FAVICON_ASSET } }),
    getOrigin: async () => "https://example.ru",
    canonical: {
      canonicalUrl: async (id) => (id === ENTRY ? "https://example.ru/news/x/" : null),
    } satisfies SeoCanonicalPort,
    getFacts: async (id) =>
      id === ENTRY ? { page_title: "Заголовок", intro: "Интро записи.", hero_image: null } : null,
    socialImage: SOCIAL,
    favicon: FAVICON,
    getSitemapCandidates: async () => [
      {
        entryId: ENTRY,
        path: "/news/x/",
        lastmod: "2026-09-01T10:00:00Z",
        noindex: false,
        eligibility: { public: true, http200: true },
      },
    ],
    getRobotsPolicy: async () =>
      defaultRobotsTxtPolicy({ sitemapUrl: "https://example.ru/sitemap.xml" }),
    ...overrides,
  };
}

test("the schema descriptor exposes the exact §3 fields, hints and directives", () => {
  const discovery = createSeoDiscovery(makeDeps());
  const schema = discovery.getSeoSchema();
  assert.deepEqual(
    schema.fields.map((f) => f.name),
    [
      "seo_title",
      "meta_description",
      "canonical_override",
      "robots_policy",
      "social_title",
      "social_description",
      "social_image",
      "structured_data_type_hint",
    ],
  );
  assert.ok(schema.fields.every((f) => f.description.length > 0));
  assert.ok(schema.structured_data_type_hints.includes("news_article"));
  assert.ok(schema.robots_directives.includes("max_image_preview"));
});

test("operations carry stable names and scopes; the scope registry is bounded", () => {
  const discovery = createSeoDiscovery(makeDeps());
  assert.equal(discovery.scopes, SEO_AGENT_SCOPES);
  const names = discovery.operations.map((o) => o.name);
  for (const expected of [
    "get_seo_schema",
    "resolve_seo_metadata",
    "preview_seo",
    "validate_seo",
    "get_site_identity",
    "get_indexing_policy",
    "get_sitemap_status",
    "get_robots_policy",
  ]) {
    assert.ok(names.includes(expected), expected);
  }
  // Privileged operations never map to the read scope.
  const validate = discovery.operations.find((o) => o.name === "validate_seo");
  assert.equal(validate?.scope, "seo.validate");
  assert.ok(SEO_AGENT_SCOPES.includes("seo.canonical_override"));
});

test("resolve/preview/validate answer with provenance before publish (agent flow)", async () => {
  const discovery = createSeoDiscovery(makeDeps());
  const resolved = await discovery.resolveSeoMetadataFor(ENTRY);
  assert.equal(resolved?.resolved.title.source, "seo_title");
  assert.equal(resolved?.robots, null);

  const preview = await discovery.previewSeoFor(ENTRY, {
    openGraph: true,
    twitterCard: true,
    locale: "ru-RU",
  });
  assert.ok(
    preview?.head.core_meta.some(
      (m) => m.property === "og:title" && m.content === "Заголовок записи",
    ),
  );
  assert.ok(preview?.head.icons.some((i) => i.rel === "icon"));
  assert.ok(
    preview !== null && JSON.parse(preview.structured_data.json_ld[0] as string) !== undefined,
  );

  const report = await discovery.validateSeoFor(ENTRY);
  assert.ok(report !== null);
  // 0.1.196: counts include the OG/canonical issues appended after the base
  // report (the fixture carries no OG image → at least one error-severity
  // issue), so counts.error can no longer disagree with the issue list.
  const errorCount = report.issues.filter((i) => i.severity === "error").length;
  assert.ok(errorCount >= 1);
  assert.equal(report?.counts.error, errorCount);
  assert.ok(report.issues.every((i) => SEO_DIAGNOSTIC_CODES.includes(i.code as never)));

  assert.equal(await discovery.resolveSeoMetadataFor("01900000-0000-7000-8000-0000000000ff"), null);
});

test("site default social image reaches preview and validation (explicit → hero → default)", async () => {
  // Owner defect (2026-10-08): the site default appeared in resolved metadata
  // but never in the preview/public OG tags. The chain explicit → hero →
  // site default must resolve ONE ref for every surface.
  const deps = makeDeps({
    getSiteIdentity: async () => ({
      site_name: "Пример",
      favicon: { asset_id: FAVICON_ASSET },
      default_social_image: { asset_id: ASSET },
    }),
  });
  const discovery = createSeoDiscovery(deps);

  const resolvedMeta = await discovery.resolveSeoMetadataFor(ENTRY);
  assert.equal(resolvedMeta?.resolved.social_image.source, "site_default_social_image");

  const preview = await discovery.previewSeoFor(ENTRY, {
    openGraph: true,
    twitterCard: true,
  });
  assert.ok(
    preview?.head.core_meta.some(
      (m) => m.property === "og:image" && (m.content ?? "").includes("social-x"),
    ),
  );

  const report = await discovery.validateSeoFor(ENTRY);
  assert.ok(report !== null);
  assert.ok(!report.issues.some((i) => i.code === "OG_IMAGE_MISSING"));
});

test("indexing policy exposes the environment guard and sitemap status is a summary", async () => {
  const discovery = createSeoDiscovery(makeDeps({ environment: "staging" }));
  const policy = await discovery.getIndexingPolicy(ENTRY);
  assert.equal(policy?.indexable, false);
  assert.equal(policy?.environment_guarded, true);
  assert.equal(policy?.robots, "noindex");

  const status = await discovery.getSitemapStatus();
  assert.equal(status.environment_indexable, false);
  assert.equal(status.candidates, 1);
  assert.equal(status.included, 0, "non-production sitemap excludes everything");

  const robots = await discovery.getRobotsPolicy();
  assert.equal(robots.sitemap_url, "https://example.ru/sitemap.xml");
});

test("site identity serves the public subset (no verification records)", async () => {
  const discovery = createSeoDiscovery(makeDeps());
  const identity = await discovery.getSiteIdentity();
  assert.equal(identity?.site_name, "Пример");
  assert.ok(!("verification" in (identity ?? {})));
});

test("getSitemapDocument renders XML in production and refuses elsewhere (M17 §44)", async () => {
  const production = createSeoDiscovery(makeDeps());
  const document = await production.getSitemapDocument();
  assert.ok(document?.includes("<urlset"));
  assert.ok(document?.includes("https://example.ru/news/x/"));
  assert.ok(document?.includes("2026-09-01"));

  const staging = createSeoDiscovery(makeDeps({ environment: "staging" }));
  assert.equal(await staging.getSitemapDocument(), null);

  const noOrigin = createSeoDiscovery(makeDeps({ getOrigin: async () => null }));
  assert.equal(await noOrigin.getSitemapDocument(), null);
});

test("verification projections are server-only: meta list and proof files", async () => {
  const deps = makeDeps({
    getSiteIdentity: async () => ({
      site_name: "Пример",
      verification: [
        { provider: "google", content: "g-token" },
        { provider: "yandex", content: "y-token" },
        { provider: "other", content: "o-token" },
        {
          provider: "google",
          content: "g-file-token",
          method: "file",
          file: {
            filename: "google1a2b3c4d5e6f7a8b.html",
            body: "google-site-verification: g-file-token",
          },
        },
        {
          provider: "yandex",
          content: "y-file-token",
          method: "file",
          file: { filename: "yandex_5a24bfc8483b6e17.html", body: "y-file-token" },
        },
      ],
    }),
  });
  const discovery = createSeoDiscovery(deps);
  // Agent-facing identity stays stripped.
  const identity = await discovery.getSiteIdentity();
  assert.equal("verification" in (identity ?? {}), false);
  // Meta projection: exactly the two provider meta tags (no "other", no files).
  assert.deepEqual(await discovery.getSiteVerificationMeta(), [
    { name: "google-site-verification", content: "g-token" },
    { name: "yandex-verification", content: "y-token" },
  ]);
  // File projection: exact stored filename/body pairs.
  assert.deepEqual(await discovery.getOwnershipProofFiles(), [
    { filename: "google1a2b3c4d5e6f7a8b.html", body: "google-site-verification: g-file-token" },
    { filename: "yandex_5a24bfc8483b6e17.html", body: "y-file-token" },
  ]);
  // The projections are not agent operations.
  assert.equal(
    discovery.operations.some((operation) => operation.name.includes("verification")),
    false,
    "verification projections stay off the agent surface",
  );
});
