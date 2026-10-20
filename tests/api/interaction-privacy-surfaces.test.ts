import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ApplicationServices,
  bindOperations,
  createApiFastify,
  createApiV1,
  type OperationContext,
} from "@pcms/api";
import { builtinRolePermissions, createAuthorizationService } from "@pcms/auth";
import { createLogger } from "@pcms/core";
import { createMcpServer, type McpOperations } from "@pcms/mcp";
import { makeInteractionPrivacyRoutes } from "../../packages/api/src/http/routes/interaction-privacy.js";
import { hashCsrfToken } from "../../packages/auth/src/csrf.js";
import { interactionPrivacyCommand } from "../../packages/cli/src/commands/interaction-privacy.js";

const target = { entity: "submission", id: randomUUID() };
const operation = { target, action: "block" };

function fixture() {
  const authorization = createAuthorizationService();
  let actor: OperationContext["actor"] = {
    type: "USER",
    id: "owner",
    permissions: new Set(["privacy.manage"]),
    siteKey: "default",
    environment: "test",
    sessionId: "synthetic",
    strength: { factors: ["password"], authenticatedAt: new Date(), mfaAt: null },
  };
  const calls: { method: string; input: unknown }[] = [];
  const capture = (method: string, input: unknown) => {
    calls.push({ method, input });
    return Promise.resolve({
      case_id: target.id,
      expected_token: "preview",
      local_state: "blocked",
      followups: [],
    });
  };
  const app = {
    defaultSiteKey: "default",
    authorization,
    pool: {},
    authorize: (who: OperationContext["actor"], permission: string) =>
      authorization.authorize(who, permission),
    sessions: { resolveSession: async () => ({ csrfHash: hashCsrfToken("synthetic-csrf") }) },
    actorResolver: { sessionActor: async () => actor },
    interactionPrivacy: {
      preview: (input: unknown) => capture("preview", input),
      apply: (input: unknown) => capture("apply", input),
      get: (id: string) => capture("get", id),
      acknowledge: (caseId: string, deliveryId: string, input: unknown) =>
        capture("ack", { caseId, deliveryId, input }),
    },
  } as unknown as ApplicationServices;
  return {
    app,
    calls,
    ctx: (): OperationContext => ({ actor, transport: "rest", requestId: "test" }),
    setActor: (patch: Partial<OperationContext["actor"]>) => {
      actor = { ...actor, ...patch };
    },
  };
}

test("privacy REST uses session CSRF, strict schemas, owner scope/site and trusted actor", async (t) => {
  const f = fixture();
  const server = createApiFastify(() => "privacy-test");
  t.after(() => server.close());
  await server.register(createApiV1(makeInteractionPrivacyRoutes()), {
    application: f.app,
    logger: createLogger({ level: "error", base: {} }),
    cookieSecure: false,
  });
  const headers = { cookie: "pcms_session=synthetic", "x-pcms-csrf": "synthetic-csrf" };
  const send = (payload: Record<string, unknown>, extraHeaders: Record<string, string> = headers) =>
    server.inject({
      method: "POST",
      url: "/api/v1/interactions/privacy/preview",
      headers: extraHeaders,
      payload,
    });
  assert.equal(
    (await send(operation, { cookie: headers.cookie } as typeof headers)).statusCode,
    403,
  );
  assert.equal(f.calls.length, 0);
  assert.equal((await send(operation)).statusCode, 200);
  assert.equal((await send({ ...operation, actor: { id: "spoof" } })).statusCode, 400);
  assert.equal((await send({ ...operation, action: "unknown" })).statusCode, 400);
  f.setActor({ permissions: new Set(["interactions.manage", "leads.manage"]) });
  assert.equal((await send(operation)).statusCode, 403);
  f.setActor({ permissions: new Set(["privacy.manage"]), siteKey: "foreign" });
  assert.equal((await send(operation)).statusCode, 403);
  f.setActor({ siteKey: "default" });
  const applied = await server.inject({
    method: "POST",
    url: "/api/v1/interactions/privacy/apply",
    headers,
    payload: { ...operation, request_id: randomUUID(), expected_token: "preview" },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  const last = f.calls.at(-1);
  assert.ok(last);
  assert.deepEqual((last.input as { actor: unknown }).actor, {
    type: "USER",
    id: "owner",
  });
  const deniedOrigin = await send(operation, { ...headers, origin: "https://foreign.invalid" });
  assert.equal(deniedOrigin.statusCode, 403);
  assert.ok(builtinRolePermissions("OWNER").includes("privacy.manage"));
  assert.ok(!builtinRolePermissions("ADMIN").includes("privacy.manage"));
});

test("privacy MCP bindings enforce scopes/site and expose strict input schemas", async () => {
  const f = fixture();
  const server = createMcpServer({
    operations: bindOperations(f.app) as unknown as McpOperations,
    serverInfo: { name: "test", version: "1" },
  });
  const call = async (args: object) =>
    server.handleRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "cms_preview_interaction_privacy", arguments: args },
      },
      () => ({ ...f.ctx(), transport: "mcp" }),
    );
  const textOf = (value: unknown) => JSON.stringify(value);
  assert.ok(!textOf(await call(operation)).includes('"isError":true'));
  f.setActor({ permissions: new Set(["interactions.manage"]) });
  assert.match(textOf(await call(operation)), /AUTH_PERMISSION_DENIED/);
  f.setActor({ permissions: new Set(["privacy.manage"]), siteKey: "foreign" });
  assert.match(textOf(await call(operation)), /AUTH_TOKEN_SITE_DENIED/);
  f.setActor({ siteKey: "default" });
  assert.match(textOf(await call({ ...operation, actor: "spoof" })), /PRIVACY_OPERATION_INVALID/);
});

test("privacy CLI requires explicit write confirmation, uses site headers and transports full request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pcms-privacy-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "request.json");
  const input = { ...operation, request_id: randomUUID(), expected_token: "preview" };
  await writeFile(file, JSON.stringify(input));
  const env = {
    PCMS_API_URL: "https://example.invalid",
    PCMS_API_TOKEN: "synthetic",
    PCMS_SITE_KEY: "default",
    PCMS_ENVIRONMENT: "test",
  };
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json({ case_id: input.request_id });
  });
  const denied = await interactionPrivacyCommand({
    args: ["privacy-apply", file],
    options: { json: true, yes: false },
    env,
  });
  assert.notEqual(denied.exitCode, 0);
  assert.equal(calls.length, 0);
  const applied = await interactionPrivacyCommand({
    args: ["privacy-apply", file],
    options: { json: true, yes: true, environment: "test" },
    env,
  });
  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), input);
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-pcms-site"), "default");
  const badPath = await interactionPrivacyCommand({
    args: ["privacy-get", "../escape"],
    options: { json: true, yes: false },
    env,
  });
  assert.notEqual(badPath.exitCode, 0);
  assert.equal(calls.length, 1);
});
