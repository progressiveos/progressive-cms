// Media runtime composition (Spangar audit gap #2): theme presets reach the
// application registry, uploads generate preset derivatives, and the public
// media-files route serves the generated variant URLs.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";
import { listVariants } from "@pcms/media";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const THEME_PRESETS = JSON.parse(
  readFileSync("themes/reference-theme-v1/theme.json", "utf8"),
).media_presets;

async function jpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 900, height: 600, channels: 3, background: { r: 40, g: 60, b: 90 } },
  })
    .jpeg()
    .toBuffer();
}

test("upload generates theme-preset variants; media route serves them", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const root = mkdtempSync(join(tmpdir(), "pcms-media-"));
  const { app } = await createApiFixture(t, {
    mediaRoots: { storage: join(root, "media"), quarantine: join(root, "quarantine") },
    mediaPresets: THEME_PRESETS,
  });
  const ctx = apiContextOf(ownerActor("media-seeder"));
  const { uploadMediaOp } = await import("@pcms/api");

  const accepted = await uploadMediaOp(app, ctx, {
    bytes: await jpeg(),
    filename: "montage.jpg",
  });
  const variants = await listVariants(app.pool, accepted.asset.id, accepted.asset.currentVersionNo);
  const presets = new Set(variants.map((variant) => variant.presetId));
  assert.ok(presets.has("hero"), `hero variant missing: ${[...presets].join(", ")}`);
  assert.ok(presets.has("card"), `card variant missing: ${[...presets].join(", ")}`);
  assert.ok(variants.some((variant) => variant.format === "avif"));

  // The public route serves exactly the URLs the view model hands to themes.
  const { variantPublicUrl } = await import("@pcms/media");
  const hero = variants.find((variant) => variant.presetId === "hero" && variant.format === "webp");
  assert.ok(hero);
  const url = variantPublicUrl({
    assetId: hero.assetId,
    versionNo: hero.versionNo,
    presetId: hero.presetId,
    variantKey: hero.variantKey,
    format: hero.format,
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_media");
  const { registerMediaFilesRoute } = await import("../../apps/web/src/media-files.js");
  registerMediaFilesRoute(fastify, { application: app });
  const response = await fastify.inject({ method: "GET", url });
  assert.equal(response.statusCode, 200, url);
  assert.equal(response.headers["content-type"], "image/webp");
  assert.ok(String(response.headers["cache-control"]).includes("immutable"));
});
