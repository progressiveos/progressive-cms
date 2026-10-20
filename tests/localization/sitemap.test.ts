// Sitemap hreflang alternates (opt-in multilingual §31): the pure builder
// emits xhtml:link alternates for locale candidates; single-language sitemaps
// stay byte-identical (no xhtml namespace). No DB needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSitemapEntries, renderSitemapXml } from "@pcms/seo";

test("multilingual candidates emit reciprocal alternates + xhtml namespace", () => {
  const result = buildSitemapEntries({
    origin: "https://example.org",
    candidates: [
      {
        entryId: "01900000-0000-7000-8000-000000000001",
        path: "/services/erp/",
        lastmod: "2026-09-24T00:00:00.000Z",
        noindex: false,
        eligibility: { public: true, http200: true },
        alternates: [
          { hreflang: "ru-RU", href: "https://example.org/services/erp/" },
          { hreflang: "en-US", href: "https://example.org/en/services/erp-en/" },
        ],
      },
      {
        entryId: "01900000-0000-7000-8000-000000000002",
        path: "/en/services/erp-en/",
        lastmod: "2026-09-24T00:00:00.000Z",
        noindex: false,
        eligibility: { public: true, http200: true },
        alternates: [
          { hreflang: "ru-RU", href: "https://example.org/services/erp/" },
          { hreflang: "en-US", href: "https://example.org/en/services/erp-en/" },
        ],
      },
    ],
  });
  assert.equal(result.urls.length, 2);
  const xml = renderSitemapXml(result.urls);
  assert.ok(xml.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'));
  assert.ok(xml.includes("<loc>https://example.org/services/erp/</loc>"));
  assert.ok(xml.includes("<loc>https://example.org/en/services/erp-en/</loc>"));
  assert.equal(xml.match(/xhtml:link/g)?.length, 4);
  assert.ok(xml.includes('hreflang="ru-RU"'));
  assert.ok(xml.includes('hreflang="en-US"'));
});

test("single-language sitemap stays unchanged (no namespace, no alternates)", () => {
  const result = buildSitemapEntries({
    origin: "https://example.org",
    candidates: [
      {
        entryId: "01900000-0000-7000-8000-000000000001",
        path: "/services/erp/",
        lastmod: null,
        noindex: false,
        eligibility: { public: true, http200: true },
      },
    ],
  });
  const xml = renderSitemapXml(result.urls);
  assert.ok(!xml.includes("xhtml"));
  assert.ok(xml.includes("<loc>https://example.org/services/erp/</loc>"));
});
