// Outbound mail operations routes (PCMS-OPS-T110; Operations spec §31;
// PCMS-OPS-T130 Admin-managed SMTP settings). Guarded by integrations.*;
// credentials are write-only — no route ever returns a password value.
import type { ApplicationServices, OperationContext } from "../../context.js";
import { getMailSettingsOp, testMailTransport, updateMailSettingsOp } from "../../mail-ops.js";
import type { ApiRoute } from "../registry.js";

export function makeMailRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [
    {
      spec: {
        method: "POST",
        url: "/mail/test",
        operationId: "test_mail_transport",
        summary:
          "Probe the mail transport. Without overrides probes the configured transport (with `to`, one test message is delivered); with host/port/mode/username/password probes the values as typed (unsaved settings), falling back to the stored password when none is typed. Never returns or logs credentials.",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.test",
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            to: { type: "string", maxLength: 320 },
            host: { type: "string", minLength: 1, maxLength: 253 },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            mode: { enum: ["smtps", "starttls", "plain"] },
            username: { type: "string", maxLength: 320 },
            password: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const override: {
          host?: string;
          port?: number;
          mode?: "smtps" | "starttls" | "plain";
          username?: string;
          password?: string;
        } = {
          ...(typeof body.host === "string" && body.host.length > 0 ? { host: body.host } : {}),
          ...(typeof body.port === "number" ? { port: body.port } : {}),
          ...(body.mode === "smtps" || body.mode === "starttls" || body.mode === "plain"
            ? { mode: body.mode }
            : {}),
          ...(typeof body.username === "string" && body.username.length > 0
            ? { username: body.username }
            : {}),
          ...(typeof body.password === "string" && body.password.length > 0
            ? { password: body.password }
            : {}),
        };
        return {
          status: 200,
          body: await testMailTransport(app, ctx, {
            ...(typeof body.to === "string" && body.to.length > 0 ? { to: body.to } : {}),
            ...(override.host === undefined ? {} : { override }),
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/mail/settings",
        operationId: "get_mail_settings",
        summary:
          "Admin-managed SMTP settings, sanitized (never returns the password — only whether one is stored).",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getMailSettingsOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/mail/settings",
        operationId: "update_mail_settings",
        summary:
          "Save Admin-managed SMTP settings. Enabling verifies the connection before persisting; the password is write-only (string stores encrypted, null clears, absent keeps).",
        tag: "integrations",
        auth: "authenticated",
        permission: "integrations.configure",
        csrf: true,
        bodySchema: {
          type: "object",
          required: ["enabled", "from", "host"],
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            from: { type: "string", minLength: 3, maxLength: 320 },
            host: { type: "string", minLength: 1, maxLength: 253 },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            mode: { enum: ["smtps", "starttls", "plain"] },
            username: { type: "string", maxLength: 320 },
            password: { type: ["string", "null"], minLength: 1, maxLength: 1024 },
          },
        },
      },
      async handle(app, ctx, request) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        return {
          status: 200,
          body: await updateMailSettingsOp(app, ctx, {
            enabled: body.enabled === true,
            from: String(body.from ?? ""),
            host: String(body.host ?? ""),
            ...(body.port === undefined ? {} : { port: Number(body.port) }),
            ...(body.mode === undefined
              ? {}
              : { mode: body.mode as "smtps" | "starttls" | "plain" }),
            ...(body.username === undefined ? {} : { username: String(body.username) }),
            ...(body.password === undefined
              ? {}
              : body.password === null
                ? { password: null }
                : { password: String(body.password) }),
          }),
        };
      },
    },
  ];
  return routes;
}
