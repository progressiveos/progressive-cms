import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeDiscoveryRoutes, uploadMediaOp } from "@pcms/api";
import { listVariants } from "@pcms/media";
import sharp from "sharp";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

test("Admin thumbnail is bounded, cached, private and permission protected", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const root = mkdtempSync(join(tmpdir(), "pcms-thumbnail-"));
  const { app } = await createApiFixture(t, {
    mediaRoots: { storage: join(root, "media"), quarantine: join(root, "quarantine") },
  });
  const ctx = apiContextOf(ownerActor());
  const original = await sharp({
    create: {
      width: 2400,
      height: 1600,
      channels: 3,
      background: "#426080",
    },
  })
    .png()
    .toBuffer();
  const accepted = await uploadMediaOp(app, ctx, { bytes: original, filename: "large.png" });
  const route = makeDiscoveryRoutes().find((r) => r.spec.operationId === "get_media_file");
  assert.ok(route);
  assert.ok(app.mediaStorage);
  const request = { params: { mediaId: accepted.asset.id }, query: { preview: "thumbnail" } };
  const response = await route.handle(app, ctx, request as never);
  assert.equal(response.status, 200);
  assert.equal(response.headers?.["content-type"], "image/webp");
  assert.match(String(response.headers?.["cache-control"]), /private/);
  const bytes = response.body as Buffer;
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 384);
  assert.equal(metadata.height, 256);
  assert.ok(bytes.length < original.length);
  const variants = await listVariants(app.pool, accepted.asset.id);
  assert.equal(variants.length, 1);
  const sourceRead = app.mediaStorage.getBuffer.bind(app.mediaStorage);
  app.mediaStorage.getBuffer = async (key, limit) => {
    const blob = await app.pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM media_blobs WHERE sha256 = $1",
      [accepted.asset.sha256],
    );
    assert.notEqual(key, blob.rows[0]?.storage_key, "cache hit must not read original");
    return sourceRead(key, limit);
  };
  const cached = await route.handle(app, ctx, request as never);
  assert.deepEqual(cached.body, bytes);
  assert.equal((await listVariants(app.pool, accepted.asset.id)).length, 1);
  app.mediaStorage.getBuffer = sourceRead;
  const full = await route.handle(app, ctx, { ...request, query: {} } as never);
  assert.equal(full.headers?.["content-type"], "image/png");
  await assert.rejects(() => route.handle(app, apiContextOf(scopedActor([])), request as never));
  await assert.rejects(() =>
    route.handle(app, ctx, { ...request, query: { preview: "huge" } } as never),
  );
});
