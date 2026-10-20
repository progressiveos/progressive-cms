// PCMS-SEO-T026 — site validation report (spec §57/§58): duplicate meta,
// noindex pages leaking into the sitemap (error), canonical/sitemap
// disagreement, and deterministic severity-ordered output.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SITE_SEO_DEFAULTS,
  resolveSeoMetadata,
  type SeoResolvedPage,
  type SiteSeoAuditInput,
  validateSiteSeo,
} from "@pcms/seo";

function page(entryId: string, title: string, indexable = true): SeoResolvedPage {
  return {
    entryId,
    resolved: resolveSeoMetadata(
      null,
      { page_title: title, intro: `intro ${entryId}`, hero_image: null },
      DEFAULT_SITE_SEO_DEFAULTS,
    ),
    indexable,
  };
}

const BASE: SiteSeoAuditInput = {
  pages: [page("a", "Alpha"), page("b", "Beta"), page("c", "Gamma", false)],
  canonicalByEntry: new Map([
    ["a", "https://example.ru/a/"],
    ["b", "https://example.ru/b/"],
    ["c", "https://example.ru/c/"],
  ]),
  // The sitemap builder already excluded the noindex page "c".
  sitemapUrls: [
    { entryId: "a", loc: "https://example.ru/a/" },
    { entryId: "b", loc: "https://example.ru/b/" },
  ],
};

test("a consistent site yields no issues", () => {
  assert.deepEqual(validateSiteSeo(BASE), []);
});

test("a noindex page kept in the sitemap is an error (§58)", () => {
  const issues = validateSiteSeo({
    ...BASE,
    sitemapUrls: [...BASE.sitemapUrls, { entryId: "c", loc: "https://example.ru/c/" }],
  });
  const leak = issues.find((i) => i.code === "SEO_NOINDEX_IN_SITEMAP");
  assert.ok(leak);
  assert.equal(leak.severity, "error");
  assert.deepEqual(leak.details, { entryId: "c", loc: "https://example.ru/c/" });
});

test("sitemap loc disagreeing with the canonical is an error with details", () => {
  const issues = validateSiteSeo({
    ...BASE,
    sitemapUrls: [{ entryId: "a", loc: "https://example.ru/old-a/" }],
  });
  const mismatch = issues.find((i) => i.code === "SEO_CANONICAL_MISMATCH");
  assert.ok(mismatch);
  assert.equal(mismatch.severity, "error");
  assert.deepEqual(mismatch.details, { entryId: "a" });
});

test("duplicate titles surface as warnings; errors sort before warnings; deterministic", () => {
  const input: SiteSeoAuditInput = {
    ...BASE,
    pages: [page("a", "Same"), page("b", "Same"), page("c", "Gamma", false)],
    sitemapUrls: [
      { entryId: "a", loc: "https://example.ru/other-a/" },
      { entryId: "c", loc: "https://example.ru/c/" },
    ],
  };
  const a = validateSiteSeo(input);
  const b = validateSiteSeo(input);
  assert.deepEqual(a, b);
  const codes = a.map((i) => i.code);
  assert.ok(codes.includes("SEO_DUPLICATE_TITLE"));
  assert.ok(codes.includes("SEO_NOINDEX_IN_SITEMAP"));
  assert.ok(codes.includes("SEO_CANONICAL_MISMATCH"));
  assert.deepEqual(
    a.map((i) => i.severity),
    ["error", "error", "warning"],
  );
});
