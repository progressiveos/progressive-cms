import assert from "node:assert/strict";
import { test } from "node:test";
import { createMediaPresetRegistry, createMediaViewModelProvider } from "@pcms/media";

test("bulk media resolves in bounded chunks, preserves archived and live semantics", async () => {
  const ids = Array.from(
    { length: 501 },
    (_, i) => `01900000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`,
  );
  const statements: string[] = [];
  const pool = {
    query: async (sql: string, params: readonly unknown[]) => {
      statements.push(sql);
      if (sql.includes("media_assets")) {
        return {
          rows: (params[0] as string[]).map((id, index) => ({
            id,
            kind: "image",
            current_version_no: 1,
            filename_original: "a.jpg",
            width: 40,
            height: 20,
            alt_default: `alt-${id}`,
            caption_default: "caption",
            focal_x: null,
            focal_y: null,
            archived_at: id === ids[0] ? new Date() : null,
            size_bytes: "1",
            created_at: new Date(),
            index,
          })),
        };
      }
      return { rows: [] };
    },
  };
  const provider = createMediaViewModelProvider({
    pool: pool as never,
    registry: createMediaPresetRegistry([]),
  });
  const models = await provider.getAssetViewModels([...ids, ids[1]!], { includeArchived: true });
  assert.equal(Object.keys(models).length, 501);
  assert.equal(models[ids[0]!]!.alt, `alt-${ids[0]}`);
  assert.deepEqual(models[ids[1]!]!.derivatives, []);
  assert.equal(statements.filter((sql) => sql.includes("media_assets")).length, 2);
  assert.equal(statements.filter((sql) => sql.includes("media_variants")).length, 2);
  const cards = await provider.getAssetViewModels([ids[0]!, ids[1]!]);
  assert.equal(cards[ids[0]!], null);
  assert.ok(cards[ids[1]!]);
});

test("PostgreSQL batch returns the same models and observes updates on the next read", {
  skip: !process.env.PCMS_TEST_DATABASE_URL,
}, async (t) => {
  const { rollbackApiFixture } = await import("../helpers/rollback-api-fixture.js");
  const calls: string[] = [];
  const { pool } = await rollbackApiFixture(t, {}, { onQuery: (sql) => calls.push(sql) });
  const blob = "01900000-0000-7000-8000-000000000abc";
  await pool.query(
    "INSERT INTO media_blobs(id, sha256, size_bytes, storage_key) VALUES ($1, $2, 1, 'fixture')",
    [blob, "a".repeat(64)],
  );
  const ids = Array.from(
    { length: 201 },
    (_, i) => `01910000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`,
  );
  await pool.query(
    `INSERT INTO media_assets(id,kind,current_version_no,original_blob_id,filename_original,mime_type,size_bytes,sha256,width,height,alt_default,created_by)
    SELECT id,'image',1,$2,'a.jpg','image/jpeg',1,$3,40,20,'first','test' FROM unnest($1::uuid[]) AS id`,
    [ids, blob, "a".repeat(64)],
  );
  await pool.query(
    `INSERT INTO media_variants(id,asset_id,version_no,preset_id,format,width,height,size_bytes,blob_id,variant_key)
     VALUES ('01920000-0000-7000-8000-000000000001',$1,1,'card','webp',40,20,1,$2,'a'),
            ('01920000-0000-7000-8000-000000000002',$1,1,'card','avif',40,20,1,$2,'b'),
            ('01920000-0000-7000-8000-000000000003',$1,2,'card','webp',80,40,1,$2,'c')`,
    [ids[0], blob],
  );
  const provider = createMediaViewModelProvider({ pool, registry: createMediaPresetRegistry([]) });
  const single = await provider.getAssetViewModel(ids[0]!);
  calls.length = 0;
  const batch = await provider.getAssetViewModels([...ids, ids[0]!], { includeArchived: true });
  assert.deepEqual(batch[ids[0]!], single);
  assert.equal(batch[ids[0]!]!.derivatives.length, 2);
  assert.ok(batch[ids[0]!]!.derivatives.every((item) => item.url.includes("/v1/")));
  assert.equal(Object.keys(batch).length, 201);
  assert.equal(calls.filter((sql) => sql.includes("FROM media_assets")).length, 1);
  assert.equal(calls.filter((sql) => sql.includes("FROM media_variants")).length, 1);
  const { listVariants, listVariantsForAssets } = await import("@pcms/media");
  assert.deepEqual(
    await listVariantsForAssets(pool, [{ assetId: ids[0]!, versionNo: 2 }]),
    await listVariants(pool, ids[0]!, 2),
  );
  await pool.query("UPDATE media_assets SET alt_default = 'second' WHERE id = $1", [ids[0]]);
  assert.equal((await provider.getAssetViewModels([ids[0]!]))[ids[0]!]!.alt, "second");
});

test("independent site installations never share media cache or metadata", {
  skip: !process.env.PCMS_TEST_DATABASE_URL,
}, async (t) => {
  const { rollbackApiFixture } = await import("../helpers/rollback-api-fixture.js");
  const first = await rollbackApiFixture(t, {});
  const second = await rollbackApiFixture(t, {});
  const blob = "01900000-0000-7000-8000-000000000aaa";
  const asset = "01900000-0000-7000-8000-000000000bbb";
  for (const [fixture, alt] of [
    [first, "first installation"],
    [second, "second installation"],
  ] as const) {
    await fixture.pool.query(
      "INSERT INTO media_blobs(id, sha256, size_bytes, storage_key) VALUES ($1, $2, 1, 'fixture')",
      [blob, "a".repeat(64)],
    );
    await fixture.pool.query(
      "INSERT INTO media_assets(id,kind,current_version_no,original_blob_id,filename_original,mime_type,size_bytes,sha256,alt_default,created_by) VALUES ($1,'image',1,$2,'a.jpg','image/jpeg',1,$3,$4,'test')",
      [asset, blob, "a".repeat(64), alt],
    );
  }
  const registry = createMediaPresetRegistry([]);
  const a = createMediaViewModelProvider({ pool: first.pool, registry });
  const b = createMediaViewModelProvider({ pool: second.pool, registry });
  const [one, two] = await Promise.all([
    a.getAssetViewModels([asset]),
    b.getAssetViewModels([asset]),
  ]);
  assert.equal(one[asset]?.alt, "first installation");
  assert.equal(two[asset]?.alt, "second installation");
});
