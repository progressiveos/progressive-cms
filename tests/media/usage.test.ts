// PCMS-MEDIA-T017/T018 — usage graph integration through the composition
// layer: entry-field references come from the Content reference graph
// (content_references projection, incl. body-block media refs merged via
// the M05 `extraReferences` extension) and block references are extracted
// from declared Block Registry reference specs. Hard delete respects usage.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type BlockDocument,
  type BlockNode,
  type BlockRegistry,
  createBlockRegistry,
  registerFirstPartyBlocksV1,
} from "@pcms/blocks";
import {
  createReferenceGraphService,
  type EntryId,
  type ExtractedReference,
  type LoadedContentType,
  type ReferenceTargetKind,
} from "@pcms/content";
import {
  createDbPool,
  type DbPool,
  isStableId as isCoreStableId,
  isStableId,
  loadMigrations,
  migrateDatabase,
  type StableId,
} from "@pcms/core";
import {
  createMediaUsageService,
  hardDeleteAsset,
  InMemoryMediaStorage,
  LocalMediaStorage,
  MediaError,
  uploadMedia,
} from "@pcms/media";
import sharp from "sharp";
import {
  assertBaseReachable,
  connectionInfo,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

/**
 * Composition-layer adapter (this is exactly the wiring apps/ and the CLI
 * will own in M09/M10): walks a BlockDocument and collects every declared
 * media/relation reference via the Block Registry's public `references`
 * declarations — no package internals touched.
 */
function extractBlockReferencesFromDocument(
  registry: BlockRegistry,
  doc: BlockDocument,
): ExtractedReference[] {
  const out: ExtractedReference[] = [];
  const leafId = (holder: unknown, leaf: string): string | null => {
    if (typeof holder === "object" && holder !== null) {
      const value = (holder as Record<string, unknown>)[leaf];
      return typeof value === "string" && isStableId(value) ? value : null;
    }
    return null;
  };
  const walk = (nodes: readonly BlockNode[], prefix: string): void => {
    for (const node of nodes) {
      const registered = registry.getLatestBlockType(node.type);
      if (registered !== null) {
        for (const spec of registered.references) {
          const base = `${prefix}/blocks/${node.id}`;
          const kind = (spec.kind === "relation" ? "entry" : "media") as ReferenceTargetKind;
          const push = (path: string, id: unknown): void => {
            if (typeof id === "string" && isStableId(id)) {
              out.push({ path, kind, targetId: id });
            }
          };
          if (spec.prop.includes("[]")) {
            // array prop: "<items>[].<leaf>" (object list) or "<items>[]" (scalar IDs)
            const [arrayPart, ...rest] = spec.prop.split(".");
            const arrayProp = arrayPart!.replace("[]", "");
            const leaf = rest[rest.length - 1] ?? "";
            const list = node.props[arrayProp!];
            if (Array.isArray(list)) {
              list.forEach((item, index) => {
                push(`${base}/${index}/${leaf}`, rest.length > 0 ? leafId(item, leaf) : item);
              });
            }
          } else if (spec.prop.includes(".")) {
            const segments = spec.prop.split(".");
            const parent = segments[0]!;
            const leaf = segments[segments.length - 1]!;
            push(`${base}/${spec.prop}`, leafId(node.props[parent], leaf));
          } else {
            push(`${base}/${spec.prop}`, node.props[spec.prop]);
          }
        }
      }
      walk(node.children, `${prefix}/blocks/${node.id}`);
    }
  };
  walk(doc.blocks, "");
  return out;
}

test("usage query lists field and block usages; hard delete respects them", {
  skip: DB_SKIP,
}, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const root = mkdtempSync(join(tmpdir(), "pcms-usage-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const storage = new LocalMediaStorage({ root: join(root, "media") });
  const quarantine = new InMemoryMediaStorage();
  const ingestDeps = {
    pool,
    storage,
    quarantine,
    limits: { maxUploadBytes: 1_000_000, maxImagePixels: 64_000_000, maxImageDimension: 16_384 },
  };

  // Media: hero image (used by a field AND a block) and a block-only asset.
  const heroJpeg = await sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 10, g: 90, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  const acceptedHero = await uploadMedia(ingestDeps, {
    bytes: heroJpeg,
    filename: "hero.jpg",
    createdBy: "editor",
  });
  const orphanJpeg = await sharp({
    create: { width: 60, height: 80, channels: 3, background: { r: 200, g: 90, b: 10 } },
  })
    .jpeg()
    .toBuffer();
  const acceptedOrphan = await uploadMedia(ingestDeps, {
    bytes: orphanJpeg,
    filename: "orphan.jpg",
    createdBy: "editor",
  });
  const heroId = acceptedHero.asset.id;
  const orphanId = acceptedOrphan.asset.id;

  // Content: an entry whose fields reference hero (field usage).
  const graph = createReferenceGraphService(pool);
  const contentType = {
    key: "page",
    version: 1,
    fieldSchema: {
      type: "object",
      fields: {
        title: { type: "string", maxLength: 100 },
        hero_image: { type: "media" },
        gallery: { type: "media_list" },
      },
    },
  } as unknown as LoadedContentType;
  const testId = (value: string): EntryId => {
    assert.ok(isCoreStableId(value));
    return value as unknown as EntryId;
  };
  const entryId = testId("01900000-0000-7000-8000-00000000aaa1");
  const fields = {
    title: "Home",
    hero_image: heroId,
    gallery: [orphanId],
  };

  // Blocks: an image block also uses hero (block usage).
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);
  const body: BlockDocument = {
    schemaVersion: 1,
    blocks: [
      {
        id: "01900000-0000-7000-8000-00000000bbb1" as never,
        type: "image",
        schemaVersion: 1,
        variant: null,
        props: { media_id: heroId, alt_override: "stage" },
        children: [],
      },
      {
        id: "01900000-0000-7000-8000-00000000bbb2" as never,
        type: "gallery",
        schemaVersion: 1,
        variant: null,
        props: {
          items: [{ id: "01900000-0000-7000-8000-00000000ccc1", media_id: orphanId }],
        },
        children: [],
      },
    ],
  };
  const blockRefs = extractBlockReferencesFromDocument(registry, body);
  assert.equal(blockRefs.length, 2, "image block + gallery item extracted");

  // The entry row itself (FK target for the reference projection).
  await pool.query(
    `INSERT INTO entries (id, content_type_id, created_by) VALUES ($1, 'page', 'editor')`,
    [entryId],
  );

  // The single sync the composition performs on entry save:
  await graph.syncReferences(entryId, contentType, fields, blockRefs);

  // Media usage service answers "where is this used?" via the port.
  const usageService = createMediaUsageService({
    listInboundReferences: async (mediaId) => {
      const inbound = await graph.listInboundReferences("media", mediaId as never);
      return inbound.map((r) => ({
        sourceEntryId: r.sourceEntryId,
        sourcePath: r.sourcePath,
        origin: r.sourcePath.includes("/blocks/") ? ("block" as const) : ("field" as const),
      }));
    },
  });
  const heroUsage = await usageService.getUsage(heroId);
  assert.equal(heroUsage.inboundCount, 2);
  assert.equal(heroUsage.distinctSources, 1);
  const heroOrigins = heroUsage.references.map((r) => r.origin).sort();
  assert.deepEqual(heroOrigins, ["block", "field"], "field AND block usages both listed");

  const orphanUsage = await usageService.getUsage(orphanId);
  assert.ok(orphanUsage.inboundCount >= 2, "field list + gallery block item");
  assert.ok(orphanUsage.references.some((r) => r.origin === "block"));

  // Hard delete is privileged and usage-aware.
  const hardDeletePortEarly = {
    listInboundReferences: (mediaId: string) =>
      usageService.getUsage(mediaId).then((r) => r.references),
  };
  await assert.rejects(
    hardDeleteAsset({ pool, port: hardDeletePortEarly }, { assetId: heroId, actor: "admin" }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_DELETE_FORBIDDEN",
  );
  const hardDeletePort = {
    listInboundReferences: (mediaId: string) =>
      usageService.getUsage(mediaId).then((r) => r.references),
  };
  await assert.rejects(
    hardDeleteAsset(
      { pool, port: hardDeletePort },
      { assetId: heroId, actor: "admin", deleteCapability: "cap:media.delete" },
    ),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_IN_USE",
  );
  // The orphan asset: references removed first, then hard delete succeeds.
  await graph.clearReferences(entryId);
  const result = await hardDeleteAsset(
    { pool, port: hardDeletePort },
    { assetId: orphanId, actor: "admin", deleteCapability: "cap:media.delete" },
  );
  assert.equal(result.deleted, true);
  assert.equal(result.removedVersions, 1);
  assert.equal(result.blobsDeferredToGc, true);
  // the physical blobs survive until GC proves unreachability
  const blobCount = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM media_blobs");
  assert.equal(blobCount.rows[0]?.n, 2, "no physical deletion in hard delete");
});
