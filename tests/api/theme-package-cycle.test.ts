// CORE-THEME-REMOTE-PACKAGE-CYCLE — focused acceptance on the existing test
// database (private rollback schema) and the real transports.
//
// The cycle under test: export the SERVED theme → edit it on the "agent"
// machine → upload → validate → apply with lifecycle CAS → roll back. Every
// step runs the real Fastify handlers and the shared application operations;
// no stub McpOperations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ApiRoute,
  authenticateRequest,
  createApiFastify,
  createApiV1,
  createDraft,
  makeMutationRoutes,
  makeThemeManageRoutes,
  publishRevision,
  sealRevision,
  setEntryTemplateOp,
} from "@pcms/api";
import { createLogger } from "@pcms/core";
import yauzl from "yauzl";
import yazl from "yazl";
import { registerSiteRoute } from "../../apps/web/src/site.js";
import { registerThemeFilesRoute } from "../../apps/web/src/theme-files.js";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const skip = testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL is not set";
const THEME_ID = "reference-theme-v1";
const NEXT_VERSION = "9.9.9";

const PAGE_TYPE = {
  key: "page",
  version: 1,
  title: "Page",
  bodyPolicy: "block_document",
  fields: { title: { id: "title", type: "string", required: true } },
};

async function readZip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || zip === undefined) {
        reject(error ?? new Error("unreadable zip"));
        return;
      }
      const out = new Map<string, Buffer>();
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || stream === undefined) {
            reject(streamError ?? new Error("unreadable entry"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

async function writeZip(files: ReadonlyMap<string, Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const name of [...files.keys()].sort()) zip.addBuffer(files.get(name)!, name);
  zip.end();
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

/** The "agent machine": unpack, edit files, bump the version, repack. */
async function editPackage(
  bytes: Buffer,
  edits: Readonly<Record<string, string | Buffer>>,
  version: string,
): Promise<Buffer> {
  const files = await readZip(bytes);
  const manifest = JSON.parse(files.get("theme.json")!.toString("utf8")) as Record<string, unknown>;
  manifest.version = version;
  files.set("theme.json", Buffer.from(JSON.stringify(manifest, null, 2)));
  for (const [name, content] of Object.entries(edits)) {
    files.set(name, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  }
  return await writeZip(files);
}

async function cycleFixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pcms-theme-cycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = join(root, "themes", THEME_ID);
  cpSync(join(process.cwd(), "themes", THEME_ID), themeDir, { recursive: true });
  const manifestPath = join(themeDir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.cms_compatibility = ">=1.0.0-rc.1 <2.0.0";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // The theme lifecycle issues its own BEGIN/COMMIT (journal + recovery), so
  // the fixture must give it a real private schema and real commits.
  const { app } = await rollbackApiFixture(
    t,
    { themeDir, contentTypeDefinitions: [PAGE_TYPE] as never },
    { transactionMode: "committed" },
  );
  const fastify = createApiFastify(() => "req_theme_cycle");
  const routes: ApiRoute[] = [...makeThemeManageRoutes(), ...makeMutationRoutes()];
  await fastify.register(createApiV1(routes), {
    application: app,
    logger: createLogger({ level: "error", base: {} }),
    cookieSecure: false,
  });
  await registerSiteRoute(fastify, { application: app });
  registerThemeFilesRoute(fastify, { renderDir: themeDir, application: app });
  // The MCP transport exactly as production mounts it: JSON-RPC over POST
  // /mcp with bearer auth, inside the same request hook that pins the theme.
  const { bindOperations } = await import("@pcms/api");
  const { createMcpServer } = await import("@pcms/mcp");
  const mcp = createMcpServer({
    operations: bindOperations(app) as never,
    serverInfo: { name: "progressive-cms-mcp", version: "1.0.0" },
  });
  fastify.post("/mcp", { bodyLimit: 1_048_576 }, async (request, reply) => {
    const auth = await authenticateRequest(app, request, { cookieSecure: false });
    if (auth === null || auth.via !== "bearer") {
      void reply.status(401).send({ error: { code: "AUTH_UNAUTHENTICATED" } });
      return reply;
    }
    const response = await mcp.handleRequest(request.body, () => ({
      actor: auth.actor,
      transport: "mcp",
      requestId: request.id,
    }));
    void reply.send(response);
    return reply;
  });
  await fastify.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => {
    void fastify.close();
  });
  const address = fastify.server.address();
  assert.ok(address !== null && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const ctx = apiContextOf(ownerActor("theme-cycle"));

  const account = await app.machineIdentity.createServiceAccount({
    name: "theme-agent",
    purpose: "remote theme package cycle",
  });
  const scopes = ["theme.read", "theme.write", "theme.validate", "theme.activate"];
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes,
    ttlMilliseconds: 3_600_000,
    siteKey: "default",
    environment: "production",
  });
  const headers = {
    authorization: `Bearer ${token.rawSecret}`,
    "x-pcms-site": "default",
    "x-pcms-environment": "production",
  };
  return { app, fastify, baseUrl, ctx, headers, themeDir, root, account };
}

type Fixture = Awaited<ReturnType<typeof cycleFixture>>;

async function call(
  fixture: Fixture,
  method: "GET" | "POST",
  url: string,
  body?: Buffer | unknown,
): Promise<{ status: number; json: () => Record<string, unknown>; bytes: () => Buffer }> {
  const response = await fixture.fastify.inject({
    method,
    url,
    headers: {
      ...fixture.headers,
      ...(body === undefined
        ? {}
        : {
            "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json",
          }),
    },
    ...(body === undefined ? {} : { payload: body as never }),
  });
  return {
    status: response.statusCode,
    json: () => response.json() as Record<string, unknown>,
    bytes: () => response.rawPayload,
  };
}

async function publishPage(fixture: Fixture): Promise<string> {
  const { app, ctx } = fixture;
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: {
      fields: { title: "Cycle page" },
      blocks: {
        schema_version: 1,
        blocks: [
          {
            id: "01980000-0000-7000-8000-000000000101",
            type: "text",
            schema_version: 1,
            variant: null,
            props: {
              rich_text: {
                schema_version: 2,
                type: "document",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Cycle body" }] }],
              },
            },
            children: [],
          },
        ],
      },
    },
  });
  await setEntryTemplateOp(app, ctx, { entry_id: draft.entry_id, template_key: "page-default" });
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
    path: "/cycle/",
    targetType: "entry",
    targetId: draft.entry_id,
  });
  return draft.entry_id;
}

test("export: served source descriptor, deterministic digest and bootstrap without writes", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const { app } = fixture;
  const before = await app.pool.query<{ revisions: string; state: string }>(
    `SELECT (SELECT count(*) FROM theme_revisions) AS revisions,
            (SELECT count(*) FROM admin_theme_state) AS state`,
  );

  const descriptor = await call(fixture, "GET", "/api/v1/themes/source");
  assert.equal(descriptor.status, 200);
  const body = descriptor.json() as {
    theme_id: string;
    served_version: string;
    installed_head_version: string | null;
    revision_id: string | null;
    theme_generation: number;
    package_sha256: string;
    size_bytes: number;
    download_path: string;
  };
  assert.equal(body.theme_id, THEME_ID);
  assert.equal(body.served_version, "1.2.3");
  assert.equal(body.revision_id, null, "bootstrap: no lifecycle mutation yet");
  assert.equal(body.theme_generation, 0);
  assert.match(body.package_sha256, /^[0-9a-f]{64}$/);
  assert.equal(body.download_path, "/api/v1/themes/source/package?expected_generation=0");

  // Export is READ-ONLY: no baseline, no generation bump.
  const after = await app.pool.query<{ revisions: string; state: string }>(
    `SELECT (SELECT count(*) FROM theme_revisions) AS revisions,
            (SELECT count(*) FROM admin_theme_state) AS state`,
  );
  assert.deepEqual(after.rows[0], before.rows[0]);

  const download = await call(
    fixture,
    "GET",
    `/api/v1/themes/source/package?expected_generation=${body.theme_generation}`,
  );
  assert.equal(download.status, 200);
  const bytes = download.bytes();
  assert.equal(bytes.length, body.size_bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), body.package_sha256);

  // Determinism: an unchanged basis produces the identical archive digest.
  const again = await call(
    fixture,
    "GET",
    `/api/v1/themes/source/package?expected_generation=${body.theme_generation}`,
  );
  assert.equal(createHash("sha256").update(again.bytes()).digest("hex"), body.package_sha256);

  // The archive is a real package: manifest at the root, binary assets kept,
  // service state excluded.
  const files = await readZip(bytes);
  assert.ok(files.has("theme.json"));
  assert.ok(files.has("templates/page-default.liquid"));
  assert.ok(files.has("assets/css/theme.css"));
  for (const name of files.keys()) {
    assert.ok(!name.startsWith("."), `service file leaked into the archive: ${name}`);
    assert.ok(!name.includes(".pcms-"), `receipt leaked into the archive: ${name}`);
  }

  // A stale generation never returns another basis.
  const stale = await call(fixture, "GET", "/api/v1/themes/source/package?expected_generation=7");
  assert.equal(stale.status, 409);
  assert.equal((stale.json() as { error: { code: string } }).error.code, "THEME_REVISION_STALE");

  // A theme the process does not serve cannot be exported at all: a symlink in
  // the served directory is refused instead of silently dropping its target.
  symlinkSync("/etc/passwd", join(fixture.themeDir, "templates", "escape.liquid"));
  const refused = await call(
    fixture,
    "GET",
    `/api/v1/themes/source/package?expected_generation=${body.theme_generation}`,
  );
  assert.equal(refused.status, 409);
  assert.equal(
    (refused.json() as { error: { code: string } }).error.code,
    "THEME_EXPORT_UNSUPPORTED",
  );
});

test("store: foreign actor, expiry, corruption and empty uploads are refused", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const { app } = fixture;
  const exportDescriptor = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    theme_generation: number;
  };
  const bytes = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${exportDescriptor.theme_generation}`,
    )
  ).bytes();

  const empty = await call(fixture, "POST", "/api/v1/themes/packages", Buffer.alloc(0));
  assert.equal(empty.status, 400);

  const uploaded = await call(fixture, "POST", "/api/v1/themes/packages", bytes);
  assert.equal(uploaded.status, 201);
  const staged = uploaded.json() as { package_ref: string; sha256: string; expires_at: string };
  assert.match(staged.package_ref, /^[0-9a-f-]{36}$/);
  assert.equal(staged.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(Date.parse(staged.expires_at) > Date.now());

  // A ref is not a capability: another actor's ref is indistinguishable from a
  // missing one.
  const other = await app.machineIdentity.createServiceAccount({
    name: "other-agent",
    purpose: "x",
  });
  const otherToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: other.id,
    scopes: ["theme.read", "theme.write", "theme.validate"],
    ttlMilliseconds: 3_600_000,
    siteKey: "default",
    environment: "production",
  });
  const foreign = await fixture.fastify.inject({
    method: "POST",
    url: `/api/v1/themes/packages/${staged.package_ref}/validate`,
    headers: {
      authorization: `Bearer ${otherToken.rawSecret}`,
      "x-pcms-site": "default",
      "x-pcms-environment": "production",
    },
  });
  assert.equal(foreign.statusCode, 404);

  // Corrupted bytes are refused instead of applied.
  const storeDir = join(fixture.root, "themes", ".pcms-theme-packages");
  writeFileSync(join(storeDir, `${staged.package_ref}.pcTheme`), Buffer.from("not a zip"));
  const corrupt = await call(
    fixture,
    "POST",
    `/api/v1/themes/packages/${staged.package_ref}/validate`,
  );
  assert.equal(corrupt.status, 409);
  assert.equal((corrupt.json() as { error: { code: string } }).error.code, "THEME_PACKAGE_CORRUPT");

  // Expired refs disappear (the TTL is fixed and documented).
  const reuploaded = (await call(fixture, "POST", "/api/v1/themes/packages", bytes)).json() as {
    package_ref: string;
  };
  const receiptPath = join(storeDir, `${reuploaded.package_ref}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.expires_at = new Date(Date.now() - 1000).toISOString();
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const expired = await call(
    fixture,
    "POST",
    `/api/v1/themes/packages/${reuploaded.package_ref}/validate`,
  );
  assert.equal(expired.status, 404);
  assert.equal(
    (expired.json() as { error: { code: string } }).error.code,
    "THEME_PACKAGE_NOT_FOUND",
  );
});

test("validation and apply: remote edit reaches the live HTML, CAS protects the basis", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const { app } = fixture;
  await publishPage(fixture);
  // A theme setting that must survive the update.
  await app.pool.query(
    `UPDATE admin_theme_state SET settings = '{"primary_color":"#123456"}'::jsonb WHERE site_key = $1`,
    [app.defaultSiteKey],
  );

  const before = await fixture.fastify.inject({ method: "GET", url: "/cycle/" });
  assert.equal(before.statusCode, 200);
  assert.doesNotMatch(before.body, /data-cycle="updated"/);

  const source = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    theme_generation: number;
    package_sha256: string;
  };
  const exported = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${source.theme_generation}`,
    )
  ).bytes();
  // Agent machine: Liquid, CSS, a binary asset and a version bump.
  const edited = await editPackage(
    exported,
    {
      "blocks/text.liquid":
        '<div class="block block-text" data-cycle="updated">{{ block.props.rich_text }}</div>',
      "assets/css/theme.css": `${readFileSync(join(fixture.themeDir, "assets/css/theme.css"), "utf8")}\n.cycle-marker{color:#c0ffee}`,
      "assets/img/cycle-marker.png": Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001",
        "hex",
      ),
    },
    NEXT_VERSION,
  );

  const staged = (await call(fixture, "POST", "/api/v1/themes/packages", edited)).json() as {
    package_ref: string;
  };
  const validated = await call(
    fixture,
    "POST",
    `/api/v1/themes/packages/${staged.package_ref}/validate`,
  );
  assert.equal(validated.status, 200);
  const validatedBody = validated.json() as {
    theme: { id: string; version: string };
    render_stack: string;
    active_theme_unchanged: boolean;
  };
  assert.equal(validatedBody.theme.id, THEME_ID);
  assert.equal(validatedBody.theme.version, NEXT_VERSION);
  assert.equal(validatedBody.render_stack, "ok");
  assert.equal(validatedBody.active_theme_unchanged, true);
  // Validation touched nothing.
  const stillServed = (await call(fixture, "GET", "/api/v1/themes/active")).json() as {
    version: string;
  };
  assert.equal(stillServed.version, "1.2.3");

  // An invalid package is refused with a typed error and changes nothing.
  const brokenFiles = await readZip(edited);
  // Broken manifest: the package gate must refuse it, not just fail at render.
  brokenFiles.set("theme.json", Buffer.from("{ not json"));
  const broken = await call(
    fixture,
    "POST",
    "/api/v1/themes/packages",
    await writeZip(brokenFiles),
  );
  const brokenValidate = await call(
    fixture,
    "POST",
    `/api/v1/themes/packages/${(broken.json() as { package_ref: string }).package_ref}/validate`,
  );
  // Typed package refusal (same code/status family as the installer), never a
  // 500 and never a partial apply.
  assert.equal(
    (brokenValidate.json() as { error: { code: string } }).error.code,
    "THEME_PACKAGE_INVALID",
  );
  assert.ok(brokenValidate.status >= 400 && brokenValidate.status < 500);
  assert.equal((await call(fixture, "GET", "/api/v1/themes/active")).json().version, "1.2.3");

  // Two agents hold the same basis; the first applies, the second is stale.
  const secondStaged = (await call(fixture, "POST", "/api/v1/themes/packages", edited)).json() as {
    package_ref: string;
  };
  const first = await call(fixture, "POST", "/api/v1/themes/active/update", {
    package_ref: staged.package_ref,
    expected_generation: source.theme_generation,
  });
  assert.equal(first.status, 200);
  const served = (first.json() as { served: { version: string; theme_generation: number } }).served;
  assert.equal(served.version, NEXT_VERSION);
  assert.equal(served.theme_generation, source.theme_generation + 1);

  const stale = await call(fixture, "POST", "/api/v1/themes/active/update", {
    package_ref: secondStaged.package_ref,
    expected_generation: source.theme_generation,
  });
  assert.equal(stale.status, 409);
  assert.equal((stale.json() as { error: { code: string } }).error.code, "THEME_REVISION_STALE");
  assert.equal((await call(fixture, "GET", "/api/v1/themes/active")).json().version, NEXT_VERSION);

  // The live site changed without a restart; settings survived.
  const after = await fixture.fastify.inject({ method: "GET", url: "/cycle/" });
  assert.equal(after.statusCode, 200);
  assert.match(after.body, /data-cycle="updated"/);
  const settings = await app.pool.query<{ settings: Record<string, unknown> }>(
    "SELECT settings FROM admin_theme_state WHERE site_key = $1",
    [app.defaultSiteKey],
  );
  assert.equal(settings.rows[0]!.settings.primary_color, "#123456");
  // Assets (CSS + binary) are served from the new basis.
  const css = await fixture.fastify.inject({
    method: "GET",
    url: `/themes/${THEME_ID}/assets/css/theme.css`,
  });
  assert.equal(css.statusCode, 200);
  assert.match(css.body, /cycle-marker/);
  const png = await fixture.fastify.inject({
    method: "GET",
    url: `/themes/${THEME_ID}/assets/img/cycle-marker.png`,
  });
  assert.equal(png.statusCode, 200);
  assert.equal(png.rawPayload.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  // After the update the descriptor reports the served (new) basis while the
  // installed head is the same package: a further update must still be newer.
  const postUpdate = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    served_version: string;
    revision_id: string | null;
    theme_generation: number;
    installed_head_version: string | null;
  };
  assert.equal(postUpdate.served_version, NEXT_VERSION);
  assert.ok(postUpdate.revision_id !== null);
  assert.equal(postUpdate.theme_generation, served.theme_generation);
  assert.equal(postUpdate.installed_head_version, NEXT_VERSION);

  // The exported archive of the UPDATED basis carries no service receipt.
  const reexport = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${postUpdate.theme_generation}`,
    )
  ).bytes();
  for (const name of (await readZip(reexport)).keys()) {
    assert.ok(!name.includes(".pcms-"), `receipt leaked after update: ${name}`);
  }

  // Rollback through the same CAS restores the previous basis.
  const revisions = (await call(fixture, "GET", "/api/v1/themes/revisions")).json() as {
    revisions: { revision_id: string; package_version: string; active: boolean }[];
  };
  const original = revisions.revisions.find((row) => row.package_version === "1.2.3");
  assert.ok(original);
  const rolledBack = await call(fixture, "POST", "/api/v1/themes/rollback", {
    revision_id: original.revision_id,
    expected_generation: postUpdate.theme_generation,
  });
  assert.equal(rolledBack.status, 200);
  const restored = await fixture.fastify.inject({ method: "GET", url: "/cycle/" });
  assert.doesNotMatch(restored.body, /data-cycle="updated"/);
});

test("compatibility: old raw update without CAS, install never activates, write-only denied", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const { app } = fixture;
  const source = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    theme_generation: number;
  };
  const exported = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${source.theme_generation}`,
    )
  ).bytes();
  const updated = await editPackage(
    exported,
    { "blocks/text.liquid": '<div data-cycle="raw">{{ block.props.rich_text }}</div>' },
    "2.0.0",
  );

  // 1. The historical raw-body update keeps working without a CAS parameter.
  const raw = await call(fixture, "POST", "/api/v1/themes/active/update", updated);
  assert.equal(raw.status, 200);
  assert.equal((raw.json() as { version: string }).version, "2.0.0");

  // 2. A write-only actor cannot replace the active theme (activate is separate).
  const writer = await app.machineIdentity.createServiceAccount({
    name: "theme-writer",
    purpose: "no activate",
  });
  const writerToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: writer.id,
    scopes: ["theme.read", "theme.write", "theme.validate"],
    ttlMilliseconds: 3_600_000,
    siteKey: "default",
    environment: "production",
  });
  const staged = (await call(fixture, "POST", "/api/v1/themes/packages", exported)).json() as {
    package_ref: string;
  };
  const denied = await fixture.fastify.inject({
    method: "POST",
    url: "/api/v1/themes/active/update",
    headers: {
      authorization: `Bearer ${writerToken.rawSecret}`,
      "x-pcms-site": "default",
      "x-pcms-environment": "production",
    },
    payload: { package_ref: staged.package_ref, expected_generation: 1 },
  });
  assert.equal(denied.statusCode, 403);

  // 3. Install of a DIFFERENT theme id stays a candidate and never activates.
  const other = await editPackage(exported, {}, "1.0.0");
  const otherFiles = await readZip(other);
  const otherManifest = JSON.parse(otherFiles.get("theme.json")!.toString("utf8")) as Record<
    string,
    unknown
  >;
  otherManifest.id = "cycle-candidate";
  otherFiles.set("theme.json", Buffer.from(JSON.stringify(otherManifest)));
  const candidate = await call(
    fixture,
    "POST",
    "/api/v1/themes/packages",
    await writeZip(otherFiles),
  );
  const installed = await call(fixture, "POST", "/api/v1/themes/install", {
    package_ref: (candidate.json() as { package_ref: string }).package_ref,
  });
  assert.equal(installed.status, 201);
  assert.equal((installed.json() as { activated: boolean }).activated, false);
  assert.equal((await call(fixture, "GET", "/api/v1/themes/active")).json().version, "2.0.0");

  // 4. Invalid CAS numbers are input errors, never a silent default.
  const badGeneration = await call(fixture, "POST", "/api/v1/themes/active/update", {
    package_ref: staged.package_ref,
    expected_generation: -1,
  });
  assert.equal(badGeneration.status, 400);
});

test("export after rollback reports the SERVED basis and the installed head separately", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const source = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    theme_generation: number;
  };
  const exported = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${source.theme_generation}`,
    )
  ).bytes();
  const staged = (
    await call(fixture, "POST", "/api/v1/themes/packages", await editPackage(exported, {}, "9.9.9"))
  ).json() as { package_ref: string };
  const applied = await call(fixture, "POST", "/api/v1/themes/active/update", {
    package_ref: staged.package_ref,
    expected_generation: source.theme_generation,
  });
  assert.equal(applied.status, 200);
  const afterApply = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    theme_generation: number;
  };
  const revisions = (await call(fixture, "GET", "/api/v1/themes/revisions")).json() as {
    revisions: { revision_id: string; package_version: string }[];
  };
  const original = revisions.revisions.find((row) => row.package_version === "1.2.3");
  assert.ok(original);
  const rollback = await call(fixture, "POST", "/api/v1/themes/rollback", {
    revision_id: original.revision_id,
    expected_generation: afterApply.theme_generation,
  });
  assert.equal(rollback.status, 200);

  // Serving A1 while the catalog holds A4: an agent that only looked at the
  // served version would ship a version the update guard rejects.
  const descriptor = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    served_version: string;
    installed_head_version: string | null;
    theme_generation: number;
    package_sha256: string;
  };
  assert.equal(descriptor.served_version, "1.2.3");
  assert.equal(descriptor.installed_head_version, "9.9.9");
  const download = await call(
    fixture,
    "GET",
    `/api/v1/themes/source/package?expected_generation=${descriptor.theme_generation}`,
  );
  assert.equal(download.status, 200);
  assert.equal(
    createHash("sha256").update(download.bytes()).digest("hex"),
    descriptor.package_sha256,
  );
  const manifest = JSON.parse(
    (await readZip(download.bytes())).get("theme.json")!.toString("utf8"),
  ) as { version: string };
  assert.equal(manifest.version, "1.2.3", "the archive is the SERVED basis, not the catalog head");
});

test("MCP: descriptor without binary, validate, CAS apply through the real transport", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  let id = 0;
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fixture.fastify.inject({
      method: "POST",
      url: "/mcp",
      headers: fixture.headers,
      payload: {
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    assert.equal(response.statusCode, 200);
    const envelope = response.json() as {
      result?: { content: { type: string; text: string }[]; isError?: boolean };
      error?: { message: string };
    };
    assert.ok(envelope.result !== undefined, envelope.error?.message);
    const text = envelope.result.content.map((part) => part.text).join("");
    return { text, isError: envelope.result.isError === true, json: () => JSON.parse(text) };
  };

  const active = await callTool("cms_get_active_theme");
  const activeBody = active.json() as { id: string; version: string; theme_generation: number };
  assert.equal(activeBody.id, THEME_ID);
  assert.equal(activeBody.version, "1.2.3");

  // The export tool carries the descriptor, never the archive.
  const exported = await callTool("cms_export_theme");
  const descriptor = exported.json() as {
    theme_generation: number;
    package_sha256: string;
    size_bytes: number;
  };
  assert.equal(descriptor.theme_generation, activeBody.theme_generation);
  assert.ok(descriptor.size_bytes > 1000);
  assert.ok(exported.text.length < 2000, "no binary/base64 in the MCP result");
  assert.doesNotMatch(exported.text, /base64/);

  const installed = await callTool("cms_list_installed_themes");
  assert.ok(
    (installed.json() as { themes: { id: string }[] }).themes.some(
      (theme) => theme.id === THEME_ID,
    ),
  );

  // Stage the edited package over REST (bytes never enter the model context),
  // then validate and apply through MCP refs only.
  const bytes = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${descriptor.theme_generation}`,
    )
  ).bytes();
  const staged = (
    await call(
      fixture,
      "POST",
      "/api/v1/themes/packages",
      await editPackage(
        bytes,
        { "blocks/text.liquid": '<div data-cycle="mcp">{{ block.props.rich_text }}</div>' },
        "9.9.9",
      ),
    )
  ).json() as { package_ref: string };

  const validated = await callTool("cms_validate_theme_package", {
    package_ref: staged.package_ref,
  });
  assert.equal((validated.json() as { theme: { version: string } }).theme.version, "9.9.9");

  const applied = await callTool("cms_update_active_theme", {
    package_ref: staged.package_ref,
    expected_generation: descriptor.theme_generation,
  });
  assert.notEqual(applied.isError, true);
  assert.equal((applied.json() as { served: { version: string } }).served.version, "9.9.9");

  // A second agent with the same basis is refused, and the tool reports the
  // typed code instead of a generic failure.
  const staleStaged = (await call(fixture, "POST", "/api/v1/themes/packages", bytes)).json() as {
    package_ref: string;
  };
  const stale = await callTool("cms_update_active_theme", {
    package_ref: staleStaged.package_ref,
    expected_generation: descriptor.theme_generation,
  });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /THEME_REVISION_STALE/);

  // Install without activation is a candidate, never a live switch. A
  // different id is required: the renderDir theme can never be installed over.
  const candidateFiles = await readZip(bytes);
  const candidateManifest = JSON.parse(
    candidateFiles.get("theme.json")!.toString("utf8"),
  ) as Record<string, unknown>;
  candidateManifest.id = "cycle-candidate";
  candidateFiles.set("theme.json", Buffer.from(JSON.stringify(candidateManifest)));
  const candidateStaged = (
    await call(fixture, "POST", "/api/v1/themes/packages", await writeZip(candidateFiles))
  ).json() as { package_ref: string };
  const installedCandidate = await callTool("cms_install_theme_package", {
    package_ref: candidateStaged.package_ref,
  });
  assert.equal((installedCandidate.json() as { activated: boolean }).activated, false);
  assert.equal(
    ((await callTool("cms_get_active_theme")).json() as { version: string }).version,
    "9.9.9",
  );
});

test("CLI: export, upload, validate-package and CAS update against the real API", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PCMS_API_URL: fixture.baseUrl,
    PCMS_API_TOKEN: fixture.headers.authorization.replace("Bearer ", ""),
    PCMS_SITE_KEY: "default",
    PCMS_ENVIRONMENT: "production",
  };
  const { themePackageCommand } = await import("../../packages/cli/src/commands/theme-package.js");
  const { themeUpdateCommand } = await import("../../packages/cli/src/commands/theme-update.js");
  const options = { json: true, yes: true, environment: "production" };
  const out = join(fixture.root, "exported.pcTheme");

  const exported = await themePackageCommand({
    args: ["export", "--output", out],
    options,
    env,
  });
  assert.equal(exported.exitCode, 0, `STDERR:${exported.stderr}`);
  const exportedBody = JSON.parse(exported.stdout) as {
    output: string;
    theme_generation: number;
    package_sha256: string;
    served_version: string;
  };
  assert.equal(exportedBody.output, out);
  assert.equal(exportedBody.served_version, "1.2.3");
  const onDisk = readFileSync(out);
  assert.equal(createHash("sha256").update(onDisk).digest("hex"), exportedBody.package_sha256);

  // Edit locally, then upload the file.
  const edited = await editPackage(
    onDisk,
    { "blocks/text.liquid": '<div data-cycle="cli">{{ block.props.rich_text }}</div>' },
    "9.9.9",
  );
  const editedPath = join(fixture.root, "edited.pcTheme");
  writeFileSync(editedPath, edited);
  const uploaded = await themePackageCommand({
    args: ["upload", editedPath],
    options,
    env,
  });
  assert.equal(uploaded.exitCode, 0, uploaded.stderr);
  const ref = (JSON.parse(uploaded.stdout) as { package_ref: string }).package_ref;

  const validated = await themePackageCommand({
    args: ["validate-package", ref],
    options,
    env,
  });
  assert.equal(validated.exitCode, 0, validated.stderr);
  assert.equal(
    (JSON.parse(validated.stdout) as { theme: { version: string } }).theme.version,
    "9.9.9",
  );

  // update-active with CAS: the first call applies, a repeat with the same
  // basis is a typed stale refusal (exit 7), never a second update.
  const first = await themeUpdateCommand({
    args: [
      "update-active",
      editedPath,
      "--expected-generation",
      String(exportedBody.theme_generation),
    ],
    options,
    env,
  });
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal((JSON.parse(first.stdout) as { version: string }).version, "9.9.9");
  const repeat = await themeUpdateCommand({
    args: [
      "update-active",
      editedPath,
      "--expected-generation",
      String(exportedBody.theme_generation),
    ],
    options,
    env,
  });
  assert.notEqual(repeat.exitCode, 0);
  assert.match(repeat.stderr, /THEME_REVISION_STALE/);
});

test("R1: a staged ref is bound to its environment, not only to actor and site", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const { app } = fixture;
  const source = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    theme_generation: number;
  };
  const bytes = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${source.theme_generation}`,
    )
  ).bytes();

  // ONE service account, two tokens for two environments on the same site.
  const account = await app.machineIdentity.createServiceAccount({
    name: "multi-env-agent",
    purpose: "environment binding",
  });
  const scopes = ["theme.read", "theme.write", "theme.validate", "theme.activate"];
  const production = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes,
    ttlMilliseconds: 3_600_000,
    siteKey: "default",
    environment: "production",
  });
  const staging = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes,
    ttlMilliseconds: 3_600_000,
    siteKey: "default",
    environment: "staging",
  });
  const asEnv = async (token: string, environment: string, path: string, body?: Buffer) => {
    const response = await fixture.fastify.inject({
      method: body === undefined ? "GET" : "POST",
      url: path,
      headers: {
        authorization: `Bearer ${token}`,
        "x-pcms-site": "default",
        "x-pcms-environment": environment,
        ...(body === undefined ? {} : { "content-type": "application/octet-stream" }),
      },
      ...(body === undefined ? {} : { payload: body as never }),
    });
    return { status: response.statusCode, json: () => response.json() as Record<string, unknown> };
  };

  const uploaded = await asEnv(
    production.rawSecret,
    "production",
    "/api/v1/themes/packages",
    bytes,
  );
  assert.equal(uploaded.status, 201);
  const ref = (uploaded.json() as { package_ref: string }).package_ref;

  // The same actor and site in ANOTHER environment must not see it.
  const foreignEnv = await asEnv(
    staging.rawSecret,
    "staging",
    `/api/v1/themes/packages/${ref}/validate`,
    Buffer.alloc(0),
  );
  assert.equal(foreignEnv.status, 404);
  assert.equal(
    (foreignEnv.json() as { error: { code: string } }).error.code,
    "THEME_PACKAGE_NOT_FOUND",
  );
  // Nor may the staging token apply it.
  const stagingApply = await fixture.fastify.inject({
    method: "POST",
    url: "/api/v1/themes/active/update",
    headers: {
      authorization: `Bearer ${staging.rawSecret}`,
      "x-pcms-site": "default",
      "x-pcms-environment": "staging",
      "content-type": "application/json",
    },
    payload: { package_ref: ref, expected_generation: source.theme_generation },
  });
  assert.equal(stagingApply.statusCode, 404);

  // The original context still works.
  const original = await asEnv(
    production.rawSecret,
    "production",
    `/api/v1/themes/packages/${ref}/validate`,
    Buffer.alloc(0),
  );
  assert.equal(original.status, 200);
});

test("R2: export keeps author dotfiles and hidden dirs, skips only service state", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const { app } = fixture;
  // Author files the INSTALLER allowlist accepts: a nested dotfile asset and a
  // hidden directory inside an allowed root.
  writeFileSync(join(fixture.themeDir, "assets", ".brand.bin"), Buffer.from([0, 1, 2, 3]));
  // The reviewer's case: an AUTHOR asset whose name merely starts with the
  // Core prefix. A prefix rule would silently drop it.
  writeFileSync(join(fixture.themeDir, "assets", ".pcms-brand.bin"), Buffer.from([9, 8, 7, 6, 5]));
  mkdirSync(join(fixture.themeDir, "assets", ".cache"), { recursive: true });
  writeFileSync(join(fixture.themeDir, "assets", ".cache", "sprite.txt"), "sprite");
  // The same NAME as the root receipt, deeper in the tree: author content.
  writeFileSync(join(fixture.themeDir, "assets", ".pcms-install.json"), '{"mine":true}');
  // Service state that must never leave the instance.
  writeFileSync(
    join(fixture.themeDir, ".pcms-install.json"),
    JSON.stringify({ installedAt: "2026-01-01T00:00:00.000Z" }),
  );

  const source = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    theme_generation: number;
  };
  const bytes = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${source.theme_generation}`,
    )
  ).bytes();
  const files = await readZip(bytes);
  assert.deepEqual([...(files.get("assets/.brand.bin") ?? [])], [0, 1, 2, 3]);
  assert.deepEqual(
    [...(files.get("assets/.pcms-brand.bin") ?? [])],
    [9, 8, 7, 6, 5],
    "an author asset named .pcms-* is not service state",
  );
  assert.equal(files.get("assets/.cache/sprite.txt")?.toString("utf8"), "sprite");
  assert.ok(!files.has(".pcms-install.json"), "the ROOT service receipt is not exported");
  assert.equal(
    files.get("assets/.pcms-install.json")?.toString("utf8"),
    '{"mine":true}',
    "a nested .pcms-install.json is author content, not service state",
  );

  // The round trip is lossless: the exported package is still installable and
  // carries the same author bytes.
  const { validateThemePackage } = await import("../../packages/themes/src/install-package.js");
  const info = await validateThemePackage(bytes, "1.0.0-rc.1");
  assert.equal(info.id, THEME_ID);
  const staged = (await call(fixture, "POST", "/api/v1/themes/packages", bytes)).json() as {
    package_ref: string;
  };
  const validated = await call(
    fixture,
    "POST",
    `/api/v1/themes/packages/${staged.package_ref}/validate`,
  );
  assert.equal(validated.status, 200);

  // A file outside the package layout is a typed refusal, never a silent loss.
  writeFileSync(join(fixture.themeDir, "notes.local.md"), "private");
  const refused = await call(
    fixture,
    "GET",
    `/api/v1/themes/source/package?expected_generation=${source.theme_generation}`,
  );
  assert.equal(refused.status, 409);
  assert.equal(
    (refused.json() as { error: { code: string } }).error.code,
    "THEME_EXPORT_UNSUPPORTED",
  );
  void app;
});

test("R3/R4: receipt publication is atomic, quota is cross-process, orphans expire", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const storeDir = join(fixture.root, "themes", ".pcms-theme-packages");
  const { stageThemePackageUpload, readStagedThemePackage } = await import(
    "../../packages/api/src/theme-package-store.js"
  );
  const ctx = {
    actor: {
      type: "machine",
      id: "store-agent",
      permissions: new Set<string>(),
      siteKey: "default",
      environment: "production",
    },
    transport: "test",
    requestId: "req_store",
  } as never;

  // R3: a published receipt is always complete and immediately readable.
  const first = await stageThemePackageUpload({
    themesRoot: join(fixture.root, "themes"),
    bytes: Buffer.alloc(64, 0x41),
    ctx,
    siteKey: "default",
  });
  const readBack = await readStagedThemePackage({
    themesRoot: join(fixture.root, "themes"),
    ref: first.package_ref,
    ctx,
    siteKey: "default",
  });
  assert.equal(readBack.bytes.length, 64);
  assert.deepEqual(
    (await import("node:fs")).readdirSync(storeDir).filter((name) => name.endsWith(".tmp")),
    [],
    "no temp file survives a successful upload",
  );

  // R4: a fresh orphan (another process mid-upload) is NOT deleted.
  const freshOrphan = join(storeDir, "01980000-0000-4000-8000-00000000aa01.pcTheme.tmp");
  writeFileSync(freshOrphan, Buffer.alloc(32));
  // An expired orphan IS deleted and counted while it lives.
  const staleOrphan = join(storeDir, "01980000-0000-4000-8000-00000000aa02.pcTheme");
  writeFileSync(staleOrphan, Buffer.alloc(32));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  (await import("node:fs")).utimesSync(staleOrphan, old, old);

  const second = await stageThemePackageUpload({
    themesRoot: join(fixture.root, "themes"),
    bytes: Buffer.alloc(16, 0x42),
    ctx,
    siteKey: "default",
  });
  const mine = [first.package_ref, second.package_ref];
  assert.ok(second.package_ref.length > 0);
  const afterSweep = (await import("node:fs")).readdirSync(storeDir);
  assert.ok(
    afterSweep.includes("01980000-0000-4000-8000-00000000aa01.pcTheme.tmp"),
    "fresh orphan kept",
  );
  assert.ok(
    !afterSweep.includes("01980000-0000-4000-8000-00000000aa02.pcTheme"),
    "stale orphan swept",
  );

  // Cross-process quota: fill to 19, then several SEPARATE processes race for
  // the single remaining slot at the SAME instant. They must serialize on the
  // store lock: exactly 20 receipts, one winner, everyone else typed-refused.
  const { spawn } = await import("node:child_process");
  const { readdirSync } = await import("node:fs");
  const existing = readdirSync(storeDir).filter((name) => name.endsWith(".json")).length;
  const fillerRefs: string[] = [];
  for (let index = existing; index < 19; index += 1) {
    const staged = await stageThemePackageUpload({
      themesRoot: join(fixture.root, "themes"),
      bytes: Buffer.alloc(8, index),
      ctx,
      siteKey: "default",
    });
    fillerRefs.push(staged.package_ref);
  }
  assert.equal(readdirSync(storeDir).filter((name) => name.endsWith(".json")).length, 19);
  const worker = "tests/helpers/theme-package-stage-worker.ts";
  const startAt = Date.now() + 400;
  const runWorker = () =>
    new Promise<{ ok: boolean; code?: string; package_ref?: string; hint?: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--env-file-if-exists=.env",
            "--import",
            "tsx",
            worker,
            join(fixture.root, "themes"),
            "8",
            String(startAt),
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", () => {
          const line = out.trim().split("\n").pop() ?? "";
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error(`worker produced no result: ${out}`));
          }
        });
      },
    );
  // Four live processes at once: only one can take the last slot.
  const racers = await Promise.all([runWorker(), runWorker(), runWorker(), runWorker()]);
  const winners = racers.filter((result) => result.ok === true);
  const losers = racers.filter((result) => result.ok === false);
  assert.equal(
    winners.length,
    1,
    `exactly one worker may take the last slot: ${JSON.stringify(racers)}`,
  );
  assert.equal(losers.length, 3);
  for (const loser of losers) assert.equal(loser.code, "THEME_PACKAGE_STORE_FULL");
  const finalCount = readdirSync(storeDir).filter((name) => name.endsWith(".json")).length;
  assert.equal(finalCount, 20, "the store never exceeds its count limit");
  // The winner's receipt is complete (published by rename, never partial) and
  // its bytes are the ones it uploaded. It belongs to the worker actor, so it
  // is read directly instead of through this actor's scoped port.
  const winnerRef = winners[0]!.package_ref!;
  const winnerReceipt = JSON.parse(
    (await import("node:fs")).readFileSync(join(storeDir, `${winnerRef}.json`), "utf8"),
  ) as { package_ref: string; size_bytes: number; sha256: string };
  assert.equal(winnerReceipt.package_ref, winnerRef);
  assert.equal(winnerReceipt.size_bytes, 8);
  const winnerBytes = (await import("node:fs")).readFileSync(
    join(storeDir, `${winnerRef}.pcTheme`),
  );
  assert.equal(winnerBytes.length, 8);
  assert.equal(
    (await import("node:crypto")).createHash("sha256").update(winnerBytes).digest("hex"),
    winnerReceipt.sha256,
  );

  // Lock safety — the reviewer's over-quota repro, now with THREE processes and
  // an aged lock that belongs to a LIVE process. No process may ever break
  // another's lock (a rename-away window let a third entrant through and
  // published a 21st package), so the store must stay at 19 and every caller
  // must get the typed busy answer.
  const lockPath = join(storeDir, ".lock");
  const droppedRef = fillerRefs.at(-1);
  assert.ok(droppedRef, "the fixture fills the store with disposable receipts");
  assert.ok(!mine.includes(droppedRef), "keep the actor's original staged refs intact");
  const dropped = `${droppedRef}.json`;
  rmSync(join(storeDir, dropped), { force: true });
  rmSync(join(storeDir, `${droppedRef}.pcTheme`), { force: true });
  assert.equal(readdirSync(storeDir).filter((name) => name.endsWith(".json")).length, 19);
  writeFileSync(
    lockPath,
    JSON.stringify({
      token: "live-holder",
      pid: process.pid,
      created_at: "2026-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const aged = new Date(Date.now() - 10 * 60 * 1000);
  (await import("node:fs")).utimesSync(lockPath, aged, aged);
  const racersOnLiveLock = await Promise.all([runWorker(), runWorker(), runWorker()]);
  for (const result of racersOnLiveLock) {
    assert.equal(result.ok, false, "no entrant may publish while a live lock exists");
    assert.equal(result.code, "THEME_PACKAGE_STORE_BUSY");
  }
  assert.equal(
    readdirSync(storeDir).filter((name) => name.endsWith(".json")).length,
    19,
    "a live holder's lock is never broken, so the quota is never exceeded",
  );
  const stillMine = JSON.parse(
    readdirSync(storeDir).includes(".lock")
      ? (await import("node:fs")).readFileSync(lockPath, "utf8")
      : "{}",
  ) as { token?: string };
  assert.equal(stillMine.token, "live-holder", "the live lock file is untouched");

  // A lock left by a CRASHED process is not removed automatically either: the
  // removal would race exactly like the case above. It is reported as busy with
  // an actionable hint, and the operator's one-line cleanup unblocks the store.
  const { spawnSync } = await import("node:child_process");
  const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  writeFileSync(
    lockPath,
    JSON.stringify({
      token: "dead-holder",
      pid: deadPid.pid,
      created_at: "2026-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  (await import("node:fs")).utimesSync(lockPath, aged, aged);
  const staleAnswer = await runWorker();
  assert.equal(staleAnswer.ok, false);
  assert.equal(staleAnswer.code, "THEME_PACKAGE_STORE_BUSY");
  assert.match(staleAnswer.hint ?? "", /stop every Web process sharing this theme store/);
  assert.ok(
    (await import("node:fs")).existsSync(lockPath),
    "the crashed holder's lock is left for the operator, never auto-broken",
  );
  // The documented operator action restores service.
  (await import("node:fs")).rmSync(lockPath, { force: true });
  const afterCleanup = await runWorker();
  assert.equal(afterCleanup.ok, true, "removing the stale lock unblocks the store");
  assert.equal(readdirSync(storeDir).filter((name) => name.endsWith(".json")).length, 20);

  // Fault injection: an unusable store path is a typed refusal, never a 500,
  // and it leaves the active theme and catalog untouched.
  const brokenRoot = join(fixture.root, "broken-themes");
  mkdirSync(brokenRoot, { recursive: true });
  writeFileSync(join(brokenRoot, ".pcms-theme-packages"), "not a directory");
  await assert.rejects(
    stageThemePackageUpload({
      themesRoot: brokenRoot,
      bytes: Buffer.alloc(8),
      ctx,
      siteKey: "default",
    }),
    (error: { code?: string; status?: number }) => {
      assert.equal(error.code, "THEME_PACKAGE_STORE_INVALID");
      assert.notEqual(error.status, 500);
      return true;
    },
  );
  assert.equal(
    ((await call(fixture, "GET", "/api/v1/themes/active")).json() as { version: string }).version,
    "1.2.3",
  );

  // Every receipt this actor published is readable: no partial commit survived
  // (the worker processes' refs belong to another actor by design).
  for (const ref of mine) {
    const staged = await readStagedThemePackage({
      themesRoot: join(fixture.root, "themes"),
      ref,
      ctx,
      siteKey: "default",
    });
    assert.ok(staged.bytes.length > 0);
  }
  assert.ok(readdirSync(storeDir).filter((name) => name.endsWith(".json")).length > mine.length);
});

test("R5: a receipt whose bytes vanished is a typed refusal, not a 500", { skip }, async (t) => {
  const fixture = await cycleFixture(t);
  const { app } = fixture;
  const source = (await call(fixture, "GET", "/api/v1/themes/source")).json() as {
    theme_generation: number;
  };
  const bytes = (
    await call(
      fixture,
      "GET",
      `/api/v1/themes/source/package?expected_generation=${source.theme_generation}`,
    )
  ).bytes();
  const staged = (await call(fixture, "POST", "/api/v1/themes/packages", bytes)).json() as {
    package_ref: string;
  };
  const storeDir = join(fixture.root, "themes", ".pcms-theme-packages");
  rmSync(join(storeDir, `${staged.package_ref}.pcTheme`));

  const before = await app.pool.query<{ state: string; revisions: string }>(
    `SELECT (SELECT count(*) FROM theme_revisions) AS revisions,
            (SELECT count(*) FROM admin_theme_state) AS state`,
  );
  const validate = await call(
    fixture,
    "POST",
    `/api/v1/themes/packages/${staged.package_ref}/validate`,
  );
  assert.equal(validate.status, 404);
  assert.equal(
    (validate.json() as { error: { code: string } }).error.code,
    "THEME_PACKAGE_NOT_FOUND",
  );
  const apply = await call(fixture, "POST", "/api/v1/themes/active/update", {
    package_ref: staged.package_ref,
    expected_generation: source.theme_generation,
  });
  assert.equal(apply.status, 404);
  assert.equal((apply.json() as { error: { code: string } }).error.code, "THEME_PACKAGE_NOT_FOUND");
  // A REAL storage fault is not a missing ref: a directory where the bytes
  // belong (EISDIR) must surface as a typed storage/corruption answer, never
  // as "not found", and never as a bare 500.
  const second = (await call(fixture, "POST", "/api/v1/themes/packages", bytes)).json() as {
    package_ref: string;
  };
  const secondBytes = join(storeDir, `${second.package_ref}.pcTheme`);
  rmSync(secondBytes);
  mkdirSync(secondBytes);
  const fault = await call(
    fixture,
    "POST",
    `/api/v1/themes/packages/${second.package_ref}/validate`,
  );
  assert.notEqual(fault.status, 404, "a storage fault is not 'package missing'");
  assert.notEqual(fault.status, 500, "a storage fault is a typed answer");
  assert.equal(fault.status, 409);
  assert.equal((fault.json() as { error: { code: string } }).error.code, "THEME_PACKAGE_CORRUPT");
  // The same classification applies to the receipt itself: a directory where
  // the receipt belongs is a typed answer, not a silent 404 or a 500.
  const third = (await call(fixture, "POST", "/api/v1/themes/packages", bytes)).json() as {
    package_ref: string;
  };
  const thirdReceipt = join(storeDir, `${third.package_ref}.json`);
  rmSync(thirdReceipt);
  mkdirSync(thirdReceipt);
  const receiptFault = await call(
    fixture,
    "POST",
    `/api/v1/themes/packages/${third.package_ref}/validate`,
  );
  assert.notEqual(receiptFault.status, 500);
  assert.equal(receiptFault.status, 409);
  assert.equal(
    (receiptFault.json() as { error: { code: string } }).error.code,
    "THEME_PACKAGE_CORRUPT",
  );

  const after = await app.pool.query<{ state: string; revisions: string }>(
    `SELECT (SELECT count(*) FROM theme_revisions) AS revisions,
            (SELECT count(*) FROM admin_theme_state) AS state`,
  );
  assert.deepEqual(after.rows[0], before.rows[0], "nothing changed");
  assert.equal(
    ((await call(fixture, "GET", "/api/v1/themes/active")).json() as { version: string }).version,
    "1.2.3",
  );
});

test("lock failure paths: typed answer, no leaked lock, no leaked descriptor", {
  skip,
}, async (t) => {
  const fixture = await cycleFixture(t);
  const themesRoot = join(fixture.root, "themes");
  const storeDir = join(themesRoot, ".pcms-theme-packages");
  const { stageThemePackageUpload } = await import("../../packages/api/src/theme-package-store.js");
  const ctx = {
    actor: {
      type: "machine",
      id: "lock-agent",
      permissions: new Set<string>(),
      siteKey: "default",
      environment: "production",
    },
    transport: "test",
    requestId: "req_lock",
  } as never;
  // The store directory is created on first use.
  mkdirSync(storeDir, { recursive: true });

  // The lock cannot be created at all (permissions): a typed storage answer,
  // never a 500, and nothing is left behind.
  const { chmodSync } = await import("node:fs");
  chmodSync(storeDir, 0o500);
  await assert.rejects(
    stageThemePackageUpload({ themesRoot, bytes: Buffer.alloc(8), ctx, siteKey: "default" }),
    (error: { code?: string; status?: number }) => {
      assert.equal(error.code, "THEME_PACKAGE_STORE_INVALID");
      assert.equal(error.status, 503);
      return true;
    },
  );
  chmodSync(storeDir, 0o700);
  assert.ok(
    !(await import("node:fs")).existsSync(join(storeDir, ".lock")),
    "a failed lock attempt leaves no lock file",
  );

  // Repeated failures must not leak descriptors: after many attempts the store
  // still works and no lock is left over.
  chmodSync(storeDir, 0o500);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await stageThemePackageUpload({
      themesRoot,
      bytes: Buffer.alloc(8),
      ctx,
      siteKey: "default",
    }).catch(() => undefined);
  }
  chmodSync(storeDir, 0o700);
  assert.ok(!(await import("node:fs")).existsSync(join(storeDir, ".lock")));
  const staged = await stageThemePackageUpload({
    themesRoot,
    bytes: Buffer.alloc(8, 0x11),
    ctx,
    siteKey: "default",
  });
  assert.ok(staged.package_ref.length > 0, "the store still works after failures");
  assert.ok(!(await import("node:fs")).existsSync(join(storeDir, ".lock")));

  // A half-written record (empty lock, the crash shape) is never auto-removed:
  // it is reported as busy with the operator hint, and the store recovers only
  // through that explicit action.
  writeFileSync(join(storeDir, ".lock"), "", { mode: 0o600 });
  await assert.rejects(
    stageThemePackageUpload({ themesRoot, bytes: Buffer.alloc(8), ctx, siteKey: "default" }),
    (error: { code?: string; status?: number; details?: { hint?: string }[] }) => {
      assert.equal(error.code, "THEME_PACKAGE_STORE_BUSY");
      assert.equal(error.status, 503);
      assert.match(error.details?.[0]?.hint ?? "", /\.pcms-theme-packages\/\.lock/);
      return true;
    },
  );
  assert.ok(
    (await import("node:fs")).existsSync(join(storeDir, ".lock")),
    "an empty lock is left for the operator instead of being broken automatically",
  );
  rmSync(join(storeDir, ".lock"), { force: true });
  await stageThemePackageUpload({ themesRoot, bytes: Buffer.alloc(8), ctx, siteKey: "default" });
});
