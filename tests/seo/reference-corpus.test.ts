// PCMS-SEO-T028 — reference fixture corpus (spec §72): every v1 semantic
// scenario driven through the full SEO pipeline — fallbacks, head model,
// structured graph, sitemap eligibility and validation — as plain
// composition input, exactly the way apps will wire it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildSitemapEntries,
  DEFAULT_SITE_SEO_DEFAULTS,
  emptySeoDocument,
  previewSeo,
  type SeoFaviconPort,
  type SeoSiteIdentity,
  type SeoSocialImagePort,
  type SitemapCandidate,
  selectOrganizationSchema,
  siteFactsFromIdentity,
  toSiteSeoDefaults,
} from "@pcms/seo";

interface CorpusEntry {
  readonly scenario: string;
  readonly entryId: string;
  readonly path: string;
  readonly contentType: string;
  readonly document: Record<string, unknown>;
  readonly facts: {
    page_title: string | null;
    intro: string | null;
    hero_image: { asset_id: string } | null;
  };
  readonly breadcrumb: readonly { name: string; url: string | null }[] | null;
  readonly article?: Record<string, unknown> | null;
  readonly video?: Record<string, unknown> | null;
  readonly locale: string;
  readonly redirect?: { statusCode: number; location: string };
  readonly expectations: Record<string, unknown>;
}
interface Corpus {
  readonly site: {
    readonly origin: string;
    readonly identity: SeoSiteIdentity;
    readonly home_entry_id: string;
  };
  readonly entries: readonly CorpusEntry[];
}

const CORPUS: Corpus = JSON.parse(readFileSync("fixtures/seo/reference-seo-corpus.json", "utf8"));

const SOCIAL: SeoSocialImagePort = {
  resolveSocialImage: async (ref) => ({
    asset_id: ref.asset_id,
    version: ref.version ?? 1,
    url: `https://cdn.example.ru/media/a/${ref.asset_id.slice(-6)}/v1/social-display-x.jpeg`,
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
    url: "https://cdn.example.ru/media/a/f/v1/favicon-x.png",
    width: 512,
    height: 512,
    mime_type: "image/png",
  }),
};

const byScenario = new Map(CORPUS.entries.map((e) => [e.scenario, e]));
const scenarios = [
  "homepage-organization",
  "generic-page",
  "service-page",
  "article",
  "news-article",
  "video-page",
  "no-hero-fallback",
  "noindex-page",
  "canonical-override",
  "redirected-old-url",
  "multilingual-readiness",
  "missing-metadata-warnings",
];

test("the corpus covers all §72 semantic scenarios", () => {
  for (const scenario of scenarios) {
    assert.ok(byScenario.has(scenario), `missing scenario: ${scenario}`);
  }
});

test("every indexable scenario previews deterministically with the expected head", async (t) => {
  for (const scenario of scenarios) {
    const entry = byScenario.get(scenario);
    assert.ok(entry != null);
    const redirect = entry.redirect;
    if (redirect != null) continue; // redirect sources have no page preview
    const preview = await previewSeo(
      { socialImage: SOCIAL, favicon: FAVICON },
      {
        entryId: entry.entryId,
        document: { ...emptySeoDocument(), ...entry.document } as never,
        facts: entry.facts,
        identity: CORPUS.site.identity,
        origin: CORPUS.site.origin,
        routeCanonicalUrl: `${CORPUS.site.origin}${entry.path}`,
        environment: "production",
        locale: entry.locale,
        openGraph: true,
        twitterCard: true,
        contentTypeKey: entry.contentType,
      },
      {
        webpage:
          (entry.expectations.graphTypes as string[] | undefined)?.includes("WebPage") === true
            ? {
                id: `${(entry.expectations.canonical as string).replace(/\/$/, "")}/#webpage`,
                name: entry.facts.page_title ?? entry.facts.intro ?? CORPUS.site.identity.site_name,
                url: entry.expectations.canonical as string,
                is_part_of: `${CORPUS.site.origin}/#website`,
                in_language: entry.locale,
              }
            : null,
        article: (entry.article ?? null) as never,
        breadcrumbs: entry.breadcrumb
          ? {
              id: `${(entry.expectations.canonical as string).replace(/\/$/, "")}/#breadcrumb`,
              items: entry.breadcrumb,
            }
          : null,
        video: (entry.video ?? null) as never,
      },
    );

    // Title + provenance expectations.
    if (entry.expectations.title !== undefined) {
      assert.equal(preview.resolved.title.value, entry.expectations.title, scenario);
    }
    if (entry.expectations.titleSource !== undefined) {
      assert.equal(preview.resolved.title.source, entry.expectations.titleSource, scenario);
    }
    if (entry.expectations.socialImageSource !== undefined) {
      assert.equal(
        preview.resolved.social_image.source,
        entry.expectations.socialImageSource,
        scenario,
      );
    }
    // Canonical + provenance.
    if (entry.expectations.canonical !== undefined) {
      assert.equal(preview.canonical.url, entry.expectations.canonical, scenario);
    }
    if (entry.expectations.canonicalSource !== undefined) {
      assert.equal(preview.canonical.source, entry.expectations.canonicalSource, scenario);
    }
    // Robots.
    if (entry.expectations.robots !== undefined) {
      assert.equal(preview.robots, entry.expectations.robots, scenario);
    }
    // OG projection.
    const og = new Map(
      preview.head.core_meta
        .filter((m) => m.property != null)
        .map((m) => [m.property as string, m.content as string]),
    );
    if (entry.expectations.ogType !== undefined) {
      assert.equal(og.get("og:type"), entry.expectations.ogType, scenario);
    }
    if (entry.expectations.ogLocale !== undefined) {
      assert.equal(og.get("og:locale"), entry.expectations.ogLocale, scenario);
    }
    // Missing metadata diagnostics.
    for (const code of (entry.expectations.diagnostics as string[] | undefined) ?? []) {
      assert.ok(
        preview.diagnostics.some((d) => d.code === code),
        `${scenario}: ${code}`,
      );
    }
    // Graph composition (site-level org selection: LocalBusiness normalization).
    if (entry.expectations.graphTypes !== undefined) {
      const actual = preview.structured_data.nodes.map((n) => {
        const type = n["@type"];
        return Array.isArray(type) ? (type[0] as string) : (type as string);
      });
      assert.deepEqual(actual, entry.expectations.graphTypes, scenario);
    }
  }
  void t;
});

test("local business selection: the corpus identity emits LocalBusiness, not Organization (§34)", () => {
  const selection = selectOrganizationSchema(CORPUS.site.identity);
  assert.equal(selection.type, "LocalBusiness");
  const facts = siteFactsFromIdentity(CORPUS.site.identity, CORPUS.site.origin);
  assert.ok(facts.organization != null);
  assert.equal(facts.organization?.url, CORPUS.site.origin);
  assert.deepEqual(facts.organization?.local_business, CORPUS.site.identity.local_business);
});

test("sitemap eligibility follows the corpus: redirects, noindex and canonical consolidations excluded", async () => {
  const candidates: SitemapCandidate[] = [];
  const compositionExcluded: { entryId: string; reason: string }[] = [];
  for (const entry of CORPUS.entries) {
    if (entry.redirect != null) {
      compositionExcluded.push({ entryId: entry.entryId, reason: "redirect_source" });
      continue;
    }
    const doc = { ...emptySeoDocument(), ...entry.document } as never as {
      robots_policy?: { index: boolean } | null;
      canonical_override?: string | null;
    };
    if (doc.robots_policy?.index === false) {
      compositionExcluded.push({ entryId: entry.entryId, reason: "not_composition_candidate" });
      continue;
    }
    if (
      doc.canonical_override != null &&
      doc.canonical_override !== `${CORPUS.site.origin}${entry.path}`
    ) {
      // Consolidation override: the target page lists itself, not this alias.
      compositionExcluded.push({
        entryId: entry.entryId,
        reason: "canonical_override_consolidation",
      });
      continue;
    }
    candidates.push({
      entryId: entry.entryId,
      path: entry.path,
      lastmod: null,
      noindex: false,
      eligibility: { public: true, http200: true },
    });
  }
  const result = buildSitemapEntries({ origin: CORPUS.site.origin, candidates });
  const listed = new Set(result.urls.map((u) => u.loc));
  for (const entry of CORPUS.entries) {
    const expected = entry.expectations.inSitemap as boolean | undefined;
    const isCandidate = candidates.some((c) => c.entryId === entry.entryId);
    if (expected === undefined) continue;
    assert.equal(
      isCandidate && listed.has(`${CORPUS.site.origin}${entry.path}`),
      expected,
      entry.scenario,
    );
  }
  const excluded = new Map(compositionExcluded.map((e) => [e.entryId, e.reason]));
  assert.equal(excluded.get("0195fdc0-0000-7000-8000-00000000000a"), "redirect_source");
  assert.equal(excluded.get("0195fdc0-0000-7000-8000-000000000008"), "not_composition_candidate");
  assert.equal(
    excluded.get("0195fdc0-0000-7000-8000-000000000009"),
    "canonical_override_consolidation",
  );
});

test("defaults mapping for the corpus identity matches the fallback chains", () => {
  const defaults = toSiteSeoDefaults(CORPUS.site.identity);
  assert.deepEqual(defaults, {
    ...DEFAULT_SITE_SEO_DEFAULTS,
    site_name: "Пример",
    title_pattern: "{page_title} — {site_name}",
    default_social_image: { asset_id: "0195fdc0-0000-7000-8000-00000000f003" },
  });
});
