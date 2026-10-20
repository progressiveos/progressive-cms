// PCMS-SEO-T008 — X/Twitter compatibility projection (spec §26). The card
// tags derive from the same social model as OG — one source of truth.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSeoHeadModel,
  buildTwitterCardMeta,
  DEFAULT_SITE_SEO_DEFAULTS,
  emptySeoDocument,
  resolveSeoMetadata,
  type SeoDocument,
  type SocialImageViewModel,
} from "@pcms/seo";

const SMALL: SocialImageViewModel = {
  asset_id: "0195fdc0-7a5e-7000-8000-000000000001",
  version: 1,
  url: "https://cdn.example.ru/media/a/x/v1/s-abc.png",
  width: 400,
  height: 400,
  mime_type: "image/png",
  alt: "logo",
};
const LARGE: SocialImageViewModel = { ...SMALL, width: 1200, height: 630, mime_type: "image/jpeg" };

function resolved(doc: Partial<SeoDocument> = {}) {
  return resolveSeoMetadata(
    { ...emptySeoDocument(), ...doc },
    { page_title: "Страница", intro: "Intro", hero_image: null },
    { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "Example" },
  );
}

test("default card is summary_large_image for a suitable image, else summary", () => {
  const r = resolved();
  assert.equal(
    buildTwitterCardMeta({ resolved: r, socialImage: LARGE })[0]?.content,
    "summary_large_image",
  );
  assert.equal(buildTwitterCardMeta({ resolved: r, socialImage: SMALL })[0]?.content, "summary");
  assert.equal(buildTwitterCardMeta({ resolved: r, socialImage: null })[0]?.content, "summary");
});

test("card fields mirror the social model — same fallbacks as OG", () => {
  const tags = new Map(
    buildTwitterCardMeta({
      resolved: resolved({ social_title: "ST", social_description: "SD" }),
      socialImage: LARGE,
    }).map((t) => [t.name, t.content]),
  );
  assert.equal(tags.get("twitter:title"), "ST");
  assert.equal(tags.get("twitter:description"), "SD");
  assert.equal(tags.get("twitter:image"), LARGE.url);
  // Alt is media accessibility semantics, not the social description.
  assert.equal(tags.get("twitter:image:alt"), LARGE.alt);
});

test("title/description fall back to the resolved values; absent image omits image tags", () => {
  const tags = new Map(
    buildTwitterCardMeta({ resolved: resolved(), socialImage: null }).map((t) => [
      t.name,
      t.content,
    ]),
  );
  assert.equal(tags.get("twitter:title"), "Страница");
  assert.equal(tags.get("twitter:description"), "Intro");
  assert.ok(!tags.has("twitter:image"));
  assert.ok(!tags.has("twitter:image:alt"));
});

test("twitter tags are emitted after OG through the head builder when requested", () => {
  const { head } = buildSeoHeadModel({
    document: null,
    facts: { page_title: "T", intro: null, hero_image: null },
    site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "S" },
    routeCanonicalUrl: "https://example.ru/",
    openGraph: true,
    twitterCard: true,
    socialImage: LARGE,
  });
  const names = head.core_meta.map((m) => m.property ?? m.name ?? "");
  const ogIndex = names.indexOf("og:title");
  const twitterIndex = names.indexOf("twitter:card");
  assert.ok(
    ogIndex >= 0 && twitterIndex > ogIndex,
    "core section order: OG then twitter compatibility",
  );
  assert.equal(names[names.length - 1], "twitter:image:alt");
});
