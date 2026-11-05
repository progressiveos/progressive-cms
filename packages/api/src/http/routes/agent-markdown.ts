import {
  getAgentMarkdownSettingsOp,
  getEntryMarkdownSettingsOp,
  saveAgentMarkdownSettingsOp,
  saveEntryMarkdownSettingsOp,
} from "../../markdown-settings-ops.js";
import type { ApiRoute } from "../registry.js";

const ENTRY_ID = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
} as const;
const SETTINGS_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "expected_generation"],
  properties: {
    enabled: { type: "boolean" },
    expected_generation: { type: "integer", minimum: 0 },
  },
} as const;

export function makeAgentMarkdownRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/markdown/settings",
        operationId: "get_agent_markdown_settings",
        summary: "Read the site-wide Markdown availability switch (seo.read)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getAgentMarkdownSettingsOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/markdown/settings",
        operationId: "update_agent_markdown_settings",
        summary: "Set site-wide Markdown availability (seo.site_settings)",
        tag: "discovery",
        auth: "authenticated",
        permission: "seo.site_settings",
        csrf: true,
        bodySchema: SETTINGS_BODY,
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await saveAgentMarkdownSettingsOp(
            app,
            ctx,
            request.body as { enabled: boolean; expected_generation: number },
          ),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/entries/:entryId/markdown",
        operationId: "get_entry_markdown_settings",
        summary: "Read one entry's Markdown availability switch (content.read)",
        tag: "content",
        auth: "authenticated",
        permission: "content.read",
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["entryId"],
          properties: { entryId: ENTRY_ID },
        },
      },
      async handle(app, ctx, request) {
        const { entryId } = request.params as { entryId: string };
        return { status: 200, body: await getEntryMarkdownSettingsOp(app, ctx, entryId) };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/entries/:entryId/markdown",
        operationId: "update_entry_markdown_settings",
        summary: "Set one entry's Markdown availability switch (content.edit)",
        tag: "content",
        auth: "authenticated",
        permission: "content.edit",
        csrf: true,
        paramsSchema: {
          type: "object",
          additionalProperties: false,
          required: ["entryId"],
          properties: { entryId: ENTRY_ID },
        },
        bodySchema: SETTINGS_BODY,
      },
      async handle(app, ctx, request) {
        const { entryId } = request.params as { entryId: string };
        return {
          status: 200,
          body: await saveEntryMarkdownSettingsOp(
            app,
            ctx,
            entryId,
            request.body as { enabled: boolean; expected_generation: number },
          ),
        };
      },
    },
  ];
}
