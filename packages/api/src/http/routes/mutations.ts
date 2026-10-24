// Mutation routes (PCMS-API-T013..T016; API spec §31–§38/§41/§47).
// Handlers are one-line delegations into packages/api/operations.ts — the
// same operations MCP tools call. Every route declares the permission its
// operation enforces; statuses come from the central error mapping.
import type { BatchScheduleSpec } from "@pcms/publication";
import { submitBundle } from "../../bundle.js";
import { ApiError } from "../../errors.js";
import {
  activateTheme,
  addChangesetItem,
  addNavigationOverride,
  applyChangeset,
  archiveEntry,
  archiveMediaOp,
  assignRoleOp,
  bindPlacement,
  cancelChangeset,
  cancelPlanItem,
  changeEntryRoute,
  cleanupEntryRevisionsOp,
  convertRichText,
  createAccessTokenOp,
  createChangeset,
  createDraft,
  createMediaFolderOp,
  createNavigationSet,
  createPublicationPlan,
  createServiceAccountOp,
  createThemePreview,
  createUpdateDeleteRoleOp,
  createUserOp,
  createUserWithPasswordOp,
  createWorkingDraft,
  deleteMediaFolderOp,
  deleteNavigationItem,
  deleteNavigationSet,
  deleteRevisionOp,
  deleteServiceAccountOp,
  deleteUserOp,
  disableEnableUserOp,
  disableServiceAccountOp,
  duplicateEntryOp,
  importMediaUrl,
  insertNavigationItem,
  listAccessTokensOp,
  listAuditOp,
  listMediaFoldersOp,
  listNavigationOverrides,
  listRolesOp,
  listServiceAccountsOp,
  listTranslationsOp,
  listUsersOp,
  mediaVariantFailureField,
  moveEntryOp,
  moveMediaAssetOp,
  moveNavigationItem,
  preflightChangeset,
  previewPublicationPlan,
  publishNowOp,
  publishRevision,
  regenerateMediaVariantsOp,
  reidentifyEntryLocale,
  removeNavigationOverride,
  replaceMediaVersionOp,
  reschedulePlanItem,
  resetUserMfaOp,
  restoreEntryOp,
  revokeAccessTokenOp,
  revokeUserSessionsOp,
  rollbackPublication,
  saveThemeSettings,
  schedulePublicationPlan,
  sealNavigationSet,
  sealRevision,
  sealThemeSettings,
  setEntryTemplateOp,
  setHomeEntryOp,
  setUserPasswordOp,
  unbindPlacement,
  unpublishPublication,
  updateDraft,
  updateEntrySeo,
  updateMediaFolderOp,
  updateMediaMetadataOp,
  updateNavigationItem,
  updateSiteIdentityOp,
  updateUserOp,
  uploadMediaOp,
  validateBlockProps,
  validateNavigationOp,
  validateRevision,
  validateThemeOp,
} from "../../operations.js";
import { mediaResponseSchema } from "../media-response-schemas.js";
import { API_BODY_LIMIT_MEDIA_UPLOAD } from "../plugin.js";
import type { ApiRoute } from "../registry.js";
import { stableId } from "./helpers.js";

const STABLE_ID = { type: "string", pattern: "^[0-9a-f-]{36}$" } as const;
const PLAN_OVERRIDES = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      changeset_item_id: STABLE_ID,
      changesetItemId: STABLE_ID,
      publish_at: { type: "string", format: "date-time" },
      publishAt: { type: "string", format: "date-time" },
      unpublish_at: { type: "string", format: "date-time" },
      unpublishAt: { type: "string", format: "date-time" },
    },
    anyOf: [
      { properties: { changeset_item_id: STABLE_ID }, required: ["changeset_item_id"] },
      { properties: { changesetItemId: STABLE_ID }, required: ["changesetItemId"] },
    ],
    allOf: [
      {
        anyOf: [
          {
            properties: { publish_at: { type: "string", format: "date-time" } },
            required: ["publish_at"],
          },
          {
            properties: { publishAt: { type: "string", format: "date-time" } },
            required: ["publishAt"],
          },
          {
            properties: { unpublish_at: { type: "string", format: "date-time" } },
            required: ["unpublish_at"],
          },
          {
            properties: { unpublishAt: { type: "string", format: "date-time" } },
            required: ["unpublishAt"],
          },
        ],
      },
    ],
  },
};
const PLAN_SCHEDULE_BODY = {
  type: "object",
  required: ["spec"],
  properties: {
    spec: { type: "object" },
    overrides: PLAN_OVERRIDES,
  },
};

export function makeMutationRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [
    // --- T013: content mutations (spec §31). ---
    {
      spec: {
        method: "POST",
        url: "/entries",
        operationId: "create_draft",
        summary: "Create entry + first working revision atomically",
        tag: "content",
        auth: "authenticated",
        permission: "content.create",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["content_type", "payload"],
          properties: {
            content_type: { type: "string", maxLength: 64 },
            entry_id: STABLE_ID,
            parent_entry_id: { ...STABLE_ID, nullable: true },
            template_key: { type: ["string", "null"], maxLength: 64 },
            payload: { type: "object" },
            locale: { type: "string", maxLength: 16 },
          },
        },
      },
      async handle(app, ctx, request) {
        return {
          status: 201,
          body: await createDraft(app, ctx, request.body as never),
        };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/revisions/:revisionId",
        operationId: "update_draft",
        summary: "Autosave a working revision (optimistic edit generation)",
        tag: "content",
        auth: "authenticated",
        permission: "content.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["payload", "expected_edit_generation"],
          properties: {
            payload: { type: "object" },
            expected_edit_generation: { type: "integer", minimum: 0 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = request.body as {
          payload: { fields?: unknown; blocks?: unknown };
          expected_edit_generation: number;
        };
        const revision = await updateDraft(app, ctx, {
          payload: body.payload,
          expected_edit_generation: body.expected_edit_generation,
          revision_id: (request.params as { revisionId: string }).revisionId,
        });
        return {
          status: 200,
          body: {
            revision_id: revision.id,
            state: revision.state,
            edit_generation: revision.editGeneration,
            updated_at: revision.updatedAt.toISOString(),
          },
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/revisions/:revisionId",
        operationId: "delete_revision",
        summary:
          "Delete a WORKING or SEALED revision (cleanup). The currently published revision is undeletable (409 REVISION_PUBLISHED). Audited.",
        tag: "content",
        auth: "authenticated",
        csrf: true,
        permission: "content.edit",
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["revisionId"],
          properties: {
            revisionId: {
              type: "string",
              pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { revisionId: string };
        return {
          status: 200,
          body: await deleteRevisionOp(app, ctx, { revision_id: params.revisionId }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/identity-locale",
        operationId: "reidentify_entry_locale",
        summary:
          "Identity repair (owner 2026-10-06): move an entry and ALL its revisions to a policy-allowed identity locale in one transaction. Entry id, routes, publication pointers, payloads and edit generations are untouched. Refuses locales outside the site localization policy and translation-group members. Permission: content.edit",
        tag: "content",
        auth: "authenticated",
        permission: "content.edit",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["locale"],
          properties: { locale: { type: "string", minLength: 2, maxLength: 35 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        const body = (request.body ?? {}) as { locale?: unknown };
        return {
          status: 200,
          body: await reidentifyEntryLocale(app, ctx, {
            entry_id: params.entryId,
            locale: String(body.locale ?? ""),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/revisions/cleanup",
        operationId: "cleanup_entry_revisions",
        summary:
          "Delete all SEALED revisions of an entry except the currently published one. The working revision is always kept; refuses entries without a published revision. Permission: content.edit",
        tag: "content",
        auth: "authenticated",
        permission: "content.edit",
        csrf: true,
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        return {
          status: 200,
          body: await cleanupEntryRevisionsOp(app, ctx, { entry_id: params.entryId }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/revisions/:revisionId/validate",
        operationId: "validate_revision",
        summary: "Validate a revision (draft or publish level)",
        tag: "content",
        auth: "authenticated",
        permission: "content.edit",
      },
      async handle(app, ctx, request) {
        const params = request.params as { revisionId: string };
        return {
          status: 200,
          body: await validateRevision(app, ctx, {
            revision_id: params.revisionId,
            ...(request.body === undefined ? {} : (request.body as { publish_level?: boolean })),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/revisions/:revisionId/seal",
        operationId: "seal_revision",
        summary: "Seal a working revision (publish-level validation)",
        tag: "content",
        auth: "authenticated",
        permission: "revision.seal",
        bodySchema: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: { expected_edit_generation: { type: "integer", minimum: 0 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { revisionId: string };
        const sealed = await sealRevision(app, ctx, {
          revision_id: params.revisionId,
          ...(request.body === undefined
            ? {}
            : (request.body as { expected_edit_generation?: number })),
        });
        return {
          status: 200,
          body: {
            revision_id: sealed.id,
            state: sealed.state,
            payload_hash: sealed.payloadHash,
            sealed_at: sealed.sealedAt?.toISOString() ?? null,
          },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/content/richtext/convert",
        operationId: "convert_rich_text",
        summary:
          "Canonical Markdown<->AST conversion for the Admin rich text editor (PCMS-ADMIN-T005)",
        tag: "content",
        auth: "authenticated",
        permission: "content.read",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["direction", "value"],
          properties: {
            direction: { enum: ["markdown_to_ast", "ast_to_markdown"] },
            value: {},
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as { direction?: unknown; value?: unknown };
        if (body.direction !== "markdown_to_ast" && body.direction !== "ast_to_markdown") {
          throw new ApiError("API_REQUEST_INVALID", "unknown direction", { status: 400 });
        }
        return {
          status: 200,
          body: await convertRichText(app, ctx, {
            direction: body.direction,
            value: body.value,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/route/change",
        operationId: "change_entry_route",
        summary: "Explicit canonical route change with a recorded redirect (navigation.edit)",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["to_path"],
          properties: {
            to_path: { type: "string", minLength: 1, maxLength: 500 },
            reason: { type: "string", maxLength: 500 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        const body = (request.body ?? {}) as { to_path?: unknown; reason?: unknown };
        if (typeof body.to_path !== "string" || body.to_path === "") {
          throw new ApiError("API_REQUEST_INVALID", "to_path is required", { status: 400 });
        }
        return {
          status: 200,
          body: await changeEntryRoute(app, ctx, {
            entry_id: stableId(params.entryId, "entryId"),
            to_path: body.to_path,
            ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/home",
        operationId: "set_home_entry",
        summary: "Homepage binding for the site (navigation.edit; Routing home_entry_id)",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        bodySchema: { type: "object", additionalProperties: false, properties: {} },
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        return {
          status: 200,
          body: await setHomeEntryOp(app, ctx, { entry_id: stableId(params.entryId, "entryId") }),
        };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/entries/:entryId/seo",
        operationId: "update_entry_seo",
        summary:
          "Save the entry SEO document (seo.edit; canonical override also needs seo.canonical_override)",
        tag: "content",
        auth: "authenticated",
        permission: "seo.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["document"],
          properties: { document: { type: ["object", "null"] } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        const body = (request.body ?? {}) as { document?: unknown };
        if (typeof body.document !== "object" || body.document === null) {
          throw new ApiError("API_REQUEST_INVALID", "document object is required", { status: 400 });
        }
        return {
          status: 200,
          body: await updateEntrySeo(app, ctx, {
            entry_id: stableId(params.entryId, "entryId"),
            document: body.document,
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/navigation/sets/:setId/overrides",
        operationId: "list_navigation_overrides",
        summary: "Derived-set overrides + stale ones (PCMS-ADMIN-T013)",
        tag: "discovery",
        auth: "authenticated",
        permission: "navigation.read",
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string };
        return {
          status: 200,
          body: await listNavigationOverrides(app, ctx, { set_id: params.setId }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/navigation/validate",
        operationId: "validate_navigation",
        summary: "Placement binding validation (depth/type/required) — PCMS-ADMIN-T013",
        tag: "discovery",
        auth: "authenticated",
        permission: "navigation.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await validateNavigationOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/navigation/sets",
        operationId: "create_navigation_set",
        summary: "Create a navigation set (optionally derived)",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["key", "title"],
          properties: {
            key: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
            title: { type: "string", minLength: 1, maxLength: 200 },
            derived_from_set_id: { ...STABLE_ID, nullable: true },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as {
          key?: unknown;
          title?: unknown;
          derived_from_set_id?: unknown;
        };
        if (typeof body.key !== "string" || typeof body.title !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "key and title are required", { status: 400 });
        }
        return {
          status: 201,
          body: await createNavigationSet(app, ctx, {
            key: body.key,
            title: body.title,
            ...(typeof body.derived_from_set_id === "string"
              ? { derived_from_set_id: body.derived_from_set_id }
              : {}),
          }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/navigation/sets/:setId",
        operationId: "delete_navigation_set",
        summary:
          "Hard-delete an UNBOUND navigation set and its own items, overrides and revisions (navigation.edit). Placement bindings or derived sets block deletion (NAV_SET_BOUND).",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["setId"],
          properties: { setId: STABLE_ID },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string };
        return {
          status: 200,
          body: await deleteNavigationSet(app, ctx, { set_id: params.setId }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/navigation/sets/:setId/items",
        operationId: "insert_navigation_item",
        summary: "Insert a navigation item (stable Item ID assigned by the domain)",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            parent_item_id: { ...STABLE_ID, nullable: true },
            type: { type: "string", maxLength: 32 },
            label: { type: ["string", "null"], maxLength: 200 },
            target: { type: ["object", "null"] },
            ui_intent: { type: ["string", "null"], maxLength: 16 },
            at: { type: ["integer", "null"], minimum: 0 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 201,
          body: await insertNavigationItem(app, ctx, {
            set_id: params.setId,
            type: String(body.type),
            ...(body.parent_item_id === undefined || body.parent_item_id === null
              ? {}
              : { parent_item_id: body.parent_item_id as string }),
            ...(body.label === undefined || body.label === null
              ? {}
              : { label: String(body.label) }),
            ...(body.target === undefined || body.target === null ? {} : { target: body.target }),
            ...(body.ui_intent === undefined || body.ui_intent === null
              ? {}
              : { ui_intent: String(body.ui_intent) }),
            ...(body.at === undefined || body.at === null ? {} : { at: Number(body.at) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/navigation/sets/:setId/items/:itemId/move",
        operationId: "move_navigation_item",
        summary: "Move/reorder a navigation item (stable Item IDs preserved)",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["parent_item_id"],
          properties: {
            parent_item_id: { ...STABLE_ID, nullable: true },
            at: { type: ["integer", "null"], minimum: 0 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string; itemId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        if (body.parent_item_id !== null && typeof body.parent_item_id !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "parent_item_id must be a stable id or null", {
            status: 400,
          });
        }
        return {
          status: 200,
          body: await moveNavigationItem(app, ctx, {
            set_id: params.setId,
            item_id: params.itemId,
            parent_item_id: body.parent_item_id as string | null,
            ...(body.at === undefined || body.at === null ? {} : { at: Number(body.at) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/navigation/sets/:setId/items/:itemId",
        operationId: "update_navigation_item",
        summary: "Update an existing menu item (label, type, target) in the working tree",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            type: { type: "string", maxLength: 32 },
            label: { type: ["string", "null"], maxLength: 200 },
            target: { type: ["object", "null"] },
            ui_intent: { type: ["string", "null"], maxLength: 16 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string; itemId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 200,
          body: await updateNavigationItem(app, ctx, {
            set_id: params.setId,
            item_id: params.itemId,
            type: String(body.type),
            ...(body.label === undefined || body.label === null
              ? {}
              : { label: String(body.label) }),
            ...(body.target === undefined || body.target === null ? {} : { target: body.target }),
            ...(body.ui_intent === undefined || body.ui_intent === null
              ? {}
              : { ui_intent: String(body.ui_intent) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/navigation/sets/:setId/items/:itemId",
        operationId: "delete_navigation_item",
        summary: "Delete a navigation item (subtree)",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string; itemId: string };
        return {
          status: 200,
          body: await deleteNavigationItem(app, ctx, {
            set_id: params.setId,
            item_id: params.itemId,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/navigation/sets/:setId/overrides",
        operationId: "add_navigation_override",
        summary:
          "Add a derived-set override (hide/relabel/reorder/move/insert/replace_target/show)",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["target_item_id", "op"],
          properties: {
            target_item_id: STABLE_ID,
            op: { type: "string", maxLength: 32 },
            payload: { type: "object" },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 201,
          body: await addNavigationOverride(app, ctx, {
            set_id: params.setId,
            target_item_id: String(body.target_item_id),
            op: String(body.op),
            payload: body.payload,
          }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/navigation/sets/:setId/overrides/:overrideId",
        operationId: "remove_navigation_override",
        summary: "Remove a derived-set override",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string; overrideId: string };
        return {
          status: 200,
          body: await removeNavigationOverride(app, ctx, {
            set_id: params.setId,
            override_id: params.overrideId,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/navigation/sets/:setId/seal",
        operationId: "seal_navigation_set",
        summary: "Seal the working tree of a navigation set (navigation.publish)",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.publish",
      },
      async handle(app, ctx, request) {
        const params = request.params as { setId: string };
        return { status: 200, body: await sealNavigationSet(app, ctx, { set_id: params.setId }) };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/navigation/placements/:placementKey",
        operationId: "bind_navigation_placement",
        summary: "Bind a navigation set to a theme placement",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["navigation_set_id"],
          properties: { navigation_set_id: STABLE_ID },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { placementKey: string };
        const body = (request.body ?? {}) as { navigation_set_id?: unknown };
        if (typeof body.navigation_set_id !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "navigation_set_id is required", {
            status: 400,
          });
        }
        return {
          status: 200,
          body: await bindPlacement(app, ctx, {
            placement_key: params.placementKey,
            navigation_set_id: body.navigation_set_id,
          }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/navigation/placements/:placementKey",
        operationId: "unbind_navigation_placement",
        summary: "Unbind a theme placement",
        tag: "content",
        auth: "authenticated",
        permission: "navigation.edit",
      },
      async handle(app, ctx, request) {
        const params = request.params as { placementKey: string };
        return {
          status: 200,
          body: await unbindPlacement(app, ctx, { placement_key: params.placementKey }),
        };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/settings/site-identity",
        operationId: "update_site_identity",
        summary: "Save the typed site identity (seo.site_settings)",
        tag: "content",
        auth: "authenticated",
        permission: "seo.site_settings",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["identity"],
          properties: { identity: { type: ["object", "null"] } },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as { identity?: unknown };
        if (typeof body.identity !== "object" || body.identity === null) {
          throw new ApiError("API_REQUEST_INVALID", "identity object is required", { status: 400 });
        }
        return {
          status: 200,
          body: await updateSiteIdentityOp(app, ctx, { identity: body.identity }),
        };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/theme/settings",
        operationId: "save_theme_settings",
        summary: "Save the working theme settings (CAS generation; theme.write)",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.write",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["values", "expected_generation"],
          properties: {
            values: { type: "object" },
            expected_generation: { type: "integer", minimum: 0 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as { values?: unknown; expected_generation?: unknown };
        if (
          typeof body.values !== "object" ||
          body.values === null ||
          typeof body.expected_generation !== "number"
        ) {
          throw new ApiError(
            "API_REQUEST_INVALID",
            "values object and expected_generation are required",
            { status: 400 },
          );
        }
        return {
          status: 200,
          body: await saveThemeSettings(app, ctx, {
            values: body.values,
            expected_generation: body.expected_generation,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/theme/activate",
        operationId: "activate_theme",
        summary: "Activate a validated installed theme and switch live rendering (theme.activate)",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.activate",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["theme_key"],
          properties: {
            theme_key: { type: "string", maxLength: 64 },
            theme_version: { type: "string", maxLength: 32 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as { theme_key?: unknown; theme_version?: unknown };
        if (typeof body.theme_key !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "theme_key is required", { status: 400 });
        }
        return {
          status: 200,
          body: await activateTheme(app, ctx, {
            theme_key: body.theme_key,
            ...(typeof body.theme_version === "string"
              ? { theme_version: body.theme_version }
              : {}),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/users",
        operationId: "list_users",
        summary: "Admin users with roles and MFA status (users.read)",
        tag: "discovery",
        auth: "authenticated",
        permission: "users.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "string", pattern: "^[0-9]+$" },
            offset: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as { limit?: string; offset?: string };
        return {
          status: 200,
          body: await listUsersOp(app, ctx, {
            ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
            ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/users/direct",
        operationId: "create_user_with_password",
        summary: "Create a user with an initial password and role (users.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["display_name", "email", "role_key", "password"],
          properties: {
            display_name: { type: "string", minLength: 1, maxLength: 200 },
            email: { type: "string", maxLength: 320 },
            role_key: { type: "string", maxLength: 64 },
            password: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 201,
          body: await createUserWithPasswordOp(app, ctx, {
            display_name: String(body.display_name),
            email: String(body.email),
            role_key: String(body.role_key),
            password: String(body.password),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/users",
        operationId: "create_user",
        summary: "Create a user with a role; invite token returned exactly once (users.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["display_name", "email", "role_key"],
          properties: {
            display_name: { type: "string", minLength: 1, maxLength: 200 },
            email: { type: "string", maxLength: 320 },
            role_key: { type: "string", maxLength: 64 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 201,
          body: await createUserOp(app, ctx, {
            display_name: String(body.display_name),
            email: String(body.email),
            role_key: String(body.role_key),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/users/:userId/disable",
        operationId: "disable_user",
        summary: "Disable a user (last-OWNER invariant enforced server-side)",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string };
        return {
          status: 200,
          body: await disableEnableUserOp(app, ctx, {
            user_id: params.userId,
            disable: true,
            reason: "disabled via Admin",
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/users/:userId/enable",
        operationId: "enable_user",
        summary: "Re-enable a disabled user",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string };
        return {
          status: 200,
          body: await disableEnableUserOp(app, ctx, {
            user_id: params.userId,
            disable: false,
            reason: "enabled via Admin",
          }),
        };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/users/:userId",
        operationId: "update_user",
        summary:
          "Edit a user's display name and/or primary email (users.manage). OWNER targets require the actor to hold OWNER.",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            display_name: { type: "string", minLength: 1, maxLength: 200 },
            email: { type: "string", maxLength: 320 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string };
        const body = (request.body ?? {}) as { display_name?: unknown; email?: unknown };
        return {
          status: 200,
          body: await updateUserOp(app, ctx, {
            user_id: params.userId,
            ...(typeof body.display_name === "string" ? { display_name: body.display_name } : {}),
            ...(typeof body.email === "string" ? { email: body.email } : {}),
          }),
        };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/users/:userId/password",
        operationId: "set_user_password",
        summary:
          "Set a user's password after policy validation (users.manage). The user's sessions are revoked; a self change keeps the current session.",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["new_password"],
          properties: { new_password: { type: "string", minLength: 1, maxLength: 1024 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string };
        const body = (request.body ?? {}) as { new_password?: unknown };
        return {
          status: 200,
          body: await setUserPasswordOp(app, ctx, {
            user_id: params.userId,
            new_password: String(body.new_password),
          }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/users/:userId",
        operationId: "delete_user",
        summary:
          "Hard-delete a user with credentials, sessions, MFA and tokens (users.manage). Last active OWNER and self-deletion are refused.",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
        csrf: true,
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string };
        return { status: 200, body: await deleteUserOp(app, ctx, { user_id: params.userId }) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/users/:userId/sessions/revoke",
        operationId: "revoke_user_sessions",
        summary: "Revoke all sessions of a user (users.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string };
        return {
          status: 200,
          body: await revokeUserSessionsOp(app, ctx, { user_id: params.userId }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/users/:userId/mfa",
        operationId: "reset_user_mfa",
        summary: "Reset a user's TOTP enrollment (users.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "users.manage",
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string };
        return { status: 200, body: await resetUserMfaOp(app, ctx, { user_id: params.userId }) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/users/:userId/roles",
        operationId: "assign_role",
        summary: "Assign a role to a user (roles.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "roles.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["role_key"],
          properties: { role_key: { type: "string", maxLength: 64 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string };
        const body = (request.body ?? {}) as { role_key?: unknown };
        return {
          status: 200,
          body: await assignRoleOp(app, ctx, {
            user_id: params.userId,
            role_key: String(body.role_key),
          }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/users/:userId/roles/:roleKey",
        operationId: "remove_role",
        summary: "Remove a role from a user (roles.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "roles.manage",
      },
      async handle(app, ctx, request) {
        const params = request.params as { userId: string; roleKey: string };
        return {
          status: 200,
          body: await assignRoleOp(app, ctx, {
            user_id: params.userId,
            role_key: params.roleKey,
            remove: true,
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/roles",
        operationId: "list_roles",
        summary: "Roles + permission registry + agent scope presets (roles.read)",
        tag: "discovery",
        auth: "authenticated",
        permission: "roles.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await listRolesOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/roles-admin",
        operationId: "manage_custom_role",
        summary: "Create/update/delete a custom role (roles.manage; registry-validated)",
        tag: "content",
        auth: "authenticated",
        permission: "roles.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { enum: ["create", "update", "delete"] },
            role_key: { type: "string", maxLength: 64 },
            name: { type: "string", maxLength: 200 },
            permissions: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 200 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 200,
          body: await createUpdateDeleteRoleOp(app, ctx, {
            action: body.action as "create" | "update" | "delete",
            ...(body.role_key === undefined ? {} : { role_key: String(body.role_key) }),
            ...(body.name === undefined ? {} : { name: String(body.name) }),
            ...(body.permissions === undefined
              ? {}
              : { permissions: (body.permissions as unknown[]).map(String) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/service-accounts",
        operationId: "list_service_accounts",
        summary: "Service accounts (tokens.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "tokens.manage",
      },
      async handle(app, ctx) {
        return { status: 200, body: await listServiceAccountsOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/service-accounts",
        operationId: "create_service_account",
        summary: "Create a service account (tokens.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "tokens.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["name", "purpose"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            purpose: { type: "string", minLength: 1, maxLength: 500 },
            allowed_scopes: {
              type: "array",
              items: { type: "string", maxLength: 64 },
              maxItems: 100,
            },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 201,
          body: await createServiceAccountOp(app, ctx, {
            name: String(body.name),
            purpose: String(body.purpose),
            ...(body.allowed_scopes === undefined
              ? {}
              : { allowed_scopes: (body.allowed_scopes as unknown[]).map(String) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/service-accounts/:accountId/disable",
        operationId: "disable_service_account",
        summary: "Disable a service account (tokens.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "tokens.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: { reason: { type: "string", minLength: 1, maxLength: 500 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { accountId: string };
        const body = (request.body ?? {}) as { reason?: unknown };
        return {
          status: 200,
          body: await disableServiceAccountOp(app, ctx, {
            account_id: params.accountId,
            reason: String(body.reason),
          }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/service-accounts/:accountId",
        operationId: "delete_service_account",
        summary: "Delete a service account and every token it issued, irreversibly (tokens.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "tokens.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: { reason: { type: "string", minLength: 1, maxLength: 500 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { accountId: string };
        const body = (request.body ?? {}) as { reason?: unknown };
        return {
          status: 200,
          body: await deleteServiceAccountOp(app, ctx, {
            account_id: params.accountId,
            reason: String(body.reason),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/service-accounts/:accountId/tokens",
        operationId: "list_access_tokens",
        summary: "Access tokens of a service account (prefix only; tokens.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "tokens.manage",
      },
      async handle(app, ctx, request) {
        const params = request.params as { accountId: string };
        return {
          status: 200,
          body: await listAccessTokensOp(app, ctx, { account_id: params.accountId }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/service-accounts/:accountId/tokens",
        operationId: "create_access_token",
        summary: "Create an access token; the raw secret is returned exactly once (tokens.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "tokens.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["scopes"],
          properties: {
            scopes: {
              type: "array",
              items: { type: "string", maxLength: 64 },
              minItems: 1,
              maxItems: 100,
            },
            description: { type: "string", maxLength: 500 },
            ttl_hours: { type: ["integer", "null"], minimum: 1, maximum: 8760 },
            allow_permanent: { type: "boolean" },
            site_key: { type: "string", maxLength: 64 },
            environment: { type: "string", maxLength: 32 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { accountId: string };
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 201,
          body: await createAccessTokenOp(app, ctx, {
            account_id: params.accountId,
            scopes: (body.scopes as unknown[]).map(String),
            ...(body.description === undefined ? {} : { description: String(body.description) }),
            ...(body.ttl_hours === undefined || body.ttl_hours === null
              ? {}
              : { ttl_hours: Number(body.ttl_hours) }),
            ...(body.allow_permanent === undefined
              ? {}
              : { allow_permanent: body.allow_permanent === true }),
            ...(body.site_key === undefined ? {} : { site_key: String(body.site_key) }),
            ...(body.environment === undefined ? {} : { environment: String(body.environment) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/access-tokens/:tokenId/revoke",
        operationId: "revoke_access_token",
        summary: "Revoke an access token (tokens.manage)",
        tag: "content",
        auth: "authenticated",
        permission: "tokens.manage",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: { reason: { type: "string", minLength: 1, maxLength: 500 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { tokenId: string };
        const body = (request.body ?? {}) as { reason?: unknown };
        return {
          status: 200,
          body: await revokeAccessTokenOp(app, ctx, {
            token_id: params.tokenId,
            reason: String(body.reason),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/audit",
        operationId: "list_audit",
        summary: "Security/audit events with filters (audit.read)",
        tag: "discovery",
        auth: "authenticated",
        permission: "audit.read",
        querySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            event_type: { type: "string", maxLength: 64 },
            actor_type: { type: "string", maxLength: 32 },
            actor_id: { type: "string", maxLength: 64 },
            transport: { type: "string", maxLength: 16 },
            limit: { type: "string", pattern: "^[0-9]+$" },
            offset: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      },
      async handle(app, ctx, request) {
        const query = request.query as Record<string, string | undefined>;
        return {
          status: 200,
          body: await listAuditOp(app, ctx, {
            ...(query.event_type === undefined ? {} : { event_type: query.event_type }),
            ...(query.actor_type === undefined ? {} : { actor_type: query.actor_type }),
            ...(query.actor_id === undefined ? {} : { actor_id: query.actor_id }),
            ...(query.transport === undefined ? {} : { transport: query.transport }),
            ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
            ...(query.offset === undefined ? {} : { offset: Number(query.offset) }),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/theme/settings/seal",
        operationId: "seal_theme_settings",
        summary: "Seal the working settings as a theme_settings revision (theme.write)",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.write",
      },
      async handle(app, ctx) {
        return { status: 200, body: await sealThemeSettings(app, ctx) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/blocks/validate",
        operationId: "validate_block_props",
        summary: "Semantic block props validation + calculator preview (PCMS-ADMIN-T006/T007)",
        tag: "content",
        auth: "authenticated",
        permission: "content.read",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["type_id", "props"],
          properties: {
            type_id: { type: "string", maxLength: 64 },
            props: { type: "object" },
            sample_values: { type: "object" },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as {
          type_id?: unknown;
          props?: unknown;
          sample_values?: unknown;
        };
        if (typeof body.type_id !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "type_id is required", { status: 400 });
        }
        if (typeof body.props !== "object" || body.props === null) {
          throw new ApiError("API_REQUEST_INVALID", "props must be an object", { status: 400 });
        }
        return {
          status: 200,
          body: await validateBlockProps(app, ctx, {
            type_id: body.type_id,
            props: body.props,
            ...(body.sample_values === undefined || typeof body.sample_values !== "object"
              ? {}
              : { sample_values: body.sample_values }),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/entries/:entryId/translations",
        operationId: "list_entry_translations",
        summary: "Translation group members of an entry (opt-in multilingual).",
        tag: "content",
        auth: "authenticated",
        permission: "content.read",
      },
      handle: async (app, ctx, request) => {
        const entryId = stableId((request.params as { entryId: string }).entryId, "entryId");
        return { status: 200, body: await listTranslationsOp(app, ctx, entryId) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/draft",
        operationId: "create_working_draft",
        summary: "Open or create the entry's working draft (Admin spec §24)",
        tag: "content",
        auth: "authenticated",
        permission: "content.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: { from_revision_id: { ...STABLE_ID, nullable: true } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        const body = (request.body ?? {}) as { from_revision_id?: unknown };
        if (
          body.from_revision_id !== undefined &&
          body.from_revision_id !== null &&
          typeof body.from_revision_id !== "string"
        ) {
          throw new ApiError(
            "API_REQUEST_INVALID",
            "from_revision_id must be a stable id or null",
            {
              status: 400,
            },
          );
        }
        return {
          status: 201,
          body: await createWorkingDraft(app, ctx, {
            entry_id: params.entryId,
            ...(typeof body.from_revision_id === "string"
              ? { from_revision_id: body.from_revision_id }
              : {}),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/move",
        operationId: "move_entry",
        summary: "Reparent an entry in the Content Tree (never rewrites routes/navigation)",
        tag: "content",
        auth: "authenticated",
        permission: "content.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["parent_entry_id"],
          properties: { parent_entry_id: { ...STABLE_ID, nullable: true } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        const body = (request.body ?? {}) as { parent_entry_id?: unknown };
        if (body.parent_entry_id !== null && typeof body.parent_entry_id !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "parent_entry_id must be a stable id or null", {
            status: 400,
          });
        }
        return {
          status: 200,
          body: await moveEntryOp(app, ctx, {
            entry_id: params.entryId,
            parent_entry_id: body.parent_entry_id as string | null,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/restore",
        operationId: "restore_entry",
        summary: "Clear the archive flag (Admin spec §5)",
        tag: "content",
        auth: "authenticated",
        permission: "content.archive",
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        return { status: 200, body: await restoreEntryOp(app, ctx, { entry_id: params.entryId }) };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/entries/:entryId/template",
        operationId: "set_entry_template",
        summary:
          "Assign the theme template for an entry (null = compatible default; live page changes only at next publish)",
        tag: "content",
        auth: "authenticated",
        permission: "content.edit",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["template_key"],
          properties: { template_key: { type: ["string", "null"], maxLength: 64 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        const body = (request.body ?? {}) as { template_key?: unknown };
        if (body.template_key !== null && typeof body.template_key !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "template_key must be a string or null", {
            status: 422,
          });
        }
        return {
          status: 200,
          body: await setEntryTemplateOp(app, ctx, {
            entry_id: params.entryId,
            template_key: body.template_key as string | null,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/duplicate",
        operationId: "duplicate_entry",
        summary: "Duplicate the latest revision payload into a new sibling draft (spec §5)",
        tag: "content",
        auth: "authenticated",
        permission: "content.create",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: { parent_entry_id: { ...STABLE_ID, nullable: true } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        const body = (request.body ?? {}) as { parent_entry_id?: unknown };
        if (
          body.parent_entry_id !== undefined &&
          body.parent_entry_id !== null &&
          typeof body.parent_entry_id !== "string"
        ) {
          throw new ApiError("API_REQUEST_INVALID", "parent_entry_id must be a stable id or null", {
            status: 400,
          });
        }
        return {
          status: 201,
          body: await duplicateEntryOp(app, ctx, {
            entry_id: params.entryId,
            ...(body.parent_entry_id === undefined
              ? {}
              : { parent_entry_id: body.parent_entry_id as string | null }),
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/entries/:entryId/archive",
        operationId: "archive_entry",
        summary: "Archive an entry (idempotent, never a hard delete)",
        tag: "content",
        auth: "authenticated",
        permission: "content.archive",
      },
      async handle(app, ctx, request) {
        const params = request.params as { entryId: string };
        return { status: 200, body: await archiveEntry(app, ctx, { entry_id: params.entryId }) };
      },
    },

    // --- T014: media mutations (spec §35). ---
    {
      spec: {
        method: "POST",
        url: "/media",
        operationId: "upload_media",
        idempotency: "supported",
        summary:
          "Direct binary upload; accepted assets include per-preset derivative failures when present (application/octet-stream + X-PCMS-Filename).",
        tag: "media",
        auth: "authenticated",
        permission: "media.write",
        successStatus: 201,
        responseSchema: mediaResponseSchema(
          {
            media_id: { type: "string" },
            version_no: { type: "integer" },
            sha256: { type: "string" },
            size_bytes: { type: "integer" },
            mime_type: { type: "string" },
            duplicate_blob: { type: "boolean" },
          },
          ["media_id", "version_no", "sha256", "size_bytes", "mime_type", "duplicate_blob"],
        ),
        bodyLimit: API_BODY_LIMIT_MEDIA_UPLOAD,
      },
      async handle(app, ctx, request) {
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          // Handled explicitly; the parser only accepts octet-stream bodies.
          throw new ApiError("API_REQUEST_INVALID", "media upload requires an octet-stream body", {
            status: 400,
          });
        }
        const filename = request.headers["x-pcms-filename"];
        if (typeof filename !== "string" || filename.length === 0 || filename.length > 255) {
          throw new ApiError("API_REQUEST_INVALID", "X-PCMS-Filename header is required", {
            status: 400,
          });
        }
        const declared = request.headers["x-pcms-mime-type"];
        const folderHeader = request.headers["x-pcms-folder-id"];
        const accepted = await uploadMediaOp(app, ctx, {
          bytes,
          filename,
          ...(typeof declared === "string" ? { declared_mime_type: declared } : {}),
          ...(typeof folderHeader === "string" && folderHeader !== ""
            ? { folder_id: folderHeader }
            : {}),
        });
        return {
          status: 201,
          body: {
            media_id: accepted.asset.id,
            version_no: accepted.version.versionNo,
            sha256: accepted.asset.sha256,
            size_bytes: accepted.asset.sizeBytes,
            mime_type: accepted.asset.mimeType,
            duplicate_blob: accepted.duplicateBlob,
            ...mediaVariantFailureField(accepted.media_variant_failures ?? []),
          },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/media/:mediaId/variants/regenerate",
        operationId: "regenerate_media_variants",
        summary: "Generate missing raster image variants for the active theme",
        tag: "media",
        auth: "authenticated",
        permission: "media.write",
        responseSchema: mediaResponseSchema(
          {
            media_id: { type: "string" },
            generated: { type: "integer", minimum: 0 },
            reused: { type: "integer", minimum: 0 },
          },
          ["media_id", "generated", "reused"],
        ),
      },
      async handle(app, ctx, request) {
        const params = request.params as { mediaId: string };
        return {
          status: 200,
          body: await regenerateMediaVariantsOp(app, ctx, { media_id: params.mediaId }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/media/import",
        operationId: "import_media_url",
        summary:
          "Server-side remote import (SSRF-safe); accepted assets include per-preset derivative failures when present.",
        tag: "media",
        auth: "authenticated",
        permission: "media.import",
        idempotency: "supported",
        successStatus: 201,
        responseSchema: mediaResponseSchema(
          {
            media_id: { type: "string" },
            version_no: { type: "integer" },
            sha256: { type: "string" },
            duplicate_blob: { type: "boolean" },
          },
          ["media_id", "version_no", "sha256", "duplicate_blob"],
        ),
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: { url: { type: "string", maxLength: 2048 } },
        },
      },
      async handle(app, ctx, request) {
        const accepted = await importMediaUrl(app, ctx, request.body as { url: string });
        return {
          status: 201,
          body: {
            media_id: accepted.asset.id,
            version_no: accepted.version.versionNo,
            sha256: accepted.asset.sha256,
            duplicate_blob: accepted.duplicateBlob,
            ...mediaVariantFailureField(accepted.media_variant_failures ?? []),
          },
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/media/folders",
        operationId: "list_media_folders",
        summary: "Logical media folders (editorial organization only)",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await listMediaFoldersOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/media/folders",
        operationId: "create_media_folder",
        summary: "Create a logical media folder",
        tag: "media",
        auth: "authenticated",
        permission: "media.write",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            parent_id: { ...STABLE_ID, nullable: true },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as { name: string; parent_id?: string };
        return {
          status: 201,
          body: await createMediaFolderOp(app, ctx, {
            name: body.name,
            ...(body.parent_id === undefined ? {} : { parent_id: body.parent_id }),
          }),
        };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/media/folders/:folderId",
        operationId: "update_media_folder",
        summary: "Rename and/or move a folder (cycle-protected)",
        tag: "media",
        auth: "authenticated",
        permission: "media.write",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            parent_id: { type: ["string", "null"], maxLength: 64 },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { folderId: string };
        const body = (request.body ?? {}) as { name?: string; parent_id?: string | null };
        return {
          status: 200,
          body: await updateMediaFolderOp(app, ctx, {
            folder_id: params.folderId,
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.parent_id === undefined ? {} : { parent_id: body.parent_id }),
          }),
        };
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/media/folders/:folderId",
        operationId: "delete_media_folder",
        summary: "Delete an empty folder (MEDIA_FOLDER_NOT_EMPTY otherwise)",
        tag: "media",
        auth: "authenticated",
        permission: "media.write",
      },
      async handle(app, ctx, request) {
        const params = request.params as { folderId: string };
        return {
          status: 200,
          body: await deleteMediaFolderOp(app, ctx, { folder_id: params.folderId }),
        };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/media/:mediaId/folder",
        operationId: "move_media_asset",
        summary:
          "Move an asset into a folder (null = root) — logical only, identity/URLs unchanged",
        tag: "media",
        auth: "authenticated",
        permission: "media.write",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["folder_id"],
          properties: { folder_id: { type: ["string", "null"], maxLength: 64 } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { mediaId: string };
        const body = (request.body ?? {}) as { folder_id?: unknown };
        if (body.folder_id !== null && typeof body.folder_id !== "string") {
          throw new ApiError("API_REQUEST_INVALID", "folder_id must be a string or null", {
            status: 422,
          });
        }
        return {
          status: 200,
          body: await moveMediaAssetOp(app, ctx, {
            media_id: params.mediaId,
            folder_id: body.folder_id as string | null,
          }),
        };
      },
    },
    {
      spec: {
        method: "PATCH",
        url: "/media/:mediaId",
        operationId: "update_media_metadata",
        summary: "Update descriptive metadata and the image focal point",
        tag: "media",
        auth: "authenticated",
        permission: "media.write",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", maxLength: 300, nullable: true },
            alt_default: { type: "string", maxLength: 300, nullable: true },
            caption_default: { type: "string", maxLength: 500, nullable: true },
            source_name: { type: "string", maxLength: 200, nullable: true },
            focal_x: { type: "number", minimum: 0, maximum: 1, nullable: true },
            focal_y: { type: "number", minimum: 0, maximum: 1, nullable: true },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { mediaId: string };
        const asset = (await updateMediaMetadataOp(app, ctx, {
          ...(request.body as object),
          media_id: params.mediaId,
        } as never)) as { id: string; title: string | null };
        return { status: 200, body: { media_id: asset.id, title: asset.title } };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/media/:mediaId/version",
        operationId: "replace_media_version",
        summary: "Replace the current document version (new immutable version)",
        tag: "media",
        auth: "authenticated",
        permission: "media.replace",
        bodyLimit: API_BODY_LIMIT_MEDIA_UPLOAD,
      },
      async handle(app, ctx, request) {
        const params = request.params as { mediaId: string };
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          throw new ApiError("API_REQUEST_INVALID", "media replace requires an octet-stream body", {
            status: 400,
          });
        }
        const filename = request.headers["x-pcms-filename"];
        if (typeof filename !== "string" || filename.length === 0) {
          throw new ApiError("API_REQUEST_INVALID", "X-PCMS-Filename header is required", {
            status: 400,
          });
        }
        const result = (await replaceMediaVersionOp(app, ctx, {
          media_id: params.mediaId,
          bytes,
          filename,
        })) as {
          version?: { versionNo?: number };
        };
        return {
          status: 200,
          body: { media_id: params.mediaId, version_no: result?.version?.versionNo ?? null },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/media/:mediaId/archive",
        operationId: "archive_media",
        summary: "Archive the asset (usage-aware hard delete is a privileged domain op)",
        tag: "media",
        auth: "authenticated",
        permission: "media.archive",
      },
      async handle(app, ctx, request) {
        const params = request.params as { mediaId: string };
        await archiveMediaOp(app, ctx, { media_id: params.mediaId });
        return { status: 200, body: { ok: true } };
      },
    },

    // --- T015: ChangeSet / PublicationPlan (spec §41). ---
    {
      spec: {
        method: "POST",
        url: "/changesets",
        operationId: "create_changeset",
        summary: "Create a ChangeSet (coordinated release container)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.plan",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: { title: { type: "string", minLength: 1, maxLength: 300 } },
        },
      },
      async handle(app, ctx, request) {
        return {
          status: 201,
          body: await createChangeset(app, ctx, request.body as { title: string }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/changesets/:changesetId/items",
        operationId: "add_changeset_item",
        summary: "Add a candidate (revision/route operation) to a ChangeSet",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.plan",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["entity_type", "entity_id", "intent", "expected_generation"],
          properties: {
            entity_type: { type: "string", enum: ["entry"] },
            entity_id: STABLE_ID,
            intent: { enum: ["PUBLISH", "UNPUBLISH"] },
            target_revision_id: STABLE_ID,
            expected_generation: { type: "integer", minimum: 0 },
            // Publication locale context (opt-in multilingual; "default"
            // sentinel keeps the baseline single-language flow).
            context: { type: "string", maxLength: 32 },
            route_operation: { type: "object" },
          },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { changesetId: string };
        return {
          status: 201,
          body: await addChangesetItem(app, ctx, {
            ...(request.body as {
              entity_type: string;
              entity_id: string;
              intent: "PUBLISH" | "UNPUBLISH";
              expected_generation: number;
              target_revision_id?: string;
              context?: string;
              route_operation?: unknown;
            }),
            changeset_id: params.changesetId,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/changesets/:changesetId/preflight",
        operationId: "preflight_changeset",
        summary: "Validate the whole release without applying it",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.plan",
      },
      async handle(app, ctx, request) {
        const params = request.params as { changesetId: string };
        return {
          status: 200,
          body: await preflightChangeset(app, ctx, { changeset_id: params.changesetId }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/changesets/:changesetId/apply",
        operationId: "apply_changeset",
        summary: "Apply the release: every pointer/route move in ONE transaction",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.publish",
      },
      async handle(app, ctx, request) {
        const params = request.params as { changesetId: string };
        return {
          status: 200,
          body: await applyChangeset(app, ctx, { changeset_id: params.changesetId }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/changesets/:changesetId/cancel",
        operationId: "cancel_changeset",
        summary: "Cancel a ChangeSet",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.plan",
      },
      async handle(app, ctx, request) {
        const params = request.params as { changesetId: string };
        await cancelChangeset(app, ctx, { changeset_id: params.changesetId });
        return { status: 200, body: { ok: true } };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/plans",
        operationId: "create_publication_plan",
        summary: "Create a publication plan for a ready ChangeSet",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.plan",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["changeset_id", "timezone"],
          properties: {
            changeset_id: STABLE_ID,
            timezone: { type: "string", maxLength: 64 },
            // FailurePolicy domain union (plans.ts) — the previous enum
            // ["pause_batch", "pause"] rejected the "continue" value the
            // Admin sends, surfacing a raw API-contract error.
            failure_policy: { enum: ["continue", "pause_batch", "pause_plan"] },
          },
        },
      },
      async handle(app, ctx, request) {
        return {
          status: 201,
          body: await createPublicationPlan(
            app,
            ctx,
            request.body as {
              changeset_id: string;
              timezone: string;
              failure_policy?: string;
            },
          ),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/plans/:planId/preview",
        operationId: "preview_publication_plan",
        summary: "Dry-run the schedule (nothing persisted)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.plan",
        bodySchema: PLAN_SCHEDULE_BODY as never,
      },
      async handle(app, ctx, request) {
        const params = request.params as { planId: string };
        const body = request.body as { spec: BatchScheduleSpec; overrides?: unknown[] };
        return {
          status: 200,
          body: {
            items: await previewPublicationPlan(app, ctx, {
              plan_id: params.planId,
              spec: body.spec,
              ...(body.overrides === undefined ? {} : { overrides: body.overrides }),
            }),
          },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/plans/:planId/schedule",
        operationId: "schedule_publication_plan",
        summary: "Materialize timestamps and enqueue idempotent jobs",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.schedule",
        idempotency: "supported",
        bodySchema: PLAN_SCHEDULE_BODY as never,
      },
      async handle(app, ctx, request) {
        const params = request.params as { planId: string };
        const body = request.body as { spec: BatchScheduleSpec; overrides?: unknown[] };
        return {
          status: 200,
          body: {
            items: await schedulePublicationPlan(app, ctx, {
              plan_id: params.planId,
              spec: body.spec,
              ...(body.overrides === undefined ? {} : { overrides: body.overrides }),
            }),
          },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/plans/:planId/items/:itemId/reschedule",
        operationId: "reschedule_publication_item",
        summary: "Atomic cancel+replace of one pending schedule",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.schedule",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["publish_at"],
          properties: { publish_at: { type: "string", format: "date-time" } },
        },
      },
      async handle(app, ctx, request) {
        const params = request.params as { planId: string; itemId: string };
        const body = request.body as { publish_at: string };
        return {
          status: 200,
          body: await reschedulePlanItem(app, ctx, {
            plan_id: params.planId,
            item_id: params.itemId,
            publish_at: body.publish_at,
          }),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/plans/:planId/items/:itemId/cancel",
        operationId: "cancel_publication_item",
        summary: "Cancel one scheduled item",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.schedule",
      },
      async handle(app, ctx, request) {
        const params = request.params as { planId: string; itemId: string };
        await cancelPlanItem(app, ctx, { plan_id: params.planId, item_id: params.itemId });
        return { status: 200, body: { ok: true } };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/plans/:planId/items/:itemId/publish-now",
        operationId: "publish_now",
        summary: "Cancel the pending schedule and publish exactly once",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.publish",
      },
      async handle(app, ctx, request) {
        const params = request.params as { planId: string; itemId: string };
        await publishNowOp(app, ctx, { plan_id: params.planId, item_id: params.itemId });
        return { status: 200, body: { ok: true } };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/publications/publish",
        operationId: "publish_revision",
        summary:
          "Direct single-entity publish with generation CAS. Entries WITHOUT a live public route are rejected (409 PUBLICATION_ROUTE_MISSING) — first publish goes through a changeset with a route_operation.",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.publish",
        idempotency: "supported",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["entity_type", "entity_id", "target_revision_id", "expected_generation"],
          properties: {
            // Only content entries are publishable through this surface; a
            // free-form string here used to surface as a misleading CAS
            // conflict for a non-existent (type, id) pair (spangar 2026-10-06).
            entity_type: { type: "string", enum: ["entry"] },
            entity_id: STABLE_ID,
            target_revision_id: STABLE_ID,
            expected_generation: { type: "integer", minimum: 0 },
            // Publication context: generation counters are tracked per
            // context; the "default" sentinel is the baseline single-locale
            // flow (unknown contexts create their own counter silently).
            context: { type: "string", maxLength: 32 },
            reason: { type: "string", maxLength: 500 },
          },
        },
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await publishRevision(app, ctx, request.body as never),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/publications/rollback",
        operationId: "rollback_publication",
        summary: "Point the pointer at a previous sealed revision",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.rollback",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["entity_type", "entity_id", "target_revision_id", "expected_generation"],
          properties: {
            entity_type: { type: "string", enum: ["entry"] },
            entity_id: STABLE_ID,
            target_revision_id: STABLE_ID,
            expected_generation: { type: "integer", minimum: 0 },
            context: { type: "string", maxLength: 32 },
            reason: { type: "string", maxLength: 500 },
          },
        },
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await rollbackPublication(app, ctx, request.body as never),
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/publications/unpublish",
        operationId: "unpublish_publication",
        summary: "Remove public visibility (history preserved)",
        tag: "publication",
        auth: "authenticated",
        permission: "publication.unpublish",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["entity_type", "entity_id", "expected_generation"],
          properties: {
            entity_type: { type: "string", enum: ["entry"] },
            entity_id: STABLE_ID,
            expected_generation: { type: "integer", minimum: 0 },
            context: { type: "string", maxLength: 32 },
            reason: { type: "string", maxLength: 500 },
          },
        },
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await unpublishPublication(app, ctx, request.body as never),
        };
      },
    },

    // --- T017/T018: Publication Bundle (spec §42–§46). ---
    {
      spec: {
        method: "POST",
        url: "/bundles",
        operationId: "submit_publication_bundle",
        summary:
          "Validate or atomically apply a coordinated content bundle (strict all-or-nothing)",
        tag: "bundle",
        auth: "authenticated",
        permission: "content.create",
        // Replay safety is enforced inside the application operation (the
        // bundle's external_id is the retry identity), not by the transport.
        bodyLimit: 5 * 1_048_576,
        bodySchema: {
          type: "object",
          required: ["bundle_version", "external_id", "changeset", "entries", "mode"],
          properties: {
            bundle_version: { type: "integer", enum: [1] },
            external_id: { type: "string", minLength: 8, maxLength: 200 },
            changeset: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string", minLength: 1, maxLength: 300 } },
            },
            entries: { type: "array", maxItems: 50 },
            media: { type: "array", maxItems: 50 },
            publication: {
              type: "object",
              properties: { mode: { enum: ["now", "none"] } },
            },
            mode: { enum: ["validate", "apply"] },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = request.body as { mode: "validate" | "apply" };
        const result = await submitBundle(app, ctx, body, body.mode);
        if ("accepted" in result && result.accepted === true) {
          return { status: 201, body: result };
        }
        return { status: 200, body: result };
      },
    },

    // --- T016: themes (spec §38) — validate/preview real, activation has no
    // v1 store (capability reported unavailable; no fake endpoint). ---
    {
      spec: {
        method: "POST",
        url: "/themes/validate",
        operationId: "validate_theme",
        summary: "Validate the configured theme source against the theme contract",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.validate",
      },
      async handle(app, ctx) {
        return { status: 200, body: await validateThemeOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/previews",
        operationId: "create_preview",
        summary: "Create a signed, expiring preview reference (never a public route)",
        tag: "themes",
        auth: "authenticated",
        permission: "preview.create",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["scope"],
          properties: {
            scope: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "entity_type", "entity_id", "revision_id"],
                  properties: {
                    kind: { enum: ["revision"] },
                    entity_type: { type: "string", enum: ["entry"] },
                    entity_id: STABLE_ID,
                    revision_id: STABLE_ID,
                    allow_draft: { type: "boolean" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "changeset_id"],
                  properties: {
                    kind: { enum: ["changeset"] },
                    changeset_id: STABLE_ID,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "template"],
                  properties: {
                    kind: { enum: ["service"] },
                    template: { enum: ["search", "error-404"] },
                    locale: { type: "string", maxLength: 64 },
                  },
                },
              ],
            },
            /** Candidate theme id (installed) for the /preview page render —
             * signed into the token (2026-10-01 site-developer request). */
            theme: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
          },
        },
      },
      async handle(app, ctx, request) {
        const result = await createThemePreview(app, ctx, request.body as never);
        return {
          status: 201,
          body: {
            token: result.token,
            preview_path: `${(request.body as { scope: { kind: string } }).scope.kind === "service" ? "/preview/page" : "/preview"}?token=${encodeURIComponent(result.token)}`,
          },
        };
      },
    },
  ];
  return routes;
}
