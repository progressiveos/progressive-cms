// R14 (2026-10-02 site-developer report, Core 0.1.145): themes had no safe
// channel for JSON-LD — the engine unconditionally escapes plain strings, so
// `head.json_ld` came out as `{&quot;@type&quot;:…}` inside the script tag
// (HTML entities are not decoded there → not JSON), and `raw`/`escape` are
// deliberately unregistered. The contract now exposes the Core-protected
// head boundary as ONE trusted scope fragment:
//
//   {{ head_html }}   → SafeHtml(assembleHeadHtml(head view model))
//
// covering title / core meta / canonical / alternates / robots / icons /
// JSON-LD (`</script>`-safe) / theme slots. Regression pins, on the real
// public rendering seam: JSON-LD parses and matches, no `&quot;`, script-
// closing injection is neutralized, ordinary text stays escaped, no
// duplicated title/canonical, preview keeps noindex/no-store, a candidate
// theme renders the same contract under its own CSP.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";
import { assembleHeadHtml } from "@pcms/themes";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_THEME = join(process.cwd(), "themes", "reference-theme-v1");
const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

function stageThemeWithHeadHtml(root: string, dirName: string): string {
  const dir = join(root, dirName);
  cpSync(REFERENCE_THEME, dir, { recursive: true });
  const templatePath = join(dir, "templates", "page-default.liquid");
  writeFileSync(
    templatePath,
    readFileSync(templatePath, "utf8").replace(
      `  <title>{{ head.title }} — {{ site.site_name }}</title>
  {% for meta in head.core_meta %}<meta {% if meta.property %}property="{{ meta.property }}"{% else %}name="{{ meta.name }}"{% endif %} content="{{ meta.content }}">{% endfor %}
  {% if head.canonical %}<link rel="canonical" href="{{ head.canonical }}">{% endif %}
  {% for alt in head.alternates %}<link rel="alternate" hreflang="{{ alt.hreflang }}" href="{{ alt.href }}">{% endfor %}`,
      "  {{ head_html }}",
    ),
  );
  return dir;
}

async function bootStack(t: import("node:test").TestContext, activeDir: string) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: activeDir,
    seoEnvironment: "production",
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_head_html");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  return { app, fastify };
}

function ldJsonScripts(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? "",
  );
}

test("assembleHeadHtml: JSON-LD stays parsable and script-closing injection is neutralized", () => {
  const hostile = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    description: `close </script><script>alert(1)</script> & "quotes"`,
  });
  const html = assembleHeadHtml({
    title: 'Страница "X" & друзья',
    core_meta: [{ name: "description", content: "Обычное <b>описание</b>" }],
    canonical: "https://site.example/page/",
    alternates: [{ hreflang: "en", href: "https://site.example/en/page/" }],
    robots: "noindex, nofollow",
    json_ld: [hostile],
    theme_slots: [],
  });
  // Exactly one JSON-LD script; the hostile payload never closes it early —
  // the only `</script>` literal is the real closing tag, the payload's own
  // is escaped to `<\/script>` (valid JSON escaping, parsed back verbatim).
  const scripts = ldJsonScripts(html);
  assert.equal(scripts.length, 1, html);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1, html);
  const parsed = JSON.parse(scripts[0] ?? "null") as { description?: string };
  assert.equal(parsed.description, `close </script><script>alert(1)</script> & "quotes"`);
  // Ordinary attribute/text content stays escaped.
  assert.ok(html.includes("<title>Страница &quot;X&quot; &amp; друзья</title>"), html);
  assert.ok(html.includes('content="Обычное &lt;b&gt;описание&lt;/b&gt;"'), html);
  assert.ok(
    html.includes('<link rel="alternate" hreflang="en" href="https://site.example/en/page/">'),
    html,
  );
});

test("head_html scope fragment: live, preview and candidate renders (real seam)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const stage = mkdtempSync(join(tmpdir(), "pcms-head-html-"));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const activeDir = stageThemeWithHeadHtml(stage, "reference-theme-v1");
  const candidateDir = stageThemeWithHeadHtml(stage, "candidate-c");
  const { writeFileSync: wfs } = await import("node:fs");
  const manifestPath = join(candidateDir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    id: string;
    name: string;
  };
  manifest.id = "candidate-c";
  manifest.name = "Candidate C";
  wfs(manifestPath, JSON.stringify(manifest, null, 2));

  const { app, fastify } = await bootStack(t, activeDir);
  const ctx = apiContextOf(ownerActor("head-html-seeder"));
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: {
        title: "Страница head_html",
        intro: "Вступление с <b>разметкой</b> пользователя",
      },
      blocks: { schema_version: 1, blocks: [] },
    },
  });

  // --- Signed WORKING preview against the ACTIVE theme: the fragment renders
  // JSON-LD through the real engine; headers keep the preview contract. ---
  assert.ok(app.previewTokens);
  const previewToken = app.previewTokens.issue(
    {
      kind: "revision",
      entityType: "entry",
      entityId: draft.entry_id as never,
      revisionId: draft.revision_id as never,
    },
    { draft: true },
  );
  const preview = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(previewToken)}`,
  });
  assert.equal(preview.statusCode, 200, preview.body.slice(0, 300));
  assert.ok(
    String(preview.headers["x-robots-tag"]).includes("noindex"),
    String(preview.headers["x-robots-tag"]),
  );
  assert.ok(String(preview.headers["cache-control"]).includes("no-store"));
  // A WORKING draft may legitimately have no structured data yet (no
  // route/canonical) — whatever the composer did emit must be valid JSON.
  for (const script of ldJsonScripts(preview.body)) {
    assert.ok(!script.includes("&quot;"), script.slice(0, 200));
    JSON.parse(script);
  }
  // The template replaced its own head block with the fragment: exactly one
  // title and one robots meta, no duplication; robots is noindex in preview.
  assert.equal((preview.body.match(/<title>/g) ?? []).length, 1, preview.body.slice(0, 600));
  assert.ok(preview.body.includes('<meta name="robots" content="noindex, nofollow">'));
  // Ordinary user text keeps escaping OUTSIDE the trusted fragment.
  assert.ok(preview.body.includes("&lt;b&gt;разметкой&lt;/b&gt;"), preview.body.slice(0, 900));

  // --- Candidate preview: same contract under the candidate stack/CSP. ---
  const candidateToken = app.previewTokens.issue(
    {
      kind: "revision",
      entityType: "entry",
      entityId: draft.entry_id as never,
      revisionId: draft.revision_id as never,
    },
    { draft: true, theme: "candidate-c" },
  );
  const candidate = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(candidateToken)}`,
  });
  assert.equal(candidate.statusCode, 200, candidate.body.slice(0, 300));
  // The candidate keeps its own stack: CSP from ITS manifest, same contract.
  assert.ok(candidate.headers["content-security-policy"]);
  for (const script of ldJsonScripts(candidate.body)) {
    assert.ok(!script.includes("&quot;"), script.slice(0, 200));
    JSON.parse(script);
  }

  // --- Live page: publish + route + primary domain; the SEO composer then
  // has a canonical origin, so WebPage JSON-LD is composed (production shape;
  // a domainless fixture degrades to no JSON-LD by design). ---
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  const site = await app.routes.ensureSite("default");
  await app.domains.addDomainBinding({
    siteId: site.id,
    hostname: "site.example",
    isPrimary: true,
  } as never);
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/head-html",
    targetType: "entry",
    targetId: draft.entry_id,
  });
  const live = await fastify.inject({ method: "GET", url: "/head-html/" });
  assert.equal(live.statusCode, 200, live.body.slice(0, 300));
  const liveScripts = ldJsonScripts(live.body);
  assert.ok(liveScripts.length >= 1, live.body.slice(0, 600));
  for (const script of liveScripts) {
    assert.ok(!script.includes("&quot;"), script.slice(0, 200));
    JSON.parse(script);
  }
  assert.equal((live.body.match(/<title>/g) ?? []).length, 1);
  assert.equal((live.body.match(/rel="canonical"/g) ?? []).length, 1);

  // Discovery agreement: the structured-data composer is the SAME source
  // head_html carries (the developer-facing /discovery/seo/structured-data).
  const discovery = await app.seoDiscovery.previewSeoFor(draft.entry_id as never);
  assert.ok(discovery !== null);
  assert.ok(discovery.structured_data.json_ld.length >= 1);
  for (const json of discovery.structured_data.json_ld) {
    assert.ok(json.includes("schema.org"), json.slice(0, 200));
  }
});
