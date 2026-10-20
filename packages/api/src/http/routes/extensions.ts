// Extensions REST operations (PCMS-EXT-T019; Extensions spec §48). Transport
// only — authorization/audit live in extensions-ops.ts. Discovery routes are
// authenticated reads; lifecycle mutations are extensions.manage and audited.
import { recordSecurityEvent } from "@pcms/auth";
import type { ApplicationServices, OperationContext } from "../../context.js";
import {
  clearExtensionSecretOp,
  getExtensionConfigOp,
  setExtensionSecretOp,
  updateExtensionConfigOp,
} from "../../extension-config-ops.js";
import {
  applyUpdate,
  disableExtension,
  enableExtension,
  getCapabilities,
  getCompatibilityReport,
  getContractVersions,
  getExtensionCompatibility,
  getUpdatePreflight,
  installExtension,
  listDeprecations,
  listExtensions,
  uninstallExtension,
} from "../../extensions-ops.js";
import type { ApiRoute, RouteResult } from "../registry.js";
import { jsonBody } from "./helpers.js";

async function handle(
  app: ApplicationServices,
  ctx: OperationContext,
  fn: (app: ApplicationServices, ctx: OperationContext) => Promise<unknown> | unknown,
): Promise<RouteResult> {
  return { status: 200, body: await fn(app, ctx) };
}

const EXTENSION_ID_PARAM = {
  type: "object",
  additionalProperties: false,
  properties: {
    extensionId: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]{2,120}$" },
  },
  required: ["extensionId"],
} as const;

const INSTALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    config: { type: "object" },
  },
} as const;

const UNINSTALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    confirmation: { type: "string", maxLength: 200 },
  },
} as const;

export function makeExtensionsRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [
    {
      spec: {
        method: "GET",
        url: "/extensions/contracts",
        operationId: "get_contract_versions",
        summary: "Independent contract versions (cms, config, extension, REST, MCP, theme, …).",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      handle: (app, ctx) => handle(app, ctx, () => getContractVersions(app, ctx)),
    },
    {
      spec: {
        method: "GET",
        url: "/extensions/capabilities",
        operationId: "get_extension_capabilities",
        summary: "Effective capability provisions (key, version, provider).",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      handle: (app, ctx) => handle(app, ctx, () => getCapabilities(app, ctx)),
    },
    {
      spec: {
        method: "GET",
        url: "/extensions/deprecations",
        operationId: "list_deprecations",
        summary: "Machine-readable deprecation records with replacement/removal metadata.",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      handle: (app, ctx) => handle(app, ctx, () => listDeprecations(app, ctx)),
    },
    {
      spec: {
        method: "GET",
        url: "/extensions/compatibility",
        operationId: "get_compatibility_report",
        summary: "Read-only compatibility scan of the actual installation.",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      handle: (app, ctx) => handle(app, ctx, () => getCompatibilityReport(app, ctx)),
    },
    {
      spec: {
        method: "POST",
        url: "/update/apply",
        operationId: "update_apply",
        summary: "Update orchestration contract: fails closed without the M15 deployment adapter.",
        tag: "extensions",
        auth: "authenticated",
        csrf: true,
        permission: "extensions.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["manifest"],
          properties: {
            manifest: { type: "object" },
            // Operator's backup acknowledgment: must equal the target version
            // when the release declares backup_required (Extensions §25).
            backup_confirmation: { type: "string", maxLength: 64 },
          },
        },
      },
      handle: (app, ctx, request) => {
        const body = jsonBody(request);
        return handle(app, ctx, () =>
          applyUpdate(app, ctx, {
            manifest: body.manifest,
            ...(body.backup_confirmation === undefined
              ? {}
              : { backup_confirmation: String(body.backup_confirmation) }),
          }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/update/preflight",
        operationId: "get_update_preflight",
        summary: "Read-only preflight against the configured target release manifest (no writes).",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      handle: (app, ctx) => handle(app, ctx, () => getUpdatePreflight(app, ctx)),
    },
    {
      spec: {
        // T114: the operator-side `cms update check --manifest <file>` posts
        // the operator's target for fail-closed comparison with the
        // configured target; still read-only (no writes, no migrations).
        method: "POST",
        url: "/update/preflight",
        operationId: "submit_update_preflight",
        summary: "Read-only preflight against an operator-supplied target manifest.",
        tag: "extensions",
        auth: "authenticated",
        csrf: true,
        permission: "extensions.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["manifest"],
          properties: { manifest: { type: "object" } },
        },
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          getUpdatePreflight(app, ctx, { manifest: jsonBody(request).manifest }),
        ),
    },
    {
      spec: {
        method: "GET",
        url: "/extensions",
        operationId: "list_extensions",
        summary: "Deployed extensions with lifecycle state, capabilities and compatibility.",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
      },
      handle: (app, ctx) => handle(app, ctx, () => listExtensions(app, ctx)),
    },
    {
      spec: {
        method: "GET",
        url: "/extensions/:extensionId/compatibility",
        operationId: "get_extension_compatibility",
        summary: "Compatibility issues for one extension.",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
        paramsSchema: EXTENSION_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          getExtensionCompatibility(app, ctx, {
            extension_id: String((request.params as Record<string, unknown>).extensionId),
          }),
        ),
    },
    {
      spec: {
        method: "GET",
        url: "/extensions/:extensionId/mount",
        operationId: "extension_mount_get",
        summary:
          "The extension's ACTIVE site-level route mount (CORE-SHOP-01; canonical public URLs are mount-based).",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
        paramsSchema: EXTENSION_ID_PARAM,
      },
      handle: (app, _ctx, request) => {
        const extensionId = String((request.params as Record<string, unknown>).extensionId);
        return app.extensionRouteMounts.activeFor(extensionId).then((mount) => ({
          status: 200,
          body: { extension_id: extensionId, mount_path: mount?.mountPath ?? null },
        }));
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/extensions/:extensionId/mount",
        operationId: "extension_mount_set",
        summary:
          "Assign (or move) the extension's site-level route mount. Fail-closed preflight: reserved namespaces, other mounts, active entry routes (extensions.manage, audited).",
        tag: "extensions",
        auth: "authenticated",
        csrf: true,
        permission: "extensions.manage",
        paramsSchema: EXTENSION_ID_PARAM,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string", minLength: 1, maxLength: 300 } },
        },
      },
      handle: (app, ctx, request) => {
        const extensionId = String((request.params as Record<string, unknown>).extensionId);
        const path = String(jsonBody(request).path);
        return (async () => {
          const site = await app.routes.ensureSite(app.defaultSiteKey);
          const mount = await app.extensionRouteMounts.setMount(site.id, extensionId, path);
          await recordSecurityEvent(app.pool, null, {
            type: "EXTENSION_MOUNT_SET" as never,
            actorType: ctx.actor.type,
            actorId: ctx.actor.id,
            subjectType: "extension",
            subjectId: extensionId,
            metadata: { mount_path: mount.mountPath },
          });
          return { status: 200, body: { extension_id: extensionId, mount_path: mount.mountPath } };
        })();
      },
    },
    {
      spec: {
        method: "POST",
        url: "/extensions/:extensionId/install",
        operationId: "extension_install",
        summary:
          "Activate an already-deployed trusted artifact into the CMS lifecycle (never a download).",
        tag: "extensions",
        auth: "authenticated",
        csrf: true,
        permission: "extensions.manage",
        paramsSchema: EXTENSION_ID_PARAM,
        bodySchema: INSTALL_SCHEMA,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          installExtension(app, ctx, {
            extension_id: String((request.params as Record<string, unknown>).extensionId),
            ...((jsonBody(request).config as Record<string, unknown> | undefined) === undefined
              ? {}
              : { config: jsonBody(request).config as Record<string, unknown> }),
          }),
        ),
    },
    {
      spec: {
        method: "POST",
        url: "/extensions/:extensionId/enable",
        operationId: "extension_enable",
        summary: "Enable an installed extension (preflight gates composition).",
        tag: "extensions",
        auth: "authenticated",
        csrf: true,
        permission: "extensions.manage",
        paramsSchema: EXTENSION_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          enableExtension(app, ctx, {
            extension_id: String((request.params as Record<string, unknown>).extensionId),
          }),
        ),
    },
    {
      spec: {
        method: "POST",
        url: "/extensions/:extensionId/disable",
        operationId: "extension_disable",
        summary: "Disable an extension (impact preflight blocks active dependents).",
        tag: "extensions",
        auth: "authenticated",
        csrf: true,
        permission: "extensions.manage",
        paramsSchema: EXTENSION_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          disableExtension(app, ctx, {
            extension_id: String((request.params as Record<string, unknown>).extensionId),
          }),
        ),
    },
    {
      spec: {
        method: "POST",
        url: "/extensions/:extensionId/uninstall",
        operationId: "extension_uninstall",
        summary:
          "Remove executable state; destructive data policies require the explicit confirmation.",
        tag: "extensions",
        auth: "authenticated",
        csrf: true,
        permission: "extensions.manage",
        paramsSchema: EXTENSION_ID_PARAM,
        bodySchema: UNINSTALL_SCHEMA,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          uninstallExtension(app, ctx, {
            extension_id: String((request.params as Record<string, unknown>).extensionId),
            ...((jsonBody(request).confirmation as string | undefined) === undefined
              ? {}
              : { confirmation: jsonBody(request).confirmation as string }),
          }),
        ),
    },
    // ADR-0013 §52.3: generic, namespaced surface for typed extension
    // application operations. Discovery is an authenticated read; invocation
    // enforces the operation's OWN registered permission inside the service
    // (spec.permission below is intentionally omitted — it is per-operation).
    {
      spec: {
        method: "GET",
        url: "/extensions/operations",
        operationId: "list_all_extension_operations",
        summary:
          "Typed application operations across all enabled deployed extensions — the capability-binding discovery (ADR-0017 S4): generic consumers (Admin media studio, CLI) find operations by `capability`, never by extension id.",
        tag: "extensions",
        auth: "authenticated",
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, async () => ({
          items: await app.extensionOperations.list(),
        })),
    },
    {
      spec: {
        method: "GET",
        url: "/extensions/:extensionId/operations",
        operationId: "list_extension_operations",
        summary:
          "Typed application operations contributed by an enabled deployed extension (schemas + permissions).",
        tag: "extensions",
        auth: "authenticated",
        paramsSchema: EXTENSION_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, async () => ({
          items: await app.extensionOperations.list(
            String((request.params as Record<string, unknown>).extensionId),
          ),
        })),
    },
    {
      spec: {
        method: "POST",
        url: "/extensions/:extensionId/operations/:operationId",
        operationId: "invoke_extension_operation",
        summary:
          "Invoke a typed extension application operation (permission enforced per operation; same handler as MCP).",
        tag: "extensions",
        auth: "authenticated",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["extensionId", "operationId"],
          properties: {
            extensionId: EXTENSION_ID_PARAM.properties.extensionId,
            operationId: {
              type: "string",
              pattern: "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$",
            },
          },
        },
        bodySchema: { type: "object", additionalProperties: true, maxProperties: 64 },
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        return handle(app, ctx, () =>
          app.extensionOperations.invoke(
            app,
            ctx,
            String(params.extensionId),
            String(params.operationId),
            jsonBody(request),
          ),
        );
      },
    },
    // Generic extension settings (PCMS-PRE-RESEARCH A2): one declarative
    // contract — manifest config_schema → these operations → the Admin
    // settings dialog. Secrets stay write-only; extensions.manage gates.
    {
      spec: {
        method: "GET",
        url: "/extensions/:extensionId/config",
        operationId: "get_extension_config",
        summary:
          "Extension settings view: manifest config schema, public (non-secret) config, declared secret slots with presence only.",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
        paramsSchema: EXTENSION_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          getExtensionConfigOp(app, ctx, {
            extension_id: String((request.params as Record<string, unknown>).extensionId),
          }),
        ),
    },
    {
      spec: {
        method: "PUT",
        url: "/extensions/:extensionId/config",
        operationId: "update_extension_config",
        summary:
          "Merge the non-secret extension settings (partial updates preserve sibling keys and stored secret refs); schema-validated, audited.",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
        csrf: true,
        paramsSchema: EXTENSION_ID_PARAM,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["config"],
          properties: { config: { type: "object" } },
        },
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        const body = jsonBody(request);
        return handle(app, ctx, () =>
          updateExtensionConfigOp(app, ctx, {
            extension_id: String(params.extensionId),
            config: body["config"] as Record<string, unknown>,
          }),
        );
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/extensions/:extensionId/secrets/:slot",
        operationId: "set_extension_secret",
        summary: "Write an extension secret slot (write-only; the value is never returned).",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["extensionId", "slot"],
          properties: {
            extensionId: EXTENSION_ID_PARAM.properties.extensionId,
            slot: { type: "string", pattern: "^[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*){0,4}$" },
          },
        },
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "string", minLength: 1, maxLength: 8192 } },
        },
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        const body = jsonBody(request);
        return handle(app, ctx, () =>
          setExtensionSecretOp(app, ctx, {
            extension_id: String(params.extensionId),
            slot: String(params.slot),
            value: body["value"] as string,
          }),
        );
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/extensions/:extensionId/secrets/:slot",
        operationId: "clear_extension_secret",
        summary: "Clear an extension secret slot (audited).",
        tag: "extensions",
        auth: "authenticated",
        permission: "extensions.manage",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["extensionId", "slot"],
          properties: {
            extensionId: EXTENSION_ID_PARAM.properties.extensionId,
            slot: { type: "string", pattern: "^[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*){0,4}$" },
          },
        },
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        return handle(app, ctx, () =>
          clearExtensionSecretOp(app, ctx, {
            extension_id: String(params.extensionId),
            slot: String(params.slot),
          }),
        );
      },
    },
  ];
  return routes;
}
