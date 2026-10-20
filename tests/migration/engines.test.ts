// Engine connectors over the shared migration core: WordPress REST mapping,
// Tilda rendered-HTML conversion, Bitrix SEF templates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkspaceFromBitrixExport } from "../../packages/routing/src/migration/bitrix.js";
import {
  buildWorkspaceFromTildaPages,
  sitemapLocs,
  tildaHtmlToPage,
} from "../../packages/routing/src/migration/tilda.js";
import {
  buildWorkspaceFromWpRest,
  mediaInventoryCsv,
  type WpPage,
} from "../../packages/routing/src/migration/wordpress.js";

const WP_PAGES: WpPage[] = [
  {
    id: 2,
    link: "https://old.example/about/",
    status: "publish",
    type: "page",
    title: { rendered: "About &#038; Team" },
    content: {
      rendered:
        "<h2>Who we are</h2><p>We are <strong>great</strong>.</p><p><img src='/wp-content/uploads/team.jpg' alt='t'></p>",
    },
  },
  {
    id: 7,
    link: "https://old.example/legacy/",
    status: "trash",
    type: "page",
    title: { rendered: "Legacy" },
    content: { rendered: "<p>x</p>" },
  },
  {
    id: 9,
    link: "https://old.example/draft/",
    status: "draft",
    type: "page",
    title: { rendered: "Draft" },
    content: { rendered: "<p>d</p>" },
  },
];

test("wordpress: publish → §61 documents, trash → 410, drafts skipped with count", () => {
  const plan = buildWorkspaceFromWpRest(WP_PAGES);
  assert.equal(plan.documents.length, 1);
  const about = plan.documents[0]!;
  assert.equal(about.externalId, "wp-2");
  assert.equal(about.routePath, "/about/");
  assert.equal(about.title, "About & Team");
  assert.match(about.markdown, /## Who we are/);
  assert.match(about.markdown, /\*\*great\*\*/);
  assert.doesNotMatch(about.markdown, /<img/);
  assert.deepEqual(about.imageUrls, ["https://old.example/wp-content/uploads/team.jpg"]);
  assert.equal(plan.redirects[0]?.status_code, 410);
  assert.equal(plan.redirects[0]?.source, "/legacy/");
  assert.equal(plan.drafts, 1);
});

test("wordpress: media inventory CSV", () => {
  const csv = mediaInventoryCsv([
    { id: 5, source_url: "https://old.example/a.png", mime_type: "image/png" },
  ]);
  assert.match(csv, /^wp_id,source_url,mime_type\n5,https:\/\/old\.example\/a\.png,image\/png\n$/);
});

const TILDA_HTML = `<!doctype html><html><head><title>Услуги</title></head><body>
<div id="allrecords"><div class="t-rec"><div class="t-container"><h2>Наши услуги</h2>
<p>Перевозки <strong>24/7</strong>.</p><img src="https://static.tildacdn.com/photo.png"></div></div></div>
<script>tilda something</script></body></html>`;

test("tilda: #allrecords extraction, CDN images, title; sitemap locs filtered", () => {
  const page = tildaHtmlToPage("https://site.tilda.ws/services/", TILDA_HTML);
  assert.ok(!("skipped" in page));
  if (!("skipped" in page)) {
    assert.equal(page.title, "Услуги");
    assert.match(page.html, /Наши услуги/);
  }
  const plan = buildWorkspaceFromTildaPages(
    [{ url: "https://site.tilda.ws/services/", html: TILDA_HTML }],
    "https://site.tilda.ws/",
  );
  assert.equal(plan.documents.length, 1);
  const doc = plan.documents[0]!;
  assert.equal(doc.routePath, "/services/");
  assert.deepEqual(doc.imageUrls, ["https://static.tildacdn.com/photo.png"]);
  assert.match(doc.markdown, /\*\*24\/7\*\*/);
  // Scripts and tilda glue are stripped by the shared converter.
  assert.doesNotMatch(doc.markdown, /tilda something/);
  const locs = sitemapLocs(
    "<urlset><url><loc>https://s.tilda.ws/a/</loc></url><url><loc>https://s.tilda.ws/b.css</loc></url><url><loc>https://s.tilda.ws/app.js</loc></url></urlset>",
  );
  assert.deepEqual(locs, ["https://s.tilda.ws/a/"]);
});

test("bitrix: SEF template composition, sections as pages, inactive → 410", () => {
  const sections = [
    { id: 1, parent: 0, name: "Каталог", code: "catalog", url: "/catalog/" },
    { id: 2, parent: 1, name: "Услуги", code: "services", url: "/catalog/services/" },
  ];
  const elements = [
    {
      id: 100,
      section: 2,
      name: "Переезд",
      code: "pereezd",
      url: "",
      active: true,
      detail_text: "<p>Текст услуги.</p>",
      preview_text: "",
      properties: [],
    },
    {
      id: 101,
      section: 2,
      name: "Удалённая",
      code: "deleted",
      url: "",
      active: false,
      detail_text: "<p>x</p>",
      preview_text: "",
      properties: [],
    },
  ];
  const plan = buildWorkspaceFromBitrixExport(sections, elements, {
    sectionUrlTemplate: "/{SECTION_PATH}/",
    elementUrlTemplate: "/{SECTION_PATH}/{CODE}/",
    siteUrl: "https://old.example/",
  });
  // SECTION_PATH of the root section is empty → it composes to "/".
  const sectionPage = plan.documents.find((doc) => doc.sourceId === "s2");
  assert.equal(sectionPage?.routePath, "/catalog/");
  const element = plan.documents.find((doc) => doc.sourceId === 100);
  assert.equal(element?.routePath, "/catalog/services/pereezd/");
  assert.match(element?.markdown ?? "", /Текст услуги\./);
  assert.equal(
    plan.redirects.some(
      (row) => row.source === "/catalog/services/deleted/" && row.status_code === 410,
    ),
    true,
  );
});
