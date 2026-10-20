// MCP server handler (PCMS-API-T019; API spec §16/§48).
// Transport-independent: the composition root resolves the ActorContext from
// the transport credential (bearer token over HTTP) and passes a context
// factory — every tools/call is executed against a fresh, authenticated
// context. No implicit localhost trust, no privileged mode (spec §50/#50).

import { projectError } from "./errors.js";
import type { McpOperations, OperationContextLike } from "./operations.js";
import {
  JSON_RPC_ERROR,
  type JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  parseJsonRpc,
  rpcError,
  rpcResult,
} from "./protocol.js";
import { findTool, type McpTool, toolsListPayload } from "./tools.js";

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpServer {
  handleRequest(
    body: unknown,
    contextFactory: () => Promise<OperationContextLike> | OperationContextLike,
  ): Promise<JsonRpcResponse | null>;
}

export function createMcpServer(deps: {
  readonly operations: McpOperations;
  readonly serverInfo: McpServerInfo;
  /**
   * ADR-0013: tools derived at request time from enabled deployed extension
   * operations (cms_ext_*). Recomputed per tools/list so a disable removes
   * tools promptly; collisions with core tools fail closed (toolsListPayload).
   */
  readonly dynamicTools?: () => readonly McpTool[] | Promise<readonly McpTool[]>;
}): McpServer {
  return {
    /** Handles one JSON-RPC request. Returns null for notifications (no reply). */
    async handleRequest(body, contextFactory) {
      const request = parseJsonRpc(body);
      if (request === null) {
        return rpcError(null, JSON_RPC_ERROR.INVALID_REQUEST, "not a JSON-RPC 2.0 request");
      }
      switch (request.method) {
        case "initialize":
          return rpcResult(request.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: deps.serverInfo.name, version: deps.serverInfo.version },
          });
        case "ping":
          return rpcResult(request.id, {});
        case "tools/list":
          return rpcResult(request.id, { tools: toolsListPayload(await deps.dynamicTools?.()) });
        case "tools/call": {
          const params = request.params ?? {};
          const name = params["name"];
          if (typeof name !== "string") {
            return rpcError(
              request.id,
              JSON_RPC_ERROR.INVALID_PARAMS,
              "tools/call requires a tool name",
            );
          }
          const tool = findTool(name, await deps.dynamicTools?.());
          if (tool === null) {
            // Unknown tools are structured failures, not protocol errors —
            // agents can recover by listing tools (spec §49 discovery-first).
            return rpcResult(request.id, {
              content: [
                { type: "text", text: JSON.stringify({ error: { code: "TOOL_NOT_FOUND" } }) },
              ],
              structuredContent: {
                error: { code: "TOOL_NOT_FOUND", message: `no tool "${name}"` },
              },
              isError: true,
            });
          }
          const args = (params["arguments"] ?? {}) as Record<string, unknown>;
          try {
            const ctx = await contextFactory();
            const permission = tool.permissionFor?.(args) ?? tool.permission;
            if (permission !== undefined) {
              if (deps.operations.authorizeTool === undefined) {
                throw Object.assign(new Error("trusted MCP authorizer is unavailable"), {
                  code: "AUTH_PERMISSION_DENIED",
                });
              }
              await deps.operations.authorizeTool(
                ctx,
                permission,
                tool.siteArgument === true && typeof args["site"] === "string"
                  ? args["site"]
                  : undefined,
              );
            }
            const result = await tool.run(deps.operations, ctx, args);
            const text = JSON.stringify(result);
            return rpcResult(request.id, {
              content: [{ type: "text", text }],
              structuredContent: result as Record<string, unknown>,
              isError: false,
            });
          } catch (error) {
            // Stable domain codes stay machine-readable inside the tool
            // result (spec §52): retryable + conflict generation survive.
            const projection = projectError(error);
            const text = JSON.stringify({ error: projection });
            return rpcResult(request.id, {
              content: [{ type: "text", text }],
              structuredContent: { error: projection },
              isError: true,
            });
          }
        }
        default:
          return rpcError(
            request.id,
            JSON_RPC_ERROR.METHOD_NOT_FOUND,
            `method "${request.method}" is not supported`,
          );
      }
    },
  };
}
