// OG image + favicon contract (2026-10-03, owner brief «новый чистый
// контракт для social images и favicon»):
//
//   page.seo.social_image -> MediaAsset (source reference)
//     -> core derivative og-v1 (1200×630 jpeg, cover, focal-aware)
//   Site Branding identity.favicon -> MediaAsset (source reference)
//     -> core derivative favicon-v1 (512×512 png)
//
// The derivatives are rebuildable generated data: materialized only at
// assignment / social preview / publication validate / publish — never at
// upload and never on a public crawler request. The renderer resolves an
// EXISTING derivative; there is no best-variant heuristic and no
// first-image fallback. Publication validation reports a missing ogImage
// and broken sources with machine-readable codes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";
import { LocalMediaStorage } from "@pcms/media";
import { createDomainService } from "@pcms/routing";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const OWNER_CTX = () => apiContextOf(ownerActor("og-contract"), "rest", "req_og");

async function pngBytes(width: number, height: number, color: object): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 3, background: color } })
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
  alt: string,
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
     VALUES ($1,'image',1,$2,'og-source.png','image/png',$3,$4,$5,$6,$7,'test')
     ON CONFLICT (id) DO NOTHING`,
    [id, stored.sha256.slice(0, 32), bytes.length, sha, width, height, alt],
  );
  await app.pool.query(
    `INSERT INTO media_versions
       (asset_id, version_no, blob_id, filename_original, mime_type, size_bytes, sha256, created_by)
     VALUES ($1, 1, $2, 'og-source.png', 'image/png', $3, $4, 'test')
     ON CONFLICT DO NOTHING`,
    [id, stored.sha256.slice(0, 32), bytes.length, sha],
  );
}

test("og-v1 and favicon-v1: assignment materializes, validation reports, renderer resolves", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const root = mkdtempSync(join(tmpdir(), "pcms-og-contract-"));
  const mediaRoot = join(root, "media");
  mkdirSync(mediaRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

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
    themeDir: join(process.cwd(), "themes", "reference-theme-v1"),
    seoEnvironment: "production",
    mediaRoots: { storage: mediaRoot, quarantine: join(root, "quarantine") },
  });
  const storage = new LocalMediaStorage({ root: mediaRoot });
  const site = await app.routes.ensureSite("default");

  const ogAssetId = "0198c0de-0000-7000-8000-0000000b0001";
  const documentAssetId = "0198c0de-0000-7000-8000-0000000b0002";
  const faviconAssetId = "0198c0de-0000-7000-8000-0000000b0003";
  await seedImageAsset(
    app,
    storage,
    ogAssetId,
    await pngBytes(1600, 900, { r: 10, g: 60, b: 120 }),
    1600,
    900,
    "Brand OG",
  );
  await seedImageAsset(
    app,
    storage,
    documentAssetId,
    await pngBytes(100, 100, { r: 1, g: 2, b: 3 }),
    100,
    100,
    "Doc",
  );
  await seedImageAsset(
    app,
    storage,
    faviconAssetId,
    await pngBytes(512, 512, { r: 40, g: 90, b: 40 }),
    512,
    512,
    "Brand icon",
  );

  // --- 1. Explicit assignment materializes og-v1 (assignment point). ---
  const { updateEntrySeo, createDraft, publishRevision, sealRevision } = await import("@pcms/api");
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "OG-страница" }, blocks: { schema_version: 1, blocks: [] } },
  });
  const saved = await updateEntrySeo(app, OWNER_CTX(), {
    entry_id: draft.entry_id,
    document: { social_image: { asset_id: ogAssetId } },
  });
  assert.deepEqual(saved, { ok: true });
  const ogVariants = async (): Promise<
    { format: string; width: number; height: number; variant_key: string }[]
  > => {
    const result = await app.pool.query<{
      format: string;
      width: number;
      height: number;
      variant_key: string;
    }>(`SELECT * FROM media_variants WHERE asset_id = $1 AND preset_id = 'og-v1'`, [ogAssetId]);
    return result.rows;
  };
  const first = await ogVariants();
  assert.equal(first.length, 1, "exactly one og-v1 derivative");
  assert.equal(first[0]?.format, "jpeg");
  assert.equal(first[0]?.width, 1200);
  assert.equal(first[0]?.height, 630);

  // --- 2. Idempotent repeated generation: no duplicates. ---
  const { materializeOgDerivative } = await import("@pcms/api");
  await materializeOgDerivative(app, ogAssetId);
  await materializeOgDerivative(app, ogAssetId);
  assert.equal((await ogVariants()).length, 1);

  // --- 3. Focal point changes the crop deterministically (old key retired). ---
  const keyBefore = first[0]?.variant_key;
  await app.pool.query(`UPDATE media_assets SET focal_x = 0.2, focal_y = 0.3 WHERE id = $1`, [
    ogAssetId,
  ]);
  await materializeOgDerivative(app, ogAssetId);
  const afterFocal = await ogVariants();
  assert.equal(afterFocal.length, 1, "superseded og-v1 row retired");
  assert.notEqual(afterFocal[0]?.variant_key, keyBefore, "focal change → new crop");

  // --- 4. Invalid source: a non-image reference is rejected at assignment. ---
  await assert.rejects(
    updateEntrySeo(app, OWNER_CTX(), {
      entry_id: draft.entry_id,
      document: { social_image: { asset_id: "0198c0de-0000-7000-8000-0000000b0009" } },
    }),
    (error: { code?: string }) => error.code === "OG_IMAGE_SOURCE_INVALID",
  );
  // Restore the valid reference for the rest of the flow.
  await updateEntrySeo(app, OWNER_CTX(), {
    entry_id: draft.entry_id,
    document: { social_image: { asset_id: ogAssetId } },
  });

  // --- 6. Social preview uses the SAME pipeline: same URL as publish. ---
  const seoPreview = await app.seoDiscovery.previewSeoFor(draft.entry_id as never, {
    openGraph: true,
    materializeSocial: true,
  });
  assert.ok(seoPreview !== null);
  const ogMeta = seoPreview.head.core_meta.find((meta) => meta.property === "og:image");
  assert.ok(ogMeta !== undefined, JSON.stringify(seoPreview.head.core_meta));
  assert.match(ogMeta.content, /\/v1\/og-v1-[0-9a-z]+\.jpg$/);
  assert.ok(!ogMeta.content.includes("/current/"));

  // --- 7. Publication validation: no OG_IMAGE_MISSING for the assigned page;
  // an entry without ogImage is reported explicitly. ---
  const { validateRevision, createDraft: createDraft2 } = await import("@pcms/api");
  const bare = await createDraft2(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "Без og" }, blocks: { schema_version: 1, blocks: [] } },
  });
  const bareValidated = await validateRevision(app, OWNER_CTX(), {
    revision_id: bare.revision_id,
    publish_level: true,
  } as never).catch(() => null);
  void bareValidated;
  const seoValidate = await app.seoDiscovery.validateSeoFor(draft.entry_id as never);
  assert.ok(seoValidate !== null);
  assert.ok(
    !seoValidate.issues.some((issue) => issue.code === "OG_IMAGE_MISSING"),
    JSON.stringify(seoValidate.issues),
  );
  const bareSeo = await app.seoDiscovery.validateSeoFor(bare.entry_id as never);
  assert.ok(bareSeo !== null);
  assert.ok(
    bareSeo.issues.some((issue) => issue.code === "OG_IMAGE_MISSING"),
    JSON.stringify(bareSeo.issues),
  );

  // --- 8. Public renderer: live HTML og:image == the og-v1 derivative URL. ---
  await sealRevision(app, OWNER_CTX(), { revision_id: draft.revision_id });
  await publishRevision(app, OWNER_CTX(), {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/og-page",
    targetType: "entry",
    targetId: draft.entry_id,
  });

  const { registerMediaFilesRoute } = await import("../../apps/web/src/media-files.js");
  const fastify: FastifyInstance = createApiFastify(() => "req_og_contract");
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  await registerSiteRoute(fastify, { application: app });
  await registerMediaFilesRoute(fastify, { application: app });

  const live = await fastify.inject({ method: "GET", url: "/og-page/" });
  assert.equal(live.statusCode, 200, live.body.slice(0, 300));
  const ogImageMeta = live.body.match(/<meta property="og:image" content="([^"]*)"/);
  assert.ok(ogImageMeta !== null, live.body.slice(0, 900));
  const ogUrl = ogImageMeta[1] ?? "";
  assert.match(ogUrl, /\/v1\/og-v1-[0-9a-z]+\.jpg$/);
  assert.ok(!ogUrl.includes("/current/"));

  // --- 9. The actual href serves 200 decodable JPEG bytes (R16 acceptance). ---
  const mediaUrl = new URL(ogUrl, "http://127.0.0.1");
  const served = await fastify.inject({
    method: "GET",
    url: `${mediaUrl.pathname}${mediaUrl.search}`,
  });
  assert.equal(served.statusCode, 200, served.body.slice(0, 200));
  assert.match(String(served.headers["content-type"]), /image\/jpeg/);
  // inject returns the binary body as a latin1 string — hand sharp a Buffer.
  const servedBytes = served.rawPayload ?? Buffer.from(served.body, "binary");
  const { default: sharp } = await import("sharp");
  const decoded = await sharp(servedBytes).metadata();
  assert.equal(decoded.format, "jpeg");
  assert.equal(decoded.width, 1200);
  assert.equal(decoded.height, 630);

  // --- 10. Favicon source: branding assignment materializes favicon-v1
  // (512×512 png) and the head resolves it through the branding contract. ---
  const { updateSiteIdentityOp } = await import("@pcms/api");
  await updateSiteIdentityOp(app, OWNER_CTX(), {
    identity: { site_name: "OG Site", favicon: { asset_id: faviconAssetId } },
  });
  const faviconVariants = await app.pool.query(
    `SELECT * FROM media_variants WHERE asset_id = $1 AND preset_id = 'favicon-v1'`,
    [faviconAssetId],
  );
  assert.equal(faviconVariants.rowCount, 1);
  assert.equal(faviconVariants.rows[0]?.format, "png");
  assert.equal(faviconVariants.rows[0]?.width, 512);
  assert.equal(faviconVariants.rows[0]?.height, 512);

  const homeIdentityToken = app.previewTokens;
  void homeIdentityToken;
  const seoHead = await app.seoDiscovery.previewSeoFor(draft.entry_id as never, {
    openGraph: true,
  });
  const icons = seoHead?.head.icons ?? [];
  assert.ok(
    icons.some((icon) => icon.href.includes(`/media/a/${faviconAssetId}/`)),
    JSON.stringify(icons),
  );

  // --- 11. Permissions: page SEO assignment needs seo.edit (existing scope —
  // embedded, not expanded). ---
  const authorToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: (
      await app.machineIdentity.createServiceAccount({
        name: "og-author",
        purpose: "og permission regression",
        allowedScopes: ["content.read", "content.edit"],
      })
    ).id,
    scopes: ["content.read", "content.edit"],
    ttlMilliseconds: 3_600_000,
  });
  const fastifyApi: FastifyInstance = createApiFastify(() => "req_og_perm");
  const { createApiV1, makeMutationRoutes } = await import("@pcms/api");
  await fastifyApi.register(createApiV1([...makeMutationRoutes()]), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    cookieSecure: false,
  });
  const denied = await fastifyApi.inject({
    method: "PUT",
    url: `/api/v1/entries/${draft.entry_id}/seo`,
    headers: { authorization: `Bearer ${authorToken.rawSecret}` },
    payload: { document: { social_image: { asset_id: ogAssetId } } },
  });
  assert.equal(denied.statusCode, 403, denied.body);

  // --- Deleted source: publish refuses with a machine-readable code. ---
  const ghost = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "ghost" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await updateEntrySeo(app, OWNER_CTX(), {
    entry_id: ghost.entry_id,
    document: { social_image: { asset_id: ogAssetId } },
  });
  await app.pool.query(`DELETE FROM media_variants WHERE asset_id = $1`, [ogAssetId]);
  await app.pool.query(`DELETE FROM media_versions WHERE asset_id = $1`, [ogAssetId]);
  await app.pool.query(`DELETE FROM media_assets WHERE id = $1`, [ogAssetId]);
  await sealRevision(app, OWNER_CTX(), { revision_id: ghost.revision_id });
  await assert.rejects(
    publishRevision(app, OWNER_CTX(), {
      entity_type: "entry",
      entity_id: ghost.entry_id,
      target_revision_id: ghost.revision_id,
      expected_generation: 0,
    }),
    (error: { code?: string }) =>
      error.code === "OG_IMAGE_SOURCE_INVALID" || error.code === "OG_IMAGE_SOURCE_MISSING",
  );
});

// logo-v1 contract (p-cms.com 0.1.162 SEO audit gap 2): Site Identity.logo
// materializes its generated representation at assignment and the
// Organization structured-data node resolves ONLY that representation —
// the /current/ original transport stays closed, absence never fabricates.
test("logo-v1: identity assignment materializes, Organization resolves, absence omits", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const root = mkdtempSync(join(tmpdir(), "pcms-logo-contract-"));
  const mediaRoot = join(root, "media");
  mkdirSync(mediaRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

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
    themeDir: join(process.cwd(), "themes", "reference-theme-v1"),
    seoEnvironment: "production",
    mediaRoots: { storage: mediaRoot, quarantine: join(root, "quarantine") },
  });
  const storage = new LocalMediaStorage({ root: mediaRoot });
  const { createDraft, updateSiteIdentityOp } = await import("@pcms/api");
  const site = await app.routes.ensureSite("default");
  // Absolute structured-data URLs need a primary domain binding (§33).
  await createDomainService(app.pool).addDomainBinding({
    siteId: site.id,
    hostname: "logo.example.ru",
    schemePolicy: "https",
    isPrimary: true,
  });

  // A wide non-square source proves the contain fit + exact dimensions.
  const logoAssetId = "0198c0de-0000-7000-8000-0000000b0004";
  await seedImageAsset(
    app,
    storage,
    logoAssetId,
    await pngBytes(640, 400, { r: 200, g: 30, b: 30 }),
    640,
    400,
    "Brand logo",
  );

  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: {
      fields: { title: "Логотипная страница" },
      blocks: { schema_version: 1, blocks: [] },
    },
  });

  const organizationOf = async () => {
    const preview = await app.seoDiscovery.previewSeoFor(draft.entry_id as never, {});
    const graph = JSON.parse(preview?.structured_data.json_ld[0] ?? "{}") as {
      "@graph"?: { "@type": string; logo?: unknown }[];
    };
    return graph["@graph"]?.find((node) => node["@type"] === "Organization");
  };

  // Absence: identity without a logo → the Organization node omits it.
  await updateSiteIdentityOp(app, OWNER_CTX(), { identity: { site_name: "Акме" } });
  assert.equal((await organizationOf())?.logo, undefined, "no fabricated logo URL");

  // Assignment materializes logo-v1 (512×512 exact, contain-padded png).
  await updateSiteIdentityOp(app, OWNER_CTX(), {
    identity: { site_name: "Акме", logo: { asset_id: logoAssetId } },
  });
  const variants = await app.pool.query<{
    format: string;
    width: number;
    height: number;
  }>(
    `SELECT format, width, height FROM media_variants WHERE asset_id = $1 AND preset_id = 'logo-v1'`,
    [logoAssetId],
  );
  assert.equal(variants.rowCount, 1, "exactly one logo-v1 derivative");
  assert.equal(variants.rows[0]?.format, "png");
  assert.equal(variants.rows[0]?.width, 512);
  assert.equal(variants.rows[0]?.height, 512);

  // Discovery resolves the generated representation — never /current/.
  const organization = await organizationOf();
  const logo = organization?.logo;
  assert.ok(typeof logo === "string", JSON.stringify(organization));
  assert.match(logo as string, /\/v1\/logo-v1-[0-9a-z]+\.png$/);
  assert.ok(!(logo as string).includes("/current/"));
});
