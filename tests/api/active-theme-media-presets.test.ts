// Worker-side media preset regression (p-cms.com PCPUB report, RC31):
// .pcpub ingest stages media in the WORKER, whose composed preset set came
// from the boot seed in themes.renderDir instead of the ACTIVE theme — every
// preset the active theme declared beyond the seed set silently produced no
// derivative. Covers the active-theme refresher contract and the typed
// per-preset failure surfacing of generateVariantsAfterAccept.
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  createActiveMediaPresetsRefresher,
  createApiFastify,
  createApiV1,
  generateVariantsAfterAccept,
  makeMutationRoutes,
  makeThemeManageRoutes,
} from "@pcms/api";
import { createLogger } from "@pcms/core";
import {
  archiveAsset,
  getAsset,
  LocalMediaStorage,
  listVariants,
  uploadMedia,
  variantPublicUrl,
} from "@pcms/media";
import { readThemeManifestPresets } from "@pcms/themes";
import sharp from "sharp";
import yazl from "yazl";
import { registerMediaFilesRoute } from "../../apps/web/src/media-files.js";
import { registerSiteRoute } from "../../apps/web/src/site.js";
import { registerThemeFilesRoute } from "../../apps/web/src/theme-files.js";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";

const skip = !process.env.PCMS_TEST_DATABASE_URL;
const definitions = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
).contentTypes;
const SEED_PRESET_IDS = ["card", "gallery", "hero", "social-display", "thumbnail"].sort();

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pcms-active-presets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = join(root, "themes", "reference-theme-v1");
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });
  const mediaRoot = join(root, "media");
  const input = {
    themeDir,
    contentTypeDefinitions: definitions,
    seoEnvironment: "production" as const,
    // Boot composition mirrors the worker: the seed theme's presets, before
    // the active-theme refresher applies the real active set.
    mediaPresets: readThemeManifestPresets(themeDir),
    mediaStorage: new LocalMediaStorage({ root: mediaRoot }),
    mediaQuarantine: new LocalMediaStorage({ root: join(root, "quarantine") }),
  };
  const { app, pool } = await rollbackApiFixture(t, input, { transactionMode: "committed" });
  const ctx = apiContextOf(ownerActor());
  const account = await app.machineIdentity.createServiceAccount({
    name: "presets-agent",
    purpose: "test",
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [...ctx.actor.permissions],
    ttlMilliseconds: 3600000,
    siteKey: "default",
    environment: "production",
  });
  const headers = {
    authorization: `Bearer ${token.rawSecret}`,
    "x-pcms-site": "default",
    "x-pcms-environment": "production",
  };
  async function boot(application = app) {
    const server = createApiFastify(() => "active-presets-regression");
    await server.register(createApiV1([...makeMutationRoutes(), ...makeThemeManageRoutes()]), {
      application,
      logger: createLogger({ level: "error", base: {} }),
      cookieSecure: false,
    });
    // Theme activation requires the public renderer registration (it installs
    // application.themeRuntime) — the same wiring the web process uses.
    await registerSiteRoute(server, { application });
    registerThemeFilesRoute(server, { renderDir: themeDir, application });
    registerMediaFilesRoute(server, { application });
    t.after(() => server.close());
    await server.listen({ host: "127.0.0.1", port: 0 });
    return server;
  }
  return { root, themeDir, mediaRoot, app, pool, headers, boot };
}

function pack(dir: string): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const walk = (path: string, prefix = "") => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(path, entry.name), `${name}/`);
      else zip.addBuffer(readFileSync(join(path, entry.name)), name);
    }
  };
  walk(dir);
  zip.end();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** A native theme package declaring the seed presets plus two wide ones. */
function wideThemePackage(root: string, cmsVersion: string): string {
  const dir = join(root, "wide-package", "wide-theme-v1");
  mkdirSync(join(root, "wide-package"), { recursive: true });
  cpSync("themes/reference-theme-v1", dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "theme.json"), "utf8"));
  manifest.id = "wide-theme-v1";
  manifest.cms_compatibility = `~${cmsVersion}`;
  manifest.media_presets.push(
    {
      id: "product-wide",
      width: 1600,
      height: 1000,
      fit: "inside",
      crop: "center",
      formats: ["webp"],
      quality: 80,
      loading: "lazy",
    },
    {
      id: "article-wide",
      width: 1440,
      height: 900,
      fit: "inside",
      crop: "center",
      formats: ["webp"],
      quality: 80,
      loading: "lazy",
    },
  );
  writeFileSync(join(dir, "theme.json"), JSON.stringify(manifest));
  return dir;
}

async function uploadPng(f: Awaited<ReturnType<typeof fixture>>, width: number, height: number) {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: "#234567" },
  })
    .png()
    .toBuffer();
  return uploadMedia(
    {
      pool: f.pool,
      storage: f.app.mediaStorage as LocalMediaStorage,
      quarantine: f.app.mediaQuarantine as LocalMediaStorage,
    },
    { bytes, filename: "cover.png", createdBy: "test:active-presets" },
  );
}

test("worker media presets follow the active theme, not the boot seed", { skip }, async (t) => {
  const f = await fixture(t);
  const server = await f.boot();
  const cmsVersion = f.app.extensions.contractVersions.get("cms")?.version;
  assert.ok(cmsVersion);

  // The composed application still serves the boot seed before any refresh.
  assert.deepEqual(
    f.app.mediaPresets
      .listPresets()
      .map((preset) => preset.id)
      .sort(),
    SEED_PRESET_IDS,
  );

  const installed = await server.inject({
    method: "POST",
    url: "/api/v1/themes/install",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: await pack(wideThemePackage(f.root, cmsVersion)),
  });
  assert.equal(installed.statusCode, 201, installed.body);
  const activated = await server.inject({
    method: "POST",
    url: "/api/v1/theme/activate",
    headers: f.headers,
    payload: { theme_key: "wide-theme-v1" },
  });
  assert.equal(activated.statusCode, 200, activated.body);

  const refresh = createActiveMediaPresetsRefresher({
    application: f.app,
    configuredDir: f.themeDir,
    cmsVersion,
  });
  await refresh();
  const activeIds = f.app.mediaPresets.listPresets().map((preset) => preset.id);
  assert.ok(activeIds.includes("product-wide"));
  assert.ok(activeIds.includes("article-wide"));

  // Generation rides the refreshed set: a fresh image gets the ACTIVE
  // theme's declared derivatives (the reported PCPUB defect).
  const accepted = await uploadPng(f, 1536, 1024);
  const outcome = await generateVariantsAfterAccept(f.app, accepted);
  assert.deepEqual(outcome.failures, []);
  const generated = await f.pool.query<{ preset_id: string }>(
    "SELECT DISTINCT preset_id FROM media_variants WHERE asset_id = $1",
    [accepted.asset.id],
  );
  const presetIds = generated.rows.map((row) => row.preset_id);
  assert.ok(presetIds.includes("product-wide"));
  assert.ok(presetIds.includes("article-wide"));

  // Back to the boot seed: the next refresh drops the wide presets.
  const deactivated = await server.inject({
    method: "POST",
    url: "/api/v1/theme/activate",
    headers: f.headers,
    payload: { theme_key: "reference-theme-v1" },
  });
  assert.equal(deactivated.statusCode, 200, deactivated.body);
  await refresh();
  assert.ok(!f.app.mediaPresets.listPresets().some((preset) => preset.id === "product-wide"));
});

test("variant generation failures are surfaced per preset, never thrown", { skip }, async (t) => {
  const f = await fixture(t);
  const accepted = await uploadPng(f, 320, 200);
  // Corrupt the stored source bytes after acceptance: the single-shot pass
  // must not discard the committed asset, and every preset's failure must
  // come back typed instead of being silently swallowed.
  const corruptFirstFile = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (corruptFirstFile(path)) return true;
      } else {
        writeFileSync(path, Buffer.from("corrupted-not-an-image"));
        return true;
      }
    }
    return false;
  };
  assert.ok(corruptFirstFile(f.mediaRoot));
  const outcome = await generateVariantsAfterAccept(f.app, accepted);
  const presetCount = f.app.mediaPresets.listPresets().length;
  assert.ok(presetCount > 0);
  assert.equal(outcome.generated, 0);
  assert.equal(outcome.failures.length, presetCount);
  assert.deepEqual(
    outcome.failures.map((failure) => failure.preset).sort(),
    f.app.mediaPresets
      .listPresets()
      .map((preset) => preset.id)
      .sort(),
  );
  for (const failure of outcome.failures) {
    assert.equal(failure.media_id, accepted.asset.id);
    assert.ok(failure.error.length > 0);
  }
});

test("REST retries missing image variants without replacing the MediaAsset", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  const server = await f.boot();
  const accepted = await uploadPng(f, 320, 200);
  const before = await getAsset(f.pool, accepted.asset.id);
  assert.ok(before);
  const storage = f.app.mediaStorage;
  assert.ok(storage);
  const getBuffer = storage.getBuffer.bind(storage);
  storage.getBuffer = async () => {
    throw new Error("derivative source read failed");
  };
  const failed = await server.inject({
    method: "POST",
    url: `/api/v1/media/${accepted.asset.id}/variants/regenerate`,
    headers: f.headers,
  });
  assert.equal(failed.statusCode, 200, failed.body);
  const failureResult = failed.json() as {
    media_id: string;
    generated: number;
    media_variant_failures?: readonly { media_id: string; preset: string; error: string }[];
  };
  assert.equal(failureResult.media_id, accepted.asset.id);
  assert.equal(failureResult.generated, 0);
  assert.equal(
    failureResult.media_variant_failures?.length,
    f.app.mediaPresets.listPresets().length,
  );

  storage.getBuffer = getBuffer;
  const repaired = await server.inject({
    method: "POST",
    url: `/api/v1/media/${accepted.asset.id}/variants/regenerate`,
    headers: f.headers,
  });
  assert.equal(repaired.statusCode, 200, repaired.body);
  const repairedResult = repaired.json() as {
    media_id: string;
    generated: number;
    reused: number;
    media_variant_failures?: readonly unknown[];
  };
  assert.equal(repairedResult.media_id, accepted.asset.id);
  assert.ok(repairedResult.generated > 0);
  assert.equal(repairedResult.media_variant_failures, undefined);
  const after = await getAsset(f.pool, accepted.asset.id);
  assert.ok(after);
  assert.equal(after.currentVersionNo, before.currentVersionNo);
  assert.equal(after.sha256, before.sha256);
  const variants = await listVariants(f.pool, accepted.asset.id, after.currentVersionNo);
  assert.ok(variants.length > 0);
  const variant = variants[0];
  assert.ok(variant);
  const publicResponse = await server.inject({
    method: "GET",
    url: variantPublicUrl({
      assetId: variant.assetId,
      versionNo: variant.versionNo,
      presetId: variant.presetId,
      variantKey: variant.variantKey,
      format: variant.format,
    }),
  });
  assert.equal(publicResponse.statusCode, 200);

  const repeated = await server.inject({
    method: "POST",
    url: `/api/v1/media/${accepted.asset.id}/variants/regenerate`,
    headers: f.headers,
  });
  assert.equal(repeated.statusCode, 200, repeated.body);
  const repeatedResult = repeated.json() as { generated: number; reused: number };
  assert.equal(repeatedResult.generated, 0);
  assert.ok(repeatedResult.reused > 0);
});

test("media variant regeneration requires media.write", { skip }, async (t) => {
  const f = await fixture(t);
  const server = await f.boot();
  const accepted = await uploadPng(f, 320, 200);
  const account = await f.app.machineIdentity.createServiceAccount({
    name: "media-reader",
    purpose: "test",
  });
  const token = await f.app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["media.read"],
    ttlMilliseconds: 3600000,
    siteKey: "default",
    environment: "production",
  });
  const response = await server.inject({
    method: "POST",
    url: `/api/v1/media/${accepted.asset.id}/variants/regenerate`,
    headers: {
      authorization: `Bearer ${token.rawSecret}`,
      "x-pcms-site": "default",
      "x-pcms-environment": "production",
    },
  });
  assert.equal(response.statusCode, 403, response.body);
});

test("media variant regeneration rejects archived assets and non-images", { skip }, async (t) => {
  const f = await fixture(t);
  const server = await f.boot();
  const archived = await uploadPng(f, 320, 200);
  await archiveAsset(f.pool, archived.asset.id);
  const archivedResponse = await server.inject({
    method: "POST",
    url: `/api/v1/media/${archived.asset.id}/variants/regenerate`,
    headers: f.headers,
  });
  assert.equal(archivedResponse.statusCode, 409, archivedResponse.body);
  assert.equal(archivedResponse.json().error.code, "MEDIA_ARCHIVED");

  const storage = f.app.mediaStorage;
  const quarantine = f.app.mediaQuarantine;
  assert.ok(storage);
  assert.ok(quarantine);
  const document = await uploadMedia(
    { pool: f.pool, storage, quarantine },
    {
      bytes: Buffer.from("plain text document"),
      filename: "notes.txt",
      declaredMimeType: "text/plain",
      createdBy: "test:active-presets",
    },
  );
  const documentResponse = await server.inject({
    method: "POST",
    url: `/api/v1/media/${document.asset.id}/variants/regenerate`,
    headers: f.headers,
  });
  assert.equal(documentResponse.statusCode, 422, documentResponse.body);
  assert.equal(documentResponse.json().error.code, "MEDIA_VARIANT_REGENERATION_UNSUPPORTED");
});

test("REST upload returns preset failures while keeping the accepted asset", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  const storage = f.app.mediaStorage;
  assert.ok(storage);
  storage.getBuffer = async () => {
    throw new Error("derivative source read failed");
  };
  const server = await f.boot();
  const bytes = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#234567" },
  })
    .png()
    .toBuffer();
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/media",
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-pcms-filename": "cover.png",
    },
    payload: bytes,
  });

  assert.equal(response.statusCode, 201, response.body);
  const result = response.json() as {
    media_id: string;
    media_variant_failures?: readonly { media_id: string; preset: string; error: string }[];
  };
  assert.ok(result.media_id);
  assert.equal(result.media_variant_failures?.length, f.app.mediaPresets.listPresets().length);
  assert.ok(
    result.media_variant_failures?.every((failure) => failure.media_id === result.media_id),
  );
  assert.ok(result.media_variant_failures?.every((failure) => failure.error.length > 0));
});

test("REST remote import returns preset failures while keeping the accepted asset", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  const storage = f.app.mediaStorage;
  assert.ok(storage);
  storage.getBuffer = async () => {
    throw new Error("derivative source read failed");
  };
  const server = await f.boot();
  const bytes = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#234567" },
  })
    .png()
    .toBuffer();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(bytes.length) },
    });
  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/media/import",
      headers: f.headers,
      payload: { url: "https://8.8.8.8/cover.png" },
    });

    assert.equal(response.statusCode, 201, response.body);
    const result = response.json() as {
      media_id: string;
      media_variant_failures?: readonly { media_id: string; preset: string; error: string }[];
    };
    assert.ok(result.media_id);
    assert.equal(result.media_variant_failures?.length, f.app.mediaPresets.listPresets().length);
    assert.ok(
      result.media_variant_failures?.every((failure) => failure.media_id === result.media_id),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
