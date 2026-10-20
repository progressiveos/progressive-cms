// Notifications v1 routes (owner brief 2026-10-07): operator recipient
// routing + per-user subscriptions. Settings are gated by integrations.*
// (the SMTP transport they deliver through lives on the same screen);
// subscriptions are self-service for signed-in users. Recipient e-mails are
// resolved server-side from the users table — no free-form addresses.
import type { ApplicationServices, OperationContext } from "../../context.js";
import {
  getMyNotificationPrefsOp,
  getNotificationSettingsOp,
  saveMyNotificationPrefsOp,
  saveNotificationSettingsOp,
} from "../../notifications-ops.js";
import type { ApiRoute } from "../registry.js";

export function makeNotificationRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/notifications/settings",
        operationId: "get_notification_settings",
        summary:
          "Notification routing: per-category recipient users, per-form overrides, site wordmark — plus candidate users and forms for the picker",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getNotificationSettingsOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/notifications/settings",
        operationId: "update_notification_settings",
        summary: "Save notification routing (recipients must be existing ACTIVE site users)",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.configure",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["settings"],
          properties: { settings: { type: ["object", "null"] } },
        },
      },
      async handle(app, ctx, request) {
        const body = request.body as { settings?: unknown };
        return {
          status: 200,
          body: await saveNotificationSettingsOp(app, ctx, { settings: body.settings ?? {} }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/notifications/subscriptions",
        operationId: "get_notification_subscriptions",
        summary:
          "The signed-in user's notification subscriptions (defaults: all enabled, immediate)",
        tag: "integrations",
        auth: "authenticated",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getMyNotificationPrefsOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/notifications/subscriptions",
        operationId: "update_notification_subscriptions",
        summary:
          "Save the signed-in user's notification subscriptions (category opt-outs + digest interval)",
        tag: "integrations",
        auth: "authenticated",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            disabled: { type: "array", items: { type: "string", maxLength: 32 } },
            digest_minutes: { type: "integer", minimum: 0, maximum: 720 },
            locale: { type: "string", enum: ["ru", "en"] },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = request.body as {
          disabled?: unknown;
          digest_minutes?: unknown;
          locale?: unknown;
        };
        return {
          status: 200,
          body: await saveMyNotificationPrefsOp(app, ctx, {
            disabled: body.disabled ?? [],
            digest_minutes: body.digest_minutes ?? 0,
            locale: body.locale,
          }),
        };
      },
    },
  ];
}
