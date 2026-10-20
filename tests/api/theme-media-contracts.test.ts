import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  createApiFastify,
  createApiV1,
  createApplicationServices,
  createDraft,
  makeDiscoveryRoutes,
  makeFormsRoutes,
  makeMutationRoutes,
  makeThemeManageRoutes,
  publishRevision,
  sealRevision,
} from "@pcms/api";
import { createLogger } from "@pcms/core";
import { LocalMediaStorage } from "@pcms/media";
import { installThemePackage, snapshotThemeFiles } from "@pcms/themes";
import sharp from "sharp";
import yazl from "yazl";
import { registerSiteRoute } from "../../apps/web/src/site.js";
import { registerThemeFilesRoute } from "../../apps/web/src/theme-files.js";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";

const skip = !process.env.PCMS_TEST_DATABASE_URL;
const definitions = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
).contentTypes;

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pcms-contracts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = join(root, "themes", "reference-theme-v1");
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });
  const input = {
    themeDir,
    contentTypeDefinitions: definitions,
    seoEnvironment: "production" as const,
    mediaStorage: new LocalMediaStorage({ root: join(root, "media") }),
    mediaQuarantine: new LocalMediaStorage({ root: join(root, "quarantine") }),
  };
  const { app, pool } = await rollbackApiFixture(t, input, { transactionMode: "committed" });
  const ctx = apiContextOf(ownerActor());
  const account = await app.machineIdentity.createServiceAccount({
    name: "contract-agent",
    purpose: "test",
  });
  const scopes = [...ctx.actor.permissions];
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes,
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
    const server = createApiFastify(() => "contract-regression");
    await server.register(
      createApiV1([
        ...makeMutationRoutes(),
        ...makeThemeManageRoutes(),
        ...makeFormsRoutes(),
        ...makeDiscoveryRoutes(),
      ]),
      { application, logger: createLogger({ level: "error", base: {} }), cookieSecure: false },
    );
    await registerSiteRoute(server, { application });
    registerThemeFilesRoute(server, { renderDir: themeDir, application });
    t.after(() => server.close());
    await server.listen({ host: "127.0.0.1", port: 0 });
    return server;
  }
  return { root, themeDir, app, pool, input, ctx, headers, boot, account };
}

async function pack(dir: string) {
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
  for await (const chunk of zip.outputStream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function page(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  ctx: ReturnType<typeof apiContextOf>,
  path: string,
  media?: string,
) {
  const draft = await createDraft(app, ctx, {
    content_type: media ? "case" : "page",
    payload: {
      fields: { title: "Contract page", ...(media ? { hero_image: media } : {}) },
      blocks: { schema_version: 1, blocks: [] },
    },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  const site = await app.routes.ensureSite("default");
  await app.routes.activateRoute({
    siteId: site.id,
    path,
    targetType: "entry",
    targetId: draft.entry_id,
  });
  return draft;
}

test("installed theme activation and settings CAS change actual HTTP rendering without restart", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  await page(f.app, f.ctx, "/contract/");
  const server = await f.boot();
  const before = await server.inject({ method: "GET", url: "/contract/" });
  assert.equal(before.statusCode, 200);
  const candidate = join(f.root, "package");
  cpSync(f.themeDir, candidate, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(candidate, "theme.json"), "utf8"));
  manifest.id = "runtime-candidate";
  const cmsVersion = f.app.extensions.contractVersions.get("cms")?.version;
  assert.ok(cmsVersion);
  manifest.cms_compatibility = `~${cmsVersion}`;
  manifest.navigation_placements[0].id = "candidate.primary";
  writeFileSync(join(candidate, "theme.json"), JSON.stringify(manifest));
  const template = join(candidate, "templates", "page-default.liquid");
  writeFileSync(
    template,
    readFileSync(template, "utf8") +
      "<p>CANDIDATE_RENDER</p><p>MEDIA_REF={{ theme_settings.logo }}</p>",
  );
  const installed = await server.inject({
    method: "POST",
    url: "/api/v1/themes/install",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: await pack(candidate),
  });
  assert.equal(installed.statusCode, 201, installed.body);
  const activated = await server.inject({
    method: "POST",
    url: "/api/v1/theme/activate",
    headers: f.headers,
    payload: { theme_key: manifest.id },
  });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.match(
    (await server.inject({ method: "GET", url: "/contract/" })).body,
    /CANDIDATE_RENDER/,
  );
  assert.equal(f.app.themeRuntime.served?.().id, manifest.id);
  assert.equal(f.app.navigationDiscovery.listPlacements()[0]?.id, "candidate.primary");
  const address = server.server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  assert.match(await (await fetch(`${endpoint}/contract/`)).text(), /CANDIDATE_RENDER/);
  assert.equal(
    (await f.pool.query("SELECT theme_key FROM admin_theme_state")).rows[0]?.theme_key,
    manifest.id,
  );
  const state = await server.inject({
    method: "GET",
    url: "/api/v1/theme/state",
    headers: f.headers,
  });
  const generation = state.json().settings.generation;
  const form = await server.inject({
    method: "POST",
    url: "/api/v1/forms",
    headers: f.headers,
    payload: {
      key: "live_contact",
      title: "LIVE_FORM",
      fields: [{ key: "name", type: "text", label: "LIVE_FORM_FIELD", required: true }],
    },
  });
  assert.equal(form.statusCode, 201, form.body);
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } })
    .png()
    .toBuffer();
  const upload = await server.inject({
    method: "POST",
    url: "/api/v1/media",
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-pcms-filename": "logo.png",
    },
    payload: bytes,
  });
  assert.equal(upload.statusCode, 201, upload.body);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM media_assets")).rows[0]?.n, 1);
  const values = {
    footer_text: "LIVE_SETTINGS",
    lead_form_id: form.json().id,
    logo: upload.json().media_id,
  };
  const updated = await server.inject({
    method: "PUT",
    url: "/api/v1/theme/settings",
    headers: f.headers,
    payload: { expected_generation: generation, values },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().applied, true);
  const html = await (await fetch(`${endpoint}/contract/`)).text();
  assert.match(html, /LIVE_SETTINGS/);
  assert.match(html, /LIVE_FORM_FIELD/);
  assert.ok(html.includes(upload.json().media_id));
  const appliedState = (
    await server.inject({ method: "GET", url: "/api/v1/theme/state", headers: f.headers })
  ).json();
  assert.equal(appliedState.settings.applied_generation, updated.json().generation);
  const invalid = await server.inject({
    method: "PUT",
    url: "/api/v1/theme/settings",
    headers: f.headers,
    payload: {
      expected_generation: updated.json().generation,
      values: { primary_color: "not-a-color" },
    },
  });
  assert.equal(invalid.statusCode, 422);
  assert.match((await server.inject({ method: "GET", url: "/contract/" })).body, /LIVE_SETTINGS/);
  const concurrent = await Promise.all(
    ["FIRST", "SECOND"].map((footer_text) =>
      server.inject({
        method: "PUT",
        url: "/api/v1/theme/settings",
        headers: f.headers,
        payload: {
          expected_generation: updated.json().generation,
          values: { ...values, footer_text },
        },
      }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    concurrent.find((r) => r.statusCode === 409)?.json().error.code,
    "THEME_SETTINGS_STALE",
  );
  const winner = concurrent[0]?.statusCode === 200 ? "FIRST" : "SECOND";
  assert.match(
    (await server.inject({ method: "GET", url: "/contract/" })).body,
    new RegExp(winner),
  );
  for (const key of ["absent", "../escape", "untrusted"]) {
    if (key === "untrusted") cpSync(candidate, join(f.root, "themes", key), { recursive: true });
    const failure = await server.inject({
      method: "POST",
      url: "/api/v1/theme/activate",
      headers: f.headers,
      payload: { theme_key: key },
    });
    assert.equal(failure.statusCode, key === "absent" ? 404 : 422, failure.body);
    assert.match(
      (await server.inject({ method: "GET", url: "/contract/" })).body,
      new RegExp(winner),
    );
  }
  const badManifestPath = join(f.root, "themes", manifest.id, "theme.json");
  const savedManifest = readFileSync(badManifestPath, "utf8");
  const incompatible = JSON.parse(savedManifest);
  incompatible.theme_contract = "^99.0";
  writeFileSync(badManifestPath, JSON.stringify(incompatible));
  const badActivation = await server.inject({
    method: "POST",
    url: "/api/v1/theme/activate",
    headers: f.headers,
    payload: { theme_key: manifest.id },
  });
  assert.equal(badActivation.statusCode, 422);
  writeFileSync(badManifestPath, savedManifest);
  const outside = join(f.root, "outside");
  cpSync(candidate, outside, { recursive: true });
  symlinkSync(outside, join(f.root, "themes", "escape"));
  assert.equal(
    (
      await server.inject({
        method: "POST",
        url: "/api/v1/theme/activate",
        headers: f.headers,
        payload: { theme_key: "escape" },
      })
    ).statusCode,
    422,
  );
  const restricted = await f.app.machineIdentity.createAccessToken({
    serviceAccountId: f.account.id,
    scopes: ["theme.read"],
    ttlMilliseconds: 3600000,
  });
  const denied = await server.inject({
    method: "POST",
    url: "/api/v1/theme/activate",
    headers: { ...f.headers, authorization: `Bearer ${restricted.rawSecret}` },
    payload: { theme_key: manifest.id },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(
    (
      await server.inject({
        method: "POST",
        url: "/api/v1/themes/install",
        headers: {
          ...f.headers,
          authorization: `Bearer ${restricted.rawSecret}`,
          "content-type": "application/octet-stream",
        },
        payload: await pack(candidate),
      })
    ).statusCode,
    403,
  );
  const foreign = await f.app.machineIdentity.createAccessToken({
    serviceAccountId: f.account.id,
    scopes: ["theme.activate"],
    ttlMilliseconds: 3600000,
    siteKey: "foreign",
  });
  assert.equal(
    (
      await server.inject({
        method: "POST",
        url: "/api/v1/theme/activate",
        headers: {
          ...f.headers,
          authorization: `Bearer ${foreign.rawSecret}`,
          "x-pcms-site": "foreign",
        },
        payload: { theme_key: manifest.id },
      })
    ).statusCode,
    403,
  );
  rmSync(f.themeDir, { recursive: true });
  const restarted = await f.boot(createApplicationServices({ ...f.input, pool: f.pool }));
  const restartedHtml = (await restarted.inject({ method: "GET", url: "/contract/" })).body;
  assert.match(restartedHtml, /CANDIDATE_RENDER/);
  assert.match(restartedHtml, new RegExp(winner));
  const nextGeneration = (
    await server.inject({ method: "GET", url: "/api/v1/theme/state", headers: f.headers })
  ).json().settings.generation;
  assert.equal(
    (
      await server.inject({
        method: "PUT",
        url: "/api/v1/theme/settings",
        headers: f.headers,
        payload: {
          expected_generation: nextGeneration,
          values: { ...values, footer_text: "OTHER_PROCESS" },
        },
      })
    ).statusCode,
    200,
  );
  assert.match(
    (await restarted.inject({ method: "GET", url: "/contract/" })).body,
    /OTHER_PROCESS/,
  );
});

test("fresh site composition resolves installed themes against the runtime CMS version", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  await page(f.app, f.ctx, "/contract/");
  const server = await f.boot();
  const cmsVersion = f.app.extensions.contractVersions.get("cms")?.version;
  assert.ok(cmsVersion);
  const candidate = join(f.root, "compatible-theme-package");
  cpSync(f.themeDir, candidate, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(candidate, "theme.json"), "utf8"));
  manifest.id = "runtime-compatible";
  manifest.cms_compatibility = `~${cmsVersion}`;
  writeFileSync(join(candidate, "theme.json"), JSON.stringify(manifest));
  const template = join(candidate, "templates", "page-default.liquid");
  writeFileSync(template, `${readFileSync(template, "utf8")}<p>FRESH_COMPATIBLE_THEME</p>`);

  const installed = await server.inject({
    method: "POST",
    url: "/api/v1/themes/install",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: await pack(candidate),
  });
  assert.equal(installed.statusCode, 201, installed.body);
  const activated = await server.inject({
    method: "POST",
    url: "/api/v1/theme/activate",
    headers: f.headers,
    payload: { theme_key: manifest.id },
  });
  assert.equal(activated.statusCode, 200, activated.body);

  const freshApp = createApplicationServices({ ...f.input, pool: f.pool });
  const freshServer = await f.boot(freshApp);
  assert.equal(freshApp.themeRuntime.served?.().id, manifest.id);
  const rendered = await freshServer.inject({ method: "GET", url: "/contract/" });
  assert.equal(rendered.statusCode, 200, rendered.body);
  assert.match(rendered.body, /FRESH_COMPATIBLE_THEME/);

  const incompatiblePackage = join(f.root, "incompatible-theme-package");
  cpSync(f.themeDir, incompatiblePackage, { recursive: true });
  const incompatibleManifestPath = join(incompatiblePackage, "theme.json");
  const incompatibleManifest = JSON.parse(readFileSync(incompatibleManifestPath, "utf8"));
  incompatibleManifest.id = "incompatible-theme";
  incompatibleManifest.cms_compatibility = ">=999.0.0";
  writeFileSync(incompatibleManifestPath, JSON.stringify(incompatibleManifest));
  await installThemePackage(await pack(incompatiblePackage), {
    themesRoot: dirname(f.themeDir),
    renderDirThemeId: "reference-theme-v1",
    cmsVersion: "999.0.0",
  });
  await f.pool.query(
    "UPDATE admin_theme_state SET theme_key = $1, theme_version = $2, active_revision_id = NULL WHERE site_key = $3",
    [incompatibleManifest.id, incompatibleManifest.version, "default"],
  );
  const incompatibleApp = createApplicationServices({ ...f.input, pool: f.pool });
  const incompatibleServer = createApiFastify(() => "theme-compatibility-regression");
  await assert.rejects(
    registerSiteRoute(incompatibleServer, { application: incompatibleApp }),
    (error: { code?: string; message?: string }) =>
      error.code === "THEME_PACKAGE_INVALID" && /CMS/.test(error.message ?? ""),
  );
});

test("logical media IDs share physical bytes, independent metadata and references; explicit source keys replay safely", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  const server = await f.boot();
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#abcdef" } })
    .png()
    .toBuffer();
  const upload = (key?: string, filename = "identity.png", payload = bytes) =>
    server.inject({
      method: "POST",
      url: "/api/v1/media",
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-pcms-filename": filename,
        ...(key ? { "idempotency-key": key } : {}),
      },
      payload,
    });
  const first = await upload("source:object-one");
  const second = await upload("source:object-two");
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(second.statusCode, 201, second.body);
  const one = first.json().media_id,
    two = second.json().media_id;
  assert.notEqual(one, two);
  assert.equal(first.json().sha256, second.json().sha256);
  assert.equal(second.json().duplicate_blob, true);
  const patch = async (id: string, title: string) => {
    const response = await server.inject({
      method: "PATCH",
      url: `/api/v1/media/${id}`,
      headers: f.headers,
      payload: { title, alt_default: `${title} ALT`, caption_default: `${title} CAPTION` },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  await patch(one, "ONE");
  await patch(two, "TWO");
  const assets = await f.pool.query(
    "SELECT id, original_blob_id, title, alt_default, caption_default FROM media_assets ORDER BY title",
  );
  assert.equal(assets.rows.length, 2);
  assert.equal(assets.rows[0]?.original_blob_id, assets.rows[1]?.original_blob_id);
  assert.deepEqual(
    assets.rows.map((r) => r.alt_default),
    ["ONE ALT", "TWO ALT"],
  );
  await page(f.app, f.ctx, "/one/", one);
  await page(f.app, f.ctx, "/two/", two);
  const references = await f.pool.query(
    "SELECT payload->'fields'->>'hero_image' AS media FROM revisions WHERE entity_type = 'entry'",
  );
  assert.deepEqual(new Set(references.rows.map((r) => r.media)), new Set([one, two]));
  const retry = await upload("source:object-one");
  assert.equal(retry.json().media_id, one);
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS count FROM media_assets")).rows[0]?.count,
    2,
  );
  assert.equal(
    (await upload("source:object-one", "changed-name.png")).json().error.code,
    "IDEMPOTENCY_KEY_CONFLICT",
  );
  const racing = await Promise.all([upload("source:concurrent"), upload("source:concurrent")]);
  assert.deepEqual(racing.map((r) => r.statusCode).sort(), [201, 409]);
  const raceWinner = racing.find((r) => r.statusCode === 201)?.json().media_id;
  assert.equal((await upload("source:concurrent")).json().media_id, raceWinner);
  const ordinary = await upload();
  assert.equal(ordinary.statusCode, 201);
  assert.notEqual(ordinary.json().media_id, one);
  assert.equal(
    (
      await f.pool.query("SELECT count(*)::int AS count FROM media_blobs WHERE sha256 = $1", [
        first.json().sha256,
      ])
    ).rows[0]?.count,
    1,
  );
  const restricted = await f.app.machineIdentity.createAccessToken({
    serviceAccountId: f.account.id,
    scopes: ["media.read"],
    ttlMilliseconds: 3600000,
  });
  for (const key of [undefined, "source:object-one"]) {
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/api/v1/media",
          headers: {
            ...f.headers,
            authorization: `Bearer ${restricted.rawSecret}`,
            "content-type": "application/octet-stream",
            "x-pcms-filename": "identity.png",
            ...(key ? { "idempotency-key": key } : {}),
          },
          payload: bytes,
        })
      ).statusCode,
      403,
    );
  }
  const foreign = await f.app.machineIdentity.createAccessToken({
    serviceAccountId: f.account.id,
    scopes: ["media.write"],
    siteKey: "foreign",
    ttlMilliseconds: 3600000,
  });
  assert.equal(
    (
      await server.inject({
        method: "POST",
        url: "/api/v1/media",
        headers: {
          ...f.headers,
          authorization: `Bearer ${foreign.rawSecret}`,
          "x-pcms-site": "foreign",
          "content-type": "application/octet-stream",
          "x-pcms-filename": "identity.png",
          "idempotency-key": "source:object-one",
        },
        payload: bytes,
      })
    ).statusCode,
    403,
  );
});

test("theme journal restores confirmed files/render/state after final persistence failure and restart recovery is idempotent", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  await page(f.app, f.ctx, "/journal/");
  let failFinal = true;
  let failRecovery = true;
  const faultPool = {
    ...f.pool,
    async withClient<T>(work: (db: import("@pcms/core").DbClient) => Promise<T>): Promise<T> {
      return f.pool.withClient((db) =>
        work({
          ...db,
          async query<Row extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[],
          ) {
            if (failFinal && sql.includes("theme_generation=theme_generation+1")) {
              failFinal = false;
              throw new Error("INJECTED_FINAL_WRITE");
            }
            if (failRecovery && sql.includes("SET phase = 'ABORTED'")) {
              failRecovery = false;
              throw new Error("INJECTED_RECOVERY_WRITE");
            }
            return db.query<Row>(sql, params);
          },
        }),
      );
    },
  };
  const app = createApplicationServices({ ...f.input, pool: faultPool });
  const server = await f.boot(app);
  const originalVersion = app.themeRuntime.served!().version;
  const candidate = join(f.root, "journal-package");
  cpSync(f.themeDir, candidate, { recursive: true });
  const manifestPath = join(candidate, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "1.99.0";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const template = join(candidate, "templates", "page-default.liquid");
  writeFileSync(template, readFileSync(template, "utf8") + "<p>UNCONFIRMED_TARGET</p>");
  const bytes = await pack(candidate);
  const failed = await server.inject({
    method: "POST",
    url: "/api/v1/themes/active/update",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: bytes,
  });
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.json().error.code, "THEME_RECOVERY_UNAVAILABLE");
  const pending = (
    await f.pool.query(
      "SELECT active_revision_id,pending_operation_id,theme_version FROM admin_theme_state",
    )
  ).rows[0]!;
  assert.ok(pending.pending_operation_id);
  assert.equal(pending.theme_version, originalVersion);
  // A new composition must recover before reading a potentially intermediate
  // catalog; no operator edit or second update is involved.
  const restarted = createApplicationServices({ ...f.input, pool: f.pool });
  const restartedServer = await f.boot(restarted);
  const again = createApplicationServices({ ...f.input, pool: f.pool });
  await f.boot(again);
  const after = (
    await f.pool.query(
      "SELECT active_revision_id,pending_operation_id,theme_version FROM admin_theme_state",
    )
  ).rows[0]!;
  assert.equal(after.active_revision_id, pending.active_revision_id);
  assert.equal(after.pending_operation_id, null);
  assert.equal(after.theme_version, originalVersion);
  assert.equal(
    JSON.parse(readFileSync(join(f.themeDir, "theme.json"), "utf8")).version,
    originalVersion,
  );
  assert.equal(restarted.themeRuntime.served!().version, originalVersion);
  assert.doesNotMatch(
    (await restartedServer.inject({ method: "GET", url: "/journal/" })).body,
    /UNCONFIRMED_TARGET/,
  );
  assert.equal(
    (await f.pool.query("SELECT phase FROM theme_operations")).rows[0]?.phase,
    "ABORTED",
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM auth_security_events WHERE event_type='THEME_UPDATED'",
      )
    ).rows[0]?.n,
    0,
  );
  // Repeat the same valid package after recovery: one confirmation and audit.
  const success = await restartedServer.inject({
    method: "POST",
    url: "/api/v1/themes/active/update",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: bytes,
  });
  assert.equal(success.statusCode, 200, success.body);
  assert.equal(restarted.themeRuntime.served!().version, "1.99.0");
  assert.match(
    (await restartedServer.inject({ method: "GET", url: "/journal/" })).body,
    /UNCONFIRMED_TARGET/,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM auth_security_events WHERE event_type='THEME_UPDATED'",
      )
    ).rows[0]?.n,
    1,
  );
});

test("theme session lock is cross-connection, busy is typed, and failed unlock discards the session", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  const { withThemeLifecycleLock } = await import("@pcms/api");
  const input = { pool: f.pool, configuredDir: f.themeDir, siteKey: "default" };
  await withThemeLifecycleLock(input, async () => {
    await assert.rejects(
      withThemeLifecycleLock(input, async () => {}),
      (error: { code?: string }) => error.code === "THEME_CHANGE_BUSY",
    );
  });
  await withThemeLifecycleLock(input, async () => {});
  let discarded = false;
  const failingPool = {
    ...f.pool,
    async withClient<T>(work: (db: import("@pcms/core").DbClient) => Promise<T>): Promise<T> {
      return f.pool.withClient((db) =>
        work({
          ...db,
          discard(reason) {
            discarded = true;
            db.discard?.(reason);
          },
          async query<Row extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[],
          ) {
            if (sql.includes("pg_advisory_unlock")) throw new Error("INJECTED_UNLOCK");
            return db.query<Row>(sql, params);
          },
        }),
      );
    },
  };
  await withThemeLifecycleLock({ ...input, pool: failingPool }, async () => {});
  assert.equal(discarded, true);
  await withThemeLifecycleLock(input, async () => {});
});

test("uncertain theme COMMIT acknowledgement resolves from durable journal without compensating a committed update", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  await page(f.app, f.ctx, "/ack/");
  let confirming = false;
  let lostAck = false;
  const pool = {
    ...f.pool,
    async query<Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      assert.ok(
        !sql.includes("SELECT phase FROM theme_operations"),
        "journal status read must not acquire another pooled session while lock is held",
      );
      return f.pool.query<Row>(sql, params);
    },
    async withClient<T>(work: (db: import("@pcms/core").DbClient) => Promise<T>): Promise<T> {
      return f.pool.withClient((db) =>
        work({
          ...db,
          async query<Row extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[],
          ) {
            if (sql.includes("SET phase='COMMITTED'")) confirming = true;
            const result = await db.query<Row>(sql, params);
            if (sql === "COMMIT" && confirming && !lostAck) {
              lostAck = true;
              throw new Error("INJECTED_COMMIT_ACK_LOSS");
            }
            return result;
          },
        }),
      );
    },
  };
  const app = createApplicationServices({ ...f.input, pool });
  const server = await f.boot(app);
  const saved = await server.inject({
    method: "PUT",
    url: "/api/v1/theme/settings",
    headers: f.headers,
    payload: { expected_generation: 0, values: { footer_text: "ACK_CONFIRMED" } },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(lostAck, true);
  const state = (
    await f.pool.query(
      "SELECT pending_operation_id,settings,settings_generation FROM admin_theme_state",
    )
  ).rows[0];
  assert.ok(state);
  assert.equal(state.pending_operation_id, null);
  assert.equal(state.settings_generation, 1);
  assert.equal((state.settings as Record<string, unknown>).footer_text, "ACK_CONFIRMED");
  assert.equal(
    (await f.pool.query("SELECT phase FROM theme_operations")).rows[0]?.phase,
    "COMMITTED",
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM auth_security_events WHERE event_type='THEME_UPDATED'",
      )
    ).rows[0]?.n,
    1,
  );
  const restarted = createApplicationServices({ ...f.input, pool: f.pool });
  const again = await f.boot(restarted);
  assert.match((await again.inject({ method: "GET", url: "/ack/" })).body, /ACK_CONFIRMED/);
});

test("in-flight public HTML remains pinned while pending publication gates a second Web process", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  await page(f.app, f.ctx, "/pin/");
  const template = join(f.themeDir, "templates", "page-default.liquid");
  writeFileSync(template, `${readFileSync(template, "utf8")}<p>BEFORE_PIN</p>`);
  let enterRead!: () => void;
  let releaseRead!: () => void;
  const enteredRead = new Promise<void>((resolve) => {
    enterRead = resolve;
  });
  const blockedRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let enterConfirm!: () => void;
  let releaseConfirm!: () => void;
  const enteredConfirm = new Promise<void>((resolve) => {
    enterConfirm = resolve;
  });
  const blockedConfirm = new Promise<void>((resolve) => {
    releaseConfirm = resolve;
  });
  t.after(() => {
    releaseRead();
    releaseConfirm();
  });
  let pauseRead = true;
  let pauseConfirm = true;
  const pool: import("@pcms/core").DbPool = {
    ...f.pool,
    async query<Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (pauseRead && sql.includes("FROM publications")) {
        pauseRead = false;
        enterRead();
        await blockedRead;
      }
      return f.pool.query<Row>(sql, params);
    },
    async withClient(work) {
      return f.pool.withClient((db) =>
        work({
          ...db,
          async query<Row extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[],
          ) {
            if (pauseConfirm && sql.includes("theme_generation=theme_generation+1")) {
              pauseConfirm = false;
              enterConfirm();
              await blockedConfirm;
            }
            return db.query<Row>(sql, params);
          },
        }),
      );
    },
  };
  const app = createApplicationServices({ ...f.input, pool });
  const server = await f.boot(app);
  const other = createApplicationServices({ ...f.input, pool: f.pool });
  const otherServer = await f.boot(other);
  const inflight = server.inject({ method: "GET", url: "/pin/" });
  await Promise.race([
    enteredRead,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("request did not reach publication read")), 3000),
    ),
  ]);
  const candidate = join(f.root, "pin-package");
  cpSync(f.themeDir, candidate, { recursive: true });
  const manifestPath = join(candidate, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = "1.99.0";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(
    join(candidate, "templates", "page-default.liquid"),
    readFileSync(template, "utf8").replace("BEFORE_PIN", "AFTER_PIN"),
  );
  const updating = server.inject({
    method: "POST",
    url: "/api/v1/themes/active/update",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: await pack(candidate),
  });
  await Promise.race([
    enteredConfirm,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("update did not reach confirmation")), 3000),
    ),
  ]);
  const blocked = await otherServer.inject({ method: "GET", url: "/pin/" });
  assert.equal(blocked.statusCode, 503, blocked.body);
  releaseRead();
  const oldResponse = await inflight;
  assert.match(oldResponse.body, /BEFORE_PIN/);
  assert.doesNotMatch(oldResponse.body, /AFTER_PIN/);
  releaseConfirm();
  const updated = await updating;
  assert.equal(updated.statusCode, 200, updated.body);
  assert.match((await otherServer.inject({ method: "GET", url: "/pin/" })).body, /AFTER_PIN/);
});

test("failed restore callback cannot leave an unregistered same-id renderer after journal compensation", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  await page(f.app, f.ctx, "/restore-fault/");
  let failFinal = false;
  const pool = {
    ...f.pool,
    async withClient<T>(work: (db: import("@pcms/core").DbClient) => Promise<T>): Promise<T> {
      return f.pool.withClient((db) =>
        work({
          ...db,
          async query<Row extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[],
          ) {
            if (failFinal && sql.includes("theme_generation=theme_generation+1")) {
              failFinal = false;
              throw new Error("INJECTED_FINAL_WRITE");
            }
            return db.query<Row>(sql, params);
          },
        }),
      );
    },
  };
  const app = createApplicationServices({ ...f.input, pool });
  const server = await f.boot(app);
  const saved = await server.inject({
    method: "PUT",
    url: "/api/v1/theme/settings",
    headers: f.headers,
    payload: { expected_generation: 0, values: { footer_text: "CONFIRMED_SOURCE" } },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  await server.inject({ method: "GET", url: "/restore-fault/" });
  const prepare = app.themeRuntime.prepareState;
  assert.ok(prepare);
  let prepared = 0;
  app.themeRuntime.prepareState = async (...args) => {
    const apply = await prepare(...args);
    prepared++;
    return prepared === 2
      ? () => {
          throw new Error("INJECTED_RESTORE_CALLBACK");
        }
      : apply;
  };
  const candidate = join(f.root, "restore-fault-package");
  cpSync(f.themeDir, candidate, { recursive: true });
  const manifestPath = join(candidate, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const oldVersion = manifest.version;
  manifest.version = "1.99.0";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const template = join(candidate, "templates", "page-default.liquid");
  writeFileSync(template, `${readFileSync(template, "utf8")}<p>BAD_RESTORE_TARGET</p>`);
  failFinal = true;
  const failed = await server.inject({
    method: "POST",
    url: "/api/v1/themes/active/update",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: await pack(candidate),
  });
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.json().error.details[0].phase, "RESTORE");
  assert.equal(
    (await f.pool.query("SELECT pending_operation_id FROM admin_theme_state")).rows[0]
      ?.pending_operation_id,
    null,
  );
  const repaired = await server.inject({ method: "GET", url: "/restore-fault/" });
  assert.equal(repaired.statusCode, 200, repaired.body);
  assert.doesNotMatch(repaired.body, /BAD_RESTORE_TARGET/);
  assert.match(repaired.body, /CONFIRMED_SOURCE/);
  assert.equal(app.themeRuntime.served?.().version, oldVersion);
});

test("retained theme rollback restores HTML/settings/assets, keeps five revisions, and preserves installed head on failure", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  let failConfirm = false;
  let failCleanup = false;
  const pool: import("@pcms/core").DbPool = {
    ...f.pool,
    async withClient(work) {
      return f.pool.withClient((db) =>
        work({
          ...db,
          async query<Row extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[],
          ) {
            if (failConfirm && sql.includes("theme_generation=theme_generation+1")) {
              failConfirm = false;
              throw new Error("INJECTED_CONFIRM_FAILURE");
            }
            if (failCleanup && sql.startsWith("DELETE FROM theme_revisions")) {
              failCleanup = false;
              throw new Error("INJECTED_GC_FAILURE");
            }
            return db.query<Row>(sql, params);
          },
        }),
      );
    },
  };
  const app = createApplicationServices({ ...f.input, pool });
  await page(app, f.ctx, "/history/");
  const server = await f.boot(app);
  const active = async () =>
    (
      await server.inject({ method: "GET", url: "/api/v1/themes/active", headers: f.headers })
    ).json();
  const rollback = async (id: string) =>
    server.inject({
      method: "POST",
      url: "/api/v1/themes/rollback",
      headers: f.headers,
      payload: { revision_id: id, expected_generation: (await active()).theme_generation },
    });
  const save = await server.inject({
    method: "PUT",
    url: "/api/v1/theme/settings",
    headers: f.headers,
    payload: { expected_generation: 0, values: { footer_text: "OLD_SETTINGS" } },
  });
  assert.equal(save.statusCode, 200, save.body);
  const old = await active();
  const oldHtml = await server.inject({ method: "GET", url: "/history/" });
  const oldCssUrl = `/themes/reference-theme-v1/revisions/${old.revision_id}/assets/css/theme.css`;
  assert.ok(oldHtml.body.includes(oldCssUrl));
  const oldCss = await server.inject({ method: "GET", url: oldCssUrl });
  assert.equal(oldCss.statusCode, 200, oldCss.body);
  assert.match(String(oldCss.headers["cache-control"]), /immutable/);
  const before = await Promise.all(
    ["entries", "revisions", "publications", "routes"].map(
      async (table) =>
        (
          await f.pool.query(
            `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
          )
        ).rows,
    ),
  );
  const orphan = snapshotThemeFiles(f.themeDir, f.themeDir);
  const orphanId = randomUUID();
  await f.pool.query(
    "INSERT INTO theme_revisions(id,site_key,theme_key,package_version,file_sha256,storage_key,settings) VALUES($1,'default','reference-theme-v1','0.0.0',$2,$3,'{}')",
    [orphanId, orphan.sha256, orphan.storageKey],
  );
  failCleanup = true;
  async function update(version: string, marker: string) {
    const dir = join(f.root, `candidate-${version}`);
    cpSync(f.themeDir, dir, { recursive: true });
    const path = join(dir, "theme.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = version;
    writeFileSync(path, JSON.stringify(manifest));
    const template = join(dir, "templates", "page-default.liquid");
    writeFileSync(template, `${readFileSync(template, "utf8")}<p>${marker}</p>`);
    writeFileSync(join(dir, "assets", "css", "theme.css"), `/* ${marker} */ body{color:red}`);
    writeFileSync(join(dir, "assets", "js", "theme.js"), `/* ${marker} */`);
    return server.inject({
      method: "POST",
      url: "/api/v1/themes/active/update",
      headers: { ...f.headers, "content-type": "application/octet-stream" },
      payload: await pack(dir),
    });
  }
  for (let i = 1; i <= 5; i++) {
    const changed = await update(`9.0.${i}`, `NEW_${i}`);
    assert.equal(changed.statusCode, 200, changed.body);
  }
  assert.equal(failCleanup, false);
  assert.equal(existsSync(orphan.dir), false);
  assert.equal(
    (await f.pool.query("SELECT count(*)::int AS n FROM theme_revisions WHERE id=$1", [orphanId]))
      .rows[0]?.n,
    0,
  );
  const newer = await active();
  const list = (
    await server.inject({ method: "GET", url: "/api/v1/themes/revisions", headers: f.headers })
  ).json();
  assert.ok(list.revisions.length >= 7);
  assert.equal(list.theme_generation, newer.theme_generation);
  assert.equal(list.revisions.filter((r: { active: boolean }) => r.active).length, 1);
  assert.ok(!JSON.stringify(list).includes("storage_key"));
  const newerCss = await server.inject({
    method: "GET",
    url: `/themes/reference-theme-v1/revisions/${newer.revision_id}/assets/css/theme.css`,
  });
  assert.match(newerCss.body, /NEW_5/);
  assert.notEqual(newerCss.headers.etag, oldCss.headers.etag);
  assert.equal((await rollback(old.revision_id)).statusCode, 200);
  const restoredHtml = await server.inject({ method: "GET", url: "/history/" });
  assert.ok(restoredHtml.body.includes(oldCssUrl));
  assert.match(restoredHtml.body, /OLD_SETTINGS/);
  assert.doesNotMatch(restoredHtml.body, /NEW_5/);
  const alias = await server.inject({
    method: "GET",
    url: "/themes/reference-theme-v1/assets/css/theme.css",
    headers: { "if-none-match": String(newerCss.headers.etag) },
  });
  assert.equal(alias.statusCode, 200);
  assert.equal(alias.body, oldCss.body);
  assert.equal(alias.headers.etag, oldCss.headers.etag);
  assert.equal(alias.headers["cache-control"], "no-cache");
  assert.equal(
    (
      await server.inject({
        method: "GET",
        url: oldCssUrl,
        headers: { "if-none-match": String(oldCss.headers.etag) },
      })
    ).statusCode,
    304,
  );
  assert.match(
    (
      await server.inject({
        method: "GET",
        url: `/themes/reference-theme-v1/revisions/${newer.revision_id}/assets/js/theme.js`,
      })
    ).body,
    /NEW_5/,
  );
  const head = () => JSON.parse(readFileSync(join(f.themeDir, "theme.json"), "utf8")).version;
  assert.equal(head(), "9.0.5");
  const duplicate = await update("9.0.5", "DUPLICATE");
  assert.equal(duplicate.statusCode, 409);
  failConfirm = true;
  const failed = await update("9.0.6", "BAD_TARGET");
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(head(), "9.0.5");
  assert.equal((await active()).revision_id, old.revision_id);
  assert.doesNotMatch(
    (await server.inject({ method: "GET", url: "/history/" })).body,
    /BAD_TARGET|NEW_5/,
  );
  const reselected = await rollback(newer.revision_id);
  assert.equal(reselected.statusCode, 200, reselected.body);
  assert.match((await server.inject({ method: "GET", url: "/history/" })).body, /NEW_5/);
  const other = join(f.root, "other-theme");
  cpSync("themes/reference-theme-v1", other, { recursive: true });
  const otherPath = join(other, "theme.json");
  const otherManifest = JSON.parse(readFileSync(otherPath, "utf8"));
  otherManifest.id = "other-theme";
  writeFileSync(otherPath, JSON.stringify(otherManifest));
  const installed = await server.inject({
    method: "POST",
    url: "/api/v1/themes/install",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: await pack(other),
  });
  assert.equal(installed.statusCode, 201, installed.body);
  const activated = await server.inject({
    method: "POST",
    url: "/api/v1/theme/activate",
    headers: f.headers,
    payload: { theme_key: "other-theme" },
  });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal((await active()).id, "other-theme");
  assert.equal((await rollback(old.revision_id)).statusCode, 200);
  assert.equal((await active()).id, "reference-theme-v1");
  const after = await Promise.all(
    ["entries", "revisions", "publications", "routes"].map(
      async (table) =>
        (
          await f.pool.query(
            `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
          )
        ).rows,
    ),
  );
  assert.deepEqual(after, before);
  const restarted = createApplicationServices({ ...f.input, pool: f.pool });
  const again = await f.boot(restarted);
  assert.equal(restarted.themeRuntime.served?.().revision_id, old.revision_id);
  assert.ok((await again.inject({ method: "GET", url: "/history/" })).body.includes(oldCssUrl));
});

test("theme rollback API/CLI enforces permissions, site scope and generation CAS", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  const server = await f.boot();
  const saved = await server.inject({
    method: "PUT",
    url: "/api/v1/theme/settings",
    headers: f.headers,
    payload: { expected_generation: 0, values: { footer_text: "FIRST" } },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const first = f.app.themeRuntime.served!();
  assert.ok(first.revision_id);
  const { themeUpdateCommand } = await import("../../packages/cli/src/commands/theme-update.js");
  const tokenHeader = f.headers.authorization;
  const env = {
    ...process.env,
    PCMS_API_URL: server.listeningOrigin,
    PCMS_API_TOKEN: tokenHeader.slice(7),
    PCMS_SITE_KEY: "default",
    PCMS_ENVIRONMENT: "production",
  };
  const options = { json: true, yes: true, environment: "production", site: "default" };
  const listed = await themeUpdateCommand({ args: ["revisions"], options, env });
  assert.equal(listed.exitCode, 0, listed.stderr);
  const history = JSON.parse(listed.stdout);
  assert.equal(history.active_revision_id, first.revision_id);
  const rolled = await themeUpdateCommand({
    args: ["rollback", first.revision_id, "--expected-generation", String(first.theme_generation)],
    options,
    env,
  });
  assert.equal(rolled.exitCode, 0, rolled.stdout + rolled.stderr);
  const body = {
    revision_id: first.revision_id,
    expected_generation: f.app.themeRuntime.served!().theme_generation,
  };
  const stale = await server.inject({
    method: "POST",
    url: "/api/v1/themes/rollback",
    headers: f.headers,
    payload: { ...body, expected_generation: 0 },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "THEME_REVISION_STALE");
  const missing = await server.inject({
    method: "POST",
    url: "/api/v1/themes/rollback",
    headers: f.headers,
    payload: { ...body, revision_id: randomUUID() },
  });
  assert.equal(missing.statusCode, 404);
  const limited = await f.app.machineIdentity.createAccessToken({
    serviceAccountId: f.account.id,
    scopes: ["theme.read"],
    siteKey: "default",
    environment: "production",
    ttlMilliseconds: 3600000,
  });
  const denied = await server.inject({
    method: "POST",
    url: "/api/v1/themes/rollback",
    headers: { ...f.headers, authorization: `Bearer ${limited.rawSecret}` },
    payload: body,
  });
  assert.equal(denied.statusCode, 403);
  const alien = await f.app.machineIdentity.createAccessToken({
    serviceAccountId: f.account.id,
    scopes: ["theme.read", "theme.write", "theme.activate"],
    siteKey: "alien",
    environment: "production",
    ttlMilliseconds: 3600000,
  });
  for (const request of [
    { method: "GET" as const, url: "/api/v1/themes/revisions" },
    { method: "POST" as const, url: "/api/v1/themes/rollback", payload: body },
  ]) {
    const response = await server.inject({
      ...request,
      headers: { ...f.headers, authorization: `Bearer ${alien.rawSecret}`, "x-pcms-site": "alien" },
    });
    assert.equal(response.statusCode, 403, response.body);
  }
  for (const path of [
    `/themes/other-theme/revisions/${first.revision_id}/assets/css/theme.css`,
    `/themes/reference-theme-v1/revisions/${randomUUID()}/assets/css/theme.css`,
    `/themes/reference-theme-v1/revisions/${first.revision_id}/templates/page-default.liquid`,
    `/themes/reference-theme-v1/revisions/${first.revision_id}/assets/%2e%2e/theme.json`,
  ]) {
    assert.equal((await server.inject({ method: "GET", url: path })).statusCode, 404, path);
  }
  const unsafe = await themeUpdateCommand({
    args: ["rollback", first.revision_id, "--expected-generation", "1"],
    options: { json: true, yes: false },
    env,
  });
  assert.equal(unsafe.exitCode, 2);
});

test("retained revisions keep CMS compatibility guards on rollback and fresh Web composition", {
  skip,
}, async (t) => {
  const f = await fixture(t);
  const server = await f.boot();
  const candidate = join(f.root, "strict-theme");
  cpSync(f.themeDir, candidate, { recursive: true });
  const file = join(candidate, "theme.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.id = "strict-theme";
  manifest.cms_compatibility = "<2.0.0";
  writeFileSync(file, JSON.stringify(manifest));
  const installed = await server.inject({
    method: "POST",
    url: "/api/v1/themes/install",
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: await pack(candidate),
  });
  assert.equal(installed.statusCode, 201, installed.body);
  const activate = async (theme_key: string) =>
    server.inject({
      method: "POST",
      url: "/api/v1/theme/activate",
      headers: f.headers,
      payload: { theme_key },
    });
  assert.equal((await activate("strict-theme")).statusCode, 200);
  const strict = f.app.themeRuntime.served!();
  assert.ok(strict.revision_id);
  const incompatible = createApplicationServices({ ...f.input, pool: f.pool, cmsVersion: "2.0.0" });
  const bad = createApiFastify(() => "retained-compatibility");
  t.after(() => bad.close());
  await assert.rejects(
    registerSiteRoute(bad, { application: incompatible }),
    (error: { code?: string }) => error.code === "THEME_PACKAGE_INVALID",
  );
  assert.equal((await activate("reference-theme-v1")).statusCode, 200);
  const newer = createApplicationServices({ ...f.input, pool: f.pool, cmsVersion: "2.0.0" });
  const fresh = await f.boot(newer);
  const state = newer.themeRuntime.served!();
  const denied = await fresh.inject({
    method: "POST",
    url: "/api/v1/themes/rollback",
    headers: f.headers,
    payload: { revision_id: strict.revision_id, expected_generation: state.theme_generation },
  });
  assert.equal(denied.statusCode, 422, denied.body);
  assert.equal(denied.json().error.code, "THEME_PACKAGE_INVALID");
  assert.equal(newer.themeRuntime.served!().revision_id, state.revision_id);
});
