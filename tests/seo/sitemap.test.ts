// PCMS-SEO-T018 — sitemap generator (spec §15): only public, published,
// canonical, indexable 200-URLs; full machine-readable exclusion report;
// noindex/drafts/redirects/410 never listed; request Host can never appear.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSitemapEntries, renderSitemapXml, SeoError, type SitemapCandidate } from "@pcms/seo";

const ELIGIBLE: SitemapCandidate = {
  entryId: "01900000-0000-7000-8000-000000000001",
  path: "/services/",
  lastmod: "2026-09-10T08:00:00Z",
  noindex: false,
  eligibility: { public: true, http200: true },
};

function candidate(overrides: Partial<SitemapCandidate>): SitemapCandidate {
  return { ...ELIGIBLE, ...overrides };
}

test("eligible URLs render absolute locs from the configured origin, sorted by path", () => {
  const result = buildSitemapEntries({
    origin: "https://example.ru",
    candidates: [
      candidate({ path: "/b/", entryId: "01900000-0000-7000-8000-000000000002" }),
      ELIGIBLE,
    ],
  });
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(
    result.urls.map((u) => u.loc),
    ["https://example.ru/services/", "https://example.ru/b/"].sort(),
  );
  assert.equal(result.urls[1]?.lastmod, "2026-09-10T08:00:00Z");
});

test("drafts, 410 targets, noindex and non-canonical paths are excluded with reasons", () => {
  const result = buildSitemapEntries({
    origin: "https://example.ru",
    candidates: [
      candidate({ eligibility: { public: false, http200: true }, path: "/draft/" }),
      candidate({ eligibility: { public: true, http200: false }, path: "/gone/" }),
      candidate({ noindex: true, path: "/hidden/" }),
      candidate({ path: "/bad?query=1/" }),
      ELIGIBLE,
    ],
  });
  assert.deepEqual(result.excluded.map((e) => e.reason).sort(), [
    "noindex",
    "not_http_200",
    "not_public",
    "path_not_canonical",
  ]);
  assert.deepEqual(result.urls, [
    { loc: "https://example.ru/services/", lastmod: "2026-09-10T08:00:00Z" },
  ]);
  assert.ok(
    result.diagnostics.every(
      (d) => d.code === "SEO_SITEMAP_INELIGIBLE" && d.severity === "warning",
    ),
  );
  const reasons = result.diagnostics.map((d) => (d.details as { reason: string }).reason);
  assert.ok(reasons.includes("noindex"));
});

test("XML output is deterministic and escaped; bad lastmod is rejected", () => {
  const xml = renderSitemapXml([
    { loc: "https://example.ru/a?x=1&y=2", lastmod: "2026-09-10T08:00:00Z" },
  ]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes("<loc>https://example.ru/a?x=1&amp;y=2</loc>"));
  assert.ok(xml.includes("<lastmod>2026-09-10T08:00:00Z</lastmod>"));
  assert.ok(!xml.includes("<changefreq>"), "changefreq omitted by default (§18)");
  assert.ok(!xml.includes("<priority>"), "priority omitted by default (§18)");
  assert.equal(
    renderSitemapXml([]).endsWith(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>',
    ),
    true,
  );

  const badLastmod = buildSitemapEntries({
    origin: "https://example.ru",
    candidates: [candidate({ lastmod: "yesterday" })],
  });
  assert.deepEqual(badLastmod.urls, []);
  assert.ok(
    badLastmod.diagnostics.some(
      (d) => d.code === "SEO_SITEMAP_INPUT_INVALID" && d.severity === "error",
    ),
  );
});

test("origin must be absolute http(s); hostile origins rejected (no request Host path)", () => {
  for (const origin of [
    "example.ru",
    "javascript:alert(1)",
    "https://evil.example/?x=1",
    "/relative/",
  ]) {
    assert.throws(
      () => buildSitemapEntries({ origin, candidates: [] }),
      (err: unknown) => err instanceof SeoError && err.code === "SEO_SITEMAP_INPUT_INVALID",
      origin,
    );
  }
});
