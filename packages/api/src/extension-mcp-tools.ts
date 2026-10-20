// Derived MCP tools for typed extension application operations (ADR-0013,
// Extensions spec §52.3). The result is structurally a @pcms/mcp McpTool —
// @pcms/api cannot import that type (L2→L2 forbidden), so the composition
// root passes these into createMcpServer({ dynamicTools }) where TypeScript
// verifies the match. Names are deterministic and sanitized; cross-tool
// collisions fail closed in toolsListPayload.
import type { ApplicationServices, OperationContext } from "./context.js";

/** Structural subset of @pcms/mcp's McpOperations the derived tools need. */
export interface ExtensionToolOperations {
  invokeExtensionOperation(
    ctx: OperationContext,
    input: { extension_id: string; operation_id: string; input: unknown },
  ): Promise<unknown>;
}

export interface ExtensionMcpTool {
  readonly name: string;
  readonly description: string;
  readonly permission?: string;
  readonly mutation: boolean;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (
    operations: ExtensionToolOperations,
    ctx: OperationContext,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** Reverse-DNS extension id → single tool-name-safe label (collision-safe:
 * all non-alphanumerics collapse, so the composition checks collisions). */
function sanitizeId(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export async function buildExtensionMcpTools(
  app: ApplicationServices,
): Promise<readonly ExtensionMcpTool[]> {
  const operations = await app.extensionOperations.list();
  const byName = new Map<string, { extensionId: string; operationId: string }>();
  const tools: ExtensionMcpTool[] = [];
  for (const operation of operations) {
    const name = `cms_ext_${sanitizeId(operation.extension_id)}_${sanitizeId(operation.operation_id)}`;
    const existing = byName.get(name);
    if (existing !== undefined) {
      throw new Error(
        `extension MCP tool name collision: "${name}" derived from ${existing.extensionId}/${existing.operationId} and ${operation.extension_id}/${operation.operation_id}`,
      );
    }
    byName.set(name, { extensionId: operation.extension_id, operationId: operation.operation_id });
    tools.push({
      name,
      description: operation.title,
      permission: operation.permission,
      mutation: operation.mutation,
      inputSchema: operation.input_schema,
      async run(mcpOperations, ctx, args) {
        return mcpOperations.invokeExtensionOperation(ctx, {
          extension_id: operation.extension_id,
          operation_id: operation.operation_id,
          input: args,
        });
      },
    });
  }
  return tools;
}
