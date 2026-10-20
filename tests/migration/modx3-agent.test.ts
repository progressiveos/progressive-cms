// The 2-URL pipeline (packages/routing/src/migration/modx3-agent.ts): agent
// export → plan + PCMD documents. HTML→markdown via turndown, §61 route.path
// preservation, image extraction, MIGX sidecar, seosuite reuse, 410s.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentExport,
  buildWorkspaceFromAgentExport,
  resourceToPcmd,
} from "../../packages/routing/src/migration/modx3-agent.js";

const EXPORT: AgentExport = {
  info: {
    modx_version: "3.1.0-pl",
    settings: {
      site_url: "https://old.example/",
      friendly_urls: true,
      use_alias_path: true,
      container_suffix: "/",
      site_start: 1,
    },
    extras: { migx: true, migx_tv_count: 1 },
  },
  tvs: [{ id: 5, name: "services_grid", type: "migx", caption: "Услуги" }],
  resources: [
    {
      id: 10,
      parent: 0,
      template: 3,
      content_type: 1,
      class_key: "modDocument",
      context_key: "web",
      alias: "",
      uri: "",
      uri_override: 0,
      pagetitle: "Главная",
      longtitle: "",
      introtext: "",
      content: "<p>Добро пожаловать.</p>",
      menutitle: "",
      menuindex: 0,
      published: 1,
      deleted: 0,
      isfolder: 1,
      tvs: [],
    },
    {
      id: 11,
      parent: 0,
      template: 4,
      content_type: 1,
      class_key: "modDocument",
      context_key: "web",
      alias: "about",
      uri: "about.html",
      uri_override: 0,
      pagetitle: "О компании",
      longtitle: "О компании ООО",
      introtext: "<p>Короткое интро.</p>",
      content:
        '<h2>История</h2><p>Текст с <strong>жирным</strong> и <a href="/clients/">ссылкой</a>.</p><ul><li>п1</li><li>п2</li></ul><p><img src="assets/images/team.jpg" alt="Команда"></p>',
      menutitle: "",
      menuindex: 1,
      published: 1,
      deleted: 0,
      isfolder: 0,
      tvs: [{ id: 5, name: "services_grid", type: "migx", value: '[{"caption":"Услуга 1"}]' }],
    },
    {
      id: 13,
      parent: 0,
      template: 3,
      content_type: 1,
      class_key: "modDocument",
      context_key: "web",
      alias: "old-page",
      uri: "old-page.html",
      uri_override: 0,
      pagetitle: "Удалённая",
      longtitle: "",
      introtext: "",
      content: "<p>x</p>",
      menutitle: "",
      menuindex: 2,
      published: 1,
      deleted: 1,
      isfolder: 0,
      tvs: [],
    },
    {
      id: 15,
      parent: 0,
      template: 0,
      content_type: 1,
      class_key: "modWebLink",
      context_key: "web",
      alias: "linked",
      uri: "linked.html",
      uri_override: 0,
      pagetitle: "Ссылка",
      longtitle: "",
      introtext: "",
      content: "https://external.example/",
      menutitle: "",
      menuindex: 3,
      published: 1,
      deleted: 0,
      isfolder: 0,
      tvs: [],
    },
  ],
  seosuiteRedirects: [{ old_url: "legacy-price.html", new_url: "price.html" }],
  mediaSources: [],
};

test("plan: documents, 410s, weblink skip, seosuite reuse, home as /", () => {
  const plan = buildWorkspaceFromAgentExport(EXPORT);
  assert.equal(plan.summary.documents, 2);
  const gone = plan.redirects.find((row) => row.source === "/old-page.html");
  assert.equal(gone?.status_code, 410);
  assert.ok(
    plan.redirects.some(
      (row) => row.source === "/legacy-price.html" && row.target === "/price.html",
    ),
  );
  assert.ok(!plan.canonical.some((row) => row.id === 15));
  const home = plan.canonical.find((row) => row.id === 10);
  assert.equal(home?.canonical_path, "/");
});

test("HTML → markdown: headings, bold, links, lists survive; scripts strip", () => {
  const plan = buildWorkspaceFromAgentExport(EXPORT);
  const about = plan.documents.find((doc) => doc.modxId === 11);
  assert.ok(about !== undefined);
  assert.match(about.markdown, /## История/);
  assert.match(about.markdown, /\*\*жирным\*\*/);
  assert.match(about.markdown, /\[ссылкой\]\(\/clients\/\)/);
  assert.match(about.markdown, /п1/);
  assert.doesNotMatch(about.markdown, /<p>|<h2>/);
});

test("images extracted with absolute URLs; MIGX sidecar carries raw JSON", () => {
  const plan = buildWorkspaceFromAgentExport(EXPORT);
  const about = plan.documents.find((doc) => doc.modxId === 11);
  assert.deepEqual(about?.imageUrls, ["https://old.example/assets/images/team.jpg"]);
  assert.equal(plan.summary.images, 1);
  const sidecar = plan.migxSidecar.find((row) => row.modx_id === 11);
  assert.equal(sidecar?.tvs[0]?.name, "services_grid");
  assert.match(sidecar?.tvs[0]?.value ?? "", /Услуга 1/);
  assert.equal(plan.summary.migxResources, 1);
});

test("PCMD serialization: frontmatter with §61 route, text block, bundle image refs", () => {
  const plan = buildWorkspaceFromAgentExport(EXPORT);
  const about = plan.documents.find((doc) => doc.modxId === 11);
  assert.ok(about !== undefined);
  const pcmd = resourceToPcmd(about, "modx-11");
  assert.match(
    pcmd,
    /^---\npcmd_version: 1\noperation: create\nexternal_id: modx-11\ncontent_type: page\nfields:\n {2}title: "О компании ООО"\nroute:\n {2}path: "\/about\.html"/,
  );
  assert.match(pcmd, /:::block text@1\nrich_text: \|/);
  assert.match(pcmd, /:::block image@2\nmedia_id: "bundle:assets\/modx-11-1\.jpg"/);
  // Markdown body is block-indented and contains no raw HTML.
  assert.doesNotMatch(pcmd, /:::block[\s\S]*?<img/);
});
