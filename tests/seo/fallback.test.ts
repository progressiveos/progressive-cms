// PCMS-SEO-T002 — deterministic fallback resolver with provenance (§4).
// Same normalized input always resolves to the same values, sources and
// diagnostics; every chain branch is pinned by a fixture-style assertion.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SITE_SEO_DEFAULTS,
  type ResolvedSeoMetadata,
  resolveSeoMetadata,
  type SemanticPageFacts,
  type SeoDocument,
  type SiteSeoDefaults,
} from "@pcms/seo";

const ASSET = "0195fdc0-7a5e-7000-8000-000000000001";
const HERO = "0195fdc0-7a5e-7000-8000-000000000002";
const DEFAULT = "0195fdc0-7a5e-7000-8000-000000000003";
const PARENT = "0195fdc0-7a5e-7000-8000-000000000004";

function resolve(
  doc: Partial<SeoDocument> = {},
  facts: Partial<SemanticPageFacts> = {},
  site: Partial<SiteSeoDefaults> = {},
): ResolvedSeoMetadata {
  return resolveSeoMetadata(
    { ...structuredClone(emptyDoc()), ...doc },
    { page_title: null, intro: null, hero_image: null, ...facts },
    { ...DEFAULT_SITE_SEO_DEFAULTS, ...site },
  );
}

const emptyDoc = (): SeoDocument => ({
  seo_title: null,
  meta_description: null,
  canonical_override: null,
  robots_policy: null,
  social_title: null,
  social_description: null,
  social_image: null,
  structured_data_type_hint: null,
});

test("title chain: seo_title → page_title → site name, with pattern applied", () => {
  assert.deepEqual(resolve({ seo_title: "T" }).title, { value: "T", source: "seo_title" });
  assert.deepEqual(resolve({}, { page_title: "P" }).title, { value: "P", source: "page_title" });
  assert.deepEqual(resolve({}, {}, { site_name: "Site" }).title, {
    value: "Site",
    source: "site_name",
  });
  assert.deepEqual(
    resolve({}, {}, { site_name: "Site", title_pattern: "{page_title} — {site_name}" }).title,
    {
      value: "Site",
      source: "site_name",
    },
  );
  const patterned = resolve(
    { seo_title: "T" },
    {},
    { site_name: "Site", title_pattern: "{page_title} — {site_name}" },
  );
  assert.deepEqual(patterned.title, {
    value: "T — Site",
    source: "seo_title",
    note: "site title pattern applied",
  });
  // A pattern without {site_name} still composes even if the site name is unset.
  assert.equal(
    resolve({ seo_title: "T" }, {}, { title_pattern: "{page_title} | CMS" }).title.value,
    "T | CMS",
  );
  const missing = resolve();
  assert.equal(missing.title.value, null);
  assert.ok(
    missing.diagnostics.some((d) => d.code === "SEO_TITLE_MISSING" && d.severity === "warning"),
  );
});

test("description chain: meta_description → intro only when policy permits", () => {
  assert.deepEqual(resolve({ meta_description: "D" }).description, {
    value: "D",
    source: "meta_description",
  });
  assert.deepEqual(resolve({}, { intro: "Intro" }).description, {
    value: "Intro",
    source: "intro",
  });
  const noPolicy = resolve({}, { intro: "Intro" }, { allow_intro_description_fallback: false });
  assert.equal(noPolicy.description.value, null);
  assert.ok(noPolicy.diagnostics.some((d) => d.code === "SEO_DESCRIPTION_MISSING"));
});

test("social chains override then fall back to the search-facing values", () => {
  const full = resolve(
    {
      seo_title: "T",
      meta_description: "D",
      social_title: "ST",
      social_description: "SD",
      social_image: { asset_id: ASSET },
    },
    { page_title: "P", intro: "I", hero_image: { asset_id: HERO } },
    { site_name: "Site", default_social_image: { asset_id: DEFAULT } },
  );
  assert.deepEqual(full.social_title, { value: "ST", source: "social_title" });
  assert.deepEqual(full.social_description, { value: "SD", source: "social_description" });
  assert.deepEqual(full.social_image, { value: { asset_id: ASSET }, source: "social_image" });

  const fallbacks = resolve({}, { page_title: "P", intro: "I", hero_image: { asset_id: HERO } });
  assert.deepEqual(fallbacks.social_title, { value: "P", source: "page_title" });
  assert.deepEqual(fallbacks.social_description, { value: "I", source: "intro" });
  assert.deepEqual(fallbacks.social_image, { value: { asset_id: HERO }, source: "hero_image" });

  const siteDefault = resolve({}, {}, { default_social_image: { asset_id: DEFAULT } });
  assert.deepEqual(siteDefault.social_image, {
    value: { asset_id: DEFAULT },
    source: "site_default_social_image",
  });

  const nothing = resolve();
  assert.equal(nothing.social_image.value, null);
  assert.ok(nothing.diagnostics.some((d) => d.code === "SEO_SOCIAL_IMAGE_MISSING"));
});

test("social image inherits from the parent section, below hero and above site default", () => {
  const FACTS = { page_title: "P", intro: "I", hero_image: null };
  // Explicit social_image still wins over everything.
  assert.deepEqual(
    resolve(
      { social_image: { asset_id: ASSET } },
      { ...FACTS, inherited_social_image: { asset_id: PARENT } },
      { default_social_image: { asset_id: DEFAULT } },
    ).social_image,
    { value: { asset_id: ASSET }, source: "social_image" },
  );
  // The entry's own hero outranks the section image.
  assert.deepEqual(
    resolve(
      {},
      { ...FACTS, hero_image: { asset_id: HERO }, inherited_social_image: { asset_id: PARENT } },
      { default_social_image: { asset_id: DEFAULT } },
    ).social_image,
    { value: { asset_id: HERO }, source: "hero_image" },
  );
  // With neither, the section image is used before the site default.
  assert.deepEqual(
    resolve(
      {},
      { ...FACTS, inherited_social_image: { asset_id: PARENT } },
      { default_social_image: { asset_id: DEFAULT } },
    ).social_image,
    { value: { asset_id: PARENT }, source: "parent_section_image" },
  );
  // No section image → the site default still applies.
  assert.deepEqual(
    resolve(
      {},
      { ...FACTS, inherited_social_image: null },
      {
        default_social_image: { asset_id: DEFAULT },
      },
    ).social_image,
    { value: { asset_id: DEFAULT }, source: "site_default_social_image" },
  );
  // Inheritance is image-only: it must not lift the section's title or
  // description, which stay their own chains.
  const inherited = resolve({}, { ...FACTS, inherited_social_image: { asset_id: PARENT } }, {});
  assert.deepEqual(inherited.title, { value: "P", source: "page_title" });
});

test("resolution is deterministic for identical normalized input", () => {
  const input = {
    document: { ...emptyDoc(), seo_title: "T", intro: undefined },
    facts: { page_title: null, intro: "I", hero_image: null },
    site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "S" },
  };
  const a = resolveSeoMetadata(input.document, input.facts, input.site);
  const b = resolveSeoMetadata(input.document, input.facts, input.site);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
