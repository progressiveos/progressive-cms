import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { contentCommand } from "../../packages/cli/src/commands/content.js";

test("revision show returns the complete record and preserves API errors", async (t) => {
  const seen: string[] = [];
  const revision = {
    id: "revision-1",
    entity_id: "entry-1",
    entity_type: "entry",
    state: "SEALED",
    edit_generation: 7,
    payload: {
      fields: { title: "Current" },
      blocks: [{ type: "image", props: { media_id: "asset" } }],
    },
  };
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/publications/entry/entry-1")
      response.end(
        JSON.stringify({ state: "PUBLISHED", current_revision_id: "revision-1", generation: 5 }),
      );
    else if (request.url === "/api/v1/revisions/revision-1") response.end(JSON.stringify(revision));
    else {
      response.statusCode = 403;
      response.end(JSON.stringify({ code: "AUTH_FORBIDDEN", message: "Denied" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const env = {
    PCMS_API_URL: `http://127.0.0.1:${address.port}`,
    PCMS_API_TOKEN: "fixture-token",
    PCMS_SITE_KEY: "site",
    PCMS_ENVIRONMENT: "production",
  };
  const run = (id: string) =>
    contentCommand({
      args: ["revision", "show", id],
      options: { json: true, yes: false },
      env,
      cwd: process.cwd(),
    });
  const result = await run("revision-1");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), revision);
  const current = await contentCommand({
    args: ["revision", "current", "entry-1"],
    options: { json: true, yes: false },
    env,
    cwd: process.cwd(),
  });
  assert.equal(current.exitCode, 0, current.stderr);
  assert.deepEqual(JSON.parse(current.stdout), {
    publication: { state: "PUBLISHED", current_revision_id: "revision-1", generation: 5 },
    revision,
  });
  assert.notEqual((await run("denied")).exitCode, 0);
  assert.deepEqual(seen, [
    "GET /api/v1/revisions/revision-1",
    "GET /api/v1/publications/entry/entry-1",
    "GET /api/v1/revisions/revision-1",
    "GET /api/v1/revisions/denied",
  ]);
});

test("revision read uses actual API permissions and token context", {
  skip: !process.env.PCMS_TEST_DATABASE_URL,
}, async (t) => {
  const { createApiFastify, createApiV1, makeDiscoveryRoutes, createDraft, createWorkingDraft } =
    await import("@pcms/api");
  const { rollbackApiFixture } = await import("../helpers/rollback-api-fixture.js");
  const { apiContextOf, ownerActor } = await import("../helpers/api-composition.js");
  const { app } = await rollbackApiFixture(t, {
    contentTypeDefinitions: [
      {
        key: "page",
        version: 1,
        title: "Page",
        bodyPolicy: "rich_text",
        fields: { title: { id: "title", type: "string", required: true } },
      },
    ],
  });
  const draft = await createDraft(app, apiContextOf(ownerActor("test")), {
    content_type: "page",
    payload: { fields: { title: "Complete revision" } },
  });
  const account = await app.machineIdentity.createServiceAccount({
    name: "revision-reader",
    purpose: "test",
    allowedScopes: ["publication.read", "content.read", "media.read"],
  });
  const read = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["publication.read", "media.read"],
    siteKey: "default",
    environment: "production",
    ttlMilliseconds: 3600000,
  });
  const denied = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.read"],
    siteKey: "default",
    environment: "production",
    ttlMilliseconds: 3600000,
  });
  const foreign = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["publication.read", "media.read"],
    siteKey: "foreign",
    environment: "production",
    ttlMilliseconds: 3600000,
  });
  const fastify = createApiFastify(() => "req_revision_cli");
  await fastify.register(createApiV1(makeDiscoveryRoutes()), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    cookieSecure: false,
  });
  await fastify.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fastify.close());
  const address = fastify.server.address();
  assert.ok(address && typeof address === "object");
  const run = (token: string, site: string, environment: string) =>
    contentCommand({
      args: ["revision", "show", draft.revision_id],
      options: { json: true, yes: false },
      env: {
        PCMS_API_URL: `http://127.0.0.1:${address.port}`,
        PCMS_API_TOKEN: token,
        PCMS_SITE_KEY: site,
        PCMS_ENVIRONMENT: environment,
      },
      cwd: process.cwd(),
    });
  const allowed = await run(read.rawSecret, "default", "production");
  assert.equal(allowed.exitCode, 0, allowed.stdout + allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).payload.fields.title, "Complete revision");
  assert.notEqual((await run(denied.rawSecret, "default", "production")).exitCode, 0);
  assert.notEqual((await run(read.rawSecret, "foreign", "production")).exitCode, 0);
  assert.notEqual((await run(read.rawSecret, "default", "staging")).exitCode, 0);
  assert.notEqual((await run(foreign.rawSecret, "foreign", "production")).exitCode, 0);
  const blob = "01900000-0000-7000-8000-000000000abc";
  const asset = "01900000-0000-7000-8000-000000000def";
  await app.pool.query(
    "INSERT INTO media_blobs(id, sha256, size_bytes, storage_key) VALUES ($1, $2, 1, 'fixture')",
    [blob, "a".repeat(64)],
  );
  await app.pool.query(
    "INSERT INTO media_assets(id,kind,current_version_no,original_blob_id,filename_original,mime_type,size_bytes,sha256,created_by) VALUES ($1,'image',1,$2,'a.jpg','image/jpeg',1,$3,'test')",
    [asset, blob, "a".repeat(64)],
  );
  const inspectMedia = (secret: string, site: string) =>
    fastify.inject({
      method: "GET",
      url: `/api/v1/media/${asset}`,
      headers: {
        authorization: `Bearer ${secret}`,
        "x-pcms-site": site,
        "x-pcms-environment": "production",
      },
    });
  assert.equal((await inspectMedia(read.rawSecret, "default")).statusCode, 200);
  assert.equal((await inspectMedia(foreign.rawSecret, "foreign")).statusCode, 403);
  await app.revisions.sealRevision({ revisionId: draft.revision_id as never });
  const branched = await createWorkingDraft(app, apiContextOf(ownerActor("test")), {
    entry_id: draft.entry_id,
    from_revision_id: draft.revision_id,
  });
  assert.equal(branched.base_revision_id, draft.revision_id);
  const child = await app.revisions.getRevision(app.pool, branched.revision_id as never);
  assert.equal(child?.parentRevisionId, draft.revision_id);
});
