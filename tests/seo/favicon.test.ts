// PCMS-SEO-T009 — favicon Site Identity pipeline (spec §22). Icon tags are
// crawlable, stable, part of the protected core section, and health-checked.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFaviconIcons,
  buildSeoHeadModel,
  DEFAULT_SITE_SEO_DEFAULTS,
  type FaviconViewModel,
  faviconIssues,
} from "@pcms/seo";
import { assembleHeadHtml, filterThemeHeadSlots, type HeadViewModel } from "@pcms/themes";

const FAVICON: FaviconViewModel = {
  asset_id: "0195fdc0-7a5e-7000-8000-000000000009",
  version: 1,
  url: "https://example.ru/media/a/0195fdc0-9/v1/favicon-0f3a.png",
  width: 512,
  height: 512,
  mime_type: "image/png",
};

test("icon tags are crawlable: rel=icon with type/sizes, apple-touch-icon for large sources", () => {
  const icons = buildFaviconIcons(FAVICON);
  assert.deepEqual(icons, [
    { rel: "icon", href: FAVICON.url, type: "image/png", sizes: "512x512" },
    { rel: "apple-touch-icon", href: FAVICON.url },
  ]);
  assert.deepEqual(buildFaviconIcons(null), []);
});

test("icons render inside the protected core section, before JSON-LD", () => {
  const { head } = buildSeoHeadModel({
    document: null,
    facts: { page_title: "T", intro: null, hero_image: null },
    site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "S" },
    routeCanonicalUrl: "https://example.ru/",
    favicon: FAVICON,
  });
  const viewModel: HeadViewModel = {
    title: head.title,
    core_meta: head.core_meta,
    canonical: head.canonical,
    robots: head.robots,
    icons: head.icons,
    json_ld: [],
    theme_slots: [],
  };
  const html = assembleHeadHtml(viewModel);
  const iconIndex = html.indexOf(
    '<link rel="icon" href="https://example.ru/media/a/0195fdc0-9/v1/favicon-0f3a.png" type="image/png" sizes="512x512">',
  );
  const canonicalIndex = html.indexOf('rel="canonical"');
  assert.ok(canonicalIndex >= 0 && iconIndex > canonicalIndex);
  assert.ok(html.includes('<link rel="apple-touch-icon" href='));
});

test("a theme can never inject its own icon: rel=icon slots are dropped (§48)", () => {
  const filtered = filterThemeHeadSlots([
    { kind: "link", attributes: { rel: "icon", href: "/evil.png" } },
    { kind: "link", attributes: { rel: "shortcut icon", href: "/evil2.png" } },
  ]);
  assert.equal(filtered.accepted.length, 0);
  assert.equal(filtered.violations.length, 2);
  assert.ok(filtered.violations.every((v) => v.code === "THEME_HEAD_PROTECTED_METADATA"));
});

test("favicon health: missing and tiny sources warn (§22)", () => {
  assert.deepEqual(faviconIssues(FAVICON, { declared: true }), []);
  const missing = faviconIssues(null, { declared: false });
  assert.ok(missing.some((i) => i.code === "SEO_FAVICON_MISSING"));
  const unresolvable = faviconIssues(null, { declared: true });
  assert.ok(unresolvable.some((i) => i.code === "SEO_SOCIAL_IMAGE_INVALID"));
  const tiny = faviconIssues({ ...FAVICON, width: 16, height: 16 }, { declared: true });
  assert.ok(tiny.some((i) => i.code === "SEO_FAVICON_TOO_SMALL" && i.severity === "warning"));
});
