// Analytics & tagging REST surface (Analytics spec §10; ADR-0016).
// Strict schemas, typed errors, CAS settings save, authenticated reads —
// same conventions as every other domain module.

import {
  analyticsDoctorOp,
  getAnalyticsSettingsOp,
  listAnalyticsProvidersOp,
  saveAnalyticsSettingsOp,
} from "../../analytics-ops.js";
import type { ApiRoute } from "../registry.js";

const ANALYTICS_SETTINGS_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["settings", "expected_generation"],
  properties: {
    settings: { type: "object" },
    expected_generation: { type: "integer", minimum: 0 },
  },
} as const;

export function makeAnalyticsRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "GET",
        url: "/analytics/settings",
        operationId: "get_analytics_settings",
        summary: "Analytics & tagging settings with CAS generation (analytics.read)",
        tag: "discovery",
        auth: "authenticated",
        permission: "analytics.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await getAnalyticsSettingsOp(app, ctx) };
      },
    },
    {
      spec: {
        method: "PUT",
        url: "/analytics/settings",
        operationId: "update_analytics_settings",
        summary:
          "Save analytics & tagging settings (CAS; analytics.manage, rules need analytics.network.manage)",
        tag: "discovery",
        auth: "authenticated",
        permission: "analytics.manage",
        bodySchema: ANALYTICS_SETTINGS_BODY,
      },
      async handle(app, ctx, request) {
        const body = request.body as {
          settings: unknown;
          expected_generation: number;
        };
        return {
          status: 200,
          body: await saveAnalyticsSettingsOp(app, ctx, {
            settings: body.settings,
            expected_generation: body.expected_generation,
          }),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/analytics/providers",
        operationId: "list_analytics_providers",
        summary: "Registered analytics tag providers (typed contract; no code surfaces)",
        tag: "discovery",
        auth: "authenticated",
        permission: "analytics.read",
      },
      async handle(app) {
        return { status: 200, body: await listAnalyticsProvidersOp(app) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/analytics/doctor",
        operationId: "analytics_doctor",
        summary: "Analytics installation diagnostics (config, render plan, slots, CSP)",
        tag: "discovery",
        auth: "authenticated",
        permission: "analytics.read",
      },
      async handle(app, ctx) {
        return { status: 200, body: await analyticsDoctorOp(app, ctx) };
      },
    },
  ];
}
