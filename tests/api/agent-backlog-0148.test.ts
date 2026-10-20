// Site-agent backlog 2026-10-02 (registry inbox reports for 0.1.146/0.1.147):
//
// 1. `cms theme validate` never passed a cmsVersion, so an honest theme
//    declaring `cms_compatibility >= X` failed with THEME_CMS_INCOMPATIBLE
//    "site reports unknown" — and the CLI exposed no version argument.
//    Now the CLI/API validate against the running release version
//    (--cms-version overrides), and the package installer threads it too.
// 2. SEO discovery received `favicon: null`: a declared Site Identity
//    favicon could never resolve (SEO_FAVICON_MISSING even when declared).
//    The favicon port now resolves identity media through the Media
//    subsystem into crawlable head icons.
// 3. A revision stamped with a locale that differs from the entry identity
//    locale silently broke SEO/WORKING resolution (locale-keyed lookups).
//    createDraft rejects the mismatch up front (LOCALE_MISMATCH, 422) and
//    seal-level validation reports it for legacy data.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalMediaStorage } from "@pcms/media";
import { validateThemeDir } from "@pcms/themes";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";

async function pngBytes(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_THEME = join(process.cwd(), "themes", "reference-theme-v1");

/** Adopts the head_html contract: the theme's own title/meta/canonical block
 * is replaced by the trusted Core fragment (the site developer's candidate
 * does exactly this). */
function adoptHeadHtml(themeDir: string): void {
  const templatePath = join(themeDir, "templates", "page-default.liquid");
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
}
const OWNER_CTX = () => apiContextOf(ownerActor("agent-backlog"), "rest", "req_owner");

function stageThemeWithCompatibility(range: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "pcms-theme-compat-"));
  cpSync(REFERENCE_THEME, dir, { recursive: true });
  const manifestPath = join(dir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (range === null) delete manifest.cms_compatibility;
  else manifest.cms_compatibility = range;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

test("theme validate: cms_compatibility checks against the running release version", () => {
  const compatible = stageThemeWithCompatibility(">=1.0.0-rc.1 <2.0.0");
  const impossible = stageThemeWithCompatibility(">=999.0.0");
  try {
    // Running release version satisfies the declared range.
    const ok = validateThemeDir(compatible, { cmsVersion: "1.0.0-rc.1" });
    assert.equal(ok.ok, true, JSON.stringify(ok.issues));

    // No version handed in — the honest "unknown" report (was the only
    // behavior before the fix; the CLI no longer does this by default).
    const unknown = validateThemeDir(compatible);
    assert.equal(unknown.ok, false);
    assert.ok(
      unknown.issues.some((issue) => issue.code === "THEME_CMS_INCOMPATIBLE"),
      JSON.stringify(unknown.issues),
    );

    // An impossible range still fails with the version present.
    const failed = validateThemeDir(impossible, { cmsVersion: "1.0.0-rc.1" });
    assert.equal(failed.ok, false);
    assert.ok(failed.issues.some((issue) => issue.code === "THEME_CMS_INCOMPATIBLE"));
  } finally {
    rmSync(compatible, { recursive: true, force: true });
    rmSync(impossible, { recursive: true, force: true });
  }
});

test("cli theme validate: --cms-version reaches the validator", async () => {
  const dir = stageThemeWithCompatibility(">=999.0.0");
  try {
    const { themeValidate: command } = await import(
      "../../packages/cli/src/commands/theme-validate.js"
    );
    // Impossible range + explicit matching version → the CLI-level flag
    // reaches the validator (exit 1 with the issue in the JSON report).
    const report = command({ args: [dir, "--cms-version", "0.2.0", "--json"] });
    assert.equal(report.exitCode, 1);
    assert.ok(report.stdout.includes("THEME_CMS_INCOMPATIBLE"), report.stdout.slice(0, 400));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("favicon: discovery icons reach live, signed and candidate HTML; none invented", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  // The ACTIVE theme is staged in a private root so the candidate install
  // (themes root = its parent) never writes into the repository tree.
  const stage = mkdtempSync(join(tmpdir(), "pcms-favicon-"));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const activeDir = join(stage, "reference-theme-v1");
  cpSync(REFERENCE_THEME, activeDir, { recursive: true });
  adoptHeadHtml(activeDir);

  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "block_document",
        fields: { title: { id: "title", type: "string", required: true } },
      },
    ],
    themeDir: activeDir,
    seoEnvironment: "production",
    mediaRoots: { storage: join(stage, "media"), quarantine: join(stage, "quarantine") },
  });
  const site = await app.routes.ensureSite("default");
  // Minimal image assets written through the REAL storage so the media-files
  // route can serve them (R16 acceptance: the actual href must return bytes).
  const { default: sharp } = await import("sharp");
  const storage = new LocalMediaStorage({ root: join(stage, "media") });
  const putBlob = async (bytes: Buffer): Promise<{ id: string; key: string; sha: string }> => {
    const stored = await storage.put(bytes);
    const id = `0198c0de-0000-7000-8000-${stored.sha256.slice(0, 12)}`;
    await app.pool.query(
      `INSERT INTO media_blobs (id, sha256, size_bytes, storage_key)
       VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING`,
      [id, stored.sha256, stored.sizeBytes, stored.key],
    );
    return { id, key: stored.key, sha: stored.sha256 };
  };

  const ogAssetId = "0198c0de-0000-7000-8000-00000000fa01";
  const ogBlob = await putBlob(await pngBytes(1600, 900, { r: 10, g: 60, b: 120 }));
  await app.pool.query(
    `INSERT INTO media_assets
       (id, kind, current_version_no, original_blob_id, filename_original, mime_type,
        size_bytes, sha256, width, height, created_by)
     VALUES ($1,'image',1,$2,'og-source.png','image/png',2576,$3,1600,900,'test')
     ON CONFLICT (id) DO NOTHING`,
    [ogAssetId, ogBlob.id, ogBlob.sha],
  );
  await app.pool.query(
    `INSERT INTO media_versions (asset_id, version_no, blob_id, filename_original, mime_type, size_bytes, sha256, created_by)
     VALUES ($1, 1, $2, 'og-source.png', 'image/png', 2576, $3, 'test')
     ON CONFLICT DO NOTHING`,
    [ogAssetId, ogBlob.id, ogBlob.sha],
  );

  const faviconAssetId = "0198c0de-0000-7000-8000-00000000fa03";
  const favBytes = await pngBytes(512, 512, { r: 40, g: 90, b: 40 });
  const favBlob = await putBlob(favBytes);
  await app.pool.query(
    `INSERT INTO media_assets
       (id, kind, current_version_no, original_blob_id, filename_original, mime_type,
        size_bytes, sha256, width, height, alt_default, created_by)
     VALUES ($1,'image',1,$2,'favicon.png','image/png',$3,$4,512,512,'Brand icon','test')
     ON CONFLICT (id) DO NOTHING`,
    [faviconAssetId, favBlob.id, favBytes.length, favBlob.sha],
  );
  await app.pool.query(
    `INSERT INTO media_versions (asset_id, version_no, blob_id, filename_original, mime_type, size_bytes, sha256, created_by)
     VALUES ($1, 1, $2, 'favicon.png', 'image/png', $3, $4, 'test')
     ON CONFLICT DO NOTHING`,
    [faviconAssetId, favBlob.id, favBytes.length, favBlob.sha],
  );
  // Generated variant (R16): images resolve to their public VARIANT URL —
  // the document/current grammar deliberately 404s image originals.
  const variantBlobId = "0198c0de-0000-7000-8000-00000000fa03";
  const variantSha = "b".repeat(64);
  await app.pool.query(
    `INSERT INTO media_blobs (id, sha256, size_bytes, storage_key)
     VALUES ($1, $2, 20, 'test/favicon-card.png') ON CONFLICT (sha256) DO NOTHING`,
    [variantBlobId, variantSha],
  );
  await app.pool.query(
    `INSERT INTO media_variants
       (id, asset_id, version_no, preset_id, format, width, height, size_bytes, blob_id, variant_key)
     VALUES ('0198c0de-0000-7000-8000-00000000fa04', $1, 1, 'card', 'png', 192, 185, 20, $2, 'card1a2b3c')
     ON CONFLICT DO NOTHING`,
    [faviconAssetId, variantBlobId],
  );

  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "Favicon page" }, blocks: { schema_version: 1, blocks: [] } },
  });
  // Assign social_image so og:image:alt renders (the asset has alt_default)
  const { updateEntrySeo: saveSeo } = await import("@pcms/api");
  await saveSeo(app, OWNER_CTX(), {
    entry_id: draft.entry_id,
    document: { social_image: { asset_id: faviconAssetId } },
  });
  await sealRevision(app, OWNER_CTX(), { revision_id: draft.revision_id });
  await publishRevision(app, OWNER_CTX(), {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/favicon-page",
    targetType: "entry",
    targetId: draft.entry_id,
  });

  const { createApiFastify } = await import("@pcms/api");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  const fastify: import("fastify").FastifyInstance = createApiFastify(() => "req_favicon");
  await registerSiteRoute(fastify, { application: app });

  // Control — no favicon declared: no MEDIA icon tags are invented (the
  // reference theme's own hardcoded logo icon may still be there — themes
  // drop their static tags when they adopt head_html).
  const bare = await fastify.inject({ method: "GET", url: "/favicon-page/" });
  assert.equal(bare.statusCode, 200, bare.body.slice(0, 300));
  assert.equal((bare.body.match(/<link rel="icon"[^>]*href="[^"]*\/media\//g) ?? []).length, 0);

  // Declare the favicon in Site Identity...
  const { createSeoStore } = await import("@pcms/seo");
  const { ensureCoreDerivative, getAsset } = await import("@pcms/media");
  // Assignment-surface materialization: the identity op does exactly this for
  // the declared favicon source (this test assigns via the store to also pin
  // the resolution side independently of the op).
  await ensureCoreDerivative(
    { pool: app.pool, storage: app.mediaStorage!, maxSourceBytes: 128 * 1024 * 1024 },
    (await getAsset(app.pool, faviconAssetId as never))!,
    app.mediaPresets,
    "favicon-v1",
  );
  await createSeoStore(app.pool).saveSiteSettings(site.id, {
    site_name: "Favicon Site",
    favicon: { asset_id: faviconAssetId },
  } as never);
  const identity = await app.seoDiscovery.getSiteIdentity();
  assert.ok(identity?.favicon !== null && identity?.favicon !== undefined);

  // ...discovery resolves it...
  const seoPreview = await app.seoDiscovery.previewSeoFor(draft.entry_id as never, {
    openGraph: true,
  });
  assert.ok(seoPreview !== null);
  const icons = seoPreview.head.icons ?? [];
  assert.ok(icons.length >= 1, JSON.stringify(seoPreview.head));
  assert.equal(icons[0]?.rel, "icon");
  // R16: the href must be the GENERATED VARIANT URL — the document/current
  // grammar 404s image originals by design (Media §33).
  // favicon-v1 core derivative grammar (contract: versioned preset in URL)
  assert.match(icons[0]?.href ?? "", /\/media\/a\/[0-9a-f-]+\/v1\/favicon-v1-[0-9a-z]+\.png$/);
  assert.ok(!icons[0]?.href.includes("/current/"), icons[0]?.href);

  // ...and the resolved icons survive into LIVE HTML (R15: they were lost
  // between SEO discovery and the web render input).
  const live = await fastify.inject({ method: "GET", url: "/favicon-page/" });
  assert.equal(live.statusCode, 200, live.body.slice(0, 300));
  const liveMediaIcons =
    live.body.match(/<link rel="icon"[^>]*href="[^"]*\/media\/[^"]*"[^>]*>/g) ?? [];
  assert.equal(liveMediaIcons.length, 1, live.body.slice(0, 900));
  assert.ok(!liveMediaIcons[0]?.includes("/current/"), liveMediaIcons[0]);
  // R17/OG-contract: the favicon resolves the favicon-v1 core derivative
  // (not a best-variant heuristic URL).
  assert.ok(liveMediaIcons[0]?.includes("/favicon-v1-"), liveMediaIcons[0]);
  // R17-followup (2026-10-03): og:image:alt carries the ASSET's alt, never
  // the filename. Declare social_image on the entry's SEO document.
  const { createSeoStore: seoStoreCtor } = await import("@pcms/seo");
  const seoDocuments = seoStoreCtor(app.pool);
  await seoDocuments.saveDocument(
    draft.entry_id as never,
    {
      social_image: { asset_id: faviconAssetId },
    } as never,
  );
  const withSocial = await fastify.inject({ method: "GET", url: "/favicon-page/" });
  assert.equal(withSocial.statusCode, 200, withSocial.body.slice(0, 300));
  const altMeta = withSocial.body.match(/<meta property="og:image:alt" content="([^"]*)"/);
  assert.ok(altMeta !== null, withSocial.body.slice(0, 900));
  assert.equal(altMeta[1], "Brand icon", altMeta?.[1]);
  assert.ok(!altMeta[1].includes(".png"), altMeta[1]);

  // Signed CANDIDATE preview: identical icon tags under another theme.
  const candidateDir = join(stage, "candidate-f");
  cpSync(REFERENCE_THEME, candidateDir, { recursive: true });
  adoptHeadHtml(candidateDir);
  const manifestPath = join(candidateDir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    id: string;
    name: string;
  };
  manifest.id = "candidate-f";
  manifest.name = "Candidate F";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const { default: Yazl } = await import("yazl");
  const zip = new Yazl.ZipFile();
  const walk = (prefix: string, absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(name, child);
      else zip.addBuffer(readFileSync(child), name);
    }
  };
  walk("", candidateDir);
  zip.end();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  const { installThemePackage } = await import("@pcms/themes");
  const installed = await installThemePackage(bytes, {
    themesRoot: stage,
    renderDirThemeId: "reference-theme-v1",
  });
  assert.equal(installed.id, "candidate-f");

  const candidateToken = app.previewTokens?.issue(
    {
      kind: "revision",
      entityType: "entry",
      entityId: draft.entry_id as never,
      revisionId: draft.revision_id as never,
    },
    { theme: "candidate-f" },
  );
  assert.ok(candidateToken);
  const candidate = await fastify.inject({
    method: "GET",
    url: `/preview/page?token=${encodeURIComponent(candidateToken)}`,
  });
  assert.equal(candidate.statusCode, 200, candidate.body.slice(0, 300));
  const candidateMediaIcons =
    candidate.body.match(/<link rel="icon"[^>]*href="[^"]*\/media\/[^"]*"[^>]*>/g) ?? [];
  assert.deepEqual(candidateMediaIcons, liveMediaIcons, "same media icon tag as live");

  // Preview policy headers are untouched by the icon threading.
  assert.ok(String(candidate.headers["x-robots-tag"]).includes("noindex"));
  assert.ok(String(candidate.headers["cache-control"]).includes("no-store"));
});

test("locale contract: foreign-locale revisions are rejected early, legacy mismatches fail seal", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "block_document",
        fields: { title: { id: "title", type: "string", required: true } },
      },
    ],
  });
  // A `ru-RU` identity is only legal once the site declares it — identity
  // locales follow the localization policy (see the defect-H test below for
  // the single-locale rejection).
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru-RU",
    locales: ["ru-RU"],
    updatedBy: "test",
  });

  // (a) createDraft with an explicit locale carries it into the ENTRY
  // identity, so identity and revisions agree by construction (the agent's
  // broken shape — a foreign-locale revision under a `default` identity —
  // can no longer be produced by this path).
  const localized = await import("@pcms/api").then(({ createDraft }) =>
    createDraft(app, OWNER_CTX(), {
      content_type: "page",
      locale: "ru-RU",
      payload: { fields: { title: "x" }, blocks: { schema_version: 1, blocks: [] } },
    }),
  );
  const localizedEntry = await app.entries.getEntry(localized.entry_id as never);
  assert.equal(localizedEntry.locale, "ru-RU");
  const { validateRevision } = await import("@pcms/api");
  const localizedOk = await validateRevision(app, OWNER_CTX(), {
    revision_id: localized.revision_id,
  });
  assert.equal(localizedOk.ok, true, JSON.stringify(localizedOk.issues));

  // (b) legacy mismatched data (created before the gate): validate and seal
  // report LOCALE_MISMATCH instead of publishing a silently-unresolvable
  // revision.
  const { createDraft, sealRevision } = await import("@pcms/api");
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "Локаль" }, blocks: { schema_version: 1, blocks: [] } },
  });
  const foreign = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: draft.entry_id as never,
    payload: { fields: { title: "Локаль ru" }, blocks: null },
    schemaVersion: "1",
    locale: "ru-RU",
    actor: { actorClass: "human", actorId: "test-owner", origin: "human" },
  });
  const validated = await validateRevision(app, OWNER_CTX(), { revision_id: foreign.id });
  assert.equal(validated.ok, false);
  assert.ok(
    validated.issues.some((issue) => (issue as { code: string }).code === "LOCALE_MISMATCH"),
    JSON.stringify(validated.issues),
  );
  await assert.rejects(
    sealRevision(app, OWNER_CTX(), { revision_id: foreign.id }),
    (error: { code?: string }) => error.code === "REVISION_VALIDATION_FAILED",
  );
});

test("identity repair: sealed history keeps its locale without poisoning the entry (defect H)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "block_document",
        fields: { title: { id: "title", type: "string", required: true } },
      },
    ],
  });
  const { createDraft, reidentifyEntryLocale, sealRevision, validateRevision } = await import(
    "@pcms/api"
  );

  // The pilot shape: localization was ON when a service account sealed the
  // `ru-RU` history, then switched OFF (2026-09-29) — multilingual is
  // disabled again while the sealed history stays on the foreign locale.
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru-RU",
    locales: ["ru-RU"],
    updatedBy: "test",
  });
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    locale: "ru-RU",
    payload: { fields: { title: "Конфиденциальность" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, OWNER_CTX(), { revision_id: draft.revision_id });
  await app.localization.update({
    enabled: false,
    defaultLocale: "ru-RU",
    locales: ["ru-RU"],
    updatedBy: "test",
  });

  // The repair op moves identity + WORKING revisions to `default`; the sealed
  // revision is immutable and legitimately keeps `ru-RU`.
  const repaired = await reidentifyEntryLocale(app, OWNER_CTX(), {
    entry_id: draft.entry_id,
    locale: "default",
  });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.to, "default");
  const sealed = await app.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM revisions
     WHERE entity_type = 'entry' AND entity_id = $1 AND state = 'SEALED' AND locale = 'ru-RU'`,
    [draft.entry_id],
  );
  assert.equal(sealed.rows[0]?.count, "1", "sealed history keeps its own locale");

  // The sealed revision is HISTORY: it is immutable and legitimately keeps
  // `ru-RU`. Validating it must not report LOCALE_MISMATCH — otherwise the
  // repair op produces an entry its own validator rejects (defect H).
  const sealedValidated = await validateRevision(app, OWNER_CTX(), {
    revision_id: draft.revision_id,
  });
  assert.ok(
    !sealedValidated.issues.some((issue) => (issue as { code: string }).code === "LOCALE_MISMATCH"),
    `sealed history must not be flagged: ${JSON.stringify(sealedValidated.issues)}`,
  );

  // A fresh WORKING draft follows the repaired identity and still seals: the
  // mismatch guard keeps protecting new edits (2026-10-02 contract).
  const followUp = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: draft.entry_id as never,
    payload: { fields: { title: "Конфиденциальность" }, blocks: { schema_version: 1, blocks: [] } },
    schemaVersion: "1",
    locale: "default",
    actor: { actorClass: "human", actorId: "agent-backlog", origin: "human" },
  });
  const validated = await validateRevision(app, OWNER_CTX(), { revision_id: followUp.id });
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));

  // The guard is NOT weakened for live edits: a working revision in a foreign
  // locale under the repaired identity is still rejected.
  const foreign = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: draft.entry_id as never,
    payload: { fields: { title: "Стр" }, blocks: { schema_version: 1, blocks: [] } },
    schemaVersion: "1",
    locale: "ru-RU",
    actor: { actorClass: "human", actorId: "agent-backlog", origin: "human" },
  });
  const foreignValidated = await validateRevision(app, OWNER_CTX(), { revision_id: foreign.id });
  assert.equal(foreignValidated.ok, false);
  assert.ok(
    foreignValidated.issues.some((issue) => (issue as { code: string }).code === "LOCALE_MISMATCH"),
    JSON.stringify(foreignValidated.issues),
  );
});

test("single-locale site: foreign identity locale is refused on every creation path (defect H root)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "block_document",
        fields: { title: { id: "title", type: "string", required: true } },
      },
    ],
  });
  const { createDraft, duplicateEntryOp } = await import("@pcms/api");

  // Multilingual off (the default state): the identity gate must refuse a
  // foreign locale on the PUBLIC op, not only on the low-level service call —
  // createDraft goes through createEntryWithinTx, which used to bypass it.
  await assert.rejects(
    createDraft(app, OWNER_CTX(), {
      content_type: "page",
      locale: "ru-RU",
      payload: { fields: { title: "x" }, blocks: { schema_version: 1, blocks: [] } },
    }),
    (error: { code?: string }) => error.code === "LOCALIZATION_LOCALE_NOT_ENABLED",
  );

  // The default sentinel and an omitted locale still work on a single-locale
  // site — the gate must not break the ordinary path (or bundle/ingest, which
  // create entries without a locale).
  const plain = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "Обычная" }, blocks: { schema_version: 1, blocks: [] } },
  });
  assert.ok(plain.entry_id.length > 0);
  const explicit = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    locale: "default",
    payload: { fields: { title: "Явный default" }, blocks: { schema_version: 1, blocks: [] } },
  });
  assert.ok(explicit.entry_id.length > 0);

  // duplicateEntry derives the identity from the source entry, so a
  // single-locale site keeps duplicating default-locale entries.
  const copy = await duplicateEntryOp(app, OWNER_CTX(), { entry_id: plain.entry_id });
  assert.ok(copy.entry_id.length > 0);
});
