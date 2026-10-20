// AmoCRM lead connector (owner request): pushes new CMS leads into AmoCRM
// through POST /api/v4/leads/complex (lead + contact in one call) with a
// long-lived access token issued in the AmoCRM UI (Authorization: Bearer).
// Contract per amocrm.ru/developers (leads-api): body is an ARRAY of deal
// objects; _embedded.contacts[0] carries custom_fields_values with
// field_code EMAIL/PHONE; response 200 [{id, contact_id, merged, request_id}].
// The lead's readable presentation goes into the deal name/first note-able
// description — amoCRM has no single long-text lead field, so the
// presentation is delivered via the contact "note"? No — v1 keeps it simple:
// deal name = title line, presentation is appended to the deal `name` is
// wrong; instead the presentation rides in `request_id`-adjacent metadata is
// not supported either. Decision (documented): the deal gets
// name = "Lead: {name}"; the FULL readable presentation is stored in the
// deal's built-in note analogue — amoCRM v4 has no such field on
// complex add, so the presentation is truncated into `name`? NO.
//
// Final contract decision: AmoCRM complex-add supports `custom_fields_values`
// on the DEAL too. Operators map a free-text deal field (e.g. a
// created "Website lead" text field) by FIELD ID in config; when
// `presentation_field_id` is configured, the immutable presentation is
// attached there. Without it, only the contact + name are sent.

import type { ConnectorDefinition } from "./connectors.js";
import {
  type ActionExecutionContext,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp, type OutboundHttpResponse } from "./transport.js";

const AMO_TIMEOUT_DEFAULT = 15_000;

export const AMO_LEAD_PROJECTION_FIELDS = [
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

/** Builds the /api/v4/leads/complex body (array with ONE deal) from a lead
 * projection. Deterministic: same projection → byte-identical JSON. */
export function amocrmLeadBody(input: {
  readonly sourceSite: string;
  readonly projection: Readonly<Record<string, unknown>>;
  readonly presentationFieldId?: number;
}): readonly Record<string, unknown>[] {
  const { projection } = input;
  const name = text(projection["name"]);
  const email = text(projection["email"]);
  const phone = text(projection["phone"]);
  const summary = text(projection["summary"]);
  const presentation = text(projection["presentation"]);
  const site = text(input.sourceSite);
  const title =
    name !== "" ? `Lead: ${name}` : summary !== "" ? summary.slice(0, 250) : "Website lead";
  const contactFields: Record<string, unknown>[] = [];
  if (email !== "") {
    contactFields.push({
      field_code: "EMAIL",
      values: [{ enum_code: "WORK", value: email }],
    });
  }
  if (phone !== "") {
    contactFields.push({
      field_code: "PHONE",
      values: [{ enum_code: "WORK", value: phone }],
    });
  }
  const deal: Record<string, unknown> = {
    name: title,
    ...(input.presentationFieldId !== undefined && presentation !== ""
      ? {
          custom_fields_values: [
            {
              field_id: input.presentationFieldId,
              values: [{ value: presentation }],
            },
          ],
        }
      : {}),
    request_id: text(projection["lead_id"]) || undefined,
    _embedded: {
      contacts: [
        {
          ...(name === "" ? {} : { first_name: name }),
          ...(contactFields.length === 0 ? {} : { custom_fields_values: contactFields }),
        },
      ],
    },
  };
  void site;
  return [deal];
}

export const amocrmConnectorDefinition: ConnectorDefinition = {
  connectorType: "amocrm",
  title: "amoCRM",
  description:
    "Creates leads in AmoCRM (deal + contact in one call) via /api/v4/leads/complex with a long-lived access token.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      domain: { type: "string", maxLength: 120 },
      pipeline_id: { type: "integer", minimum: 1 },
      presentation_field_id: { type: "integer", minimum: 1 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
    },
    required: ["domain"],
  },
  secrets: [
    {
      name: "access_token",
      description: "AmoCRM long-lived access token",
    },
  ],
  testable: true,
  actions: [
    {
      actionType: "intake_lead",
      description: "Create an AmoCRM deal (with contact) from the CMS lead",
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
        fields: [...AMO_LEAD_PROJECTION_FIELDS],
      },
    },
  ],
};

export function createAmocrmConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  return {
    async execute(
      actionType: string,
      payload: Readonly<Record<string, unknown>>,
      ctx: ActionExecutionContext,
    ) {
      if (actionType !== "intake_lead") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown amocrm action "${actionType}"`,
        });
      }
      const token = ctx.secrets["access_token"];
      if (token === undefined || token === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "AMO_NO_TOKEN",
          errorMessage: "the AmoCRM access token is not configured",
        });
      }
      const domain = text(ctx.instance.config["domain"])
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
      if (domain === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "AMO_CONFIG_INVALID",
          errorMessage: "domain is required in the connection config (e.g. company.amocrm.ru)",
        });
      }
      const leadId = text(payload["lead_id"]);
      if (leadId === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "AMO_PAYLOAD_INVALID",
          errorMessage: "mapped payload lacks lead_id",
        });
      }
      const email = text(ctx.projection?.["email"]);
      if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "AMO_CONTACT_FORMAT_INVALID",
          errorMessage: `projected email does not look like an address: "${email.slice(0, 64)}"`,
        });
      }
      const phone = text(ctx.projection?.["phone"]);
      if (phone !== "" && !/^[+0-9()\-\s]{5,40}$/.test(phone)) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "AMO_CONTACT_FORMAT_INVALID",
          errorMessage: `projected phone does not look like a number: "${phone.slice(0, 64)}"`,
        });
      }
      const timeoutMs =
        typeof ctx.instance.config["timeout_ms"] === "number"
          ? (ctx.instance.config["timeout_ms"] as number)
          : AMO_TIMEOUT_DEFAULT;
      const pipelineId = ctx.instance.config["pipeline_id"];
      const presentationFieldId = ctx.instance.config["presentation_field_id"];
      const bodyArray = amocrmLeadBody({
        sourceSite: text(ctx.instance.config["source_site"] ?? ""),
        projection: ctx.projection ?? {},
        ...(typeof presentationFieldId === "number" ? { presentationFieldId } : {}),
      });
      if (typeof pipelineId === "number") {
        (bodyArray[0] as Record<string, unknown>)["pipeline_id"] = pipelineId;
      }
      const url = `https://${domain}/api/v4/leads/complex`;
      let response: OutboundHttpResponse;
      try {
        response = await http({
          method: "POST",
          url,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(bodyArray),
          timeoutMs,
        });
      } catch (cause) {
        return networkFailure(cause, "AmoCRM");
      }
      if (response.status >= 200 && response.status < 300) {
        try {
          const parsed = JSON.parse(response.body) as { id?: unknown }[];
          const first = Array.isArray(parsed) ? parsed[0] : undefined;
          return actionSucceeded(
            first !== undefined && (typeof first?.id === "number" || typeof first?.id === "string")
              ? String(first.id)
              : undefined,
          );
        } catch {
          return actionSucceeded();
        }
      }
      const detail = response.body.slice(0, 200);
      if (response.status === 401) {
        return actionFailed({
          retryable: false,
          httpStatus: response.status,
          providerErrorCode: "AMO_AUTH_FAILED",
          errorMessage: "AmoCRM rejected the access token (expired or revoked?)",
        });
      }
      if (response.status === 429 || response.status >= 500) {
        return actionFailed({
          retryable: true,
          httpStatus: response.status,
          providerErrorCode: "AMO_RATE_LIMITED",
          errorMessage: `AmoCRM returned HTTP ${String(response.status)}`,
        });
      }
      return actionFailed({
        retryable: false,
        httpStatus: response.status,
        providerErrorCode: `AMO_HTTP_${String(response.status)}`,
        errorMessage: detail === "" ? `HTTP ${String(response.status)}` : detail,
      });
    },
    async test(ctx: ActionExecutionContext) {
      const domain = text(ctx.instance.config["domain"])
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
      if (domain === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "AMO_CONFIG_INVALID",
          errorMessage: "domain is required",
        });
      }
      try {
        // /api/v4/accounts/current requires auth — a 401 there proves the
        // domain is an AmoCRM installation; 200 proves the token works too.
        const token = ctx.secrets["access_token"];
        const response = await http({
          method: "GET",
          url: `https://${domain}/api/v4/accounts/current`,
          ...(token !== undefined && token !== ""
            ? { headers: { authorization: `Bearer ${token}` } }
            : {}),
          timeoutMs: 10_000,
        });
        if (response.status === 200) return actionSucceeded();
        if (response.status === 401) {
          return actionFailed({
            retryable: false,
            providerErrorCode: "AMO_AUTH_FAILED",
            errorMessage: "domain reachable but the access token was rejected",
          });
        }
        return actionFailed({
          retryable: response.status >= 500,
          providerErrorCode: `AMO_HTTP_${String(response.status)}`,
          errorMessage: `AmoCRM responded HTTP ${String(response.status)}`,
        });
      } catch (cause) {
        return networkFailure(cause, "AmoCRM");
      }
    },
  };
}
