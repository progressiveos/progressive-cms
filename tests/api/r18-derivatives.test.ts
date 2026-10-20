// R18 (p-cms.ru site-developer report, 2026-10-03): core derivative presets
// declared exact dimensions (favicon-v1 512×512 png, og-v1 1200×630 jpeg)
// but silently produced smaller files from undersized sources — both resize
// paths ran with withoutEnlargement, and a cached row sharing the variant
// key was reused without a dimension check, freezing the malformed
// derivative in place. Regression coverage:
//   1. undersized favicon/OG sources materialize at the declared
//      dimensions (ordinary AND focal transforms), verified by decoding
//      the stored bytes — not just the recorded row;
//   2. a stale cached row (written under the old size policy) is rebuilt
//      under the SAME variant key, so public URLs stay stable;
//   3. correct existing derivatives stay reused (no rebuild churn);
//   4. ordinary theme-preset transforms keep the never-enlarge policy;
//   5. media pagination reports has_more at the documented limit maximum
//      (the service-side cap used to swallow the API overfetch row);
//   6. the SEO preview route materializes og-v1 (OG contract §3).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createApiFastify,
  createApiV1,
  makeDiscoveryRoutes,
  makeMutationRoutes,
  materializeOgDerivative,
  updateEntrySeo,
  updateSiteIdentityOp,
} from "@pcms/api";
import { LocalMediaStorage, transformImage } from "@pcms/media";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const OWNER_CTX = () => apiContextOf(ownerActor("r18"), "rest", "req_r18");

async function pngBytes(width: number, height: number, color: object): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

interface SeedStorage {
  put(bytes: Buffer): Promise<{ key: string; sha256: string; sizeBytes: number }>;
}

async function seedImageAsset(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  storage: SeedStorage,
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
     VALUES ($1,'image',1,$2,'r18-source.png','image/png',$3,$4,$5,$6,$7,'test')
     ON CONFLICT (id) DO NOTHING`,
    [id, stored.sha256.slice(0, 32), bytes.length, sha, width, height, alt],
  );
  await app.pool.query(
    `INSERT INTO media_versions
       (asset_id, version_no, blob_id, filename_original, mime_type, size_bytes, sha256, created_by)
     VALUES ($1, 1, $2, 'r18-source.png', 'image/png', $3, $4, 'test')
     ON CONFLICT DO NOTHING`,
    [id, stored.sha256.slice(0, 32), bytes.length, sha],
  );
}

interface VariantRow extends Record<string, unknown> {
  readonly id: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly variant_key: string;
  readonly blob_id: string;
}

async function fetchVariants(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  assetId: string,
  presetId: string,
): Promise<readonly VariantRow[]> {
  const result = await app.pool.query<VariantRow>(
    `SELECT id, format, width, height, variant_key, blob_id FROM media_variants
     WHERE asset_id = $1 AND preset_id = $2`,
    [assetId, presetId],
  );
  return result.rows;
}

/** Decodes the ACTUAL stored bytes of a variant — the recorded row may lie
 * (that is exactly the R18 stale-cache state). */
async function decodeVariant(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  storage: LocalMediaStorage,
  variant: VariantRow,
): Promise<{ format: string; width: number; height: number }> {
  const blob = await app.pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM media_blobs WHERE id = $1`,
    [variant.blob_id],
  );
  const bytes = await storage.getBuffer(blob.rows[0]?.storage_key ?? "", 128 * 1024 * 1024);
  const { default: sharp } = await import("sharp");
  const meta = await sharp(bytes).metadata();
  return { format: meta.format ?? "unknown", width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function bearerToken(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  name: string,
  scopes: readonly string[],
): Promise<string> {
  return (
    await app.machineIdentity.createAccessToken({
      serviceAccountId: (
        await app.machineIdentity.createServiceAccount({
          name,
          purpose: "r18 regression",
          allowedScopes: [...scopes],
        })
      ).id,
      scopes: [...scopes],
      ttlMilliseconds: 3_600_000,
    })
  ).rawSecret;
}

test("R18: undersized favicon/OG sources materialize at declared dimensions; stale cache self-heals", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const root = mkdtempSync(join(tmpdir(), "pcms-r18-dimensions-"));
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
  void site;

  // The exact reproduction from the report: a 192×185 identity logo, and an
  // undersized OG source.
  const faviconAssetId = "0198c0de-0000-7000-8000-0000000c0001";
  const ogAssetId = "0198c0de-0000-7000-8000-0000000c0002";
  await seedImageAsset(
    app,
    storage,
    faviconAssetId,
    await pngBytes(192, 185, { r: 40, g: 90, b: 40 }),
    192,
    185,
    "Brand icon",
  );
  await seedImageAsset(
    app,
    storage,
    ogAssetId,
    await pngBytes(800, 360, { r: 10, g: 60, b: 120 }),
    800,
    360,
    "Brand OG",
  );

  // --- Favicon: identity assignment materializes 512×512 png from the
  // undersized source — both recorded row and actual bytes. ---
  await updateSiteIdentityOp(app, OWNER_CTX(), {
    identity: { site_name: "R18 Site", favicon: { asset_id: faviconAssetId } },
  });
  const faviconVariants = await fetchVariants(app, faviconAssetId, "favicon-v1");
  const faviconRow = faviconVariants[0];
  assert.equal(faviconVariants.length, 1);
  assert.equal(faviconRow?.format, "png");
  assert.equal(faviconRow?.width, 512);
  assert.equal(faviconRow?.height, 512);
  assert.ok(faviconRow !== undefined);
  assert.deepEqual(await decodeVariant(app, storage, faviconRow), {
    format: "png",
    width: 512,
    height: 512,
  });

  // --- OG: undersized source → exactly 1200×630 jpeg. ---
  const draft = await (async () => {
    const { createDraft } = await import("@pcms/api");
    return createDraft(app, OWNER_CTX(), {
      content_type: "page",
      payload: { fields: { title: "R18 page" }, blocks: { schema_version: 1, blocks: [] } },
    });
  })();
  await updateEntrySeo(app, OWNER_CTX(), {
    entry_id: draft.entry_id,
    document: { social_image: { asset_id: ogAssetId } },
  });
  const ogVariants = await fetchVariants(app, ogAssetId, "og-v1");
  const ogRow = ogVariants[0];
  assert.equal(ogVariants.length, 1);
  assert.equal(ogRow?.format, "jpeg");
  assert.equal(ogRow?.width, 1200);
  assert.equal(ogRow?.height, 630);
  assert.ok(ogRow !== undefined);
  assert.deepEqual(await decodeVariant(app, storage, ogRow), {
    format: "jpeg",
    width: 1200,
    height: 630,
  });

  // --- Focal transform on an undersized source: the extract+fill path
  // must also reach the declared dimensions. ---
  await app.pool.query(`UPDATE media_assets SET focal_x = 0.15, focal_y = 0.85 WHERE id = $1`, [
    ogAssetId,
  ]);
  await materializeOgDerivative(app, ogAssetId);
  const afterFocal = await fetchVariants(app, ogAssetId, "og-v1");
  const focalRow = afterFocal[0];
  assert.equal(afterFocal.length, 1, "superseded focal row retired");
  assert.notEqual(focalRow?.variant_key, ogRow?.variant_key, "focal change → new crop");
  assert.ok(focalRow !== undefined);
  assert.deepEqual(await decodeVariant(app, storage, focalRow), {
    format: "jpeg",
    width: 1200,
    height: 630,
  });

  // --- Correct derivatives stay reused: a re-run keeps the same row. ---
  const reusedBefore = await fetchVariants(app, faviconAssetId, "favicon-v1");
  await updateSiteIdentityOp(app, OWNER_CTX(), {
    identity: { site_name: "R18 Site", favicon: { asset_id: faviconAssetId } },
  });
  const reusedAfter = await fetchVariants(app, faviconAssetId, "favicon-v1");
  assert.equal(reusedAfter.length, 1);
  assert.equal(reusedAfter[0]?.id, reusedBefore[0]?.id, "correct row reused, not rebuilt");

  // --- Stale cache self-heals: a row written under the old size policy
  // (same key, wrong recorded dimensions) is rebuilt IN PLACE — the key,
  // and therefore the public URL, stays stable. ---
  const staleKey = reusedAfter[0]?.variant_key;
  await app.pool.query(
    `UPDATE media_variants SET width = 192, height = 185 WHERE asset_id = $1 AND preset_id = 'favicon-v1'`,
    [faviconAssetId],
  );
  await updateSiteIdentityOp(app, OWNER_CTX(), {
    identity: { site_name: "R18 Site", favicon: { asset_id: faviconAssetId } },
  });
  const healed = await fetchVariants(app, faviconAssetId, "favicon-v1");
  const healedRow = healed[0];
  assert.equal(healed.length, 1);
  assert.equal(healedRow?.variant_key, staleKey, "public URL stays stable across the rebuild");
  assert.equal(healedRow?.width, 512);
  assert.equal(healedRow?.height, 512);
  assert.ok(healedRow !== undefined);
  assert.deepEqual(await decodeVariant(app, storage, healedRow), {
    format: "png",
    width: 512,
    height: 512,
  });

  // --- Ordinary theme-preset policy unchanged: without the exact-dimension
  // flag an undersized source still yields a smaller image; only core
  // presets enlarge. ---
  const small = await pngBytes(192, 185, { r: 1, g: 2, b: 3 });
  const ordinary = await transformImage(small, {
    width: 512,
    height: 512,
    fit: "cover",
    format: "png",
    quality: 80,
  });
  assert.deepEqual(
    { width: ordinary.width, height: ordinary.height },
    { width: 192, height: 185 },
    "ordinary presets never enlarge",
  );
  const exact = await transformImage(small, {
    width: 512,
    height: 512,
    fit: "cover",
    format: "png",
    quality: 80,
    allowEnlargement: true,
  });
  assert.deepEqual(
    { width: exact.width, height: exact.height },
    { width: 512, height: 512 },
    "exact-dimension presets enlarge to the declaration",
  );
});

test("R18: media pagination reports has_more at the documented limit maximum", async (t) => {
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
  const fastify = createApiFastify(() => "req_r18_page");
  await fastify.register(createApiV1([...makeDiscoveryRoutes()]), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    cookieSecure: false,
  });
  const token = await bearerToken(app, "r18-pager", ["media.read"]);

  // 105 assets: one row past the documented limit maximum of 100.
  const storage = new InMemoryStorageForR18();
  for (let i = 0; i < 105; i += 1) {
    const id = `0198c0de-0000-7000-8000-${String(i).padStart(12, "0")}`;
    await seedImageAsset(
      app,
      storage,
      id,
      await pngBytes(8, 8, { r: i % 255, g: 3, b: 7 }),
      8,
      8,
      `r18 bulk ${i}`,
    );
  }

  const first = await fastify.inject({
    method: "GET",
    url: "/api/v1/media?limit=100",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(first.statusCode, 200, first.body.slice(0, 300));
  const firstBody = first.json() as {
    items: { id: string }[];
    has_more: boolean;
    next_cursor: string | null;
  };
  assert.equal(firstBody.items.length, 100);
  assert.equal(firstBody.has_more, true, "5 more assets exist behind limit=100");
  assert.ok(firstBody.next_cursor !== null);

  const second = await fastify.inject({
    method: "GET",
    url: `/api/v1/media?limit=100&cursor=${encodeURIComponent(firstBody.next_cursor ?? "")}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(second.statusCode, 200, second.body.slice(0, 300));
  const secondBody = second.json() as {
    items: { id: string }[];
    has_more: boolean;
    next_cursor: string | null;
  };
  assert.equal(secondBody.items.length, 5);
  assert.equal(secondBody.has_more, false);
  assert.equal(secondBody.next_cursor, null);

  const seen = new Set([...firstBody.items, ...secondBody.items].map((item) => item.id));
  assert.equal(seen.size, 105, "pagination enumerates every asset exactly once");
});

test("R18: GET /discovery/seo/preview materializes og-v1 (OG contract §3)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const root = mkdtempSync(join(tmpdir(), "pcms-r18-preview-"));
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
  void site;
  const ogAssetId = "0198c0de-0000-7000-8000-0000000c0003";
  await seedImageAsset(
    app,
    storage,
    ogAssetId,
    await pngBytes(1600, 900, { r: 10, g: 60, b: 120 }),
    1600,
    900,
    "Brand OG",
  );

  const { createDraft } = await import("@pcms/api");
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "R18 preview" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await updateEntrySeo(app, OWNER_CTX(), {
    entry_id: draft.entry_id,
    document: { social_image: { asset_id: ogAssetId } },
  });
  assert.equal((await fetchVariants(app, ogAssetId, "og-v1")).length, 1);

  // The site's reported state: an explicit reference that predates the
  // og-v1 presets — no derivative exists yet.
  await app.pool.query(`DELETE FROM media_variants WHERE asset_id = $1`, [ogAssetId]);

  const fastify = createApiFastify(() => "req_r18_preview");
  await fastify.register(createApiV1([...makeDiscoveryRoutes()]), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    cookieSecure: false,
  });
  const token = await bearerToken(app, "r18-seo", ["seo.read"]);
  const preview = await fastify.inject({
    method: "GET",
    url: `/api/v1/discovery/seo/preview?entry_id=${draft.entry_id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(preview.statusCode, 200, preview.body.slice(0, 300));
  const body = preview.json() as { head: { core_meta: { property: string; content: string }[] } };
  const ogMeta = body.head.core_meta.find((meta) => meta.property === "og:image");
  assert.ok(ogMeta !== undefined, "preview shows the real og:image");
  assert.match(ogMeta.content, /\/v1\/og-v1-[0-9a-z]+\.jpg$/);
  assert.equal(
    (await fetchVariants(app, ogAssetId, "og-v1")).length,
    1,
    "preview materialized og-v1",
  );
});

/** Minimal storage adapter for bulk seeding — rows only need content-keyed
 * blob records; the pagination test never reads bytes back. */
class InMemoryStorageForR18 {
  async put(bytes: Buffer): Promise<{ key: string; sha256: string; sizeBytes: number }> {
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { key: `mem/${sha256}`, sha256, sizeBytes: bytes.length };
  }

  async getBuffer(): Promise<Buffer> {
    throw new Error("not needed for the pagination regression");
  }
}

test("R18 observation 3: focal point write surface (PATCH media) re-crops core derivatives", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const root = mkdtempSync(join(tmpdir(), "pcms-r18-focal-write-"));
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
  await app.routes.ensureSite("default");

  const ogAssetId = "0198c0de-0000-7000-8000-0000000c0004";
  await seedImageAsset(
    app,
    storage,
    ogAssetId,
    await pngBytes(1600, 900, { r: 10, g: 60, b: 120 }),
    1600,
    900,
    "Wide brand",
  );

  const { createDraft } = await import("@pcms/api");
  const draft = await createDraft(app, OWNER_CTX(), {
    content_type: "page",
    payload: { fields: { title: "Focal write" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await updateEntrySeo(app, OWNER_CTX(), {
    entry_id: draft.entry_id,
    document: { social_image: { asset_id: ogAssetId } },
  });
  const keyBefore = (await fetchVariants(app, ogAssetId, "og-v1"))[0]?.variant_key;
  assert.ok(keyBefore !== undefined);

  const fastify = createApiFastify(() => "req_r18_focal");
  await fastify.register(createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes()]), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    cookieSecure: false,
  });
  const token = await bearerToken(app, "r18-focal", ["media.write", "media.read"]);

  // Out of range → typed client error, asset untouched.
  const rejected = await fastify.inject({
    method: "PATCH",
    url: `/api/v1/media/${ogAssetId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { focal_x: 1.5 },
  });
  assert.equal(rejected.statusCode, 400, rejected.body);

  // In range → asset updated AND og-v1 re-cropped immediately (the stale
  // focal-key row is retired; the renderer never serves the old crop).
  const patched = await fastify.inject({
    method: "PATCH",
    url: `/api/v1/media/${ogAssetId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { focal_x: 0.2, focal_y: 0.8 },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const assetRow = await app.pool.query<{ focal_x: string | null; focal_y: string | null }>(
    `SELECT focal_x, focal_y FROM media_assets WHERE id = $1`,
    [ogAssetId],
  );
  assert.equal(Number(assetRow.rows[0]?.focal_x), 0.2);
  assert.equal(Number(assetRow.rows[0]?.focal_y), 0.8);

  const afterFocal = await fetchVariants(app, ogAssetId, "og-v1");
  const focalRow = afterFocal[0];
  assert.equal(afterFocal.length, 1, "stale focal-key row retired");
  assert.notEqual(focalRow?.variant_key, keyBefore, "new crop → new variant key");
  assert.equal(focalRow?.width, 1200);
  assert.equal(focalRow?.height, 630);
  assert.ok(focalRow !== undefined);
  assert.deepEqual(await decodeVariant(app, storage, focalRow), {
    format: "jpeg",
    width: 1200,
    height: 630,
  });

  // Setting the same focal point again reuses the row (no rebuild churn).
  const idBefore = afterFocal[0]?.id;
  await fastify.inject({
    method: "PATCH",
    url: `/api/v1/media/${ogAssetId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { focal_x: 0.2, focal_y: 0.8 },
  });
  const unchanged = await fetchVariants(app, ogAssetId, "og-v1");
  assert.equal(unchanged.length, 1);
  assert.equal(unchanged[0]?.id, idBefore, "same focal → derivative reused");

  // null clears the focal point and re-crops back to center.
  const cleared = await fastify.inject({
    method: "PATCH",
    url: `/api/v1/media/${ogAssetId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { focal_x: null, focal_y: null },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  const clearedRow = await app.pool.query<{ focal_x: string | null }>(
    `SELECT focal_x FROM media_assets WHERE id = $1`,
    [ogAssetId],
  );
  assert.equal(clearedRow.rows[0]?.focal_x, null);
  const afterClear = await fetchVariants(app, ogAssetId, "og-v1");
  assert.equal(afterClear.length, 1);
  assert.notEqual(
    afterClear[0]?.variant_key,
    unchanged[0]?.variant_key,
    "cleared focal → center crop key",
  );
});
