// PCMS-SEO-T005 — SeoHeadViewModel. The core-protected head model is field-
// compatible with the M03 themes HeadViewModel; composition drops it in
// together with the theme slot. Provenance explains every value.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSeoHeadModel,
  DEFAULT_SITE_SEO_DEFAULTS,
  emptySeoDocument,
  type SeoDocument,
} from "@pcms/seo";
import { assembleHeadHtml, type HeadViewModel } from "@pcms/themes";

const ROUTE_URL = "https://example.ru/services/audit/";

function build(doc: Partial<SeoDocument> = {}, overrides = {}) {
  return buildSeoHeadModel({
    document: { ...emptySeoDocument(), ...doc },
    facts: { page_title: "Аудит", intro: "Intro", hero_image: null },
    site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "Example" },
    routeCanonicalUrl: ROUTE_URL,
    ...overrides,
  });
}

test("head model resolves title/description/canonical/robots with provenance", () => {
  const { head, resolved, canonical_source } = build({
    seo_title: "SEO заголовок",
    meta_description: "Описание",
    robots_policy: { index: false, follow: true },
  });
  assert.equal(head.title, "SEO заголовок");
  assert.deepEqual(head.core_meta, [{ name: "description", content: "Описание" }]);
  assert.equal(head.canonical, ROUTE_URL);
  assert.equal(head.robots, "noindex");
  assert.deepEqual(head.json_ld, []);
  assert.equal(canonical_source, "canonical_route");
  const sources = Object.fromEntries(head.provenance.map((p) => [p.field, p.source]));
  assert.equal(sources.title, "seo_title");
  assert.equal(sources.description, "meta_description");
  assert.equal(sources.social_title, "seo_title");
  assert.equal(sources.canonical, "canonical_route");
  // No explicit/hero/site-default social image in this fixture.
  assert.deepEqual(
    resolved.diagnostics.map((d) => d.code),
    ["SEO_SOCIAL_IMAGE_MISSING"],
  );
  assert.deepEqual(head.diagnostics, resolved.diagnostics);
});

test("fallbacks flow into the head model with their own provenance", () => {
  const { head } = build();
  assert.equal(head.title, "Аудит");
  assert.deepEqual(head.core_meta, [{ name: "description", content: "Intro" }]);
  const sources = Object.fromEntries(head.provenance.map((p) => [p.field, p.source]));
  assert.equal(sources.title, "page_title");
  assert.equal(sources.description, "intro");
});

test("invalid canonical override and missing canonical surface diagnostics", () => {
  const bad = build({ canonical_override: "javascript:alert(1)" });
  assert.ok(bad.head.diagnostics.some((d) => d.code === "SEO_CANONICAL_INVALID"));
  assert.equal(bad.head.canonical, "javascript:alert(1)"); // stored value stays, validation flags it

  const missing = buildSeoHeadModel({
    document: null,
    facts: { page_title: "X", intro: null, hero_image: null },
    site: DEFAULT_SITE_SEO_DEFAULTS,
    routeCanonicalUrl: null,
  });
  assert.ok(missing.head.diagnostics.some((d) => d.code === "SEO_CANONICAL_MISSING"));
  assert.equal(missing.head.canonical, null);
});

test("robots conflicts surface in head diagnostics", () => {
  const { head } = build({
    robots_policy: { index: true, follow: true, nosnippet: true, max_snippet: 10 },
  });
  assert.ok(head.diagnostics.some((d) => d.code === "SEO_ROBOTS_CONFLICT"));
});

test("the model drops into the themes HeadViewModel and renders core-first", () => {
  const { head } = build({
    seo_title: "T",
    meta_description: "D",
    robots_policy: { index: false, follow: false },
  });
  const viewModel: HeadViewModel = {
    title: head.title,
    core_meta: head.core_meta,
    canonical: head.canonical,
    robots: head.robots,
    json_ld: head.json_ld,
    theme_slots: [{ kind: "meta", attributes: { name: "theme-color", content: "#3060f0" } }],
  };
  const html = assembleHeadHtml(viewModel);
  const lines = html.split("\n");
  assert.equal(lines[0], "<title>T</title>");
  assert.ok(lines[1]?.startsWith('<meta name="description" content="D">'));
  assert.equal(lines[3], `<meta name="robots" content="noindex, nofollow">`);
  assert.ok(lines.join("\n").endsWith('<meta name="theme-color" content="#3060f0">'));
});

test("building is deterministic for identical input", () => {
  const a = build({ seo_title: "T" });
  const b = build({ seo_title: "T" });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
