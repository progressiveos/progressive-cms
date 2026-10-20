// @pcms/mcp — bounded MCP server for the CMS application operations (M09).
export const PACKAGE_NAME = "@pcms/mcp";
export { domainCodeOf } from "./errors.js";
export type { McpOperations, OperationContextLike } from "./operations.js";
export type { JsonRpcRequest, JsonRpcResponse } from "./protocol.js";
export { MCP_PROTOCOL_VERSION } from "./protocol.js";
export { createMcpServer, type McpServer, type McpServerInfo } from "./server.js";
export { findTool, type McpTool, TOOLS, toolsListPayload } from "./tools.js";
