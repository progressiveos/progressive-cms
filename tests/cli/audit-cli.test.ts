import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  bindOperations,
  createApiFastify,
  createApiV1,
  createDraft,
  makeDiscoveryRoutes,
  makeMutationRoutes,
} from "@pcms/api";
import { runCli } from "@pcms/cli";
import { newStableId } from "@pcms/core";
import { createMcpServer, type McpOperations } from "@pcms/mcp";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

function cliEnv(t: { after(fn: () => void): void }, url: string, token: string) {
  const values = {
    PCMS_API_URL: url,
    PCMS_API_TOKEN: token,
    PCMS_SITE_KEY: "default",
    PCMS_ENVIRONMENT: "production",
  };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// Test a continuation failure and a per-entry failure without a database.
test("audit CLI keeps partial results, stable errors, scope headers and confirmation", async (t) => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    assert.equal(req.headers["x-pcms-site"], "default");
    assert.equal(req.headers["x-pcms-environment"], "production");
    const url = new URL(req.url!, "http://localhost");
    seen.push(req.method + " " + url.pathname);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/media") {
      if (url.searchParams.has("cursor")) {
        res.statusCode = 503;
        res.end(
          JSON.stringify({
            error: {
              code: "MEDIA_UNAVAILABLE",
              message: "fixture continuation failure",
              details: ["kept"],
            },
          }),
        );
      } else
        res.end(JSON.stringify({ items: [{ id: "one" }], has_more: true, next_cursor: "next" }));
    } else if (url.pathname === "/api/v1/discovery/content/tree") {
      res.end(
        JSON.stringify(
          url.searchParams.has("cursor")
            ? {
                items: [
                  { entry_id: "bad", kind: "content" },
                  { entry_id: "folder", kind: "folder" },
                ],
                has_more: false,
                next_cursor: null,
              }
            : {
                items: [{ entry_id: "good", kind: "content" }],
                has_more: true,
                next_cursor: "next",
              },
        ),
      );
    } else if (url.pathname === "/api/v1/discovery/seo/validate") {
      if (url.searchParams.get("entry_id") === "bad") {
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            error: { code: "SEO_FACTS_UNAVAILABLE", message: "no eligible revision" },
          }),
        );
      } else
        res.end(
          JSON.stringify({
            counts: { error: 0 },
            issues: [{ severity: "recommendation", code: "SEO_TITLE_LENGTH" }],
          }),
        );
    } else if (url.pathname.endsWith("/usage"))
      res.end(JSON.stringify({ inboundCount: 0, references: [] }));
    else if (url.pathname.endsWith("/route"))
      res.end(JSON.stringify({ current: { path: "/old/" } }));
    else {
      res.statusCode = 409;
      res.end(
        JSON.stringify({
          error: { code: "ROUTE_COLLISION", message: "taken", details: ["collision"] },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  cliEnv(t, `http://127.0.0.1:${address.port}`, "fixture-token");
  const partial = await runCli(["media", "list", "--all", "--json"]);
  assert.equal(partial.exitCode, 7);
  assert.deepEqual(JSON.parse(partial.stdout).items, [{ id: "one" }]);
  assert.equal(JSON.parse(partial.stdout).partial, true);
  assert.deepEqual(JSON.parse(partial.stdout).error.details, ["kept"]);
  const seo = await runCli(["seo", "validate", "--all", "--json"]);
  const report = JSON.parse(seo.stdout);
  assert.equal(report.processed, 2);
  assert.equal(report.checked, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.catalog_complete, true);
  assert.equal(report.partial, true);
  assert.equal(report.failures[0].code, "SEO_FACTS_UNAVAILABLE");
  assert.equal(report.counts.recommendation, 1);
  assert.notEqual(seo.exitCode, 0);
  assert.equal((await runCli(["media", "archive", "one", "--json"])).exitCode, 2);
  assert.equal(
    (await runCli(["entries", "route", "change", "one", "--to-path", "/new/", "--json"])).exitCode,
    2,
  );
  assert.ok(!seen.some((path) => path.startsWith("POST")));
  const collision = await runCli([
    "entries",
    "route",
    "change",
    "one",
    "--to-path",
    "/new/",
    "--reason",
    "fixture",
    "--yes",
    "--json",
  ]);
  assert.equal(collision.exitCode, 4);
  assert.equal(JSON.parse(collision.stdout).error.code, "ROUTE_COLLISION");
  for (const flag of [["--limit", "0"], ["--limit"], ["--all", "--limit", "2"]])
    assert.equal((await runCli(["media", "list", ...flag, "--json"])).exitCode, 2);
});

test("audit CLI and MCP golden path over REST: 224 media, SEO page/article and 301 move", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const definition = (key: string) => ({
    key,
    version: 1,
    title: key,
    bodyPolicy: "block_document",
    fields: { title: { id: "title", type: "string", required: true } },
  });
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [definition("page"), definition("article")] as never,
  });
  const ctx = apiContextOf(ownerActor());
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  // This fixture exercises identity repair on a `ru-RU` entry, so the site
  // must declare that locale: identity locales follow the policy.
  await app.localization.update({
    enabled: true,
    defaultLocale: "ru-RU",
    locales: ["ru-RU"],
    updatedBy: "test",
  });
  const blob = newStableId();
  const sha = "a".repeat(64);
  await app.pool.query(
    "INSERT INTO media_blobs (id, sha256, size_bytes, storage_key) VALUES ($1,$2,1,'fixture')",
    [blob, sha],
  );
  const ids = Array.from({ length: 224 }, () => newStableId());
  await app.pool.query(
    `INSERT INTO media_assets (id,kind,current_version_no,original_blob_id,filename_original,mime_type,size_bytes,sha256,created_by)
    SELECT id,'document',1,$2,'fixture.txt','text/plain',1,$3,'test' FROM unnest($1::uuid[]) AS id`,
    [ids, blob, sha],
  );
  const page = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Legal page" } },
    locale: "ru-RU",
  });
  // Historical SEALED state, then the existing identity-repair operation.
  await app.pool.query(
    `UPDATE revisions SET state='SEALED',sealed_at=now(),payload_hash='fixture-hash' WHERE id=$1`,
    [page.revision_id],
  );
  await app.pool.query(
    `INSERT INTO publications (entity_type,entity_id,state,current_revision_id,current_payload_hash,generation,first_published_at,published_at,modified_at)
    VALUES ('entry',$1,'PUBLISHED',$2,'fixture-hash',1,now(),now(),now())`,
    [page.entry_id, page.revision_id],
  );
  await app.entries.reidentifyLocale(page.entry_id as never, "default");
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/old/",
    targetType: "entry",
    targetId: page.entry_id,
  });
  const article = await createDraft(app, ctx, {
    content_type: "article",
    payload: { fields: { title: "Article" } },
  });
  const scopes = [
    "media.read",
    "media.archive",
    "seo.validate",
    "content.read",
    "navigation.read",
    "navigation.edit",
  ];
  const account = await app.machineIdentity.createServiceAccount({
    name: "audit-cli",
    purpose: "audit contract",
    allowedScopes: scopes,
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes,
    ttlMilliseconds: 3_600_000,
  });
  const fastify = createApiFastify(() => "req_audit");
  await fastify.register(createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes()]), {
    application: app,
    logger: { info() {}, warn() {}, error() {} } as never,
    cookieSecure: false,
  });
  await fastify.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => {
    void fastify.close();
  });
  const address = fastify.server.address();
  assert.ok(address && typeof address === "object");
  cliEnv(t, `http://127.0.0.1:${address.port}`, token.rawSecret);
  for (const flags of [["--limit", "224"], ["--all"]]) {
    const result = await runCli(["media", "list", ...flags, "--json"]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.items.length, 224);
    assert.equal(new Set(body.items.map((i: { id: string }) => i.id)).size, 224);
    assert.equal(body.complete, true);
  }
  const limited = JSON.parse((await runCli(["media", "list", "--limit", "21", "--json"])).stdout);
  assert.equal(limited.items.length, 21);
  assert.equal(limited.has_more, true);
  assert.equal(limited.complete, false);
  assert.ok(limited.next_cursor);
  const remaining = JSON.parse(
    (await runCli(["media", "list", "--all", "--cursor", limited.next_cursor, "--json"])).stdout,
  );
  assert.equal(remaining.items.length, 203);
  const firstTree = await fastify.inject({
    url: "/api/v1/discovery/content/tree?limit=1",
    headers: { authorization: `Bearer ${token.rawSecret}` },
  });
  assert.equal(firstTree.statusCode, 200);
  assert.equal(firstTree.json().has_more, true);
  const nextTree = await fastify.inject({
    url: `/api/v1/discovery/content/tree?limit=1&cursor=${firstTree.json().next_cursor}`,
    headers: { authorization: `Bearer ${token.rawSecret}` },
  });
  assert.equal(nextTree.json().items.length, 1);
  assert.notEqual(nextTree.json().items[0].entry_id, firstTree.json().items[0].entry_id);
  assert.equal(nextTree.json().has_more, false);
  for (const id of [page.entry_id, article.entry_id]) {
    const validation = await runCli(["seo", "validate", "--entry", id, "--json"]);
    assert.equal(validation.exitCode, 3, validation.stderr || validation.stdout); // missing OG is a content issue
    assert.equal(JSON.parse(validation.stdout).entryId, id);
  }
  const all = await runCli(["seo", "validate", "--all", "--json"]);
  const audit = JSON.parse(all.stdout);
  assert.equal(audit.processed, 2);
  assert.equal(audit.checked, 2);
  assert.equal(audit.complete, true);
  assert.equal(audit.failures.length, 0);
  const usage = await runCli(["media", "usage", ids[0]!, "--json"]);
  assert.equal(JSON.parse(usage.stdout).inboundCount, 0);
  const preview = await runCli(["media", "archive", ids[0]!, "--json"]);
  assert.equal(preview.exitCode, 2);
  assert.equal((await app.mediaDiscovery.inspectAsset(ids[0]!)).asset.archivedAt, null);
  const archived = await runCli(["media", "archive", ids[0]!, "--yes", "--json"]);
  assert.equal(archived.exitCode, 0, archived.stderr);
  assert.ok((await app.mediaDiscovery.inspectAsset(ids[0]!)).asset.archivedAt);
  const move = await runCli([
    "entries",
    "route",
    "change",
    page.entry_id,
    "--to-path",
    "/new/",
    "--yes",
    "--json",
  ]);
  assert.equal(move.exitCode, 0, move.stderr || move.stdout);
  assert.deepEqual(JSON.parse(move.stdout), { old_path: "/old/", new_path: "/new/" });
  const redirect = await app.requestResolver.resolve({ path: "/old/" });
  assert.equal(redirect.kind, "redirect");
  assert.equal(redirect.statusCode, 301);
  assert.equal((await app.requestResolver.resolve({ path: "/new/" })).kind, "route");
  const repeat = await runCli([
    "entries",
    "route",
    "change",
    page.entry_id,
    "--to-path",
    "/new/",
    "--yes",
    "--json",
  ]);
  assert.notEqual(repeat.exitCode, 0);
  assert.notEqual(JSON.parse(repeat.stdout).error.code, "INTERNAL_ERROR");
  const readToken = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["media.read"],
    ttlMilliseconds: 3_600_000,
  });
  process.env["PCMS_API_TOKEN"] = readToken.rawSecret;
  for (const words of [
    ["media", "archive", ids[1]!, "--yes"],
    ["seo", "validate", "--entry", page.entry_id],
    ["entries", "route", "change", page.entry_id, "--to-path", "/denied/", "--yes"],
  ]) {
    const denied = await runCli([...words, "--json"]);
    assert.equal(denied.exitCode, 5);
    assert.equal(JSON.parse(denied.stdout).error.code, "AUTH_PERMISSION_DENIED");
  }
  const mcp = createMcpServer({
    operations: bindOperations(app) as unknown as McpOperations,
    serverInfo: { name: "fixture", version: "1" },
  });
  const call = async (name: string, args: object, actor = ownerActor()) =>
    (await mcp.handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      () => apiContextOf(actor, "mcp"),
    )) as { result: { isError: boolean; structuredContent: any } };
  const searched = (await call("cms_search_media", { limit: 100 })).result.structuredContent;
  assert.equal(searched.items.length, 100);
  assert.ok(searched.next_cursor);
  assert.equal(
    (await call("cms_search_media", { limit: 100, cursor: searched.next_cursor })).result
      .structuredContent.items.length,
    100,
  );
  assert.equal((await call("cms_validate_seo", { entry_id: page.entry_id })).result.isError, false);
  assert.equal(
    (await call("cms_list_seo_entries", { limit: 1 })).result.structuredContent.has_more,
    true,
  );
  assert.equal((await call("cms_get_media_usage", { media_id: ids[1] })).result.isError, false);
  assert.equal(
    (await call("cms_archive_media", { media_id: ids[1] })).result.structuredContent.error.code,
    "TARGET_UNCONFIRMED",
  );
  assert.equal(
    (
      await call(
        "cms_archive_media",
        { media_id: ids[1], confirmed: true },
        scopedActor(["media.read"]),
      )
    ).result.structuredContent.error.code,
    "AUTH_PERMISSION_DENIED",
  );
  const archiveAttempt = (await call("cms_archive_media", { media_id: ids[1], confirmed: true }))
    .result;
  assert.equal(archiveAttempt.isError, false);
  assert.equal(
    (await call("cms_change_entry_route", { entry_id: page.entry_id, to_path: "/via-mcp/" })).result
      .structuredContent.error.code,
    "TARGET_UNCONFIRMED",
  );
  const routeAttempt = (
    await call("cms_change_entry_route", {
      entry_id: page.entry_id,
      to_path: "/via-mcp/",
      confirmed: true,
    })
  ).result;
  assert.equal(routeAttempt.isError, false);
});
