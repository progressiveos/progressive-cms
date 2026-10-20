// PCMS-API-T027/T028 — cross-transport semantic equivalence and audit
// metadata / secret redaction. The same underlying operation must surface
// the same stable codes over REST, MCP and CLI (spec §64), and every request
// must remain auditable without leaking credentials (spec §61/§85).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ApiRoute,
  bindOperations,
  createApiFastify,
  createApiV1,
  createDraft,
  makeDiscoveryRoutes,
  makeMutationRoutes,
  sealRevision,
} from "@pcms/api";
import { runCli } from "@pcms/cli";
import type { McpOperations, OperationContextLike } from "@pcms/mcp";
import { createMcpServer } from "@pcms/mcp";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: { title: { id: "title", type: "string", required: true, sortable: true } },
  },
] as const;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

interface Rig {
  readonly app: Awaited<ReturnType<typeof createApiFixture>>["app"];
  readonly rest: unknown;
  readonly inject: (opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }) => Promise<{ statusCode: number; body: string }>;
  readonly mcp: (
    name: string,
    args: Record<string, unknown>,
    ctx: OperationContextLike,
  ) => Promise<{ isError: boolean; structuredContent: Record<string, unknown> }>;
}

async function rig(t: { after: (fn: () => void) => void }): Promise<Rig> {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
  });
  const fastify = createApiFastify(() => "req_equiv");
  await fastify.register(createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes()]), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });

  const operations = bindOperations(app) as unknown as McpOperations;
  const server = createMcpServer({
    operations,
    serverInfo: { name: "progressive-cms-mcp", version: "1.0.0" },
  });

  return {
    app,
    rest: null,
    inject: (opts) => fastify.inject(opts as never) as never,
    mcp: async (name, args, ctx) => {
      const response = (await server.handleRequest(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        () => ctx,
      )) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
      return response.result;
    },
  };
}

const OWNER = () => apiContextOf(ownerActor(), "rest", "req_rest");
const AGENT_MCP = () =>
  apiContextOf(
    scopedActor(["content.read", "content.create", "content.edit", "revision.seal"]),
    "mcp",
    "req_mcp",
  );

test("seal validation is identical across REST, MCP and CLI (T027)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, inject, mcp } = await rig(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "equiv-rest",
    purpose: "equivalence",
    allowedScopes: ["content.create", "content.edit", "revision.seal"],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.create", "content.edit", "revision.seal"],
    ttlMilliseconds: 3_600_000,
  });
  const headers = { authorization: `Bearer ${token.rawSecret}` };

  // REST: create + seal an invalid draft.
  const draft = await inject({
    method: "POST",
    url: "/api/v1/entries",
    headers,
    payload: {
      content_type: "page",
      payload: { fields: {}, blocks: { schema_version: 1, blocks: [] } },
    },
  });
  assert.equal(draft.statusCode, 201);
  const { revision_id } = JSON.parse(draft.body) as { revision_id: string };
  const seal = await inject({
    method: "POST",
    url: `/api/v1/revisions/${revision_id}/seal`,
    headers,
    payload: {},
  });
  assert.equal(seal.statusCode, 422);
  const sealBody = JSON.parse(seal.body) as {
    error: { code: string; details: { code: string }[] };
  };
  assert.equal(sealBody.error.code, "REVISION_VALIDATION_FAILED");
  assert.ok(sealBody.error.details.some((issue) => issue.code === "FIELD_REQUIRED"));

  // MCP: the same seal on a fresh invalid draft via the tool.
  const mcpDraft = await mcp(
    "cms_create_draft",
    { content_type: "page", payload: { fields: {}, blocks: { schema_version: 1, blocks: [] } } },
    AGENT_MCP(),
  );
  assert.equal(mcpDraft.isError, false);
  const mcpSeal = await mcp(
    "cms_seal_revision",
    { revision_id: (mcpDraft.structuredContent as { revision_id: string }).revision_id },
    AGENT_MCP(),
  );
  assert.equal(mcpSeal.isError, true);
  const mcpError = mcpSeal.structuredContent["error"] as {
    code: string;
    details: { code: string }[];
  };
  assert.equal(mcpError.code, "REVISION_VALIDATION_FAILED");
  assert.ok(mcpError.details.some((issue) => issue.code === "FIELD_REQUIRED"));

  // CLI: the same publish-level validation locally (content validate).
  const dir = mkdtempSync(join(tmpdir(), "pcms-equiv-"));
  const typesFile = join(dir, "types.json");
  writeFileSync(typesFile, JSON.stringify(CONTENT_TYPES));
  const configFile = join(dir, "pcms.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      nodeEnv: "test",
      http: { host: "127.0.0.1", port: 3000, shutdownTimeoutMilliseconds: 1000 },
      db: {
        host: "127.0.0.1",
        port: 5432,
        database: "pcms",
        user: "pcms",
        sslMode: "disable",
        migrationsDir: "db/migrations",
        pool: {
          webMax: 1,
          workerMax: 1,
          connectionTimeoutMilliseconds: 1000,
          idleTimeoutMilliseconds: 1000,
        },
      },
      log: { level: "info" },
      secrets: {},
      content: { typesFile },
    }),
  );
  const payloadFile = join(dir, "payload.json");
  writeFileSync(
    payloadFile,
    JSON.stringify({
      content_type: "page",
      payload: { fields: {}, blocks: { schema_version: 1, blocks: [] } },
    }),
  );
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PCMS_")) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  const cli = await runCli(["content", "validate", payloadFile, "--json", "--config", configFile]);
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
  }
  assert.equal(cli.exitCode, 3);
  const cliReport = JSON.parse(cli.stdout) as { issues: { code: string }[] };
  assert.ok(cliReport.issues.some((issue) => issue.code === "FIELD_REQUIRED"));
  rmSync(dir, { recursive: true, force: true });

  void sealRevision;
});

test("permission denial carries the same stable code over REST and MCP (T027)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, inject, mcp } = await rig(t);
  const account = await app.machineIdentity.createServiceAccount({
    name: "equiv-content-only",
    purpose: "equivalence",
    allowedScopes: ["content.read"],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["content.read"],
    ttlMilliseconds: 3_600_000,
  });
  const rest = await inject({
    method: "POST",
    url: "/api/v1/publications/publish",
    headers: { authorization: `Bearer ${token.rawSecret}` },
    payload: {
      entity_type: "entry",
      entity_id: "01900000-0000-7000-8000-000000000001",
      target_revision_id: "01900000-0000-7000-8000-000000000002",
      expected_generation: 0,
    },
  });
  assert.equal(rest.statusCode, 403);
  assert.equal(
    (JSON.parse(rest.body) as { error: { code: string } }).error.code,
    "AUTH_PERMISSION_DENIED",
  );

  const mcpResult = await mcp(
    "cms_publish_revision",
    {
      entity_type: "entry",
      entity_id: "01900000-0000-7000-8000-000000000001",
      target_revision_id: "01900000-0000-7000-8000-000000000002",
      expected_generation: 0,
    },
    apiContextOf(scopedActor(["content.read"]), "mcp", "req_mcp"),
  );
  assert.equal(mcpResult.isError, true);
  assert.equal(
    (mcpResult.structuredContent["error"] as { code: string }).code,
    "AUTH_PERMISSION_DENIED",
  );
});

test("audit metadata: request ids ride revisions; login events carry the transport (T028)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
  });
  // Application write with the REST context: the revision row records the
  // request id (source_run_id) and the actor class (spec §61/§75).
  const ctx = apiContextOf(ownerActor(), "rest", "req_audit_123");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "audit" }, blocks: { schema_version: 1, blocks: [] } },
  });
  const sealed = await sealRevision(app, ctx, { revision_id: draft.revision_id });
  assert.equal(sealed.origin, "human");
  assert.equal(sealed.sourceRunId, "req_audit_123");

  // MCP transport marks its own writes distinctly.
  const mcpCtx = apiContextOf(ownerActor(), "mcp", "req_audit_mcp");
  const mcpDraft = await createDraft(app, mcpCtx, {
    content_type: "page",
    payload: { fields: { title: "audit mcp" }, blocks: { schema_version: 1, blocks: [] } },
  });
  const mcpSealed = await sealRevision(app, mcpCtx, { revision_id: mcpDraft.revision_id });
  assert.equal(mcpSealed.sourceRunId, "req_audit_mcp");

  // Login events name the transport (M08 security events).
  const { createProvisioningService, createRoleService } = await import("@pcms/auth");
  const provisioning = createProvisioningService(app.pool, {
    users: app.users,
    passwords: app.passwords,
    policy: app.passwordPolicy,
    roles: createRoleService(app.pool),
  });
  await provisioning.bootstrapOwner({
    displayName: "Audit Owner",
    email: "audit@m09.test",
    password: "correct-horse-battery-staple-9!",
  });
  await app.authentication.login({
    email: "audit@m09.test",
    password: "correct-horse-battery-staple-9!",
    transport: "api",
  });
  const events = await app.pool.query<{ event_type: string; transport: string }>(
    `SELECT event_type, transport FROM auth_security_events
     WHERE event_type = 'LOGIN_SUCCESS' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(events.rows[0]!.transport, "api");
});

test("transport logs never contain credentials or tokens (T028 redaction)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...CONTENT_TYPES],
  });
  const captured: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const recordingLogger = {
    info: (message: string, fields: Record<string, unknown>) => {
      captured.push({ level: "info", message, fields });
    },
    warn: () => {},
    error: (message: string, fields: Record<string, unknown>) => {
      captured.push({ level: "error", message, fields });
    },
    debug: () => {},
  } as never;

  const fastify = createApiFastify(() => "req_redact");
  await fastify.register(
    createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes()] as ApiRoute[]),
    {
      application: app,
      logger: recordingLogger,
      cookieSecure: false,
    },
  );

  const secret = "pcms_aaaa1111_supersecretvalue";
  await fastify.inject({
    method: "GET",
    url: "/api/v1/server",
    headers: {
      authorization: `Bearer ${secret}`,
      cookie: "pcms_session=leak-attempt; x-pcms-csrf=tok",
    },
  });
  await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "x@y.test", password: "password-hunter2" },
  });

  const rendered = JSON.stringify(captured);
  assert.ok(captured.length > 0, "requests produced log lines");
  for (const forbidden of [secret, "leak-attempt", "password-hunter2", "authorization"]) {
    assert.ok(!rendered.includes(forbidden), `log corpus must not contain "${forbidden}"`);
  }
  void app;
});
