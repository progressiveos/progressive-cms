// Bitrix24 CRM lead connector (owner request): pushes new CMS leads into
// Bitrix24 through an INCOMING WEBHOOK (crm.lead.add). Contract per
// apidocs.bitrix24.com (crm.lead.add): POST {portal}/rest/{user}/{code}/crm.lead.add.json
// with {fields: {TITLE, NAME, PHONE: [{VALUE, VALUE_TYPE}], EMAIL: [...],
// COMMENTS, SOURCE_ID, SOURCE_DESCRIPTION}}; response {result: <lead id>} /
// {error, error_description}. The webhook code is a SECRET slot (it grants
// CRM write access); the portal URL and user id are plain config.
// Payloads are byte-stable across retries (no wall-clock in the body).

import type { ConnectorDefinition } from "./connectors.js";
import {
  type ActionExecutionContext,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp, type OutboundHttpResponse } from "./transport.js";

const B24_TIMEOUT_DEFAULT = 15_000;

export const B24_LEAD_PROJECTION_FIELDS = [
  "lead_id",
  "source_type",
  "source_id",
  "classification",
  "created_at",
  "name",
  "email",
  "phone",
  "summary",
  "presentation",
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Builds the crm.lead.add request body from a lead projection. Deterministic:
 * the same projection yields byte-identical JSON (HQ-style replay safety —
 * Bitrix24 itself dedups leads by configured duplicate rules, not by body). */
export function bitrix24LeadBody(input: {
  readonly sourceSite: string;
  readonly projection: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const { projection } = input;
  const name = text(projection["name"]);
  const email = text(projection["email"]);
  const phone = text(projection["phone"]);
  const summary = text(projection["summary"]);
  const presentation = text(projection["presentation"]);
  const sourceType = text(projection["source_type"]);
  const sourceId = text(projection["source_id"]);
  const site = text(input.sourceSite);
  const comments = presentation !== "" ? presentation : summary;
  const title =
    name !== ""
      ? `Lead: ${name}`
      : summary !== ""
        ? summary.slice(0, 250)
        : `${sourceType || "lead"} ${sourceId}`;
  const fields: Record<string, unknown> = {
    TITLE: title,
    ...(name === "" ? {} : { NAME: name }),
    ...(email === "" ? {} : { EMAIL: [{ VALUE: email, VALUE_TYPE: "WORK" }] }),
    ...(phone === "" ? {} : { PHONE: [{ VALUE: phone, VALUE_TYPE: "WORK" }] }),
    ...(comments === "" ? {} : { COMMENTS: comments }),
    SOURCE_ID: "WEB",
    SOURCE_DESCRIPTION: (site === "" ? "Progressive CMS" : `Progressive CMS / ${site}`).slice(
      0,
      250,
    ),
  };
  return { fields, params: { REGISTER_SONET_EVENT: "N" } };
}

export const bitrix24ConnectorDefinition: ConnectorDefinition = {
  connectorType: "bitrix24",
  title: "Bitrix24",
  description:
    "Creates leads in Bitrix24 CRM through an incoming webhook (crm.lead.add). Webhook code is stored encrypted.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      portal_url: { type: "string", format: "uri", maxLength: 255 },
      user_id: { type: "string", maxLength: 32 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
    },
    required: ["portal_url", "user_id"],
  },
  secrets: [
    {
      name: "webhook_code",
      description: "Bitrix24 incoming webhook code (the token part of the webhook URL)",
    },
  ],
  testable: true,
  actions: [
    {
      actionType: "intake_lead",
      description: "Create a Bitrix24 lead from the CMS lead",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          lead_id: { type: "string", maxLength: 64 },
          source_type: { type: "string", maxLength: 40 },
          source_id: { type: "string", maxLength: 64 },
          classification: { type: "string", maxLength: 120 },
          created_at: { type: "string", maxLength: 64 },
        },
        required: ["lead_id"],
      },
      executionProjection: {
        aggregate: "lead",
        idFromPayload: "lead_id",
        fields: [...B24_LEAD_PROJECTION_FIELDS],
      },
    },
  ],
};

export function createBitrix24ConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  return {
    async execute(
      actionType: string,
      payload: Readonly<Record<string, unknown>>,
      ctx: {
        readonly instance: {
          readonly config: Readonly<Record<string, unknown>>;
        };
        readonly secrets: Readonly<Record<string, string | undefined>>;
        readonly projection?: Readonly<Record<string, unknown>>;
      },
    ) {
      if (actionType !== "intake_lead") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown bitrix24 action "${actionType}"`,
        });
      }
      const code = ctx.secrets["webhook_code"];
      if (code === undefined || code === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "B24_NO_WEBHOOK_CODE",
          errorMessage: "the Bitrix24 incoming webhook code is not configured",
        });
      }
      const portal = text(ctx.instance.config["portal_url"]).replace(/\/+$/, "");
      const userId = text(ctx.instance.config["user_id"]);
      if (portal === "" || userId === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "B24_CONFIG_INVALID",
          errorMessage: "portal_url and user_id are required in the connection config",
        });
      }
      const leadId = text(payload["lead_id"]);
      if (leadId === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "B24_PAYLOAD_INVALID",
          errorMessage: "mapped payload lacks lead_id",
        });
      }
      // The projection is fetched fresh per attempt by the dispatcher; the
      // email/phone format gate mirrors the HQ connector.
      const email = text(ctx.projection?.["email"]);
      if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "B24_CONTACT_FORMAT_INVALID",
          errorMessage: `projected email does not look like an address: "${email.slice(0, 64)}"`,
        });
      }
      const phone = text(ctx.projection?.["phone"]);
      if (phone !== "" && !/^[+0-9()\-\s]{5,40}$/.test(phone)) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "B24_CONTACT_FORMAT_INVALID",
          errorMessage: `projected phone does not look like a number: "${phone.slice(0, 64)}"`,
        });
      }
      const timeoutMs =
        typeof ctx.instance.config["timeout_ms"] === "number"
          ? (ctx.instance.config["timeout_ms"] as number)
          : B24_TIMEOUT_DEFAULT;
      const url = `${portal}/rest/${encodeURIComponent(userId)}/${encodeURIComponent(code)}/crm.lead.add.json`;
      const body = JSON.stringify(
        bitrix24LeadBody({
          sourceSite: text(ctx.instance.config["source_site"] ?? ""),
          projection: ctx.projection ?? {},
        }),
      );
      let response: OutboundHttpResponse;
      try {
        response = await http({
          method: "POST",
          url,
          headers: { "content-type": "application/json" },
          body,
          timeoutMs,
        });
      } catch (cause) {
        return networkFailure(cause, "Bitrix24");
      }
      if (response.status >= 200 && response.status < 300) {
        try {
          const parsed = JSON.parse(response.body) as { result?: unknown };
          return actionSucceeded(
            typeof parsed.result === "number" || typeof parsed.result === "string"
              ? String(parsed.result)
              : undefined,
          );
        } catch {
          return actionSucceeded(); // 2xx with an unexpected body still counts
        }
      }
      const parsed = (() => {
        try {
          return JSON.parse(response.body) as { error?: string; error_description?: string };
        } catch {
          return {} as { error?: string; error_description?: string };
        }
      })();
      if (response.status === 401) {
        return actionFailed({
          retryable: false,
          httpStatus: response.status,
          providerErrorCode: "B24_AUTH_FAILED",
          errorMessage: parsed.error_description ?? "Bitrix24 rejected the webhook credentials",
        });
      }
      if (response.status === 429 || response.status >= 500) {
        return actionFailed({
          retryable: true,
          httpStatus: response.status,
          providerErrorCode: "B24_RATE_LIMITED",
          errorMessage:
            parsed.error_description ?? `Bitrix24 returned HTTP ${String(response.status)}`,
        });
      }
      return actionFailed({
        retryable: false,
        httpStatus: response.status,
        providerErrorCode: `B24_HTTP_${String(response.status)}`,
        errorMessage: (
          parsed.error_description ??
          parsed.error ??
          `HTTP ${String(response.status)}`
        ).slice(0, 200),
      });
    },

    async test(ctx: ActionExecutionContext) {
      const code = ctx.secrets["webhook_code"];
      const portal = text(ctx.instance.config["portal_url"]).replace(/\/+$/, "");
      const userId = text(ctx.instance.config["user_id"]);
      if (portal === "" || userId === "" || code === undefined || code === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "B24_CONFIG_INVALID",
          errorMessage: "portal_url, user_id and the webhook code are required",
        });
      }
      // Bitrix24 offers no dry-run; a GET to the portal root only proves reachability.
      try {
        const response = await http({ method: "GET", url: portal, timeoutMs: 10_000 });
        return response.status < 500
          ? actionSucceeded()
          : actionFailed({
              retryable: true,
              httpStatus: response.status,
              providerErrorCode: "B24_UNAVAILABLE",
              errorMessage: `Bitrix24 responded HTTP ${String(response.status)}`,
            });
      } catch (cause) {
        return networkFailure(cause, "Bitrix24");
      }
    },
  };
}
