// PCMS-SEO-T021 — staging/global noindex guard (spec §13). Non-production
// environments are always noindex regardless of page policy or theme input;
// production keeps the page policy verbatim.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEnvironmentGuard,
  buildSeoHeadModel,
  DEFAULT_SITE_SEO_DEFAULTS,
  emptySeoDocument,
  environmentAllowsIndexing,
  type SeoDocument,
} from "@pcms/seo";
import { assembleHeadHtml, type HeadViewModel } from "@pcms/themes";

function headFor(
  environment: "production" | "staging" | "development",
  doc: Partial<SeoDocument> = {},
) {
  return buildSeoHeadModel({
    document: { ...emptySeoDocument(), ...doc },
    facts: { page_title: "T", intro: null, hero_image: null },
    site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "S" },
    routeCanonicalUrl: "https://staging.example.ru/",
    environment,
  }).head;
}

test("non-production environments are never indexable — guard only tightens", () => {
  assert.equal(environmentAllowsIndexing("production"), true);
  assert.equal(environmentAllowsIndexing("staging"), false);
  assert.equal(environmentAllowsIndexing("development"), false);

  assert.equal(headFor("staging").robots, "noindex");
  assert.equal(headFor("development").robots, "noindex");
  // An explicit indexable page policy cannot override the guard.
  assert.equal(
    headFor("staging", { robots_policy: { index: true, follow: true } }).robots,
    "noindex",
  );
  // The guard preserves the page's other directives.
  assert.equal(
    headFor("staging", { robots_policy: { index: true, follow: false } }).robots,
    "noindex, nofollow",
  );
});

test("production keeps the page policy verbatim and emits no guard provenance", () => {
  const clean = headFor("production");
  assert.equal(clean.robots, null);
  assert.ok(!clean.provenance.some((p) => p.field === "robots"));

  const noindex = headFor("production", { robots_policy: { index: false, follow: true } });
  assert.equal(noindex.robots, "noindex");
  assert.ok(!noindex.provenance.some((p) => p.field === "robots"));
});

test("the guard provenance is explicit for agents/admin (no silent magic)", () => {
  const guarded = headFor("staging");
  const robots = guarded.provenance.find((p) => p.field === "robots");
  assert.equal(robots?.source, "environment_guard");
});

test("guard merge is policy-faithful on production", () => {
  const policy = { index: true, follow: true, noarchive: true, max_snippet: 50 };
  assert.deepEqual(applyEnvironmentGuard(policy, "production"), { policy, guarded: false });
  assert.deepEqual(applyEnvironmentGuard(null, "production"), {
    policy: { index: true, follow: true },
    guarded: false,
  });
});

test("a staging fixture renders a non-indexable page end to end", () => {
  const head = headFor("staging");
  const html = assembleHeadHtml({
    title: head.title,
    core_meta: head.core_meta,
    canonical: head.canonical,
    robots: head.robots,
    json_ld: head.json_ld,
    theme_slots: [],
  } satisfies HeadViewModel);
  assert.ok(html.includes('<meta name="robots" content="noindex">'));
});
