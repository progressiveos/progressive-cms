import assert from "node:assert/strict";
import { test } from "node:test";
import { type ApplicationServices, bindOperations, type OperationContext } from "@pcms/api";
import { createAuthorizationService } from "@pcms/auth";
import { createMcpServer, type McpOperations, TOOLS } from "@pcms/mcp";

function fixture() {
  const authorization = createAuthorizationService();
  const seen: string[] = [];
  const app = {
    defaultSiteKey: "site-a",
    authorization,
    authorize: (actor: OperationContext["actor"], permission: string) => {
      seen.push(permission);
      authorization.authorize(actor, permission);
    },
    revisions: {
      listRevisions: async () => {
        seen.push("store");
        return [{ id: "private-revision" }];
      },
      getRevision: async () => {
        seen.push("store");
        return { id: "private-revision" };
      },
    },
    contentDiscovery: {
      listContentTypes: () => {
        seen.push("store");
        return [];
      },
    },
    searchAdmin: async () => {
      seen.push("store");
      return { items: [] };
    },
    searchQuery: async () => ({ items: [] }),
    routes: { findSiteByKey: async (site: string) => ({ id: site }) },
    domains: { listDomainBindings: async () => [] },
    formsSource: {
      export: {
        export: async (input: { entity: string }) => {
          seen.push(`export:${input.entity}`);
          return {};
        },
      },
    },
  } as unknown as ApplicationServices;
  const operations = bindOperations(app) as unknown as McpOperations;
  const server = createMcpServer({ operations, serverInfo: { name: "test", version: "1" } });
  const ctx = (permissions: string[], siteKey: string | null = "site-a"): OperationContext => ({
    actor: {
      type: "SERVICE_ACCOUNT",
      id: "test",
      permissions: new Set(permissions),
      siteKey,
      environment: "test",
      sessionId: null,
      strength: { factors: ["access_token"], authenticatedAt: new Date(), mfaAt: null },
    },
    transport: "mcp",
    requestId: "test",
  });
  const call = async (
    name: string,
    args: object,
    permissions: string[],
    siteKey: string | null = "site-a",
  ) => {
    const response = await server.handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      () => ctx(permissions, siteKey),
    );
    return (
      response as {
        result: {
          isError: boolean;
          structuredContent: { error?: { code: string }; items?: unknown[] };
        };
      }
    ).result;
  };
  return { app, operations, server, seen, ctx, call };
}

test("MCP actual server/tool/binding gates direct reads before any store access", async () => {
  const { call, seen, app } = fixture();
  for (const [name, permission, args] of [
    ["cms_list_revisions", "publication.read", { entity_type: "entry", entity_id: "id" }],
    ["cms_list_content_types", "content.read", {}],
  ] as const) {
    seen.length = 0;
    const denied = await call(name, args, []);
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error?.code, "AUTH_PERMISSION_DENIED");
    assert.ok(!seen.includes("store"));
    const allowed = await call(name, args, [permission]);
    assert.equal(allowed.isError, false);
    assert.ok(seen.includes("store"));
    seen.length = 0;
    const otherSite = await call(name, args, [permission], "site-b");
    assert.equal(otherSite.structuredContent.error?.code, "AUTH_TOKEN_SITE_DENIED");
    assert.ok(!seen.includes("store"));
  }
  // The application authorizer remains authoritative even if actor metadata grants the scope.
  app.authorize = () => {
    throw Object.assign(new Error("denied by policy"), { code: "AUTH_PERMISSION_DENIED" });
  };
  seen.length = 0;
  assert.equal(
    (
      await call("cms_list_revisions", { entity_type: "entry", entity_id: "id" }, [
        "publication.read",
      ])
    ).structuredContent.error?.code,
    "AUTH_PERMISSION_DENIED",
  );
  assert.ok(!seen.includes("store"));
});

test("MCP explicit Core site scope and dynamic extension business payload remain distinct", async () => {
  const { call, operations, ctx } = fixture();
  assert.equal(
    (
      await call(
        "cms_search_admin",
        { q: "x", locale: "ru", site: "site-b" },
        ["search.admin"],
        "site-b",
      )
    ).isError,
    false,
  );
  assert.equal(
    (await call("cms_search_admin", { q: "x", locale: "ru", site: "site-b" }, ["search.admin"]))
      .structuredContent.error?.code,
    "AUTH_TOKEN_SITE_DENIED",
  );
  const server = createMcpServer({
    operations,
    serverInfo: { name: "test", version: "1" },
    dynamicTools: () => [
      {
        name: "cms_ext_test_operation",
        description: "Business site field",
        permission: "content.read",
        mutation: false,
        inputSchema: {},
        run: async (_ops, _ctx, args) => args,
      },
    ],
  });
  const result = await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cms_ext_test_operation", arguments: { site: "business-payload" } },
    },
    () => ctx(["content.read"]),
  );
  assert.equal((result as { result: { isError: boolean } }).result.isError, false);
  assert.equal((await call("cms_search_query", { q: "x", locale: "ru" }, [])).isError, false);
});

test("MCP protected tools fail closed without trusted authorizer; leads export keeps its own scope", async () => {
  const { operations, ctx, seen } = fixture();
  const server = createMcpServer({ operations, serverInfo: { name: "test", version: "1" } });
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "cms_export_interactions", arguments: { entity: "leads" } },
  };
  const result = await server.handleRequest(request, () => ctx(["leads.export"]));
  assert.equal((result as { result: { isError: boolean } }).result.isError, false);
  assert.ok(seen.includes("export:leads"));
  const unsecured = createMcpServer({
    operations: {} as McpOperations,
    serverInfo: { name: "test", version: "1" },
  });
  const denied = await unsecured.handleRequest(request, () => ctx(["leads.export"]));
  assert.equal(
    (denied as { result: { structuredContent: { error: { code: string } } } }).result
      .structuredContent.error.code,
    "AUTH_PERMISSION_DENIED",
  );
});

test("MCP awaits authoritative permission and site denials before every protected tool", async () => {
  const { app, call, seen } = fixture();
  const protectedTools = TOOLS.filter((tool) => tool.permission !== undefined);
  const permissions = protectedTools.flatMap((tool) => tool.permission ?? []);
  let checks = 0;
  app.authorize = async () => {
    checks += 1;
    await Promise.resolve();
    throw Object.assign(new Error("async policy denial"), { code: "AUTH_PERMISSION_DENIED" });
  };
  for (const tool of protectedTools) {
    const result = await call(tool.name, {}, permissions);
    assert.equal(result.isError, true, tool.name);
    assert.equal(result.structuredContent.error?.code, "AUTH_PERMISSION_DENIED", tool.name);
  }
  assert.equal(checks, protectedTools.length);
  assert.deepEqual(seen, []);

  app.authorize = () => {};
  app.authorization.authorizeSite = async () => {
    await Promise.resolve();
    throw Object.assign(new Error("async site denial"), { code: "AUTH_TOKEN_SITE_DENIED" });
  };
  const result = await call(
    "cms_list_revisions",
    { entity_type: "entry", entity_id: "id" },
    permissions,
  );
  assert.equal(result.structuredContent.error?.code, "AUTH_TOKEN_SITE_DENIED");
  assert.deepEqual(seen, []);
});
