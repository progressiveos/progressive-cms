// PCMS-API-T029 — representative end-to-end reference workflows through the
// public contracts only (API spec §73/§74/§77, owner instruction #148):
//   browser session → CSRF mutation → logout
//   machine token → discovery → content operation
//   publication: draft → validate → seal → changeset → preflight → apply
//   privilege: content agent publish attempts stay denied (REST + MCP)
//   bundle: validate → atomic apply → idempotent replay → no duplicates
//   preview: signed URL renders the candidate with security headers;
//            tampered tokens are rejected
// The composition mirrors apps/web (API plugin + MCP endpoint + preview
// route) over a disposable database — the same wiring the shipped process
// uses, exercised in-process.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApiRoute,
  bindOperations,
  createApiFastify,
  createApiV1,
  makeDiscoveryRoutes,
  makeMutationRoutes,
} from "@pcms/api";
import { createProvisioningService, createRoleService } from "@pcms/auth";
import type { McpOperations, OperationContextLike } from "@pcms/mcp";
import { createMcpServer } from "@pcms/mcp";
import { registerPreviewRoute } from "../../apps/web/src/preview.js";
import { apiContextOf, createApiFixture, scopedActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const CONTENT_TYPES = [
  {
    key: "article",
    version: 1,
    title: "Article",
    bodyPolicy: "block_document",
    fields: {
      title: { id: "title", type: "string", required: true, sortable: true },
      intro: { id: "intro", type: "text" },
    },
  },
] as const;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

const VALID_PAYLOAD = () => ({
  fields: { title: "E2E article", intro: "written end to end" },
  blocks: { schema_version: 1, blocks: [] },
});

async function fullStack(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
  });
  const site = await app.routes.ensureSite("default");
  const fastify = createApiFastify(() => "req_e2e");
  const coreAndDomain: ApiRoute[] = [...makeDiscoveryRoutes(), ...makeMutationRoutes()];
  await fastify.register(createApiV1(coreAndDomain), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  const mcp = createMcpServer({
    operations: bindOperations(app) as unknown as McpOperations,
    serverInfo: { name: "progressive-cms-mcp", version: "1.0.0" },
  });
  fastify.post("/mcp", { bodyLimit: 1_048_576 }, async (request, reply) => {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      void reply.status(401).send({ error: { code: "AUTH_UNAUTHENTICATED" } });
      return reply;
    }
    const auth = await app.actorResolver.authenticateToken(authorization.slice(7).trim());
    const response = await mcp.handleRequest(
      request.body,
      () =>
        ({
          actor: auth.actor,
          transport: "mcp",
          requestId: request.id,
        }) satisfies OperationContextLike,
    );
    if (response === null) {
      void reply.status(204).send();
      return reply;
    }
    void reply.send(response);
    return reply;
  });
  registerPreviewRoute(fastify, { application: app });

  const provisioning = createProvisioningService(app.pool, {
    users: app.users,
    passwords: app.passwords,
    policy: app.passwordPolicy,
    roles: createRoleService(app.pool),
  });
  await provisioning.bootstrapOwner({
    displayName: "E2E Owner",
    email: "owner@e2e.test",
    password: "correct-horse-battery-staple-9!",
  });
  return { app, fastify, site };
}

test("E2E browser session: login → CSRF-protected mutation → logout (#148)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await fullStack(t);

  const login = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "owner@e2e.test", password: "correct-horse-battery-staple-9!" },
  });
  assert.equal(login.statusCode, 200);
  const loginBody = login.json() as { csrf_token: string };
  const setCookieRaw = login.headers["set-cookie"];
  const setCookie = Array.isArray(setCookieRaw) ? setCookieRaw : [String(setCookieRaw)];
  const cookie = setCookie.find((value) => value.startsWith("pcms_session="))!.split(";")[0]!;
  const csrf = { cookie, "x-pcms-csrf": loginBody.csrf_token };

  // The CSRF-protected mutation creates real content.
  const mutation = await fastify.inject({
    method: "POST",
    url: "/api/v1/entries",
    headers: csrf,
    payload: { content_type: "article", payload: VALID_PAYLOAD() },
  });
  assert.equal(mutation.statusCode, 201);
  void app;

  // Logout revokes; the cookie is dead afterwards.
  const logout = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: csrf,
  });
  assert.equal(logout.statusCode, 200);
  const after = await fastify.inject({
    method: "GET",
    url: "/api/v1/auth/sessions",
    headers: { cookie },
  });
  assert.equal(after.statusCode, 401);
});

test("E2E machine + publication: token → discover → draft → seal → release → publish (#148)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, site } = await fullStack(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "e2e-agent",
    purpose: "machine workflow",
    allowedScopes: [
      "content.read",
      "content.create",
      "content.edit",
      "revision.seal",
      "publication.plan",
      "publication.publish",
      "preview.create",
    ],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [
      "content.read",
      "content.create",
      "content.edit",
      "revision.seal",
      "publication.plan",
      "publication.publish",
      "preview.create",
    ],
    ttlMilliseconds: 3_600_000,
  });
  const headers = { authorization: `Bearer ${token.rawSecret}` };

  // Discover first (agents query, never guess).
  const capabilities = await fastify.inject({
    method: "GET",
    url: "/api/v1/capabilities",
    headers,
  });
  assert.equal(capabilities.statusCode, 200);
  assert.equal(
    (capabilities.json() as { publication: { publish: boolean } }).publication.publish,
    true,
  );
  const schema = await fastify.inject({
    method: "GET",
    url: "/api/v1/discovery/content/types/article",
    headers,
  });
  assert.equal(schema.statusCode, 200);

  // Draft → autosave (CAS) → validate → seal.
  const draft = await fastify.inject({
    method: "POST",
    url: "/api/v1/entries",
    headers,
    payload: { content_type: "article", payload: VALID_PAYLOAD() },
  });
  const { entry_id, revision_id, edit_generation } = JSON.parse(draft.body) as {
    entry_id: string;
    revision_id: string;
    edit_generation: number;
  };
  const autosave = await fastify.inject({
    method: "PATCH",
    url: `/api/v1/revisions/${revision_id}`,
    headers,
    payload: { payload: VALID_PAYLOAD(), expected_edit_generation: edit_generation },
  });
  assert.equal(autosave.statusCode, 200);
  const nextGeneration = (JSON.parse(autosave.body) as { edit_generation: number }).edit_generation;

  const validate = await fastify.inject({
    method: "POST",
    url: `/api/v1/revisions/${revision_id}/validate`,
    headers,
  });
  assert.equal(validate.statusCode, 200);
  assert.equal((JSON.parse(validate.body) as { ok: boolean }).ok, true);

  const seal = await fastify.inject({
    method: "POST",
    url: `/api/v1/revisions/${revision_id}/seal`,
    headers,
    payload: { expected_edit_generation: nextGeneration },
  });
  assert.equal(seal.statusCode, 200);

  // Coordinated release with a route move.
  const changeset = await fastify.inject({
    method: "POST",
    url: "/api/v1/changesets",
    headers,
    payload: { title: "e2e release" },
  });
  assert.equal(changeset.statusCode, 201, changeset.body);
  const changesetId = (JSON.parse(changeset.body) as { id: string }).id;
  const item = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${changesetId}/items`,
    headers,
    payload: {
      entity_type: "entry",
      entity_id: entry_id,
      intent: "PUBLISH",
      target_revision_id: revision_id,
      expected_generation: 0,
      route_operation: { kind: "set", site_id: site.id, path: "/e2e/" },
    },
  });
  assert.equal(item.statusCode, 201, `item: ${item.body.slice(0, 300)}`);
  const preflight = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${changesetId}/preflight`,
    headers,
  });
  assert.equal(
    preflight.statusCode,
    200,
    `preflight ${preflight.statusCode}: ${preflight.body.slice(0, 300)}`,
  );
  assert.equal((JSON.parse(preflight.body) as { ok: boolean }).ok, true);

  const apply = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${changesetId}/apply`,
    headers,
  });
  assert.equal(apply.statusCode, 200, apply.body);

  // The public pointer moved; the canonical route resolves.
  const publication = await app.publications.getPublication(app.pool, "entry", entry_id as never);
  assert.notEqual(publication, null);
  assert.equal(publication!.state, "PUBLISHED");
  assert.equal(publication!.currentRevisionId, revision_id);

  // Republishing a revision on its existing canonical route is an idempotent
  // route operation, while still advancing the content pointer.
  const reopened = await fastify.inject({
    method: "POST",
    url: `/api/v1/entries/${entry_id}/draft`,
    headers,
    payload: { from_revision_id: revision_id },
  });
  assert.equal(reopened.statusCode, 201, reopened.body);
  const { revision_id: nextRevisionId, edit_generation: draftGeneration } = reopened.json() as {
    revision_id: string;
    edit_generation: number;
  };
  const saved = await fastify.inject({
    method: "PATCH",
    url: `/api/v1/revisions/${nextRevisionId}`,
    headers,
    payload: { payload: VALID_PAYLOAD(), expected_edit_generation: draftGeneration },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const nextEditGeneration = (saved.json() as { edit_generation: number }).edit_generation;
  const resealed = await fastify.inject({
    method: "POST",
    url: `/api/v1/revisions/${nextRevisionId}/seal`,
    headers,
    payload: { expected_edit_generation: nextEditGeneration },
  });
  assert.equal(resealed.statusCode, 200, resealed.body);
  const repeated = await fastify.inject({
    method: "POST",
    url: "/api/v1/changesets",
    headers,
    payload: { title: "same route update" },
  });
  const repeatedChangesetId = (repeated.json() as { id: string }).id;
  const repeatedItem = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${repeatedChangesetId}/items`,
    headers,
    payload: {
      entity_type: "entry",
      entity_id: entry_id,
      intent: "PUBLISH",
      target_revision_id: nextRevisionId,
      expected_generation: publication!.generation,
      route_operation: { kind: "set", site_id: site.id, path: "/e2e/" },
    },
  });
  assert.equal(repeatedItem.statusCode, 201, repeatedItem.body);
  const repeatedPreflight = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${repeatedChangesetId}/preflight`,
    headers,
  });
  assert.equal((repeatedPreflight.json() as { ok: boolean }).ok, true, repeatedPreflight.body);
  const repeatedApply = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${repeatedChangesetId}/apply`,
    headers,
  });
  assert.equal(repeatedApply.statusCode, 200, repeatedApply.body);
  const sameRoute = await app.routes.findActiveRoute(site.id, "/e2e/");
  assert.equal(sameRoute?.targetId, entry_id);

  // The same path remains unavailable to a different entry.
  const contender = await fastify.inject({
    method: "POST",
    url: "/api/v1/entries",
    headers,
    payload: { content_type: "article", payload: VALID_PAYLOAD() },
  });
  const contenderEntry = contender.json() as { entry_id: string; revision_id: string };
  const contenderSeal = await fastify.inject({
    method: "POST",
    url: `/api/v1/revisions/${contenderEntry.revision_id}/seal`,
    headers,
  });
  assert.equal(contenderSeal.statusCode, 200, contenderSeal.body);
  const blocked = await fastify.inject({
    method: "POST",
    url: "/api/v1/changesets",
    headers,
    payload: { title: "route collision stays blocked" },
  });
  const blockedChangesetId = (blocked.json() as { id: string }).id;
  const blockedItem = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${blockedChangesetId}/items`,
    headers,
    payload: {
      entity_type: "entry",
      entity_id: contenderEntry.entry_id,
      intent: "PUBLISH",
      target_revision_id: contenderEntry.revision_id,
      expected_generation: 0,
      route_operation: { kind: "set", site_id: site.id, path: "/e2e/" },
    },
  });
  assert.equal(blockedItem.statusCode, 201, blockedItem.body);
  const blockedPreflight = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${blockedChangesetId}/preflight`,
    headers,
  });
  const blockedReport = blockedPreflight.json() as {
    ok: boolean;
    issues: { code: string }[];
  };
  assert.equal(blockedReport.ok, false);
  assert.ok(blockedReport.issues.some((issue) => issue.code === "ROUTE_CONFLICT"));
});

test("E2E privilege: content agent publish attempts stay denied over REST and MCP (#148)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await fullStack(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "e2e-content-agent",
    purpose: "privilege separation",
    allowedScopes: [
      "content.read",
      "content.create",
      "content.edit",
      "revision.seal",
      "publication.plan",
    ],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.read", "content.create", "content.edit", "revision.seal", "publication.plan"],
    ttlMilliseconds: 3_600_000,
  });
  const headers = { authorization: `Bearer ${token.rawSecret}` };

  // The agent plans and seals freely…
  const draft = await fastify.inject({
    method: "POST",
    url: "/api/v1/entries",
    headers,
    payload: { content_type: "article", payload: VALID_PAYLOAD() },
  });
  const { entry_id, revision_id } = JSON.parse(draft.body) as {
    entry_id: string;
    revision_id: string;
  };
  await fastify.inject({
    method: "POST",
    url: `/api/v1/revisions/${revision_id}/seal`,
    headers,
    payload: {},
  });
  const changeset = await fastify.inject({
    method: "POST",
    url: "/api/v1/changesets",
    headers,
    payload: { title: "agent release" },
  });
  const changesetId = (JSON.parse(changeset.body) as { id: string }).id;
  await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${changesetId}/items`,
    headers,
    payload: {
      entity_type: "entry",
      entity_id: entry_id,
      intent: "PUBLISH",
      target_revision_id: revision_id,
      expected_generation: 0,
    },
  });

  // …but the public flip is denied over REST…
  const restApply = await fastify.inject({
    method: "POST",
    url: `/api/v1/changesets/${changesetId}/apply`,
    headers,
  });
  assert.equal(restApply.statusCode, 403);
  assert.equal(
    (JSON.parse(restApply.body) as { error: { code: string } }).error.code,
    "AUTH_PERMISSION_DENIED",
  );

  // …and over MCP.
  const mcpResponse = (
    await fastify.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "cms_apply_changeset", arguments: { changeset_id: changesetId } },
      },
    })
  ).json() as { result: { structuredContent: { error: { code: string } } } };
  assert.equal(mcpResponse.result.structuredContent.error.code, "AUTH_PERMISSION_DENIED");

  // Nothing leaked into public state.
  const publication = await app.publications.getPublication(app.pool, "entry", entry_id as never);
  assert.equal(publication, null);
});

test("E2E bundle: validate → atomic apply → idempotent replay → no duplicates (#148)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await fullStack(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "e2e-bundler",
    purpose: "bundle workflow",
    allowedScopes: [
      "content.create",
      "content.edit",
      "revision.seal",
      "seo.edit",
      "publication.plan",
      "publication.publish",
    ],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [
      "content.create",
      "content.edit",
      "revision.seal",
      "seo.edit",
      "publication.plan",
      "publication.publish",
    ],
    ttlMilliseconds: 3_600_000,
  });
  const headers = { authorization: `Bearer ${token.rawSecret}` };
  const bundle = {
    mode: "apply",
    bundle_version: 1,
    external_id: "e2e-bundle-run-1",
    changeset: { title: "e2e bundle" },
    entries: [
      {
        ref: "article-1",
        content_type: "article",
        payload: {
          fields: { title: "Bundled", intro: "via bundle" },
          blocks: { schema_version: 1, blocks: [] },
        },
        seo: { seo_title: "Bundled article" },
      },
    ],
    publication: { mode: "none" },
  };

  // Strict validation leaves nothing behind…
  const report = await fastify.inject({
    method: "POST",
    url: "/api/v1/bundles",
    headers: { authorization: headers.authorization },
    payload: { ...bundle, mode: "validate" },
  });
  assert.equal(report.statusCode, 200, `report: ${report.body.slice(0, 300)}`);
  assert.equal(
    (report.json() as { validation_report: { ok: boolean } }).validation_report.ok,
    true,
  );
  assert.equal((await app.changesets.listChangesets({ limit: 100 })).length, 0);

  // …then the atomic apply…
  const applied = await fastify.inject({
    method: "POST",
    url: "/api/v1/bundles",
    headers,
    payload: bundle,
  });
  assert.equal(applied.statusCode, 201, applied.body);
  const firstResult = JSON.parse(applied.body) as { changeset_id: string };

  // …and the replay returns the stored result with no duplicate state.
  const replay = await fastify.inject({
    method: "POST",
    url: "/api/v1/bundles",
    headers,
    payload: bundle,
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(
    (JSON.parse(replay.body) as { changeset_id: string }).changeset_id,
    firstResult.changeset_id,
  );
  assert.equal((await app.changesets.listChangesets({ limit: 100 })).length, 1);
});

test("E2E preview: signed candidate renders with security headers; tamper rejected (#148)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await fullStack(t);
  const ctx = apiContextOf(
    scopedActor(["content.create", "revision.seal", "preview.create"]),
    "rest",
    "req_prev",
  );
  const { createDraft, sealRevision, createThemePreview } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "article",
    payload: VALID_PAYLOAD(),
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  const preview = await createThemePreview(app, ctx, {
    scope: {
      kind: "revision",
      entity_type: "entry",
      entity_id: draft.entry_id,
      revision_id: draft.revision_id,
    },
  });

  // The signed URL is public-by-token and carries the M07 security headers.
  const rendered = await fastify.inject({
    method: "GET",
    url: `/preview?token=${encodeURIComponent(preview.token)}`,
  });
  assert.equal(rendered.statusCode, 200, rendered.body);
  assert.equal(rendered.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(rendered.headers["referrer-policy"], "no-referrer");
  assert.equal(rendered.headers["cache-control"], "private, no-store");
  const body = rendered.json() as {
    preview: { entities: { revision: { payload: { fields: { title: string } } } | null }[] };
  };
  assert.equal(body.preview.entities[0]!.revision!.payload.fields.title, "E2E article");

  // Tampered tokens fail closed.
  const tampered = await fastify.inject({
    method: "GET",
    url: `/preview?token=${encodeURIComponent(`${preview.token}x`)}`,
  });
  assert.equal(tampered.statusCode, 404);
  assert.equal(tampered.headers["cache-control"], "private, no-store");
  const garbage = await fastify.inject({ method: "GET", url: "/preview?token=garbage" });
  assert.equal(garbage.statusCode, 404);
});

test("E2E MCP: tool discovery → semantic operation → structured result (#148)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await fullStack(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "e2e-mcp",
    purpose: "mcp workflow",
    allowedScopes: ["content.read", "content.create"],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.read", "content.create"],
    ttlMilliseconds: 3_600_000,
  });
  const headers = { authorization: `Bearer ${token.rawSecret}` };

  const init = await fastify.inject({
    method: "POST",
    url: "/mcp",
    headers,
    payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  assert.equal(init.statusCode, 200);
  const listing = await fastify.inject({
    method: "POST",
    url: "/mcp",
    headers,
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  const toolNames = (listing.json() as { result: { tools: { name: string }[] } }).result.tools.map(
    (tool) => tool.name,
  );
  assert.ok(toolNames.includes("cms_get_current_actor"));

  const actorCall = await fastify.inject({
    method: "POST",
    url: "/mcp",
    headers,
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "cms_get_current_actor" },
    },
  });
  const actor = (
    actorCall.json() as {
      result: { structuredContent: { actor_type: string; permissions: string[] } };
    }
  ).result.structuredContent;
  assert.equal(actor.actor_type, "SERVICE_ACCOUNT");
  assert.deepEqual(actor.permissions, ["content.create", "content.read"]);
});
