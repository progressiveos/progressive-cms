import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { bindOperations, createApiFastify, createApiV1 } from "@pcms/api";
import { createLogger } from "@pcms/core";
import { createMcpServer, type McpOperations } from "@pcms/mcp";
import { makeInteractionPrivacyRoutes } from "../../packages/api/src/http/routes/interaction-privacy.js";
import { interactionPrivacyCommand } from "../../packages/cli/src/commands/interaction-privacy.js";
import { apiContextOf, ownerActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";

test("privacy real private-schema REST apply, CLI receipt and MCP unblock round trip", {
  skip: !process.env.PCMS_TEST_DATABASE_URL,
}, async (t) => {
  const { app } = await rollbackApiFixture(t, {});
  const definition = await app.formsSource.domain.definitions.createDefinition({
    key: "privacy_surfaces",
    title: "Synthetic privacy",
    fields: [{ key: "email", type: "email", label: "Email", required: true }],
    settings: { lead_policy: { create_lead: true, email_from: "email" } },
  });
  const submitted = await app.formsSource.publicForm.submit({
    form_definition_id: definition.id,
    values: { email: "synthetic@example.invalid" },
  });
  const account = await app.machineIdentity.createServiceAccount({
    name: "privacy-surfaces",
    purpose: "synthetic test",
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["privacy.manage"],
    ttlMilliseconds: 60000,
    siteKey: "default",
    environment: "test",
  });
  const server = createApiFastify(() => "privacy-runtime");
  t.after(() => server.close());
  await server.register(createApiV1(makeInteractionPrivacyRoutes()), {
    application: app,
    logger: createLogger({ level: "error", base: {} }),
    cookieSecure: false,
  });
  const headers = {
    authorization: `Bearer ${token.rawSecret}`,
    "x-pcms-site": "default",
    "x-pcms-environment": "test",
  };
  const operation = {
    target: { entity: "submission", id: submitted.submission_id },
    action: "block",
  };
  const preview = await server.inject({
    method: "POST",
    url: "/api/v1/interactions/privacy/preview",
    headers,
    payload: operation,
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().lead_ids.length, 1);
  const requestId = randomUUID();
  const input = {
    ...operation,
    expected_token: preview.json().expected_token,
    request_id: requestId,
  };
  const applied = await server.inject({
    method: "POST",
    url: "/api/v1/interactions/privacy/apply",
    headers,
    payload: input,
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().local_state, "blocked");
  const retry = await server.inject({
    method: "POST",
    url: "/api/v1/interactions/privacy/apply",
    headers,
    payload: input,
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().case_id, requestId);
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    const response = await server.inject({
      method: init?.method as "GET",
      url: new URL(String(url)).pathname,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "content-type": "application/json" },
    });
  });
  const cli = await interactionPrivacyCommand({
    args: ["privacy-get", requestId],
    options: { json: true, yes: false },
    env: {
      PCMS_API_URL: "http://privacy.invalid",
      PCMS_API_TOKEN: token.rawSecret,
      PCMS_SITE_KEY: "default",
      PCMS_ENVIRONMENT: "test",
    },
  });
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).local_state, "blocked");
  const mcp = createMcpServer({
    operations: bindOperations(app) as unknown as McpOperations,
    serverInfo: { name: "test", version: "1" },
  });
  const ctx = { ...apiContextOf(ownerActor()), transport: "mcp" as const };
  const call = async (name: string, args: object) => {
    const response = await mcp.handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      () => ctx,
    );
    const result = (
      response as { result: { isError: boolean; structuredContent: Record<string, unknown> } }
    ).result;
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent;
  };
  const unblock = { ...operation, action: "unblock" };
  const fresh = await call("cms_preview_interaction_privacy", unblock);
  const unblocked = await call("cms_apply_interaction_privacy", {
    ...unblock,
    expected_token: fresh.expected_token,
    request_id: randomUUID(),
  });
  assert.equal(unblocked.local_state, "unblocked");
});
