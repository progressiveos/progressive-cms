// HubSpot CRM lead connector: pushes new CMS leads into HubSpot as a
// contact + associated deal through the v3 CRM objects API with a private
// app token (Authorization: Bearer). Contact and deal creates carry the
// HubSpot `idempotencyKey` header seeded with the CMS lead id — safe
// retries never duplicate objects. Deal→contact association uses the
// built-in HUBSPOT_DEFINED type 3 (deal to contact).
// Docs: developers.hubspot.com/docs/api/crm/deals (v3).
import type { ConnectorDefinition } from "./connectors.js";
import {
  type ActionExecutionContext,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp, type OutboundHttpResponse } from "./transport.js";

const HUBSPOT_TIMEOUT_DEFAULT = 15_000;
const DEAL_TO_CONTACT_ASSOCIATION_TYPE = 3;

export const HUBSPOT_LEAD_PROJECTION_FIELDS = [
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

/** Deal title rule shared with the other CRM connectors: named lead wins,
 * then a summary slice, then the neutral fallback. */
export function leadTitle(projection: Readonly<Record<string, unknown>>): string {
  const name = text(projection["name"]);
  const summary = text(projection["summary"]);
  return name !== "" ? `Lead: ${name}` : summary !== "" ? summary.slice(0, 250) : "Website lead";
}

export function hubspotContactBody(projection: Readonly<Record<string, unknown>>): {
  properties: Record<string, string>;
} {
  const properties: Record<string, string> = {};
  const email = text(projection["email"]);
  const name = text(projection["name"]);
  const phone = text(projection["phone"]);
  if (email !== "") properties["email"] = email;
  if (name !== "") properties["firstname"] = name;
  if (phone !== "") properties["phone"] = phone;
  return { properties };
}

export function hubspotDealBody(input: {
  readonly projection: Readonly<Record<string, unknown>>;
  readonly contactId: string;
  readonly pipeline?: string;
  readonly dealStage?: string;
}): Record<string, unknown> {
  const { projection } = input;
  const presentation = text(projection["presentation"]);
  return {
    properties: {
      dealname: leadTitle(projection),
      ...(presentation !== "" ? { description: presentation } : {}),
      ...(input.pipeline !== undefined && input.pipeline !== ""
        ? { pipeline: input.pipeline }
        : {}),
      ...(input.dealStage !== undefined && input.dealStage !== ""
        ? { dealstage: input.dealStage }
        : {}),
    },
    associations: [
      {
        to: { id: input.contactId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: DEAL_TO_CONTACT_ASSOCIATION_TYPE,
          },
        ],
      },
    ],
  };
}

export const hubspotConnectorDefinition: ConnectorDefinition = {
  connectorType: "hubspot",
  title: "HubSpot",
  description:
    "Creates a HubSpot contact + associated deal from the CMS lead via the v3 CRM objects API with a private app token.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pipeline: { type: "string", maxLength: 64 },
      deal_stage: { type: "string", maxLength: 64 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
    },
  },
  secrets: [
    {
      name: "private_app_token",
      description:
        "HubSpot private app token (secrets scope: crm.objects.contacts.write, crm.objects.deals.write)",
    },
  ],
  testable: true,
  actions: [
    {
      actionType: "intake_lead",
      description: "Create a HubSpot contact and an associated deal from the CMS lead",
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
        fields: [...HUBSPOT_LEAD_PROJECTION_FIELDS],
      },
    },
  ],
};

function outcomeFailure(
  response: OutboundHttpResponse,
  prefix: string,
  provider: string,
): ReturnType<typeof actionFailed> {
  const detail = response.body.slice(0, 200);
  if (response.status === 401 || response.status === 403) {
    return actionFailed({
      retryable: false,
      httpStatus: response.status,
      providerErrorCode: `${prefix}_AUTH_FAILED`,
      errorMessage: `${provider} rejected the private app token (expired or missing scope?)`,
    });
  }
  if (response.status === 429 || response.status >= 500) {
    return actionFailed({
      retryable: true,
      httpStatus: response.status,
      providerErrorCode: `${prefix}_RATE_LIMITED`,
      errorMessage: `${provider} returned HTTP ${String(response.status)}`,
    });
  }
  return actionFailed({
    retryable: false,
    httpStatus: response.status,
    providerErrorCode: `${prefix}_HTTP_${String(response.status)}`,
    errorMessage: detail === "" ? `HTTP ${String(response.status)}` : detail,
  });
}

export function createHubspotConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  const call = async (
    method: "POST" | "GET",
    path: string,
    token: string,
    body?: unknown,
    timeoutMs = HUBSPOT_TIMEOUT_DEFAULT,
    idempotencyKey?: string,
  ): Promise<OutboundHttpResponse> =>
    http({
      method,
      url: `https://api.hubapi.com${path}`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        // Stable per logical create (seeded by the CMS lead id): safe
        // retries never duplicate the object.
        ...(idempotencyKey === undefined ? {} : { idempotencykey: idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs,
    });

  return {
    async execute(actionType, payload, ctx) {
      if (actionType !== "intake_lead") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown hubspot action "${actionType}"`,
        });
      }
      const token = ctx.secrets["private_app_token"];
      if (token === undefined || token === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "HUBSPOT_NO_TOKEN",
          errorMessage: "the HubSpot private app token is not configured",
        });
      }
      if (text(payload["lead_id"]) === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "HUBSPOT_PAYLOAD_INVALID",
          errorMessage: "mapped payload lacks lead_id",
        });
      }
      const projection = ctx.projection ?? {};
      const timeoutMs =
        typeof ctx.instance.config["timeout_ms"] === "number"
          ? (ctx.instance.config["timeout_ms"] as number)
          : HUBSPOT_TIMEOUT_DEFAULT;

      // 1. Contact (idempotent per lead via the idempotency key header).
      const leadId = text(payload["lead_id"]);
      let contactId: string;
      try {
        const response = await call(
          "POST",
          "/crm/v3/objects/contacts",
          token,
          hubspotContactBody(projection),
          timeoutMs,
          `pcms-contact-${leadId}`,
        );
        if (response.status < 200 || response.status >= 300) {
          return outcomeFailure(response, "HUBSPOT_CONTACT", "HubSpot");
        }
        contactId =
          (JSON.parse(response.body) as { id?: unknown }).id !== undefined
            ? String((JSON.parse(response.body) as { id: unknown }).id)
            : "";
      } catch (cause) {
        return networkFailure(cause, "HubSpot");
      }
      if (contactId === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "HUBSPOT_CONTACT_NO_ID",
          errorMessage: "HubSpot accepted the contact but returned no id",
        });
      }

      // 2. Deal associated with the contact.
      try {
        const response = await call(
          "POST",
          "/crm/v3/objects/deals",
          token,
          hubspotDealBody({
            projection,
            contactId,
            ...(text(ctx.instance.config["pipeline"]) !== ""
              ? { pipeline: text(ctx.instance.config["pipeline"]) }
              : {}),
            ...(text(ctx.instance.config["deal_stage"]) !== ""
              ? { dealStage: text(ctx.instance.config["deal_stage"]) }
              : {}),
          }),
          timeoutMs,
          `pcms-deal-${leadId}`,
        );
        if (response.status < 200 || response.status >= 300) {
          return outcomeFailure(response, "HUBSPOT_DEAL", "HubSpot");
        }
        const dealId = (JSON.parse(response.body) as { id?: unknown }).id;
        return actionSucceeded(dealId === undefined ? undefined : String(dealId));
      } catch (cause) {
        return networkFailure(cause, "HubSpot");
      }
    },

    async test(ctx) {
      const token = ctx.secrets["private_app_token"];
      if (token === undefined || token === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "HUBSPOT_NO_TOKEN",
          errorMessage: "the HubSpot private app token is not configured",
        });
      }
      try {
        // A cheap authenticated read: 200 proves token + scope, 401/403
        // proves the token is wrong — either way the domain was HubSpot.
        const response = await call(
          "GET",
          "/crm/v3/objects/deals?limit=1&archived=false",
          token,
          undefined,
          10_000,
        );
        if (response.status === 200) return actionSucceeded();
        return outcomeFailure(response, "HUBSPOT_TEST", "HubSpot");
      } catch (cause) {
        return networkFailure(cause, "HubSpot");
      }
    },
  };
}
