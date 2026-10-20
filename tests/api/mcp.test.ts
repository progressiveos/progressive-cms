// PCMS-API-T019..T021 — MCP server over the shared application surface:
// protocol surface, tool auth (no superuser shortcut), structured errors with
// stable codes, and the golden tool-contract fixture (minor-release gate).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { bindOperations, createDraft } from "@pcms/api";
import type { ActorContext } from "@pcms/auth";
import {
  createMcpServer,
  MCP_PROTOCOL_VERSION,
  type McpOperations,
  type OperationContextLike,
  TOOLS,
  toolsListPayload,
} from "@pcms/mcp";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const FIXTURE_PATH = "fixtures/mcp/tool-contract-v1.json";
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

const REFERENCE_CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: { title: { id: "title", type: "string", required: true, sortable: true } },
  },
] as const;

async function mcpFixture(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: [...REFERENCE_CONTENT_TYPES],
  });
  const operations = bindOperations(app) as unknown as McpOperations;
  const server = createMcpServer({
    operations,
    serverInfo: { name: "progressive-cms-mcp", version: "1.0.0" },
  });
  return { app, operations, server };
}

function ctxOf(makeActor: () => ActorContext): OperationContextLike {
  return apiContextOf(makeActor(), "mcp", "req_mcp");
}

test("MCP plan preview forwards per-item overrides to the shared operation", async () => {
  const tool = TOOLS.find((candidate) => candidate.name === "cms_preview_plan");
  assert.ok(tool);
  let received: unknown;
  const operations = {
    previewPlan: async (_ctx: OperationContextLike, input: unknown) => {
      received = input;
      return [];
    },
  } as unknown as McpOperations;
  const overrides = [
    {
      changeset_item_id: "01900000-0000-7000-8000-000000000001",
      publish_at: "2030-01-01T10:00:00Z",
    },
  ];
  await tool.run(operations, {} as OperationContextLike, {
    plan_id: "01900000-0000-7000-8000-000000000002",
    spec: { startAt: "2030-01-01T10:00:00Z", batchSize: 1, interval: { unit: "days", value: 1 } },
    overrides,
  });
  assert.deepEqual((received as { overrides: unknown[] }).overrides, overrides);
});

test("MCP protocol: initialize + tools/list; unknown method rejected (T019)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { server } = await mcpFixture(t);
  const ctx = ctxOf(ownerActor);
  const init = (await server.handleRequest(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    () => ctx,
  )) as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(init.result.protocolVersion, MCP_PROTOCOL_VERSION);

  const listing = (await server.handleRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    () => ctx,
  )) as { result: { tools: { name: string }[] } };
  assert.ok(listing.result.tools.length >= 25);
  assert.ok(listing.result.tools.some((tool) => tool.name === "cms_get_capabilities"));

  const bogus = (await server.handleRequest(
    { jsonrpc: "2.0", id: 3, method: "resources/read" },
    () => ctx,
  )) as { error: { code: number } };
  assert.equal(bogus.error.code, -32601);

  const malformed = (await server.handleRequest({ jsonrpc: "1.0", method: "x" }, () => ctx)) as {
    error: { code: number };
  };
  assert.equal(malformed.error.code, -32600);
});

test("MCP tools call the same application operations with the same permissions (T020)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, server } = await mcpFixture(t);

  // A content-scoped agent discovers → drafts → validates → seals.
  const agent = ctxOf(() =>
    scopedActor(["content.read", "content.create", "content.edit", "revision.seal"]),
  );
  const types = (await server.handleRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cms_list_content_types" } },
    () => agent,
  )) as { result: { structuredContent: { items: unknown[] }; isError: boolean } };
  assert.equal(types.result.isError, false);
  void app;

  const draft = (await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "cms_create_draft",
        arguments: {
          content_type: "page",
          payload: { fields: { title: "MCP page" }, blocks: { schema_version: 1, blocks: [] } },
        },
      },
    },
    () => agent,
  )) as {
    result: { structuredContent: { entry_id: string; revision_id: string }; isError: boolean };
  };
  assert.equal(draft.result.isError, false);
  assert.ok(draft.result.structuredContent.entry_id);

  // A tool outside the actor's permission: structured stable error, not prose.
  const denied = (await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "cms_publish_revision",
        arguments: {
          entity_type: "entry",
          entity_id: draft.result.structuredContent.entry_id,
          target_revision_id: draft.result.structuredContent.revision_id,
          expected_generation: 0,
        },
      },
    },
    () => agent,
  )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.error.code, "AUTH_PERMISSION_DENIED");

  // Unknown tool: structured TOOL_NOT_FOUND.
  const unknown = (await server.handleRequest(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "execute_sql" } },
    () => agent,
  )) as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.structuredContent.error.code, "TOOL_NOT_FOUND");
});

test("MCP error projection preserves stable domain codes with CAS details (T020/T052)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, operations, server } = await mcpFixture(t);
  const ctx = ctxOf(ownerActor);
  const draft = await operations.createDraft(ctx, {
    content_type: "page",
    payload: { fields: { title: "v1" }, blocks: { schema_version: 1, blocks: [] } },
  } as never);
  // First autosave at generation 0 succeeds; a replay must be REVISION_STALE.
  await operations.updateDraft(ctx, {
    revision_id: (draft as { revision_id: string }).revision_id,
    payload: { fields: { title: "v2" }, blocks: { schema_version: 1, blocks: [] } },
    expected_edit_generation: 0,
  } as never);
  const stale = (await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "cms_update_draft",
        arguments: {
          revision_id: (draft as { revision_id: string }).revision_id,
          payload: { fields: { title: "v3" }, blocks: { schema_version: 1, blocks: [] } },
          expected_edit_generation: 0,
        },
      },
    },
    () => ctx,
  )) as {
    result: { isError: boolean; structuredContent: { error: { code: string; details: unknown } } };
  };
  assert.equal(stale.result.isError, true);
  assert.equal(stale.result.structuredContent.error.code, "REVISION_STALE");
  void app;
});

test("golden tool-contract fixture pins names, schemas and permissions (T021)", async (t) => {
  const tools = toolsListPayload();
  // The fixture is a generated canonical artifact (owner instruction #139).
  const generated =
    JSON.stringify({ mcp_protocol_version: MCP_PROTOCOL_VERSION, tools }, null, 2) + "\n";
  if (process.env["PCMS_UPDATE_MCP_FIXTURE"] === "1") {
    writeFileSync(FIXTURE_PATH, generated);
    t.skip("fixture regenerated");
    return;
  }
  let frozen: string;
  try {
    frozen = readFileSync(FIXTURE_PATH, "utf8");
  } catch {
    frozen = "";
  }
  if (frozen === "") {
    writeFileSync(FIXTURE_PATH, generated);
    return; // first run materializes the baseline
  }
  assert.equal(
    generated,
    frozen,
    "MCP tool contract drifted: regenerate fixtures/mcp/tool-contract-v1.json deliberately (PCMS_UPDATE_MCP_FIXTURE=1) and review the diff as a contract change",
  );
});

test("tool names follow the stable cms_* contract (spec §50)", () => {
  const names = toolsListPayload().map((tool) => tool.name);
  for (const required of [
    "cms_get_capabilities",
    "cms_list_content_types",
    "cms_get_content_type",
    "cms_create_draft",
    "cms_validate_revision",
    "cms_create_preview",
    "cms_create_changeset",
    "cms_schedule_plan",
    "cms_validate_theme",
    "cms_get_current_actor",
  ]) {
    assert.ok(names.includes(required), `missing required tool ${required}`);
  }
  // Read/write separation is annotated for harnesses (spec §25).
  const readOnly = toolsListPayload().filter(
    (tool) => (tool["annotations"] as { readOnlyHint: boolean }).readOnlyHint,
  );
  assert.ok(readOnly.length >= 15);
  void createDraft;
});
