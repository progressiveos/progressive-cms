// Minimal JSON-RPC 2.0 surface of the Model Context Protocol (PCMS-API-T019).
//
// The API spec deliberately leaves the SDK choice open ("Exact MCP SDK
// conventions chosen implementation time while preserving semantic contract",
// §49) — so v1 ships a bounded server-side adapter speaking the wire
// protocol directly: initialize / tools/list / tools/call / ping over HTTP
// POST. No shell/SQL/filesystem tools can ever exist here (spec §68).
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  readonly jsonrpc: string;
  readonly id?: number | string | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const;

/** Parses a raw request body; never throws. */
export function parseJsonRpc(body: unknown): JsonRpcRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record["jsonrpc"] !== "2.0" || typeof record["method"] !== "string") return null;
  const id = record["id"];
  return {
    jsonrpc: "2.0",
    method: record["method"],
    id: typeof id === "number" || typeof id === "string" || id === null ? id : null,
    ...(record["params"] === undefined
      ? {}
      : { params: (record["params"] ?? {}) as Record<string, unknown> }),
  };
}

export function rpcResult(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function rpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
