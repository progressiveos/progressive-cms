import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApplicationServices, createApiFastify, createApiV1 } from "@pcms/api";
import { type ActorContext, assertTokenConstraints, createAuthorizationService } from "@pcms/auth";
import { runCli } from "@pcms/cli";
import { createLogger } from "@pcms/core";
import { apiCall, resolveApiClient } from "../../packages/cli/src/api-client.js";

test("CLI shared client and commands preserve explicit tenant headers and server authorization", async (t) => {
  const permissions = new Set(["theme.read"]);
  const actor: ActorContext = {
    type: "SERVICE_ACCOUNT",
    id: "fixture",
    siteKey: "site-a",
    environment: "production",
    permissions,
    sessionId: null,
    strength: { factors: ["access_token"], authenticatedAt: new Date(), mfaAt: null },
  };
  const authorization = createAuthorizationService();
  const app = {
    actorResolver: {
      async authenticateToken(token: string, context: { siteKey: string; environment: string }) {
        assert.equal(token, "fixture-token");
        assertTokenConstraints(actor, context);
        return { actor };
      },
    },
  } as unknown as ApplicationServices;
  const server = createApiFastify(() => "cli-context");
  t.after(() => server.close());
  const paths = [
    "/agent/bootstrap",
    "/themes/active",
    "/search/status",
    "/search",
    "/search/reindex",
  ];
  await server.register(
    createApiV1(
      paths.map((url) => ({
        spec: {
          method: url === "/search/reindex" ? ("POST" as const) : ("GET" as const),
          url,
          operationId: `fixture_${url.replaceAll("/", "_")}`,
          summary: "CLI transport fixture",
          tag: "themes" as const,
          auth: "authenticated" as const,
        },
        async handle(_app, ctx) {
          authorization.authorize(ctx.actor, "theme.read");
          return { status: 200, body: { id: "fixture", version: "1.0.0", items: [], total: 0 } };
        },
      })),
    ),
    { application: app, logger: createLogger({ level: "error", base: {} }), cookieSecure: false },
  );
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const env = {
    PCMS_API_URL: baseUrl,
    PCMS_API_TOKEN: "fixture-token",
    PCMS_SITE_KEY: "site-a",
    PCMS_ENVIRONMENT: "production",
  };
  const saved = Object.keys(env).map((key) => process.env[key]);
  Object.assign(process.env, env);
  t.after(() =>
    Object.keys(env).forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    }),
  );
  const commands = [
    ["agent", "bootstrap"],
    ["theme", "active"],
    ["search", "status"],
    ["search", "query", "test"],
    ["search", "reindex", "--yes"],
  ];
  for (const command of commands) {
    const success = await runCli([
      ...command,
      "--site",
      "site-a",
      "--environment",
      "production",
      "--json",
    ]);
    assert.equal(success.exitCode, 0, success.stderr || success.stdout);
    for (const [site, environment, code] of [
      ["other", "production", "AUTH_TOKEN_SITE_DENIED"],
      ["site-a", "staging", "AUTH_TOKEN_ENVIRONMENT_DENIED"],
    ]) {
      const denied = await runCli([
        ...command,
        "--site",
        site!,
        "--environment",
        environment!,
        "--json",
      ]);
      assert.equal(denied.exitCode, 5);
      assert.equal(JSON.parse(denied.stdout).error.code, code);
    }
  }
  const options = { json: true, yes: false };
  assert.equal(
    typeof resolveApiClient(options, { PCMS_API_URL: baseUrl, PCMS_API_TOKEN: "fixture-token" }),
    "string",
  );
  for (const missing of [{ PCMS_SITE_KEY: "" }, { PCMS_ENVIRONMENT: "" }]) {
    assert.equal(typeof resolveApiClient(options, { ...env, ...missing }), "string");
  }
  const client = resolveApiClient(options, env);
  assert.notEqual(typeof client, "string");
  if (typeof client === "string") throw new Error(client);
  assert.equal((await apiCall(client, "GET", "/themes/active")).ok, true);
  permissions.clear();
  const forbidden = await apiCall(client, "GET", "/themes/active");
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok)
    assert.equal(JSON.parse(forbidden.result.stdout).error.code, "AUTH_PERMISSION_DENIED");
});
