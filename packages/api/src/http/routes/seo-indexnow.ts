// IndexNow REST surface (Progressive_CMS_IndexNow_v1_Spec.md §29).
// Reads: seo.read; writes (settings/rotate/check): seo.site_settings.
// CAS on settings; no endpoint configuration surface exists anywhere.
import {
  checkIndexNowOp,
  getIndexNowSettingsOp,
  getIndexNowStatusOp,
  rotateIndexNowKeyOp,
  saveIndexNowSettingsOp,
} from "../../indexnow-ops.js";
import type { ApiRoute } from "../registry.js";

const INDEXNOW_PUT_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["settings", "expected_generation"],
  properties: {
    settings: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        notifyOnPublish: { type: "boolean" },
        notifyOnUpdate: { type: "boolean" },
        notifyOnUnpublish: { type: "boolean" },
        notifyOnRouteChange: { type: "boolean" },
      },
    },
    expected_generation: { type: "integer", minimum: 0 },
  },
} as const;

export function makeSeoIndexNowRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/seo/indexnow",
        operationId: "get_indexnow_settings",
        summary: "IndexNow settings + CAS generation + derived state (seo.read)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getIndexNowSettingsOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/seo/indexnow",
        operationId: "update_indexnow_settings",
        summary:
          "Save IndexNow settings (CAS; default disabled; enabling generates the key and queues at most one homepage verification) (seo.site_settings)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.site_settings",
        csrf: true,
        bodySchema: INDEXNOW_PUT_BODY,
      },
      async handle(app, ctx, request) {
        const body = request.body as {
          settings: { enabled: boolean } & Record<string, unknown>;
          expected_generation: number;
        };
        const result = await saveIndexNowSettingsOp(app, ctx, {
          settings: {
            enabled: body.settings.enabled,
            ...(typeof body.settings.notifyOnPublish === "boolean"
              ? { notifyOnPublish: body.settings.notifyOnPublish }
              : {}),
            ...(typeof body.settings.notifyOnUpdate === "boolean"
              ? { notifyOnUpdate: body.settings.notifyOnUpdate }
              : {}),
            ...(typeof body.settings.notifyOnUnpublish === "boolean"
              ? { notifyOnUnpublish: body.settings.notifyOnUnpublish }
              : {}),
            ...(typeof body.settings.notifyOnRouteChange === "boolean"
              ? { notifyOnRouteChange: body.settings.notifyOnRouteChange }
              : {}),
          },
          expected_generation: body.expected_generation,
        });
        return { status: 200, body: result };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/seo/indexnow/status",
        operationId: "get_indexnow_status",
        summary:
          "IndexNow delivery status: state, key file URL, pending count, diagnostics (seo.read)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app) {
        return { status: 200, body: await getIndexNowStatusOp(app) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/seo/indexnow/check",
        operationId: "check_indexnow",
        summary:
          "Local configuration checks + enqueue the single homepage verification notification (seo.site_settings)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.site_settings",
        csrf: true,
      },
      async handle(app, ctx) {
        return { status: 200, body: await checkIndexNowOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/seo/indexnow/rotate-key",
        operationId: "rotate_indexnow_key",
        summary:
          "Generate a fresh IndexNow key (pending jobs resolve the key at send time) (seo.site_settings)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.site_settings",
        csrf: true,
      },
      async handle(app, ctx) {
        return { status: 200, body: await rotateIndexNowKeyOp(app, ctx) };
      },
    },
  ];
}
