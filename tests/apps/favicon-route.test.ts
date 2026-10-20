// CORE-FAVICON-01 — the standard `/favicon.ico` alias.
//
// A migrated site renders a correct `<link rel="icon">` but the conventional
// address 404s, which audits and non-browser clients read as "no favicon". The
// route is a same-origin redirect to the SAME Site Identity favicon the core
// head already links — no second favicon setting, no web-root file, no Nginx
// rule. Absence is configuration: no favicon declared or no materialized
// derivative means 404, which is not a defect.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFastify, getSiteIdentityOp, updateSiteIdentityOp } from "@pcms/api";
import { uploadMedia } from "@pcms/media";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, ownerActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

const IDENTITY_CTX = () => apiContextOf(ownerActor("favicon-identity"));

async function pngBytes(width: number, height: number, color: object): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/** Disposable database + media roots + the public Web composition the alias
 * is registered into, with the media delivery route mounted so a redirect
 * target can actually be fetched. */
async function faviconStack(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pcms-favicon-"));
  const mediaRoot = join(root, "media");
  mkdirSync(mediaRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes,
    seoEnvironment: "production",
    mediaRoots: { storage: mediaRoot, quarantine: join(root, "quarantine") },
  });
  const fastify: FastifyInstance = createApiFastify(() => "req_favicon");
  // Exercise the same registrations the Web composition root performs, not a
  // hand-mounted copy of the redirect logic.
  const { registerFaviconRoute } = await import("../../apps/web/src/favicon.js");
  const { registerMediaFilesRoute } = await import("../../apps/web/src/media-files.js");
  registerFaviconRoute(fastify, { application: app });
  registerMediaFilesRoute(fastify, { application: app });
  t.after(() => fastify.close());
  await app.routes.ensureSite("default");
  return { app, fastify };
}

/** Uploads a raster image through the real Media ingest path. */
async function uploadImage(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  bytes: Buffer,
  filename: string,
): Promise<string> {
  assert.ok(app.mediaStorage !== null && app.mediaQuarantine !== null);
  const accepted = await uploadMedia(
    { pool: app.pool, storage: app.mediaStorage, quarantine: app.mediaQuarantine },
    { bytes, filename, createdBy: "favicon-test" },
  );
  return accepted.asset.id as string;
}

/** Assigns the default site's favicon through the real branding operation —
 * the documented materialization point for the favicon-v1 derivative. */
async function setFavicon(
  app: Awaited<ReturnType<typeof createApiFixture>>["app"],
  assetId: string,
): Promise<void> {
  const current = await getSiteIdentityOp(app, IDENTITY_CTX());
  const existing = (current.identity ?? {}) as Record<string, unknown>;
  await updateSiteIdentityOp(app, IDENTITY_CTX(), {
    identity: { ...existing, site_name: "Favicon Site", favicon: { asset_id: assetId } },
  });
}

/** Location header of the alias response, asserted to be a same-origin path
 * inside the public media namespace. */
function mediaLocation(headers: Record<string, unknown>): string {
  const location = headers.location;
  assert.equal(typeof location, "string", "Location header present");
  assert.ok((location as string).startsWith("/media/a/"), location as string);
  return location as string;
}

test("GET /favicon.ico redirects to the configured favicon and serves a decodable image", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await faviconStack(t);
  const assetId = await uploadImage(
    app,
    await pngBytes(512, 512, { r: 12, g: 90, b: 200 }),
    "brand.png",
  );
  await setFavicon(app, assetId);

  const response = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  assert.equal(response.statusCode, 302, response.body.slice(0, 200));
  const location = mediaLocation(response.headers);
  assert.ok(location.includes(assetId), location);
  assert.ok(location.includes("favicon-v1"), location);
  assert.equal(response.headers["cache-control"], "public, max-age=300");

  // The target is a real, decodable image whose content type matches.
  const asset = await fastify.inject({ method: "GET", url: location });
  assert.equal(asset.statusCode, 200, asset.body.slice(0, 200));
  assert.equal(asset.headers["content-type"], "image/png");
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(asset.rawPayload).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
});

test("the alias resolves the identity favicon without a separate setting", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await faviconStack(t);
  const assetId = await uploadImage(app, await pngBytes(256, 256, { r: 4, g: 5, b: 6 }), "one.png");
  await setFavicon(app, assetId);

  const alias = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  const icons = await app.seoDiscovery.siteFaviconIcons();
  const identityIcon = icons.find((icon) => icon.rel === "icon");
  assert.ok(identityIcon !== undefined, "the identity supplies a rel=icon link");
  // One source of truth: the alias points at exactly the URL the head links.
  assert.equal(alias.headers.location, identityIcon.href);
});

test("no favicon configured is a documented 404, not a synthesized icon", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify } = await faviconStack(t);

  const response = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  assert.equal(response.statusCode, 404);
});

test("a favicon declared but never materialized stays a 404, not a broken redirect", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await faviconStack(t);
  const site = await app.routes.ensureSite("default");
  // The reference exists but no favicon-v1 derivative was ever generated —
  // the shape a hand-seeded or partially migrated site can have.
  await app.seo.saveSiteSettings(
    site.id as never,
    {
      site_name: "Unmaterialized",
      favicon: { asset_id: "0198c0de-0000-7000-8000-0000000d00ff" },
    } as never,
  );

  const response = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  assert.equal(response.statusCode, 404);
});

test("changing the favicon retires the old location instead of pinning it", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await faviconStack(t);
  const first = await uploadImage(
    app,
    await pngBytes(128, 128, { r: 200, g: 20, b: 20 }),
    "first.png",
  );
  await setFavicon(app, first);
  const before = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  const oldLocation = mediaLocation(before.headers);
  const oldEtag = before.headers.etag;
  assert.ok(oldLocation.includes(first), oldLocation);

  const second = await uploadImage(
    app,
    await pngBytes(128, 128, { r: 20, g: 200, b: 20 }),
    "second.png",
  );
  await setFavicon(app, second);
  const after = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  assert.equal(after.statusCode, 302);
  assert.ok(after.headers.location?.includes(second), after.headers.location ?? "");
  assert.notEqual(after.headers.location, oldLocation, "the alias moved to the new asset");

  // A client revalidating with the stale tag must refetch, not be told 304.
  const revalidated = await fastify.inject({
    method: "GET",
    url: "/favicon.ico",
    headers: { "if-none-match": oldEtag as string },
  });
  assert.notEqual(revalidated.statusCode, 304, "a stale ETag must not answer Not Modified");
  assert.equal(revalidated.headers.location, after.headers.location);

  // The new location serves the new pixels, not the old cache entry.
  const beforeAsset = await fastify.inject({ method: "GET", url: oldLocation });
  const asset = await fastify.inject({ method: "GET", url: after.headers.location as string });
  assert.equal(asset.statusCode, 200);
  // favicon-v1 is a fixed 512×512 PNG by contract, so the change is visible in
  // the pixels rather than the dimensions: the two sources are red vs green.
  const { default: sharp } = await import("sharp");
  const [oldStats, newStats] = await Promise.all([
    sharp(beforeAsset.rawPayload).stats(),
    sharp(asset.rawPayload).stats(),
  ]);
  const [oldRed, oldGreen] = [oldStats.channels[0]?.mean ?? 0, oldStats.channels[1]?.mean ?? 0];
  const [newRed, newGreen] = [newStats.channels[0]?.mean ?? 0, newStats.channels[1]?.mean ?? 0];
  assert.ok(oldRed > oldGreen, `the old icon is the red source: ${oldRed} vs ${oldGreen}`);
  assert.ok(newGreen > newRed, `the new icon is the green source: ${newGreen} vs ${newRed}`);
});

test("a matching ETag revalidates to 304 without a body", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await faviconStack(t);
  const assetId = await uploadImage(app, await pngBytes(64, 64, { r: 1, g: 2, b: 3 }), "etag.png");
  await setFavicon(app, assetId);

  const first = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  const etag = first.headers.etag;
  assert.ok(typeof etag === "string" && etag.length > 0, "ETag present");
  const revalidated = await fastify.inject({
    method: "GET",
    url: "/favicon.ico",
    headers: { "if-none-match": etag as string },
  });
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.body, "");
});

test("another site's favicon never leaks through this site's alias", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await faviconStack(t);
  const theirs = await uploadImage(
    app,
    await pngBytes(96, 96, { r: 250, g: 250, b: 250 }),
    "theirs.png",
  );
  const mine = await uploadImage(app, await pngBytes(96, 96, { r: 9, g: 9, b: 9 }), "mine.png");

  // Only the OTHER site declares a favicon: the default site's alias must not
  // reach across sites for something to serve.
  const other = await app.routes.ensureSite("other", "Other Site");
  await app.seo.saveSiteSettings(
    other.id as never,
    {
      site_name: "Other Site",
      favicon: { asset_id: theirs },
    } as never,
  );
  const withoutMine = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  assert.equal(withoutMine.statusCode, 404, "another site's favicon must not be served");

  // With the default site's own favicon assigned, the alias serves only it.
  await setFavicon(app, mine);
  const response = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  const location = mediaLocation(response.headers);
  assert.ok(location.includes(mine), location);
  assert.ok(!location.includes(theirs), `leaked another site's favicon: ${location}`);
});

test("HEAD on the alias matches the GET contract without a body", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await faviconStack(t);
  const assetId = await uploadImage(app, await pngBytes(32, 32, { r: 7, g: 7, b: 7 }), "head.png");
  await setFavicon(app, assetId);

  const get = await fastify.inject({ method: "GET", url: "/favicon.ico" });
  const head = await fastify.inject({ method: "HEAD", url: "/favicon.ico" });
  assert.equal(head.statusCode, get.statusCode, "HEAD mirrors GET status");
  assert.equal(head.headers.location, get.headers.location);
  assert.equal(head.body, "", "HEAD carries no body");
});
