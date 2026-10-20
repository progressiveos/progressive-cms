// Typed extension application-operation contributions (ADR-0013,
// Extensions spec §52.3).
//
// Business logic exists once, in the extension's handler export; the REST
// route and the derived MCP tool are thin transports over `invoke`. Only
// enabled, deployed extensions contribute; invocation enforces the
// operation's registered permission through the same `app.authorize` as
// every core operation, and validates input/output against the manifest
// JSON Schemas (fail-closed).

import type { SecurityEventType } from "@pcms/auth";
import { isRegisteredPermission } from "@pcms/auth";
import {
  composeExtensionRegistrations,
  createExtensionPlatformServices,
  type ExtensionCallContext,
  type ExtensionCatalog,
  type ExtensionPlatformServices,
  type ExtensionSiteContext,
  resolveHandler,
} from "@pcms/extensions/internal";
import Ajv from "ajv";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";
import { buildExtensionCallContext } from "./extension-platform.js";

export interface ExtensionOperationView {
  readonly extension_id: string;
  readonly operation_id: string;
  readonly title: string;
  readonly permission: string;
  readonly mutation: boolean;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  /** Semantic capability (S4) — generic consumers bind to this, never ids. */
  readonly capability: string | undefined;
}

/** Structural context handed to an extension operation handler. */
export interface ExtensionOperationCallContext {
  readonly actor: { readonly id: string; readonly type: string };
  readonly requestId: string;
  /**
   * Resolved runtime of the calling extension: validated config with
   * `$secret_ref` slots resolved. `config === null` means installed+enabled
   * but not (yet) usable — the handler decides whether it can proceed
   * (typed PROVIDER_NOT_CONFIGURED-style error) or degrade.
   */
  readonly extension: {
    readonly id: string;
    readonly config: Record<string, unknown> | null;
  };
}

export interface ExtensionOperationsInput {
  readonly catalog: ExtensionCatalog;
  /** Returns ids of ENABLED extensions (lifecycle state). */
  readonly enabledIds: () => Promise<readonly string[]>;
  /**
   * Authoritative lifecycle revision (ADR-0017 R3): the composed set is
   * stamped with it; a revision change (this or ANOTHER process) forces a
   * recompose before the next list/invoke — fail-closed inter-process
   * revoke without trusting local cache invalidation.
   */
  readonly lifecycleRevision: () => Promise<string>;
  /**
   * Resolves an installed extension's runtime (config+secrets) for the call
   * context; absent resolver passes a null-config context (handlers that do
   * not need settings ignore it).
   */
  readonly resolveRuntime?: (extensionId: string) => Promise<{
    readonly id: string;
    readonly config: Record<string, unknown>;
  } | null>;
}

export interface ExtensionOperationsService {
  /** Deterministic operation views of enabled deployed extensions. */
  list(extensionId?: string): Promise<readonly ExtensionOperationView[]>;
  /** The single application entry point behind REST and MCP transports. */
  invoke(
    app: ApplicationServices,
    ctx: OperationContext,
    extensionId: string,
    operationId: string,
    input: unknown,
  ): Promise<unknown>;
  /** Drops the composed-operation cache — lifecycle ops call this so a
   * disable/uninstall revokes operations immediately (gate E2), not on the
   * next TTL tick. */
  invalidate(): void;
}

interface CompiledOperation {
  readonly extensionId: string;
  readonly operationId: string;
  readonly permission: string;
  readonly mutation: boolean;
  readonly title: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly handler: (...args: never[]) => unknown;
  readonly capability: string | undefined;
}

/** Fails closed when a manifest names a permission the registry does not know. */
export function assertExtensionPermissionsRegistered(manifest: {
  readonly id: string;
  readonly permissions: readonly string[];
  readonly registrations: {
    readonly operations: readonly { readonly permission: string }[];
    readonly http_routes: readonly { readonly permission?: string }[];
  };
}): void {
  for (const key of manifest.permissions) {
    if (!isRegisteredPermission(key)) {
      throw new ApiError(
        "EXTENSION_PERMISSION_UNREGISTERED",
        `extension "${manifest.id}" declares unregistered permission "${key}"`,
        { status: 500 },
      );
    }
  }
  for (const operation of manifest.registrations.operations) {
    if (!isRegisteredPermission(operation.permission)) {
      throw new ApiError(
        "EXTENSION_PERMISSION_UNREGISTERED",
        `extension "${manifest.id}" declares operation permission "${operation.permission}" that is not in the registry`,
        { status: 500 },
      );
    }
  }
  // Session/admin HTTP routes carry permissions too.
  for (const route of manifest.registrations.http_routes) {
    if (route.permission !== undefined && !isRegisteredPermission(route.permission)) {
      throw new ApiError(
        "EXTENSION_PERMISSION_UNREGISTERED",
        `extension "${manifest.id}" declares http route permission "${route.permission}" that is not in the registry`,
        { status: 500 },
      );
    }
  }
}

export function createExtensionOperationsService(
  input: ExtensionOperationsInput,
): ExtensionOperationsService {
  const { resolveRuntime } = input;
  const ajv = new Ajv({ allErrors: false });
  const compiled = new Map<string, CompiledOperation>();
  /** Lifecycle revision the composed set was built from (ADR-0017 R3). */
  let compiledRevision: string | null = null;

  const compile = async (): Promise<void> => {
    const revision = await input.lifecycleRevision();
    compiled.clear();
    const enabledIds = await input.enabledIds();
    const composition = composeExtensionRegistrations(input.catalog, enabledIds);
    for (const registration of composition.registrations) {
      if (registration.kind !== "operation") continue;
      const artifact = input.catalog.get(registration.extensionId);
      if (artifact === undefined) continue;
      const handler = resolveHandler(artifact, registration.handler);
      compiled.set(`${registration.extensionId}/${registration.operationId}`, {
        extensionId: registration.extensionId,
        operationId: registration.operationId,
        permission: registration.permission,
        mutation: registration.mutation,
        title: registration.title,
        inputSchema: registration.inputSchema,
        outputSchema: registration.outputSchema,
        handler,
        capability: registration.capability,
      });
    }
    compiledRevision = revision;
  };

  /** Composes on first use and whenever the authoritative lifecycle revision
   * moved (another process's install/enable/disable/uninstall) — a local
   * cache is never trusted across revisions (ADR-0017 R3). */
  const ensureComposed = async (): Promise<void> => {
    const revision = await input.lifecycleRevision();
    if (compiled.size === 0 || compiledRevision !== revision) await compile();
  };

  return {
    async list(extensionId) {
      await ensureComposed();
      return [...compiled.values()]
        .filter((operation) => extensionId === undefined || operation.extensionId === extensionId)
        .map((operation) => ({
          extension_id: operation.extensionId,
          operation_id: operation.operationId,
          title: operation.title,
          permission: operation.permission,
          mutation: operation.mutation,
          input_schema: operation.inputSchema,
          output_schema: operation.outputSchema,
          capability: operation.capability,
        }))
        .sort((a, b) =>
          a.extension_id === b.extension_id
            ? a.operation_id < b.operation_id
              ? -1
              : 1
            : a.extension_id < b.extension_id
              ? -1
              : 1,
        );
    },
    async invoke(app, ctx, extensionId, operationId, input) {
      // Composition refreshes when the authoritative revision moved — a
      // disable (here or in another process) takes the operation away
      // immediately (gate E2 + R3 inter-process revoke).
      await ensureComposed();
      const operation = compiled.get(`${extensionId}/${operationId}`);
      if (operation === undefined) {
        throw new ApiError(
          "EXTENSION_OPERATION_UNKNOWN",
          `extension "${extensionId}" does not contribute operation "${operationId}" (installed and enabled?)`,
          { status: 404 },
        );
      }
      requirePermission(app, ctx, operation.permission);
      const validateInput = ajv.compile(operation.inputSchema);
      if (!validateInput(input)) {
        throw new ApiError(
          "EXTENSION_OPERATION_INVALID_INPUT",
          "operation input failed schema validation",
          {
            status: 422,
            details: validateInput.errors ?? [],
          },
        );
      }
      const runtime =
        resolveRuntime === undefined ? null : await resolveRuntime(operation.extensionId);
      // The v2 call context is shared across operation, route and source
      // handlers: platform services, site/locale and principal.
      const callContext = await buildExtensionCallContext(app, ctx, {
        extensionId: operation.extensionId,
        config: runtime?.config ?? null,
      });
      const call = (operation.handler as (call: unknown) => unknown)({
        input,
        actor: callContext.actor,
        requestId: callContext.requestId,
        extension: callContext.extension,
        site: callContext.site,
        locale: callContext.locale,
        platform: callContext.platform,
      });
      const output = await Promise.resolve(call);
      const validateOutput = ajv.compile(operation.outputSchema);
      if (!validateOutput(output)) {
        throw new ApiError(
          "EXTENSION_OPERATION_INVALID_OUTPUT",
          `operation "${extensionId}/${operationId}" returned output that failed its schema`,
          { status: 500 },
        );
      }
      return output;
    },
    invalidate() {
      compiled.clear();
      compiledRevision = null;
    },
  };
}
