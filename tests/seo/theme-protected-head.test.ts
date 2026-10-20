// PCMS-SEO-T024 — Theme protected head integration (M03 boundary + M06 SEO
// model; spec §47/§48/§49). End-to-end composition: content semantics +
// routing canonical + media social image + SEO resolver → HeadViewModel →
// protected head renderer. A theme can extend the head only through its
// slot; it can never suppress, replace or duplicate authoritative metadata.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSeoHeadModel,
  composeStructuredData,
  DEFAULT_SITE_SEO_DEFAULTS,
  emptySeoDocument,
  type SeoDocument,
  type SocialImageViewModel,
} from "@pcms/seo";
import { assembleHeadHtml, type HeadViewModel, headViolations } from "@pcms/themes";

const CANONICAL = "https://example.ru/services/audit/";
const SOCIAL: SocialImageViewModel = {
  asset_id: "0195fdc0-7a5e-7000-8000-000000000001",
  version: 3,
  url: "https://cdn.example.ru/media/a/x/v3/social-display-x.jpeg",
  width: 1200,
  height: 630,
  mime_type: "image/jpeg",
  alt: "Аудит",
};

function buildHead(document: Partial<SeoDocument> = {}): SeoHeadViewModelFix {
  const { head } = buildSeoHeadModel({
    document: {
      ...emptySeoDocument(),
      ...document,
    },
    facts: { page_title: "Аудит безопасности", intro: "Вводный текст страницы.", hero_image: null },
    site: { ...DEFAULT_SITE_SEO_DEFAULTS, site_name: "Пример" },
    routeCanonicalUrl: CANONICAL,
    openGraph: true,
    twitterCard: true,
    locale: "ru-RU",
    environment: "production",
    socialImage: SOCIAL,
    favicon: {
      asset_id: "0195fdc0-7a5e-7000-8000-000000000009",
      version: 1,
      url: "https://cdn.example.ru/media/a/f/v1/favicon-x.png",
      width: 512,
      height: 512,
      mime_type: "image/png",
    },
  });
  return head;
}

type SeoHeadViewModelFix = ReturnType<typeof buildSeoHeadModel>["head"];

/** The theme's slot payload: every suppression/conflict attempt at once. */
const HOSTILE_SLOTS: HeadViewModel["theme_slots"] = [
  { kind: "meta", attributes: { name: "robots", content: "index, follow, max-snippet:-1" } },
  { kind: "meta", attributes: { name: "description", content: "Theme-written description" } },
  { kind: "meta", attributes: { property: "og:url", content: "https://evil.example/spoof/" } },
  { kind: "meta", attributes: { property: "og:title", content: "Theme override title" } },
  { kind: "meta", attributes: { property: "twitter:card", content: "summary" } },
  { kind: "link", attributes: { rel: "canonical", href: "https://evil.example/" } },
  { kind: "link", attributes: { rel: "icon", href: "https://evil.example/favicon.ico" } },
  { kind: "meta", attributes: { name: "viewport", content: "width=320" } },
  // Legitimate extensions that MUST survive.
  { kind: "stylesheet", attributes: { href: "/assets/theme.css" } },
  { kind: "meta", attributes: { name: "theme-color", content: "#3060f0" } },
];

function assemble(head: SeoHeadViewModelFix): string {
  const viewModel: HeadViewModel = {
    title: head.title,
    core_meta: head.core_meta,
    canonical: head.canonical,
    robots: head.robots,
    icons: head.icons,
    json_ld: head.json_ld,
    theme_slots: HOSTILE_SLOTS,
  };
  return assembleHeadHtml(viewModel);
}

test("core SEO section survives a fully hostile theme slot set, in contract order", () => {
  const head = buildHead();
  const html = assemble(head);
  const lines = html.split("\n");

  // Core section first, exactly once each, with authoritative values.
  assert.equal(lines[0], "<title>Аудит безопасности</title>");
  assert.equal(lines.filter((l) => l === `<link rel="canonical" href="${CANONICAL}">`).length, 1);
  assert.ok(lines.includes('<meta name="robots" content="index, follow">') === false);
  // Core robots: policy null → no tag; theme's "index, follow" must not appear either.
  assert.ok(!lines.some((l) => l.startsWith('<meta name="robots"')));
  assert.equal(lines.filter((l) => l.includes('property="og:url"')).length, 1);
  assert.ok(lines.some((l) => l.includes(`<meta property="og:url" content="${CANONICAL}">`)));
  assert.equal(lines.filter((l) => l.includes("<title>")).length, 1);
  assert.ok(
    lines.some((l) => l.includes('<meta property="og:title" content="Аудит безопасности">')),
  );
  assert.ok(
    lines.some((l) => l.includes('<meta name="twitter:card" content="summary_large_image">')),
  );
  assert.ok(
    lines.some((l) =>
      l.includes(`<link rel="icon" href="https://cdn.example.ru/media/a/f/v1/favicon-x.png"`),
    ),
  );

  // Theme extensions come second — only the legitimate ones.
  const themeCssIndex = lines.findIndex((l) => l.includes("/assets/theme.css"));
  const canonicalIndex = lines.findIndex((l) => l.includes('rel="canonical"'));
  assert.ok(themeCssIndex > canonicalIndex);
  assert.ok(lines.some((l) => l.includes('<meta name="theme-color" content="#3060f0">')));
  assert.ok(!lines.some((l) => l.includes("evil.example")));
  assert.ok(!lines.some((l) => l.includes("Theme-written description")));
  assert.ok(!lines.some((l) => l.includes("Theme override title")));
  assert.ok(!lines.some((l) => l.includes("width=320")));
});

test("every suppression attempt is reported with stable violation codes", () => {
  const head = buildHead();
  const viewModel: HeadViewModel = {
    title: head.title,
    core_meta: head.core_meta,
    canonical: head.canonical,
    robots: head.robots,
    icons: head.icons,
    json_ld: head.json_ld,
    theme_slots: HOSTILE_SLOTS,
  };
  const violations = headViolations(viewModel);
  const codes = violations.map((v) => v.code);
  assert.ok(
    codes.every((c) => c === "THEME_HEAD_PROTECTED_METADATA" || c === "THEME_HEAD_SLOT_INVALID"),
  );
  // robots, description, og:*, twitter:*, canonical, icon, viewport all caught.
  const protectedPaths = violations.filter((v) => v.code === "THEME_HEAD_PROTECTED_METADATA");
  assert.ok(
    protectedPaths.length >= 7,
    `expected ≥7 protected violations, got ${protectedPaths.length}`,
  );
});

test("noindex pages keep robots authoritative; theme cannot re-enable indexing", () => {
  const head = buildHead({ robots_policy: { index: false, follow: true } });
  const html = assemble(head);
  assert.equal(
    html.split("\n").filter((l) => l === '<meta name="robots" content="noindex">').length,
    1,
  );
  assert.ok(!html.includes("index, follow"));
});

test("structured data renders inside the protected section as a safe script", () => {
  const head = buildHead();
  const composed = composeStructuredData({
    website: { id: "https://example.ru/#website", name: "Пример", url: "https://example.ru" },
    organization: null,
    webpage: null,
    article: null,
    breadcrumbs: null,
    video: null,
  });
  const viewModel: HeadViewModel = {
    title: head.title,
    core_meta: head.core_meta,
    canonical: head.canonical,
    robots: head.robots,
    icons: head.icons,
    json_ld: composed.json_ld,
    theme_slots: HOSTILE_SLOTS,
  };
  const html = assembleHeadHtml(viewModel);
  assert.equal(html.split("<script").length - 1, 1);
  const scriptIndex = html.indexOf('<script type="application/ld+json">');
  const themeCssIndex = html.indexOf("/assets/theme.css");
  assert.ok(
    scriptIndex >= 0 && themeCssIndex > scriptIndex,
    "JSON-LD core section before theme slots",
  );
});
