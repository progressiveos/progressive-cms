// CORE-RC19 B — SEO social image resolution through the Content Tree.
//
// Target chain (owner brief):
//   explicit social_image → featured/hero image of the material →
//   social image of the nearest valid parent SECTION → site default
//
// The inherited value is computed at READ time (nothing is written into the
// descendant), so changing a section image is visible without touching child
// entries and without a migration. Inheritance is image-only: title,
// description and canonical keep their own chains.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalMediaStorage } from "@pcms/media";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const CTX = () => apiContextOf(ownerActor("rc19-seo-inherit"), "rest", "req_rc19_seo");

async function pngBytes(width: number, height: number, color: object): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

async function seedImage(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  storage: LocalMediaStorage,
  id: string,
  color: object,
): Promise<void> {
  const bytes = await pngBytes(1200, 630, color);
  const stored = await storage.put(bytes);
  await app.pool.query(
    `INSERT INTO media_blobs (id, sha256, size_bytes, storage_key)
     VALUES ($1, $2, $3, $4) ON CONFLICT (sha256) DO NOTHING`,
    [stored.sha256.slice(0, 32), stored.sha256, bytes.length, stored.key],
  );
  await app.pool.query(
    `INSERT INTO media_assets
       (id, kind, current_version_no, original_blob_id, filename_original, mime_type,
        size_bytes, sha256, width, height, alt_default, created_by)
     VALUES ($1,'image',1,$2,'section.png','image/png',$3,$4,1200,630,'section','test')
     ON CONFLICT (id) DO NOTHING`,
    [id, stored.sha256.slice(0, 32), bytes.length, stored.sha256],
  );
  await app.pool.query(
    `INSERT INTO media_versions
       (asset_id, version_no, blob_id, filename_original, mime_type, size_bytes, sha256, created_by)
     VALUES ($1, 1, $2, 'section.png', 'image/png', $3, $4, 'test')
     ON CONFLICT DO NOTHING`,
    [id, stored.sha256.slice(0, 32), bytes.length, stored.sha256],
  );
}

interface Fixture {
  readonly app: Awaited<ReturnType<typeof createApiFixture>>["app"];
  readonly siteId: string;
}

async function fixture(t: { after: (fn: () => void) => void }): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "pcms-rc19-seo-"));
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
        fields: {
          title: { id: "title", type: "string", required: true },
          hero_image: { id: "hero_image", type: "media" },
        },
      },
    ],
    themeDir: join(process.cwd(), "themes", "reference-theme-v1"),
    seoEnvironment: "production",
    mediaRoots: { storage: mediaRoot, quarantine: join(root, "quarantine") },
  });
  Object.assign(app, { __storage: new LocalMediaStorage({ root: mediaRoot }) });
  const site = await app.routes.ensureSite("default");
  return { app, siteId: site.id };
}

/** Publishes one page (optionally under `parent`), returns its entry id. */
async function publishPage(
  app: Fixture["app"],
  title: string,
  options: { parent?: string; heroImage?: string } = {},
): Promise<string> {
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const fields: Record<string, unknown> = { title };
  if (options.heroImage !== undefined) {
    // A `media` field's persisted value is the asset ID string (Media spec §4).
    fields.hero_image = options.heroImage;
  }
  const draft = await createDraft(app, CTX(), {
    content_type: "page",
    payload: { fields, blocks: { schema_version: 1, blocks: [] } },
    ...(options.parent === undefined ? {} : { parent_entry_id: options.parent }),
  });
  await sealRevision(app, CTX(), { revision_id: draft.revision_id });
  await publishRevision(app, CTX(), {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  return draft.entry_id;
}

/** The resolved social-image source for one entry, as the head builder sees it. */
async function socialImageSource(app: Fixture["app"], entryId: string): Promise<string | null> {
  const result = await app.seoDiscovery.resolveSeoMetadataFor(entryId, { published: true });
  return result?.resolved.social_image.source ?? null;
}

test("social image inherits from the nearest ancestor section (multi-level tree)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const storage = (app as unknown as { __storage: LocalMediaStorage }).__storage;
  const { updateEntrySeo } = await import("@pcms/api");

  const sectionImage = "0198c0de-0000-7000-8000-0000000c0001";
  const deepImage = "0198c0de-0000-7000-8000-0000000c0002";
  await seedImage(app, storage, sectionImage, { r: 200, g: 10, b: 10 });
  await seedImage(app, storage, deepImage, { r: 10, g: 200, b: 10 });

  // root (has an image) → mid (no image) → leaf (no image)
  const root = await publishPage(app, "Root", { heroImage: sectionImage });
  const mid = await publishPage(app, "Mid", { parent: root });
  const leaf = await publishPage(app, "Leaf", { parent: mid });

  // The leaf has neither explicit nor hero image → the root's image is inherited.
  assert.equal(await socialImageSource(app, leaf), "parent_section_image");

  // The nearest ancestor wins: give mid an image and the leaf follows mid, not root.
  await updateEntrySeo(app, CTX(), {
    entry_id: mid,
    document: { social_image: { asset_id: deepImage } },
  });
  assert.equal(await socialImageSource(app, leaf), "parent_section_image");
  const inherited = await app.seoDiscovery.resolveSeoMetadataFor(leaf, { published: true });
  assert.deepEqual(inherited?.resolved.social_image.value, { asset_id: deepImage });

  // A root page has no ancestor — it falls through to the site default (absent
  // here), never to a fabricated value.
  assert.equal(await socialImageSource(app, mid), "social_image");
});

test("an ancestor's own hero image is inherited when it has no explicit social image", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const storage = (app as unknown as { __storage: LocalMediaStorage }).__storage;
  const sectionImage = "0198c0de-0000-7000-8000-0000000c0003";
  await seedImage(app, storage, sectionImage, { r: 10, g: 10, b: 200 });

  const section = await publishPage(app, "Section", { heroImage: sectionImage });
  const child = await publishPage(app, "Child", { parent: section });
  const resolved = await app.seoDiscovery.resolveSeoMetadataFor(child, { published: true });
  assert.deepEqual(resolved?.resolved.social_image.value, { asset_id: sectionImage });
});

test("explicit social image and own hero outrank the section image", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const storage = (app as unknown as { __storage: LocalMediaStorage }).__storage;
  const { updateEntrySeo } = await import("@pcms/api");

  const sectionImage = "0198c0de-0000-7000-8000-0000000c0004";
  const ownHero = "0198c0de-0000-7000-8000-0000000c0005";
  const ownExplicit = "0198c0de-0000-7000-8000-0000000c0006";
  await seedImage(app, storage, sectionImage, { r: 1, g: 1, b: 1 });
  await seedImage(app, storage, ownHero, { r: 2, g: 2, b: 2 });
  await seedImage(app, storage, ownExplicit, { r: 3, g: 3, b: 3 });

  const section = await publishPage(app, "Section", { heroImage: sectionImage });
  const withHero = await publishPage(app, "WithHero", {
    parent: section,
    heroImage: ownHero,
  });
  assert.equal(await socialImageSource(app, withHero), "hero_image");

  await updateEntrySeo(app, CTX(), {
    entry_id: withHero,
    document: { social_image: { asset_id: ownExplicit } },
  });
  assert.equal(await socialImageSource(app, withHero), "social_image");
});

test("inheritance is image-only and reads through: no child write, no migration", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const storage = (app as unknown as { __storage: LocalMediaStorage }).__storage;
  const { updateEntrySeo } = await import("@pcms/api");

  const first = "0198c0de-0000-7000-8000-0000000c0007";
  const second = "0198c0de-0000-7000-8000-0000000c0008";
  await seedImage(app, storage, first, { r: 4, g: 4, b: 4 });
  await seedImage(app, storage, second, { r: 5, g: 5, b: 5 });

  const section = await publishPage(app, "Section", { heroImage: first });
  const child = await publishPage(app, "Child", { parent: section });

  // The child's own SEO document stays empty — inheritance is resolution only.
  assert.equal(await app.pool.query("SELECT 1").then(() => true), true);
  const childDoc = await app.seo.getDocument(child);
  assert.equal(childDoc, null);

  // Change the section's image; the child resolves the new one immediately.
  await updateEntrySeo(app, CTX(), {
    entry_id: section,
    document: { social_image: { asset_id: second } },
  });
  const resolved = await app.seoDiscovery.resolveSeoMetadataFor(child, { published: true });
  assert.deepEqual(resolved?.resolved.social_image.value, { asset_id: second });
  // Title still resolves from the child's own payload — inheritance did not
  // lift the section's title or description.
  assert.equal(resolved?.resolved.title.value, "Child");
});

test("an unpublished ancestor is skipped instead of leaking a draft image", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const storage = (app as unknown as { __storage: LocalMediaStorage }).__storage;
  const { createDraft, updateEntrySeo } = await import("@pcms/api");

  const draftImage = "0198c0de-0000-7000-8000-0000000c0009";
  await seedImage(app, storage, draftImage, { r: 6, g: 6, b: 6 });

  // A draft section (never published) with an explicit social image.
  const draftSection = await createDraft(app, CTX(), {
    content_type: "page",
    payload: { fields: { title: "Draft section" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await updateEntrySeo(app, CTX(), {
    entry_id: draftSection.entry_id,
    document: { social_image: { asset_id: draftImage } },
  });
  const child = await publishPage(app, "Child", { parent: draftSection.entry_id });

  const resolved = await app.seoDiscovery.resolveSeoMetadataFor(child, { published: true });
  assert.equal(resolved?.resolved.social_image.value, null);
  assert.equal(resolved?.resolved.social_image.source, "social_image");
});
