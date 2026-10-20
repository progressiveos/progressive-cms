// PCMS-SEO-T022 — validation service: one machine-readable report, stable
// codes, deterministic severity-ordered output, advisory heuristics never
// hide errors. Length checks are diagnostics, never destructive truncation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeStructuredData,
  DEFAULT_SITE_SEO_DEFAULTS,
  emptySeoDocument,
  SEO_DIAGNOSTIC_CODES,
  SEO_ERROR_CODES,
  type SeoValidationInput,
  validateSeoPage,
} from "@pcms/seo";

const BASE: SeoValidationInput = {
  entryId: "01900000-0000-7000-8000-000000000001",
  document: null,
  facts: {
    page_title: "Обычный заголовок страницы",
    intro: "Обычное интро достаточной длины.",
    hero_image: null,
  },
  site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "Пример" },
  routeCanonicalUrl: "https://example.ru/page/",
  socialImage: null,
  favicon: null,
  faviconDeclared: false,
  environment: "production",
  structuredData: null,
};

test("a healthy page produces no errors; reports carry counts and resolved values", () => {
  const report = validateSeoPage(BASE);
  assert.equal(report.counts.error, 0);
  assert.equal(report.robots, null);
  assert.equal(report.canonical_source, "canonical_route");
  assert.equal(report.resolved.title.value, "Обычный заголовок страницы");
  // Advisory-only expectations for the fixture: missing favicon/social image.
  assert.ok(report.issues.every((i) => i.severity !== "error"));
});

test("invalid canonical override and broken JSON-LD surface as errors", () => {
  const report = validateSeoPage({
    ...BASE,
    document: { ...emptySeoDocument(), canonical_override: "javascript:alert(1)" },
    structuredData: composeStructuredData({
      website: { id: "bad-id", name: "X", url: "https://example.ru" },
      organization: null,
      webpage: null,
      article: null,
      breadcrumbs: null,
      video: null,
    }),
  });
  const codes = report.issues.map((i) => i.code);
  assert.ok(codes.includes("SEO_CANONICAL_INVALID"));
  assert.ok(codes.includes("SEO_STRUCTURED_DATA_INVALID"));
  assert.equal(report.counts.error, 2);
});

test("missing content diagnostics and length advisories are warning/recommendation level", () => {
  const report = validateSeoPage({
    ...BASE,
    document: { ...emptySeoDocument(), seo_title: "Короткий" },
    facts: { page_title: null, intro: null, hero_image: null },
  });
  const codes = report.issues.map((i) => i.code);
  assert.ok(codes.includes("SEO_TITLE_LENGTH"));
  assert.ok(codes.includes("SEO_DESCRIPTION_MISSING"));
  // seo_title override present → title not missing, only short.
  assert.ok(!codes.includes("SEO_TITLE_MISSING"));
  assert.equal(report.counts.error, 0);

  // No title input at all (and no site name floor? site has one) — site_name
  // covers the floor, so build a site without a name to see the missing code.
  const nameless = validateSeoPage({
    ...BASE,
    facts: { page_title: null, intro: null, hero_image: null },
    site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: null },
  });
  assert.ok(nameless.issues.some((i) => i.code === "SEO_TITLE_MISSING"));
  // Persisted values are never truncated: the long title stays whole.
  const long = validateSeoPage({
    ...BASE,
    document: { ...emptySeoDocument(), seo_title: "Д".repeat(200) },
  });
  assert.equal(long.resolved.title.value?.length, 200);
  assert.ok(long.issues.some((i) => i.code === "SEO_TITLE_LENGTH" && i.severity === "warning"));
});

test("staging guard flows into the report robots; favicon issues reported", () => {
  const report = validateSeoPage({ ...BASE, environment: "staging" });
  assert.equal(report.robots, "noindex");
  assert.ok(report.issues.some((i) => i.code === "SEO_SOCIAL_IMAGE_MISSING"));
  // Declared-but-unresolvable favicon is flagged as invalid, absent as missing.
  assert.ok(
    validateSeoPage({ ...BASE, faviconDeclared: true }).issues.some(
      (i) => i.code === "SEO_SOCIAL_IMAGE_INVALID",
    ),
  );
  assert.ok(
    validateSeoPage({ ...BASE, faviconDeclared: false }).issues.some(
      (i) => i.code === "SEO_FAVICON_MISSING",
    ),
  );
});

test("reports are deterministic and every code is registry-listed", () => {
  const a = validateSeoPage(BASE);
  const b = validateSeoPage(BASE);
  assert.deepEqual(a.issues, b.issues);
  const registry = new Set<string>([...SEO_DIAGNOSTIC_CODES]);
  for (const issue of a.issues) assert.ok(registry.has(issue.code), issue.code);
  // Error codes stay a separate, frozen registry.
  assert.ok(SEO_ERROR_CODES.includes("SEO_DOCUMENT_INVALID"));
});
