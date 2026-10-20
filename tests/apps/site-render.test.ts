// Public site renderer (Spangar audit gap #1): Routing resolution →
// published revision → theme HTML render, over a disposable database with
// the reference content types and the reference-theme-v1 theme directory.
// Homepage/nav/404/redirect surfaces; media scope is empty without storage —
// block templates degrade to their documented fallbacks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";
import { createLogger, systemClock } from "@pcms/core";
import { LocalMediaStorage } from "@pcms/media";
import type { FastifyInstance } from "fastify";
import { changeTheme } from "../../packages/api/src/theme-lifecycle.js";
import {
  API_CLOCK,
  apiContextOf,
  createApiFixture,
  ownerActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

async function siteStack(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pcms-site-render-"));
  const mediaRoot = join(root, "media");
  mkdirSync(mediaRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: "themes/reference-theme-v1",
    seoEnvironment: "production",
    mediaRoots: { storage: mediaRoot, quarantine: join(root, "quarantine") },
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_site");
  await registerSite(fastify, app);
  return { app, fastify, storage: new LocalMediaStorage({ root: mediaRoot }) };
}

async function registerSite(
  fastify: FastifyInstance,
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
) {
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
}

/** The reference site stack, for the breadcrumb gates. */
async function stackWithBreadcrumbs(t: import("node:test").TestContext) {
  const stack = await siteStack(t);
  const site = await stack.app.routes.ensureSite("default");
  // Breadcrumb hrefs resolve through Core Routing, which requires the site's
  // primary domain binding (the same one a real install has).
  await stack.app.domains.addDomainBinding({
    siteId: site.id,
    hostname: "breadcrumbs.test",
    isPrimary: true,
  });
  return { ...stack, site };
}

/** Publishes a `page` at `path`, optionally under a parent entry. */
async function publishNested(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  input: { readonly title: string; readonly path: string; readonly parentId?: string },
): Promise<{ entryId: string }> {
  const site = await app.routes.ensureSite("default");
  const ctx = apiContextOf(ownerActor("breadcrumb-seeder"));
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: { title: input.title },
      blocks: { schema_version: 1, blocks: [] },
    },
    ...(input.parentId === undefined ? {} : { parent_entry_id: input.parentId }),
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: input.path,
    targetType: "entry",
    targetId: draft.entry_id,
  });
  return { entryId: draft.entry_id };
}

async function publishPage(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  input: {
    readonly title: string;
    readonly h1?: string;
    readonly intro?: string;
    readonly blocks?: unknown[];
  },
) {
  const ctx = apiContextOf(ownerActor("site-seeder"));
  const { createDraft, updateDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: {
        title: input.title,
        ...(input.h1 === undefined ? {} : { h1: input.h1 }),
        ...(input.intro === undefined ? {} : { intro: input.intro }),
      },
      blocks: { schema_version: 1, blocks: input.blocks ?? [] },
    },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  return { entryId: draft.entry_id };
}

test("rich_text bodyPolicy entries render their fields.body (case body)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await siteStack(t);
  const site = await app.routes.ensureSite("default");

  const ctx = apiContextOf(ownerActor("case-seeder"));
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const bodyDocument = {
    schema_version: 2,
    type: "document",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Ангар класса В 1500 м² с кровлей из сэндвич-панелей." }],
      },
    ],
  };
  const draft = await createDraft(app, ctx, {
    content_type: "case",
    payload: {
      fields: { title: "Мебельное производство, 1500 м²", body: bodyDocument },
    },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/projects/mebelnoe-proizvodstvo",
    targetType: "entry",
    targetId: draft.entry_id,
  });

  const page = await fastify.inject({ method: "GET", url: "/projects/mebelnoe-proizvodstvo/" });
  assert.equal(page.statusCode, 200, page.body);
  // Spangar acceptance regression: bodies of rich_text content types live in
  // payload.fields.body; the renderer must not read only a top-level payload.body.
  assert.ok(page.body.includes("Ангар класса В 1500 м²"));
});

test("published homepage renders through the theme; unknown path 404s", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await siteStack(t);
  const site = await app.routes.ensureSite("default");

  const home = await publishPage(app, {
    title: "СПАНГАР — Быстровозводимые ангары под ключ",
    h1: "СПАНГАР: склады и цеха из металлокаркаса",
    intro: "Проектируем, производим и монтируем ангары за 60–90 дней.",
    blocks: [
      {
        id: "01980000-0000-7000-8000-0000000000b1",
        type: "heading",
        schema_version: 1,
        variant: null,
        props: { level: 6, text: "Почему мы" },
        children: [],
      },
      {
        id: "01980000-0000-7000-8000-0000000000b2",
        type: "heading",
        schema_version: 1,
        variant: null,
        props: { level: 2, text: "Почему выбирают СПАНГАР" },
        children: [],
      },
    ],
  });
  await app.routes.setHomeEntry(site.id, home.entryId);
  const homeNav = await app.navigation.createSet({ key: "home-link", title: "Главная" });
  await app.navigation.insertItem({
    setId: homeNav.id,
    type: "internal_entry",
    label: "Главная",
    target: { kind: "internal_entry", entry_id: home.entryId },
  });
  await app.placements.bindPlacement({
    placementKey: "header.primary",
    navigationSetId: homeNav.id,
  });

  const homeResponse = await fastify.inject({ method: "GET", url: "/" });
  assert.equal(homeResponse.statusCode, 200, homeResponse.body);
  assert.ok(homeResponse.headers["content-type"]?.includes("text/html"));
  const html = homeResponse.body;
  // CSP must allow the contract's own inline tokens injection point: the
  // hash of the rendered <style> content appears in the style-src directive.
  // The browser hashes the DECODED text content, so undo the liquid
  // autoescape entities first (& last — it closes the other entities).
  const inlineStyle = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  assert.ok(inlineStyle, "page carries the tokens <style> block");
  const decoded = (inlineStyle[1] ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  assert.ok(decoded.startsWith(":root {"), "tokens block extracted");
  const csp = String(homeResponse.headers["content-security-policy"]);
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(decoded).digest("base64")}'`), csp);
  // Entry title + intro render through the theme (generic template contract:
  // the theme renders the entry title as the page h1).
  assert.ok(html.includes("<h1"));
  assert.ok(html.includes("СПАНГАР — Быстровозводимые ангары под ключ"));
  assert.ok(html.includes("Проектируем, производим и монтируем ангары"));
  // Blocks rendered through the theme's typed-block pipeline.
  assert.ok(html.includes("Почему выбирают СПАНГАР"));
  assert.ok(html.includes("block-heading"));
  // Header/footer chrome + tokens.
  assert.ok(html.includes("site-header"));
  assert.ok(html.includes('href="/"'), "the default-locale home link must point to /");
  assert.ok(!html.includes('href="/default/"'));
  assert.ok(html.includes("--color-primary"));

  const missing = await fastify.inject({ method: "GET", url: "/no/such/page" });
  assert.equal(missing.statusCode, 404);
  assert.ok(missing.body.includes("404"));
});

test("entry route renders by path; navigation placements resolve hrefs", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await siteStack(t);
  const site = await app.routes.ensureSite("default");
  // Routing action hrefs canonicalize against the site's primary binding.
  await app.domains.addDomainBinding({
    siteId: site.id,
    hostname: "site.test",
    isPrimary: true,
  });

  const privacy = await publishPage(app, { title: "Политика конфиденциальности" });
  const contacts = await publishPage(app, { title: "Контакты" });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/privacy-policy",
    targetType: "entry",
    targetId: privacy.entryId,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/contacts",
    targetType: "entry",
    targetId: contacts.entryId,
  });
  const navSet = await app.navigation.createSet({ key: "main", title: "Основное меню" });
  await app.navigation.insertItem({
    setId: navSet.id,
    type: "internal_entry",
    label: "Контакты",
    target: { kind: "internal_entry", entry_id: contacts.entryId },
  });
  await app.placements.bindPlacement({
    placementKey: "header.primary",
    navigationSetId: navSet.id,
  });

  // Default Routing policy enforces trailing slashes: bare path → 301.
  const bare = await fastify.inject({ method: "GET", url: "/privacy-policy" });
  assert.equal(bare.statusCode, 301);
  const page = await fastify.inject({ method: "GET", url: "/privacy-policy/" });
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes("Политика конфиденциальности"));

  // Navigation: routing-resolved hrefs, never theme-computed.
  const contactsPage = await fastify.inject({ method: "GET", url: "/contacts/" });
  assert.ok(contactsPage.body.includes('href="/contacts/"'));
});

test("home binding via REST op drives / render", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await siteStack(t);
  const fastify: FastifyInstance = createApiFastify(() => "req_home");
  await registerSite(fastify, app);

  const ctx = apiContextOf(ownerActor("home-binder"));
  const { createDraft, sealRevision, publishRevision, setHomeEntryOp } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Главная" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });

  // The deployment bootstrap's homepage binding: POST /entries/:id/home
  // (transport auth covered by the API suite) lands here.
  await setHomeEntryOp(app, ctx, { entry_id: draft.entry_id });
  const rendered = await fastify.inject({ method: "GET", url: "/" });
  assert.equal(rendered.statusCode, 200, rendered.body);
  assert.ok(rendered.body.includes("Главная"));
});

test("theme components receive the configured lead form view model", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: "themes/reference-theme-v1",
    seoEnvironment: "production",
  });
  const form = await app.formsSource.domain.definitions.createDefinition({
    key: "sitewide_contact",
    title: "Запросить консультацию",
    fields: [{ key: "email", type: "email", label: "E-mail", required: true }],
  });
  const ctx = apiContextOf(ownerActor("theme-form-seeder"));
  const { saveThemeSettings } = await import("@pcms/api");
  await saveThemeSettings(app, ctx, {
    values: { lead_form_id: form.id },
    expected_generation: 0,
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_theme_form");
  await registerSite(fastify, app);
  const home = await publishPage(app, { title: "Страница с формой в футере" });
  await app.routes.setHomeEntry((await app.routes.ensureSite("default")).id, home.entryId);

  const response = await fastify.inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 200, response.body);
  // The theme owns the <form> attribute order (footer adds a class) — pin the
  // CONTRACT parts (transport hook + form id) instead of a literal prefix.
  assert.ok(response.body.includes("data-pcms-form"));
  assert.ok(response.body.includes(`/api/v1/public/forms/${form.id}/submit`));
  assert.ok(response.body.includes("Запросить консультацию"));
  assert.ok(response.body.includes("E-mail"));
});

test("preview page renders a sealed draft through the theme; /preview stays JSON state", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await siteStack(t);
  const ctx = apiContextOf(ownerActor("preview-seeder"));
  const { createDraft, sealRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: { title: "Черновик: ангар 3000 м²", intro: "Предпросмотр черновика" },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  // Owner case (admin "preview" button): the draft is SEALED but never
  // published — only the signed token can reach it.
  assert.ok(app.previewTokens);
  const token = app.previewTokens.issue({
    kind: "revision",
    entityType: "entry",
    entityId: draft.entry_id as never,
    revisionId: draft.revision_id as never,
  });

  const page = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(token)}`,
  });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.ok(String(page.headers["x-robots-tag"]).includes("noindex"));
  assert.ok(String(page.headers["cache-control"]).includes("no-store"));
  assert.ok(page.body.includes("Черновик: ангар 3000 м²"), page.body);

  // (GET /preview — the JSON state transport — is registered by the API
  // composition, not the site router; its contract is pinned in tests/api.)

  // A tampered token is rejected, never a 500 or a render.
  const rejected = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(`${token}x`)}`,
  });
  assert.equal(rejected.statusCode, 404);

  // And the draft stays invisible on the public site.
  const publicHome = await fastify.inject({ method: "GET", url: "/" });
  assert.ok(!publicHome.body.includes("Черновик: ангар 3000 м²"));
});

test("draft RichText media preview prepares its derivative without sealing or publishing", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await siteStack(t);
  t.after(() => fastify.close());
  const { uploadMedia, listVariants } = await import("@pcms/media");
  const { createDraft, createThemePreview } = await import("@pcms/api");
  assert.ok(app.mediaStorage && app.mediaQuarantine);
  const accepted = await uploadMedia(
    { pool: app.pool, storage: app.mediaStorage, quarantine: app.mediaQuarantine },
    {
      bytes: readFileSync("examples/pcpub/external-entries/assets/hero.png"),
      filename: "draft.png",
      createdBy: "test",
    },
  );
  const ctx = apiContextOf(ownerActor("draft-preview"));
  const draft = await createDraft(app, ctx, {
    content_type: "article",
    payload: {
      fields: {
        title: "Unsealed image",
        body: {
          type: "document",
          schema_version: 2,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Draft body" }] },
            { type: "image", media_id: accepted.asset.id, alt: "Draft alt" },
          ],
        },
      },
    },
  });
  const before = await app.revisions.requireRevision(app.pool, draft.revision_id as never);
  assert.equal((await listVariants(app.pool, accepted.asset.id, 1)).length, 0);
  const preview = await createThemePreview(app, ctx, {
    scope: {
      kind: "revision",
      entity_type: "entry",
      entity_id: draft.entry_id,
      revision_id: draft.revision_id,
      allow_draft: true,
    },
  });
  const page = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(preview.token)}`,
  });
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.body, /alt="Draft alt"/);
  assert.match(page.body, /richtext-v1/);
  assert.deepEqual(
    await app.revisions.requireRevision(app.pool, draft.revision_id as never),
    before,
  );
  assert.equal(
    await app.publications.getPublication(app.pool, "entry", draft.entry_id as never, "default"),
    null,
  );
});

test("active theme refreshes after package replacement without a web restart", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Active revisions are immutable; deliver replacements through the native lifecycle.
  const root = mkdtempSync(join(tmpdir(), "pcms-theme-active-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const activeDir = join(root, "active-theme");
  const writeActive = (marker: string, version: string, dir = activeDir): void => {
    mkdirSync(join(dir, "templates"), { recursive: true });
    mkdirSync(join(dir, "blocks"), { recursive: true });
    mkdirSync(join(dir, "components"), { recursive: true });
    mkdirSync(join(dir, "tokens"), { recursive: true });
    mkdirSync(join(dir, "fixtures"), { recursive: true });
    writeFileSync(
      join(dir, "fixtures", "page.json"),
      JSON.stringify({
        name: "page",
        entry: {
          templateKey: "page-default",
          contentTypeKey: "page",
          contentTypeVersion: 1,
          title: "Theme fixture",
          fields: { title: "Theme fixture" },
          blocks: [],
        },
      }),
    );
    writeFileSync(
      join(dir, "theme.json"),
      JSON.stringify({
        id: "active-theme",
        name: "active-theme",
        version,
        theme_contract: "^1.0",
        templates: [
          {
            id: "page-default",
            file: "templates/page-default.liquid",
            accepts_content_types: ["page@1"],
          },
        ],
        components: [],
        block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
        navigation_placements: [
          { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
        ],
        media_presets: [{ id: "card", width: 800 }],
        settings_schema: [],
      }),
    );
    // Different marker lengths keep the fingerprint (size+mtime) honest.
    writeFileSync(
      join(dir, "templates", "page-default.liquid"),
      `<p data-theme="active">${marker}: {{ entry.fields.title }}</p>`,
    );
    writeFileSync(join(dir, "blocks", "text.liquid"), "{{ block.props.rich_text }}");
  };
  writeActive("ACTIVE-V1", "1.0.0");

  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: activeDir,
    seoEnvironment: "production",
  });
  const siteFastify: FastifyInstance = createApiFastify(() => "req_active_refresh");
  await registerSite(siteFastify, app);

  const ctx = apiContextOf(ownerActor("active-refresh-seeder"));
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Обновление темы" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  const site = await app.routes.ensureSite("default");
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/refresh",
    targetType: "entry",
    targetId: draft.entry_id,
  });

  const live1 = await siteFastify.inject({ method: "GET", url: "/refresh/" });
  assert.equal(live1.statusCode, 200, live1.body);
  assert.ok(live1.body.includes("ACTIVE-V1"), live1.body.slice(0, 400));

  const candidateDir = join(root, "candidate");
  writeActive("ACTIVE-V2-REFRESHED", "1.1.0", candidateDir);
  const archive = join(root, "update.pcTheme");
  execFileSync(
    "zip",
    ["-qr", archive, "theme.json", "templates", "blocks", "components", "tokens", "fixtures"],
    { cwd: candidateDir },
  );
  await changeTheme(app, ctx, { kind: "UPDATE", packageBytes: readFileSync(archive) });
  assert.ok(app.themeDir);
  for (const dir of ["components", "tokens"])
    assert.equal(existsSync(join(app.themeDir, dir)), false);
  const live2 = await siteFastify.inject({ method: "GET", url: "/refresh/" });
  assert.equal(live2.statusCode, 200, live2.body);
  assert.match(live2.body, /ACTIVE-V2-REFRESHED/);
});

test("site route stays gated behind CMS Maintenance Mode (503 for anonymous)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: (REFERENCE_TYPES as { contentTypes: readonly unknown[] })
      .contentTypes as never,
    themeDir: "themes/reference-theme-v1",
  });
  const { registerMaintenanceGate } = await import("../../apps/web/src/maintenance-gate.js");
  const { updateMaintenanceState } = await import("@pcms/operations");
  const fastify: FastifyInstance = createApiFastify(() => "req_gate");
  registerMaintenanceGate(fastify, {
    application: app,
    logger: createLogger({ level: "warn", base: {} }),
    cookieSecure: false,
  });
  await registerSite(fastify, app);
  await updateMaintenanceState(app.pool, systemClock, { enabled: true }, "test");

  const response = await fastify.inject({ method: "GET", url: "/" });
  assert.equal(response.statusCode, 503);

  // Signed preview surfaces stay reachable while maintenance is ON (§25) —
  // the token is the credential, no bypass session required.
  const preview = await fastify.inject({ method: "GET", url: "/preview/page?token=garbage" });
  assert.equal(preview.statusCode, 404);
});

test("collectBlockMediaIds walks nested array references (gallery items[].media_id)", async () => {
  const { collectBlockMediaIds } = await import("../../apps/web/src/site.js");
  const descriptors: Record<string, unknown> = {
    gallery: { references: [{ prop: "items[].media_id", kind: "media" }] },
    image: { references: [{ prop: "media_id", kind: "media" }] },
  };
  const app = {
    blocks: {
      getBlockType: (typeId: string, _version: number) => descriptors[typeId],
    },
  } as never;
  const ids = new Set<string>();
  collectBlockMediaIds(
    [
      {
        type: "gallery",
        schemaVersion: 1,
        props: {
          items: [
            {
              id: "0198c0de-0000-7000-8000-0000000000a1",
              media_id: "0198c0de-0000-7000-8000-000000000001",
            },
            {
              id: "0198c0de-0000-7000-8000-0000000000a2",
              media_id: "0198c0de-0000-7000-8000-000000000002",
            },
          ],
        },
        children: [],
      },
      {
        type: "image",
        schemaVersion: 1,
        props: { media_id: "0198c0de-0000-7000-8000-000000000003" },
        children: [],
      },
    ],
    app,
    ids,
  );
  assert.equal(ids.size, 3);
  assert.ok(ids.has("0198c0de-0000-7000-8000-000000000001"));
  assert.ok(ids.has("0198c0de-0000-7000-8000-000000000002"));
  assert.ok(ids.has("0198c0de-0000-7000-8000-000000000003"));
});

test("card image follows explicit hero, gallery/image document order and alt", async () => {
  const { selectCardImage } = await import("../../apps/web/src/site.js");
  const id = (n: number) => `0198c0de-0000-7000-8000-${n.toString().padStart(12, "0")}`;
  const image = (n: number, alt?: string) => ({
    type: "image",
    props: { media_id: id(n), alt_override: alt },
  });
  const gallery = {
    type: "gallery",
    props: { items: [{ media_id: id(0) }, { media_id: id(2), alt_override: "Gallery alt" }] },
  };
  const lookup = async (key: string) =>
    key === id(0)
      ? null
      : ({
          id: key,
          kind: key === id(9) ? "document" : "image",
          alt: "Library alt",
          derivatives: key === id(8) ? [] : [{ preset: "card", url: `/card/${key}` }],
          caption: null,
          width: 1,
          height: 1,
          download: null,
        } as never);
  assert.deepEqual(await selectCardImage(id(1), [gallery], lookup), {
    image: `/card/${id(1)}`,
    image_alt: "Library alt",
  });
  for (const hero of [undefined, null, "", "  "])
    assert.deepEqual(await selectCardImage(hero, [gallery, image(3)], lookup), {
      image: `/card/${id(2)}`,
      image_alt: "Gallery alt",
    });
  assert.deepEqual(
    await selectCardImage(
      null,
      [{ type: "callout", props: { icon: id(1) }, children: [image(4, "Nested alt")] }, image(3)],
      lookup,
    ),
    { image: `/card/${id(4)}`, image_alt: "Nested alt" },
  );
  assert.deepEqual(await selectCardImage(null, [image(9), image(8), image(0), image(3)], lookup), {
    image: `/card/${id(3)}`,
    image_alt: "Library alt",
  });
  for (const hero of [id(0), id(8), "invalid"])
    assert.deepEqual(await selectCardImage(hero, [image(3)], lookup), {
      image: null,
      image_alt: null,
    });
  assert.deepEqual(await selectCardImage(null, [], lookup), { image: null, image_alt: null });
});

test("published article blocks and declared media fields reach the compatible Web theme", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { uploadMedia, generateVariantsForAsset, createMediaPresetRegistry } = await import(
    "@pcms/media"
  );
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const root = mkdtempSync(join(tmpdir(), "pcms-render-fidelity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const theme = join(root, "theme");
  cpSync("themes/reference-theme-v1", theme, { recursive: true });
  const manifestPath = join(theme, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    cms_compatibility?: string;
    templates: { id: string; accepts_content_types: string[] }[];
    media_presets: { id: string; [key: string]: unknown }[];
  };
  const articleTemplate = manifest.templates.find((item) => item.id === "article-default");
  assert.ok(articleTemplate);
  articleTemplate.accepts_content_types.push("article@2");
  manifest.media_presets.push({
    id: "product-wide",
    width: 1200,
    height: 630,
    fit: "cover",
    formats: ["webp"],
    quality: 80,
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const heroTemplatePath = join(theme, "templates/page-hero.liquid");
  const heroTemplate = readFileSync(heroTemplatePath, "utf8");
  assert.ok(heroTemplate.includes(".presets.hero"));
  writeFileSync(
    heroTemplatePath,
    heroTemplate.replaceAll(".presets.hero", ".presets.product-wide"),
  );

  const definitions = JSON.parse(
    readFileSync("fixtures/content/reference-content-types.json", "utf8"),
  ).contentTypes as {
    key: string;
    version: number;
    title: string;
    description?: string;
    bodyPolicy: string;
    fields: Record<string, unknown>;
  }[];
  const pageType = definitions.find((item) => item.key === "page");
  assert.ok(pageType);
  const baseDefinitions = structuredClone(definitions);
  const mediaRoot = join(root, "media");
  const quarantineRoot = join(root, "quarantine");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: baseDefinitions as never,
    themeDir: theme,
    seoEnvironment: "production",
    mediaRoots: { storage: mediaRoot, quarantine: quarantineRoot },
  });
  const storage = app.mediaStorage;
  const quarantine = app.mediaQuarantine;
  assert.ok(storage && quarantine);
  const cmsVersion = app.extensions.contractVersions.get("cms")?.version;
  assert.ok(cmsVersion);
  manifest.cms_compatibility = `~${cmsVersion}`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const fastify = createApiFastify(() => "req_render_fidelity_before_schema");
  const { registerMediaFilesRoute } = await import("../../apps/web/src/media-files.js");
  registerMediaFilesRoute(fastify, { application: app });
  await registerSite(fastify, app);
  t.after(() => fastify.close());

  const accepted = await uploadMedia(
    { pool: app.pool, storage, quarantine },
    {
      bytes: readFileSync("examples/pcpub/external-entries/assets/hero.png"),
      filename: "render-fidelity.png",
      createdBy: "test",
    },
  );
  await generateVariantsForAsset(
    { pool: app.pool, storage, maxSourceBytes: 10_000_000 },
    accepted.asset,
    createMediaPresetRegistry(manifest.media_presets as never),
  );
  await app.pool.query("UPDATE media_assets SET alt_default = 'Library hero alt' WHERE id = $1", [
    accepted.asset.id,
  ]);

  const ctx = apiContextOf(ownerActor("render-fidelity-seeder"));
  const articlePayload = {
    fields: { title: "Typed article", author: "Editor", tags: ["Progressive CMS"] },
    blocks: {
      schema_version: 1,
      blocks: [
        {
          id: "0198c0de-0000-7000-8000-000000000201",
          type: "heading",
          schema_version: 1,
          variant: null,
          props: { level: 2, text: "First article heading" },
          children: [],
        },
        {
          id: "0198c0de-0000-7000-8000-000000000202",
          type: "text",
          schema_version: 1,
          variant: null,
          props: {
            rich_text: {
              schema_version: 2,
              type: "document",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Complete article body reaches the renderer." }],
                },
              ],
            },
          },
          children: [],
        },
        {
          id: "0198c0de-0000-7000-8000-000000000203",
          type: "gallery",
          schema_version: 1,
          variant: null,
          props: {
            items: [
              {
                id: "0198c0de-0000-7000-8000-000000000204",
                media_id: accepted.asset.id,
                alt_override: "Nested article image alt",
                caption: "Nested article image caption",
              },
            ],
          },
          children: [],
        },
        {
          id: "0198c0de-0000-7000-8000-000000000205",
          type: "heading",
          schema_version: 1,
          variant: null,
          props: { level: 3, text: "Second article heading" },
          children: [],
        },
      ],
    },
  };
  const article = await createDraft(app, ctx, {
    content_type: "article",
    template_key: "article-default",
    payload: articlePayload,
  });
  // v2-only: a rich_text revision carrying hidden blocks can no longer be
  // sealed, and no shim reopens that door.
  await assert.rejects(sealRevision(app, ctx, { revision_id: article.revision_id }), {
    code: "REVISION_VALIDATION_FAILED",
  });
  // The historical publication this test renders was sealed under RC16, before
  // v2-only validation existed. Reproduce that row directly rather than routing
  // it through a gate that now (correctly) refuses it. The row is created
  // sealed, so no existing SEALED revision is mutated.
  const { hashCanonicalPayload } = await import("@pcms/revisions");
  await app.pool.query(
    `UPDATE revisions
        SET state = 'SEALED', payload_hash = $2, sealed_at = now(), updated_at = now()
      WHERE id = $1`,
    [article.revision_id, hashCanonicalPayload(articlePayload)],
  );
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: article.entry_id,
    target_revision_id: article.revision_id,
    expected_generation: 0,
  });
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/rendered-article/",
    targetType: "entry",
    targetId: article.entry_id,
  });

  const oldSearchDocument = await app.searchSource.buildDocument("entry", article.entry_id);
  assert.ok(oldSearchDocument);
  assert.ok(!oldSearchDocument.body_text.includes("Complete article body reaches the renderer."));
  const oldArticleResponse = await fastify.inject({ method: "GET", url: "/rendered-article/" });
  assert.equal(oldArticleResponse.statusCode, 200, oldArticleResponse.body);
  assert.ok(!oldArticleResponse.body.includes("Complete article body reaches the renderer."));

  pageType.fields.hero_image = { id: "hero_image", type: "media" };
  definitions.push({
    key: "article",
    version: 2,
    title: "Article",
    description: "Block-document article with typed media references",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true },
      author: { id: "author", type: "string" },
      tags: { id: "tags", type: "list", item: { id: "tag", type: "string" } },
      body: { id: "body", type: "block_document" },
    },
  });
  const { applyContentSchemaOp, createApplicationServices } = await import("@pcms/api");
  const { effectiveContentTypeDefinitions } = await import("@pcms/content");
  const schemaApply = await applyContentSchemaOp(app, ctx, { definitions });
  assert.equal(schemaApply.restart_required, true);
  const refreshedDefinitions = await effectiveContentTypeDefinitions(
    app.pool,
    baseDefinitions as never,
  );
  const refreshedApp = createApplicationServices({
    pool: app.pool,
    clock: API_CLOCK,
    contentTypeDefinitions: refreshedDefinitions as never,
    themeDir: theme,
    seoEnvironment: "production",
    mediaStorage: new LocalMediaStorage({ root: mediaRoot }),
    mediaQuarantine: new LocalMediaStorage({ root: quarantineRoot }),
  });
  const refreshedFastify = createApiFastify(() => "req_render_fidelity_after_schema");
  registerMediaFilesRoute(refreshedFastify, { application: refreshedApp });
  await registerSite(refreshedFastify, refreshedApp);
  t.after(() => refreshedFastify.close());

  const apiReadback = await refreshedApp.revisions.getRevision(
    refreshedApp.pool,
    article.revision_id as never,
  );
  assert.deepEqual(apiReadback?.payload, articlePayload);
  assert.equal(apiReadback?.id, article.revision_id);
  const searchDocument = await refreshedApp.searchSource.buildDocument("entry", article.entry_id);
  assert.ok(searchDocument);
  assert.ok(searchDocument.body_text.includes("Complete article body reaches the renderer."));
  const firstSearchHeading = searchDocument.body_text.indexOf("First article heading");
  const secondSearchHeading = searchDocument.body_text.indexOf("Second article heading");
  assert.ok(firstSearchHeading >= 0 && secondSearchHeading > firstSearchHeading);

  const articleResponse = await refreshedFastify.inject({
    method: "GET",
    url: "/rendered-article/",
  });
  assert.equal(articleResponse.statusCode, 200, articleResponse.body);
  const articleHtml = articleResponse.body;
  assert.ok(articleHtml.includes("Complete article body reaches the renderer."));
  const firstHeading = articleHtml.indexOf("First article heading");
  const secondHeading = articleHtml.indexOf("Second article heading");
  assert.ok(firstHeading >= 0 && secondHeading > firstHeading);
  assert.ok(articleHtml.includes('alt="Nested article image alt"'));
  assert.ok(articleHtml.includes("Nested article image caption"));
  const articleImagePath = articleHtml.match(
    /<img src="([^"]+)"[^>]*alt="Nested article image alt"/,
  )?.[1];
  assert.ok(articleImagePath);
  assert.ok(articleImagePath.includes(`/media/a/${accepted.asset.id}/v1/thumbnail-`));
  const articleImage = await refreshedFastify.inject({ method: "GET", url: articleImagePath });
  assert.equal(articleImage.statusCode, 200, articleImage.body);
  assert.match(articleImage.headers["content-type"] ?? "", /^image\//);

  const heroPage = await createDraft(refreshedApp, ctx, {
    content_type: "page",
    template_key: "page-hero",
    payload: {
      fields: { title: "Typed hero page", hero_image: accepted.asset.id },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  await sealRevision(refreshedApp, ctx, { revision_id: heroPage.revision_id });
  await publishRevision(refreshedApp, ctx, {
    entity_type: "entry",
    entity_id: heroPage.entry_id,
    target_revision_id: heroPage.revision_id,
    expected_generation: 0,
  });
  await refreshedApp.routes.activateRoute({
    siteId: site.id,
    path: "/typed-hero/",
    targetType: "entry",
    targetId: heroPage.entry_id,
  });
  const heroResponse = await refreshedFastify.inject({ method: "GET", url: "/typed-hero/" });
  assert.equal(heroResponse.statusCode, 200, heroResponse.body);
  assert.ok(heroResponse.body.includes("Typed hero page"));
  const heroPath = heroResponse.body.match(/<img src="([^"]+)" alt="Library hero alt"/)?.[1];
  assert.ok(heroPath);
  assert.ok(heroPath.includes(`/media/a/${accepted.asset.id}/v1/product-wide-`));
  const heroImage = await refreshedFastify.inject({ method: "GET", url: heroPath });
  assert.equal(heroImage.statusCode, 200, heroImage.body);
  assert.match(heroImage.headers["content-type"] ?? "", /^image\//);

  const ordinaryPage = await publishPage(refreshedApp, { title: "Ordinary block page" });
  await refreshedApp.routes.activateRoute({
    siteId: site.id,
    path: "/ordinary-page/",
    targetType: "entry",
    targetId: ordinaryPage.entryId,
  });
  const ordinaryResponse = await refreshedFastify.inject({ method: "GET", url: "/ordinary-page/" });
  assert.equal(ordinaryResponse.statusCode, 200, ordinaryResponse.body);
  assert.ok(ordinaryResponse.body.includes("Ordinary block page"));
});

test("published related card renders block image and never a newer draft illustration", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { cp, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { uploadMedia, generateVariantsForAsset } = await import("@pcms/media");
  const { createMediaPresetRegistry } = await import("@pcms/media");
  const { createDraft, updateDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const root = await mkdtemp(join(tmpdir(), "pcms-card-render-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const theme = join(root, "theme");
  await cp("themes/reference-theme-v1", theme, { recursive: true });
  await writeFile(
    join(theme, "blocks/related_content.liquid"),
    '{% for card in related_cards %}<article><a href="{{ card.href }}">{{ card.title }}</a><img src="{{ card.image }}" alt="{{ card.image_alt }}"></article>{% endfor %}',
  );
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "block_document",
        fields: {
          title: { id: "title", type: "string", required: true },
          hero_image: { id: "hero_image", type: "media" },
        },
      },
    ] as never,
    themeDir: theme,
    mediaRoots: { storage: join(root, "media"), quarantine: join(root, "quarantine") },
  });
  const ctx = apiContextOf(ownerActor());
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  const accepted = await uploadMedia(
    { pool: app.pool, storage: app.mediaStorage!, quarantine: app.mediaQuarantine! },
    {
      bytes: readFileSync("examples/pcpub/external-entries/assets/hero.png"),
      filename: "card.png",
      createdBy: "test",
    },
  );
  await generateVariantsForAsset(
    { pool: app.pool, storage: app.mediaStorage!, maxSourceBytes: 10_000_000 },
    accepted.asset,
    createMediaPresetRegistry(
      JSON.parse(readFileSync(join(theme, "theme.json"), "utf8")).media_presets,
    ),
  );
  await app.pool.query("UPDATE media_assets SET alt_default = 'Library alt' WHERE id = $1", [
    accepted.asset.id,
  ]);
  const target = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: { title: "Published target" },
      blocks: {
        schema_version: 1,
        blocks: [
          {
            id: "0198c0de-0000-7000-8000-000000000101",
            type: "image",
            schema_version: 1,
            props: { media_id: accepted.asset.id, alt_override: "Published block alt" },
          },
        ],
      },
    },
  });
  await sealRevision(app, ctx, { revision_id: target.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: target.entry_id,
    target_revision_id: target.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/card-target/",
    targetType: "entry",
    targetId: target.entry_id,
  });
  const selection = await publishPage(app, {
    title: "Selection",
    blocks: [
      {
        id: "0198c0de-0000-7000-8000-000000000102",
        type: "related_content",
        schema_version: 1,
        props: { mode: "manual", entry_ids: [target.entry_id] },
      },
    ],
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/card-selection/",
    targetType: "entry",
    targetId: selection.entryId,
  });
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru",
    locales: ["ru", "en"],
    updatedBy: "test",
  });
  const translation = await createDraft(app, ctx, {
    content_type: "page",
    locale: "en",
    payload: {
      fields: { title: "Published translation" },
      blocks: {
        schema_version: 1,
        blocks: [
          {
            id: "0198c0de-0000-7000-8000-000000000104",
            type: "image",
            schema_version: 1,
            props: { media_id: accepted.asset.id, alt_override: "Translated published alt" },
          },
        ],
      },
    },
  });
  await app.pool.query(
    "UPDATE entries SET locale = 'en', translation_group_id = $2 WHERE id = $1",
    [translation.entry_id, target.entry_id],
  );
  await sealRevision(app, ctx, { revision_id: translation.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: translation.entry_id,
    target_revision_id: translation.revision_id,
    expected_generation: 0,
    context: "en",
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/card-target/",
    locale: "en",
    targetType: "entry",
    targetId: translation.entry_id,
  });
  const englishSelection = await createDraft(app, ctx, {
    content_type: "page",
    locale: "en",
    payload: {
      fields: { title: "English selection" },
      blocks: {
        schema_version: 1,
        blocks: [
          {
            id: "0198c0de-0000-7000-8000-000000000105",
            type: "related_content",
            schema_version: 1,
            props: { mode: "manual", entry_ids: [target.entry_id] },
          },
        ],
      },
    },
  });
  await sealRevision(app, ctx, { revision_id: englishSelection.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: englishSelection.entry_id,
    target_revision_id: englishSelection.revision_id,
    expected_generation: 0,
    context: "en",
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/card-selection/",
    locale: "en",
    targetType: "entry",
    targetId: englishSelection.entry_id,
  });
  const fastify = createApiFastify(() => "req_card");
  const { registerMediaFilesRoute } = await import("../../apps/web/src/media-files.js");
  registerMediaFilesRoute(fastify, { application: app });
  const variantsBeforeGet = (
    await app.pool.query("SELECT id FROM media_variants WHERE asset_id = $1 ORDER BY id", [
      accepted.asset.id,
    ])
  ).rows;
  t.after(() => fastify.close());
  await registerSite(fastify, app);
  const translatedCard = await fastify.inject({ method: "GET", url: "/en/card-selection/" });
  assert.equal(translatedCard.statusCode, 200);
  assert.match(translatedCard.body, /alt="Translated published alt"/);
  assert.match(translatedCard.body, /href="\/en\/card-target\/"/);
  const first = await fastify.inject({ method: "GET", url: "/card-selection/" });
  assert.equal(first.statusCode, 200);
  assert.match(first.body, /alt="Published block alt"/);
  assert.match(first.body, new RegExp(`/media/a/${accepted.asset.id}/v1/card-`));
  const devOrigin = await fastify.listen({ host: "127.0.0.1", port: 0 });
  const selectionUrl = `${devOrigin}/card-selection/`;
  const targetUrl = `${devOrigin}/card-target/`;
  assert.equal((await fetch(targetUrl)).status, 200);
  const httpCard = await fetch(selectionUrl);
  assert.equal(httpCard.status, 200);
  const cardHtml = await httpCard.text();
  assert.match(cardHtml, /alt="Published block alt"/);
  const imagePath = cardHtml.match(/<img src="([^"]+)" alt="Published block alt"/)![1]!;
  const cardPixels = await fetch(new URL(imagePath, devOrigin));
  assert.equal(cardPixels.status, 200);
  assert.match(cardPixels.headers.get("content-type") ?? "", /^image\//);
  assert.ok((await cardPixels.arrayBuffer()).byteLength > 0);
  assert.deepEqual(
    (
      await app.pool.query("SELECT id FROM media_variants WHERE asset_id = $1 ORDER BY id", [
        accepted.asset.id,
      ])
    ).rows,
    variantsBeforeGet,
    "GET never generates derivatives",
  );
  t.diagnostic(
    `PCMS_CARD_DEV ${JSON.stringify({ targetUrl, selectionUrl, entry_id: target.entry_id, selection_entry_id: selection.entryId, note: "disposable DEV fixture; server closes after the test" })}`,
  );
  const { createWorkingDraft } = await import("@pcms/api");
  const working = await createWorkingDraft(app, ctx, { entry_id: target.entry_id });
  await updateDraft(app, ctx, {
    revision_id: working.revision_id,
    expected_edit_generation: 0,
    payload: {
      fields: { title: "Draft title" },
      blocks: {
        schema_version: 1,
        blocks: [
          {
            id: "0198c0de-0000-7000-8000-000000000103",
            type: "image",
            schema_version: 1,
            props: { media_id: accepted.asset.id, alt_override: "Draft alt" },
          },
        ],
      },
    },
  });
  const afterDraft = await fastify.inject({ method: "GET", url: "/card-selection/" });
  assert.match(afterDraft.body, /alt="Published block alt"/);
  assert.doesNotMatch(afterDraft.body, /Draft alt|Draft title/);
  await app.pool.query("UPDATE media_assets SET archived_at = now() WHERE id = $1", [
    accepted.asset.id,
  ]);
  const afterArchive = await fastify.inject({ method: "GET", url: "/card-selection/" });
  assert.doesNotMatch(afterArchive.body, /alt="Published block alt"/);
  assert.match(afterArchive.body, /<img src="" alt="">/);
});

test("preview renders a candidate theme via the signed token; active theme untouched", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // Two minimal sibling themes: the ACTIVE one renders the page through the
  // live contract; the CANDIDATE only appears when a signed token names it
  // (2026-10-01 site-developer request: preview a theme candidate without
  // switching renderDir/activation).
  const root = mkdtempSync(join(tmpdir(), "pcms-theme-preview-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mkTheme = (id: string, marker: string, primaryColor: string, version = "1.0.0"): void => {
    const dir = join(root, id);
    mkdirSync(join(dir, "templates"), { recursive: true });
    writeFileSync(
      join(dir, "theme.json"),
      JSON.stringify({
        id,
        name: id,
        version,
        theme_contract: "^1.0",
        templates: [
          ...["search", "error-404"].map((id) => ({
            id,
            file: `templates/${id}.liquid`,
            accepts_content_types: ["page@1"],
            editor_selectable: false,
          })),
          {
            id: "page-default",
            file: "templates/page-default.liquid",
            accepts_content_types: ["page@1"],
          },
        ],
        components: [],
        block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
        navigation_placements: [
          { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
        ],
        media_presets: [{ id: "card", width: 800 }],
        settings_schema: [{ key: "brand_marker", type: "string", default: marker }],
      }),
    );
    mkdirSync(join(dir, "blocks"), { recursive: true });
    mkdirSync(join(dir, "components"), { recursive: true });
    mkdirSync(join(dir, "tokens"), { recursive: true });
    writeFileSync(
      join(dir, "templates", "page-default.liquid"),
      `<p data-theme="${id}">${marker}: {{ entry.fields.title }} {{ tokens_css }}</p>`,
    );
    for (const service of ["search", "error-404"])
      writeFileSync(
        join(dir, "templates", `${service}.liquid`),
        `<title>Service — {{ site.site_name }}</title><span data-setting="{{ theme_settings.brand_marker }}"></span><img src="{{ media[theme_settings.service_image].presets.card.src }}" alt="service media"><p>${marker} ${service} {{ theme_settings.brand_marker }} {{ request.locale }} {{ search.query }} {{ search.total }} {% for item in search.items %}{{ item.title }}{% endfor %} {% for item in nav["header.primary"].items %}<a href="{{ item.href }}">{{ item.title }}</a>{% endfor %} <style>{{ tokens_css }}</style> {{ head.robots }}</p>`,
      );
    writeFileSync(join(dir, "blocks", "text.liquid"), "{{ block.props.rich_text }}");
    writeFileSync(
      join(dir, "tokens", "base.json"),
      JSON.stringify({ "color.primary": { value: primaryColor, type: "color" } }),
    );
  };
  mkTheme("active-theme", "ACTIVE-THEME-RENDER", "#111111");
  mkTheme("candidate", "CANDIDATE-THEME-RENDER", "#222222");

  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: join(root, "active-theme"),
    seoEnvironment: "production",
    mediaRoots: { storage: join(root, "media"), quarantine: join(root, "quarantine") },
    mediaPresets: [{ id: "card", width: 800 }],
  });
  const siteFastify: FastifyInstance = createApiFastify(() => "req_theme_preview");
  const { uploadMediaOp } = await import("@pcms/api");
  const sharp = (await import("sharp")).default;
  const accepted = await uploadMediaOp(app, apiContextOf(ownerActor()), {
    filename: "service.png",
    bytes: await sharp({ create: { width: 900, height: 600, channels: 3, background: "#224466" } })
      .png()
      .toBuffer(),
  });
  for (const id of ["active-theme", "candidate"]) {
    const path = join(root, id, "theme.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.settings_schema.push({
      key: "service_image",
      type: "media",
      token: "--service-image",
      default: accepted.asset.id,
    });
    writeFileSync(path, JSON.stringify(manifest));
  }
  await app.pool.query(`INSERT INTO admin_theme_state (site_key, theme_key, theme_version, settings)
    VALUES ('default', 'active-theme', '1.0.0', '{"brand_marker":"ACTIVE-SAVED-SETTING"}')
    ON CONFLICT (site_key) DO UPDATE SET settings = EXCLUDED.settings`);
  await registerSite(siteFastify, app);

  const ctx = apiContextOf(ownerActor("theme-preview-seeder"));
  const { createDraft, sealRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: { title: "Кандидат темы", intro: "preview" },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  const ref = {
    kind: "revision" as const,
    entityType: "entry",
    entityId: draft.entry_id as never,
    revisionId: draft.revision_id as never,
  };

  // No theme in the token → the ACTIVE theme renders.
  const active = await siteFastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(app.previewTokens!.issue(ref))}`,
  });
  assert.equal(active.statusCode, 200, `ACTIVE: ${active.statusCode} ${active.body.slice(0, 300)}`);
  assert.ok(active.body.includes("ACTIVE-THEME-RENDER"), active.body);

  // Signed candidate theme → the CANDIDATE renders the same revision.
  const themed = await siteFastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(app.previewTokens!.issue(ref, { theme: "candidate" }))}`,
  });
  assert.equal(themed.statusCode, 200, `THEMED: ${themed.statusCode} ${themed.body.slice(0, 300)}`);
  assert.ok(themed.body.includes("CANDIDATE-THEME-RENDER"), themed.body);
  assert.ok(!themed.body.includes("ACTIVE-THEME-RENDER"), themed.body);
  // Tokens come from the CANDIDATE theme, never the active one
  // (0.1.130 regression: candidate preview leaked active tokens_css).
  assert.ok(themed.body.includes("#222222"), themed.body);
  assert.ok(!themed.body.includes("#111111"), themed.body);

  // Unknown/uninstalled theme id → typed 404, never a render or a leak.
  const invalid = await siteFastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(app.previewTokens!.issue(ref, { theme: "nope" }))}`,
  });
  assert.equal(invalid.statusCode, 404);
  assert.ok(invalid.body.includes("PREVIEW_THEME_INVALID"));

  // Traversal can never escape the themes root even through a signed token.
  const traversal = await siteFastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(app.previewTokens!.issue(ref, { theme: "../escape" }))}`,
  });
  assert.equal(traversal.statusCode, 404);

  const { createThemePreview } = await import("@pcms/api");
  const { scopedActor } = await import("../helpers/api-composition.js");
  await assert.rejects(
    createThemePreview(app, apiContextOf(scopedActor([])), {
      scope: { kind: "service", template: "search" },
      theme: "candidate",
    }),
  );
  const result = await publishPage(app, {
    title: "Searchable Reactor",
    intro: "Reactor technology",
  });
  const site = await app.routes.ensureSite("default");
  await app.domains.addDomainBinding({
    siteId: site.id,
    hostname: "services.test",
    isPrimary: true,
  });
  await app.routes.setHomeEntry(site.id, result.entryId);
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/reactor/",
    targetType: "entry",
    targetId: result.entryId,
  });
  await app.seo.saveSiteSettings(site.id as never, { site_name: "Progressive CMS" });
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru-RU",
    locales: ["ru-RU", "en-US"],
    updatedBy: "test",
  });
  const en = await app.entries.createEntry({
    contentTypeId: "page",
    createdBy: "test",
    locale: "en-US",
    translationGroupId: result.entryId as never,
  });
  const enRevision = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: en.id,
    locale: "en-US",
    schemaVersion: "1",
    actor: { actorClass: "human", actorId: "test", origin: "human" },
    payload: { fields: { title: "English Reactor" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: enRevision.id });
  const { publishRevision } = await import("@pcms/api");
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: en.id,
    target_revision_id: enRevision.id,
    context: "en-US",
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/reactor/",
    locale: "en-US",
    targetType: "entry",
    targetId: en.id,
  });
  const unpublished = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Private draft" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/private-draft/",
    targetType: "entry",
    targetId: unpublished.entry_id,
  });
  const nav = await app.navigation.createSet({ key: "service-menu", title: "Service menu" });
  for (const [id, label] of [
    [result.entryId, "Published nav"],
    [unpublished.entry_id, "Private draft nav"],
  ] as const)
    await app.navigation.insertItem({
      setId: nav.id,
      type: "internal_entry",
      label,
      target: { kind: "internal_entry", entry_id: id },
    });
  await app.placements.bindPlacement({ placementKey: "header.primary", navigationSetId: nav.id });
  await app.searchReindex.runSynchronously();
  const snapshot = async () =>
    (await app.pool.query("SELECT * FROM admin_theme_state ORDER BY site_key")).rows;
  const settingsBefore = await snapshot();
  const publicationsBefore = (
    await app.pool.query("SELECT * FROM publications ORDER BY entity_id, context")
  ).rows;
  for (const template of ["search", "error-404"] as const) {
    const { token } = await createThemePreview(app, apiContextOf(scopedActor(["preview.create"])), {
      scope: { kind: "service", template },
      theme: "candidate",
    });
    for (const q of template === "search" ? ["", "Reactor", "NoSuchResultUnicorn"] : [""]) {
      const response = await siteFastify.inject({
        method: "GET",
        url: `/preview/page?token=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`,
      });
      assert.equal(response.statusCode, template === "search" ? 200 : 404, response.body);
      assert.match(response.body, /CANDIDATE-THEME-RENDER/);
      assert.match(response.body, /data-setting="CANDIDATE-THEME-RENDER"/);
      assert.doesNotMatch(response.body, /ACTIVE-SAVED-SETTING/);
      assert.match(response.body, /Service — Progressive CMS/);
      assert.match(response.body, new RegExp(`/media/a/${accepted.asset.id}/v1/card-`));
      assert.match(response.body, /href="\/">Published nav/);
      assert.doesNotMatch(response.body, /Private draft nav|private-draft/);
      assert.match(response.body, /#222222/);
      assert.ok(!response.body.includes("ACTIVE-THEME-RENDER"));
      assert.match(String(response.headers["x-robots-tag"]), /noindex, nofollow/);
      assert.match(String(response.headers["cache-control"]), /no-store/);
      assert.match(String(response.headers["referrer-policy"]), /no-referrer/);
      const style = response.body.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1];
      assert.ok(style);
      assert.ok(
        String(response.headers["content-security-policy"]).includes(
          createHash("sha256").update(style).digest("base64"),
        ),
      );
      if (q === "Reactor") assert.match(response.body, /Searchable Reactor/);
      if (q === "NoSuchResultUnicorn") assert.ok(!response.body.includes("Searchable Reactor"));
    }
    for (const theme of ["nope", "../escape"]) {
      const invalid = app.previewTokens!.issue({ kind: "service", template }, { theme });
      assert.equal(
        (
          await siteFastify.inject({
            method: "GET",
            url: `/preview/page?token=${encodeURIComponent(invalid)}`,
          })
        ).statusCode,
        404,
      );
    }
    const tampered = await siteFastify.inject({
      method: "GET",
      url: `/preview/page?token=${encodeURIComponent(token + "x")}`,
    });
    assert.equal(tampered.statusCode, 404);
  }
  for (const locale of ["ru-RU", "en-US"]) {
    const token = app.previewTokens!.issue(
      { kind: "service", template: "error-404", locale },
      { theme: "candidate" },
    );
    for (const url of [
      `/preview/page?token=${encodeURIComponent(token)}`,
      locale === "en-US" ? "/en/missing/" : "/missing/",
      locale === "en-US" ? "/en/private-draft/" : "/private-draft/",
    ]) {
      const response = await siteFastify.inject({ method: "GET", url });
      assert.equal(response.statusCode, 404, response.body);
      assert.match(response.body, /Service — Progressive CMS/);
      assert.match(response.body, new RegExp(`/media/a/${accepted.asset.id}/v1/card-`));
      assert.ok(response.body.includes(locale), response.body);
      assert.match(
        response.body,
        url.startsWith("/preview/")
          ? /data-setting="CANDIDATE-THEME-RENDER"/
          : /data-setting="ACTIVE-SAVED-SETTING"/,
      );
      assert.match(
        response.body,
        locale === "en-US" ? /href="\/en\/reactor\/">Published nav/ : /href="\/">Published nav/,
      );
      assert.doesNotMatch(response.body, /Private draft nav|private-draft/);
    }
  }
  const serviceToken = app.previewTokens!.issue(
    { kind: "service", template: "search" },
    { theme: "candidate" },
  );
  mkTheme("candidate", "REINSTALLED-CANDIDATE", "#333333", "2.0.0");
  const reinstalled = await siteFastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(serviceToken)}`,
  });
  assert.equal(reinstalled.statusCode, 200, reinstalled.body);
  assert.match(reinstalled.body, /REINSTALLED-CANDIDATE/);
  assert.match(reinstalled.body, /#333333/);
  assert.ok(!reinstalled.body.includes("#222222"));
  assert.deepEqual(await snapshot(), settingsBefore);
  assert.deepEqual(
    (await app.pool.query("SELECT * FROM publications ORDER BY entity_id, context")).rows,
    publicationsBefore,
  );
  for (const url of ["/", "/search/?q=Reactor", "/missing/"]) {
    const live = await siteFastify.inject({ method: "GET", url });
    assert.match(live.body, /ACTIVE-THEME-RENDER/);
    assert.ok(!live.body.includes("CANDIDATE-THEME-RENDER"));
  }

  // Active-theme isolation is already pinned above: a themeless token still
  // renders ACTIVE while the themed token renders CANDIDATE (public home has
  // no published entry in this fixture — its own tests cover that path).
});

test("candidate preview rebuilds after the theme package is reinstalled under the same id", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // 2026-10-01 follow-up: the candidate stack cache was keyed by theme id
  // only — a .pcTheme reinstall left previews on the stale templates/tokens
  // until a web restart. The fingerprint (theme.json size+mtime) must
  // rebuild the stack so OLD and NEW tokens render the CURRENTLY installed
  // version — never a mix.
  const root = mkdtempSync(join(tmpdir(), "pcms-theme-reinstall-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Direct minimal writer (same shape as the candidate test above).
  const writeCandidate = (marker: string, color: string, version: string): void => {
    const dir = join(root, "candidate");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "templates"), { recursive: true });
    mkdirSync(join(dir, "blocks"), { recursive: true });
    mkdirSync(join(dir, "components"), { recursive: true });
    mkdirSync(join(dir, "tokens"), { recursive: true });
    writeFileSync(
      join(dir, "theme.json"),
      JSON.stringify({
        id: "candidate",
        name: "candidate",
        version,
        theme_contract: "^1.0",
        templates: [
          {
            id: "page-default",
            file: "templates/page-default.liquid",
            accepts_content_types: ["page@1"],
          },
        ],
        components: [],
        block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
        navigation_placements: [
          { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
        ],
        media_presets: [{ id: "card", width: 800 }],
        settings_schema: [],
      }),
    );
    writeFileSync(
      join(dir, "templates", "page-default.liquid"),
      `<p data-theme="candidate">${marker}: {{ entry.fields.title }} {{ tokens_css }}</p>`,
    );
    writeFileSync(join(dir, "blocks", "text.liquid"), "{{ block.props.rich_text }}");
    writeFileSync(
      join(dir, "tokens", "base.json"),
      JSON.stringify({ "color.primary": { value: color, type: "color" } }),
    );
  };
  {
    const dir = join(root, "active-theme");
    mkdirSync(join(dir, "templates"), { recursive: true });
    mkdirSync(join(dir, "blocks"), { recursive: true });
    mkdirSync(join(dir, "components"), { recursive: true });
    mkdirSync(join(dir, "tokens"), { recursive: true });
    writeFileSync(
      join(dir, "theme.json"),
      JSON.stringify({
        id: "active-theme",
        name: "active-theme",
        version: "1.0.0",
        theme_contract: "^1.0",
        templates: [
          {
            id: "page-default",
            file: "templates/page-default.liquid",
            accepts_content_types: ["page@1"],
          },
        ],
        components: [],
        block_renderers: [{ block: "text@1", file: "blocks/text.liquid" }],
        navigation_placements: [
          { id: "header.primary", max_depth: 2, supported_item_types: ["internal_entry"] },
        ],
        media_presets: [{ id: "card", width: 800 }],
        settings_schema: [],
      }),
    );
    writeFileSync(
      join(dir, "templates", "page-default.liquid"),
      `<p data-theme="active-theme">ACTIVE-THEME-RENDER: {{ entry.fields.title }} {{ tokens_css }}</p>`,
    );
    writeFileSync(join(dir, "blocks", "text.liquid"), "{{ block.props.rich_text }}");
  }
  writeCandidate("V1-THEME-RENDER", "#111111", "1.0.0");

  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: join(root, "active-theme"),
    seoEnvironment: "production",
  });
  const siteFastify: FastifyInstance = createApiFastify(() => "req_theme_reinstall");
  await registerSite(siteFastify, app);

  const ctx = apiContextOf(ownerActor("theme-reinstall-seeder"));
  const { createDraft, sealRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: { title: "Переустановка темы", intro: "preview" },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  const ref = {
    kind: "revision" as const,
    entityType: "entry",
    entityId: draft.entry_id as never,
    revisionId: draft.revision_id as never,
  };

  // Warm the stack on V1 and keep the old token.
  const oldToken = app.previewTokens!.issue(ref, { theme: "candidate" });
  const v1 = await siteFastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(oldToken)}`,
  });
  assert.equal(v1.statusCode, 200, v1.body);
  assert.ok(v1.body.includes("V1-THEME-RENDER"), v1.body);

  // "Reinstall": same id, different template, tokens, manifest version.
  writeCandidate("V2-THEME-RENDER", "#333333", "2.0.1");

  for (const label of ["old token", "fresh token"]) {
    const token =
      label === "old token" ? oldToken : app.previewTokens!.issue(ref, { theme: "candidate" });
    const page = await siteFastify.inject({
      method: "GET",
      url: `/preview/page?token=${encodeURIComponent(token)}`,
    });
    assert.equal(page.statusCode, 200, `${label}: ${page.body}`);
    assert.ok(page.body.includes("V2-THEME-RENDER"), `${label}: ${page.body}`);
    assert.ok(!page.body.includes("V1-THEME-RENDER"), `${label}: stale mix`);
    assert.ok(page.body.includes("#333333"), `${label}: ${page.body}`);
  }

  // Uninstall → typed 404, cache does not resurrect the theme.
  rmSync(join(root, "candidate"), { recursive: true, force: true });
  const gone = await siteFastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(oldToken)}`,
  });
  assert.equal(gone.statusCode, 404);
  assert.ok(gone.body.includes("PREVIEW_THEME_INVALID"));
});

test("live SEO selects published A while signed draft/SEALED preview selects B; home aliases share canonical", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await siteStack(t);
  const { createWorkingDraft, updateDraft, sealRevision } = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());
  const site = await app.routes.ensureSite("default");
  await app.domains.addDomainBinding({ siteId: site.id, hostname: "seo.test", isPrimary: true });
  const a = await publishPage(app, { title: "Published Alpha", intro: "Published intro Alpha" });
  await app.routes.setHomeEntry(site.id, a.entryId);
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/home/",
    targetType: "entry",
    targetId: a.entryId,
  });
  const b = await createWorkingDraft(app, ctx, { entry_id: a.entryId });
  const snapshot = async () =>
    (await app.pool.query("SELECT * FROM publications ORDER BY entity_id, context")).rows;
  const pointers = await snapshot();
  const checkLive = async () => {
    for (const url of ["/", "/home/"]) {
      const response = await fastify.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.body, /<title>Published Alpha(?: — default)?<\/title>/);
      assert.match(response.body, /property="og:title" content="Published Alpha"/);
      assert.match(response.body, /name="twitter:title" content="Published Alpha"/);
      assert.match(response.body, /name="description" content="Published intro Alpha"/);
      assert.match(response.body, /rel="canonical" href="https:\/\/seo.test\/"/);
      assert.match(
        JSON.stringify(
          (await app.seoDiscovery.previewSeoFor(a.entryId, { published: true }))?.head.json_ld,
        ),
        /Published Alpha/,
      );
      assert.ok(!response.body.includes("Draft Beta"));
    }
    assert.deepEqual(await snapshot(), pointers);
  };
  for (const generation of [0, 1]) {
    await updateDraft(app, ctx, {
      revision_id: b.revision_id,
      expected_edit_generation: generation,
      payload: {
        fields: { title: `Draft Beta ${generation}`, intro: "Draft Beta intro" },
        blocks: { schema_version: 1, blocks: [] },
      },
    });
    await checkLive();
    const token = app.previewTokens!.issue(
      {
        kind: "revision",
        entityType: "entry",
        entityId: a.entryId as never,
        revisionId: b.revision_id as never,
      },
      { draft: true },
    );
    const response = await fastify.inject({
      method: "GET",
      url: `/preview/page?token=${encodeURIComponent(token)}`,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(
      response.body,
      new RegExp(`<title>Draft Beta ${generation}(?: — default)?</title>`),
    );
    assert.match(response.body, /property="og:title" content="Draft Beta/);
    assert.match(
      JSON.stringify(
        (await app.seoDiscovery.previewSeoFor(a.entryId, { revisionId: b.revision_id }))?.head
          .json_ld,
      ),
      /Draft Beta/,
    );
    assert.ok(!response.body.includes("Published Alpha"));
    const live = await app.seoDiscovery.previewSeoFor(a.entryId, { published: true });
    assert.equal(live?.resolved.title.value, "Published Alpha");
    assert.equal(
      (await app.seoDiscovery.resolveSeoMetadataFor(a.entryId, { published: true }))?.resolved.title
        .value,
      "Published Alpha",
    );
    assert.equal(
      (await app.seoDiscovery.previewSeoFor(a.entryId))?.resolved.title.value,
      `Draft Beta ${generation}`,
    );
  }
  await sealRevision(app, ctx, { revision_id: b.revision_id });
  await checkLive();
  const c = await createWorkingDraft(app, ctx, { entry_id: a.entryId });
  await updateDraft(app, ctx, {
    revision_id: c.revision_id,
    expected_edit_generation: 0,
    payload: {
      fields: { title: "Draft Gamma", intro: "Gamma intro" },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  const sealedToken = app.previewTokens!.issue({
    kind: "revision",
    entityType: "entry",
    entityId: a.entryId as never,
    revisionId: b.revision_id as never,
  });
  const sealedPreview = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(sealedToken)}`,
  });
  assert.equal(sealedPreview.statusCode, 200, sealedPreview.body);
  assert.match(sealedPreview.body, /<title>Draft Beta 1/);
  assert.ok(!sealedPreview.body.includes("Draft Gamma"));
  await checkLive();
  const sitemap = await app.seoDiscovery.getSitemapDocument();
  assert.equal(sitemap?.match(/<loc>https:\/\/seo.test\/<\/loc>/g)?.length, 1);
  assert.ok(!sitemap?.includes("/home/"), sitemap ?? "missing sitemap");
  assert.match(sitemap ?? "", /hreflang="ru-RU" href="https:\/\/seo.test\/"/);
});

test("localized home SEO and sitemap use each publication context, including a translation without a route", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await siteStack(t);
  const { sealRevision, publishRevision, updateDraft } = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru-RU",
    locales: ["ru-RU", "en-US"],
    updatedBy: "test",
  });
  const site = await app.routes.ensureSite("default");
  await app.domains.addDomainBinding({ siteId: site.id, hostname: "locale.test", isPrimary: true });
  const ru = await publishPage(app, { title: "Published Russian", intro: "Russian intro" });
  await app.routes.setHomeEntry(site.id, ru.entryId);
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/home/",
    targetType: "entry",
    targetId: ru.entryId,
  });
  const en = await app.entries.createEntry({
    contentTypeId: "page",
    createdBy: "test",
    locale: "en-US",
    translationGroupId: ru.entryId as never,
  });
  const payload = {
    fields: { title: "Published English", intro: "English intro" },
    blocks: { schema_version: 1, blocks: [] },
  };
  const revision = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: en.id,
    payload,
    locale: "en-US",
    schemaVersion: "1",
    actor: { actorClass: "human", actorId: "test", origin: "human" },
  });
  await sealRevision(app, ctx, { revision_id: revision.id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: en.id,
    target_revision_id: revision.id,
    context: "en-US",
    expected_generation: 0,
  });
  const working = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: en.id,
    payload,
    locale: "en-US",
    schemaVersion: "1",
    actor: { actorClass: "human", actorId: "test", origin: "human" },
  });
  await updateDraft(app, ctx, {
    revision_id: working.id,
    expected_edit_generation: 0,
    payload: { ...payload, fields: { title: "English Draft", intro: "Draft intro" } },
  });
  const live = await fastify.inject({ method: "GET", url: "/en/" });
  assert.equal(live.statusCode, 200, live.body);
  assert.match(live.body, /<title>Published English/);
  assert.match(live.body, /rel="canonical" href="https:\/\/locale.test\/en\/"/);
  assert.match(live.body, /hreflang="ru-RU" href="https:\/\/locale.test\/"/);
  assert.ok(!live.body.includes("English Draft"));
  const seo = await app.seoDiscovery.previewSeoFor(en.id, { published: true, locale: "en-US" });
  assert.equal(seo?.resolved.title.value, "Published English");
  assert.equal(
    (await app.seoDiscovery.previewSeoFor(en.id, { locale: "en-US" }))?.resolved.title.value,
    "English Draft",
  );
  assert.equal(
    await app.seoDiscovery.previewSeoFor(en.id, { published: true, locale: "ru-RU" }),
    null,
  );
  const token = app.previewTokens!.issue(
    { kind: "revision", entityType: "entry", entityId: en.id, revisionId: working.id },
    { draft: true },
  );
  const preview = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(token)}`,
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.match(preview.body, /<title>English Draft/);
  assert.match(preview.body, /property="og:title" content="English Draft"/);
  const sitemap = await app.seoDiscovery.getSitemapDocument();
  assert.equal(sitemap?.match(/<loc>/g)?.length, 2, sitemap ?? "missing sitemap");
  assert.match(sitemap ?? "", /<loc>https:\/\/locale.test\/en\/<\/loc>/);
  assert.ok(!sitemap?.includes("/home/"));
});

// Owner tail 2026-10-03: core-rendered surfaces without an entry — the
// search results page and the 404 page — must carry the native Site
// Identity favicon exactly like entry pages do (identity ref → favicon-v1
// derivative → protected head section).
async function pngBytes(width: number, height: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 3, background: { r: 90, g: 40, b: 40 } } })
    .png()
    .toBuffer();
}

async function seedImageAsset(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  storage: LocalMediaStorage,
  id: string,
  bytes: Buffer,
  width: number,
  height: number,
): Promise<void> {
  const stored = await storage.put(bytes);
  const sha = stored.sha256;
  await app.pool.query(
    `INSERT INTO media_blobs (id, sha256, size_bytes, storage_key)
     VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING`,
    [stored.sha256.slice(0, 32), sha, bytes.length, stored.key],
  );
  await app.pool.query(
    `INSERT INTO media_assets
       (id, kind, current_version_no, original_blob_id, filename_original, mime_type,
        size_bytes, sha256, width, height, alt_default, created_by)
     VALUES ($1,'image',1,$2,'site-favicon.png','image/png',$3,$4,$5,$6,'Brand icon','test')
     ON CONFLICT (id) DO NOTHING`,
    [id, stored.sha256.slice(0, 32), bytes.length, sha, width, height],
  );
  await app.pool.query(
    `INSERT INTO media_versions
       (asset_id, version_no, blob_id, filename_original, mime_type, size_bytes, sha256, created_by)
     VALUES ($1, 1, $2, 'site-favicon.png', 'image/png', $3, $4, 'test')
     ON CONFLICT DO NOTHING`,
    [id, stored.sha256.slice(0, 32), bytes.length, sha],
  );
}

test("search results and 404 pages carry the Site Identity favicon", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, storage } = await siteStack(t);
  const site = await app.routes.ensureSite("default");
  void site;
  await publishPage(app, { title: "Favicon target", intro: "поисковое тело" });

  const faviconAssetId = "0198c0de-0000-7000-8000-0000000d0001";
  await seedImageAsset(app, storage, faviconAssetId, await pngBytes(512, 512), 512, 512);
  const { updateSiteIdentityOp } = await import("@pcms/api");
  await updateSiteIdentityOp(app, apiContextOf(ownerActor("site-favicon")), {
    identity: { site_name: "Favicon Site", favicon: { asset_id: faviconAssetId } },
  });

  const faviconTag = (html: string): string => {
    const links = html.match(/<link rel="icon"[^>]*>/g) ?? [];
    assert.equal(links.length, 1, `exactly one icon link: ${links.join("\n")}`);
    return links[0] ?? "(missing)";
  };

  const search = await fastify.inject({ method: "GET", url: "/search/?q=favicon" });
  assert.equal(search.statusCode, 200, search.body.slice(0, 300));
  const searchIcon = faviconTag(search.body);
  assert.ok(searchIcon.includes("favicon-v1"), searchIcon);
  assert.ok(searchIcon.includes(`/media/a/${faviconAssetId}/`), searchIcon);

  const missing = await fastify.inject({ method: "GET", url: "/no/such/page" });
  assert.equal(missing.statusCode, 404);
  const missingIcon = faviconTag(missing.body);
  assert.ok(missingIcon.includes("favicon-v1"), missingIcon);
  assert.ok(missingIcon.includes(`/media/a/${faviconAssetId}/`), missingIcon);

  // The derivative is exact 512×512 (R18), so sizes advertises it.
  assert.ok(searchIcon.includes('sizes="512x512"'), searchIcon);
});

// CORE-RC19 A — breadcrumbs reach the public Liquid scope.
//
// The mechanism existed (PageViewModel.breadcrumbs, deriveBreadcrumbs, the
// reference theme component) but nothing populated the public render scope, so
// `{% if breadcrumbs %}` silently rendered nothing. These gates pin the wiring
// on a real multi-level Content Tree, through the real theme.
test("breadcrumbs render for a nested page from the Content Tree", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await stackWithBreadcrumbs(t);

  // root → section → leaf: a three-level trail with the leaf's own title last.
  const section = await publishNested(app, { title: "Услуги", path: "/services" });
  const leaf = await publishNested(app, {
    title: "Аудит",
    path: "/services/audit",
    parentId: section.entryId,
  });

  const page = await fastify.inject({ method: "GET", url: "/services/audit/" });
  assert.equal(page.statusCode, 200, page.body);
  const nav = page.body.match(/<nav class="breadcrumbs"[\s\S]*?<\/nav>/);
  assert.ok(nav !== null, `breadcrumbs nav missing: ${page.body.slice(0, 600)}`);
  const trail = nav[0];
  // Order is root → current, and the current page is the non-link crumb.
  assert.ok(trail.indexOf("Услуги") < trail.indexOf("Аудит"), trail);
  assert.match(trail, /<a href="\/services\/">Услуги<\/a>/);
  assert.match(trail, /<li aria-current="page">Аудит<\/li>/);

  // A root page has no trail — no empty nav is emitted.
  const rootPage = await fastify.inject({ method: "GET", url: "/services/" });
  assert.equal(rootPage.statusCode, 200, rootPage.body);
  assert.ok(
    !rootPage.body.includes('class="breadcrumbs"'),
    "root page must not render breadcrumbs",
  );
  void leaf;
});

test("breadcrumb crumbs never leak internal IDs and skip unpublished ancestors", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await stackWithBreadcrumbs(t);

  // A DRAFT section must not appear in a live page's trail.
  const ctx = apiContextOf(ownerActor("breadcrumb-draft"));
  const { createDraft } = await import("@pcms/api");
  const draftSection = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Черновик" }, blocks: { schema_version: 1, blocks: [] } },
  });
  const child = await publishNested(app, {
    title: "Дочерняя",
    path: "/draft-child",
    parentId: draftSection.entry_id,
  });
  void child;

  const page = await fastify.inject({ method: "GET", url: "/draft-child/" });
  assert.equal(page.statusCode, 200, page.body);
  assert.ok(!page.body.includes("Черновик"), "a draft ancestor must not appear");
  // An internal stable ID must never surface as a visible crumb label.
  assert.ok(
    !/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(
      page.body.match(/<nav class="breadcrumbs"[\s\S]*?<\/nav>/)?.[0] ?? "",
    ),
    "no UUID in breadcrumb markup",
  );
});

test("ownership verification: meta tags on home head, exact root files, 404 elsewhere", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await siteStack(t);
  const site = await app.routes.ensureSite("default");
  const home = await publishPage(app, {
    title: "Домашняя",
    h1: "Домашняя",
    intro: "Проверка владения.",
    blocks: [],
  });
  await app.routes.setHomeEntry(site.id, home.entryId);
  const token = "jwA1Bc&<proof>";
  await app.seo.saveSiteSettings(site.id, {
    site_name: "Пример",
    verification: [
      // Token carrying HTML-significant characters proves the head escaping.
      { provider: "google", content: token },
      {
        provider: "yandex",
        content: "5a24bfc8483b6e17",
        method: "file",
        file: { filename: "yandex_5a24bfc8483b6e17.html", body: "5a24bfc8483b6e17" },
      },
    ],
  });

  // Homepage head carries both escaped provider meta tags in the protected
  // core section.
  const homeResponse = await fastify.inject({ method: "GET", url: "/" });
  assert.equal(homeResponse.statusCode, 200, homeResponse.body);
  assert.ok(
    homeResponse.body.includes(
      `<meta name="google-site-verification" content="jwA1Bc&amp;&lt;proof&gt;">`,
    ),
    "escaped google verification meta on home",
  );
  assert.ok(!homeResponse.body.includes("<proof>"), "raw token never reaches the markup unescaped");

  // Exact provider filename answers anonymously with the exact stored body.
  const proofResponse = await fastify.inject({
    method: "GET",
    url: "/yandex_5a24bfc8483b6e17.html",
  });
  assert.equal(proofResponse.statusCode, 200);
  assert.equal(proofResponse.body, "5a24bfc8483b6e17");
  assert.ok(proofResponse.headers["content-type"]?.includes("text/html"));
  assert.equal(proofResponse.headers["x-content-type-options"], "nosniff");
  // No theme wrapper: the body is exactly the provider bytes.
  assert.ok(!proofResponse.body.includes("<html"));

  // A wrong file path falls through to the normal 404 flow.
  const missing = await fastify.inject({ method: "GET", url: "/yandex_0000000000000000.html" });
  assert.equal(missing.statusCode, 404);

  // Non-home pages and 404 do not carry the ownership meta tags.
  await publishPage(app, { title: "Страница", h1: "Страница", intro: "x", blocks: [] });
  const nested = await fastify.inject({ method: "GET", url: "/stranica/" });
  if (nested.statusCode === 200) {
    assert.ok(
      !nested.body.includes("google-site-verification"),
      "verification meta is homepage-scoped",
    );
  }
  const notFound = await fastify.inject({ method: "GET", url: "/no-such-page/" });
  assert.equal(notFound.statusCode, 404);
  assert.ok(!notFound.body.includes("google-site-verification"));

  // Proof survives a settings round-trip (parse → save → read → serve).
  const current = await app.seo.getSiteSettings(site.id);
  assert.ok(current !== null, "site settings exist after configuring proofs");
  await app.seo.saveSiteSettings(site.id, current);
  const reread = await app.seo.getSiteSettings(site.id);
  assert.deepEqual(reread?.verification, current.verification);
  const again = await fastify.inject({ method: "GET", url: "/yandex_5a24bfc8483b6e17.html" });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body, "5a24bfc8483b6e17");
});
