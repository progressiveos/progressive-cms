// Pipedrive lead connector: pushes new CMS leads into Pipedrive as a
// person + deal through the v1 REST API with an api_token (query param —
// the documented auth for v1). Persons are deduped by email/phone search
// before create (Pipedrive has no create idempotency key); the immutable
// lead presentation rides a deal note — a failed note after deal creation
// fails the delivery NON-retryably so the retry never duplicates the deal.
// Docs: developers.pipedrive.com/docs/api/v1.
import type { ConnectorDefinition } from "./connectors.js";
import { leadTitle } from "./hubspot.js";
import {
  type ActionExecutionContext,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp, type OutboundHttpResponse } from "./transport.js";

const PIPEDRIVE_TIMEOUT_DEFAULT = 15_000;

export const PIPEDRIVE_LEAD_PROJECTION_FIELDS = [
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

function idOf(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function pipedrivePersonBody(projection: Readonly<Record<string, unknown>>): {
  name: string;
  email?: string[];
  phone?: string[];
} {
  const name = text(projection["name"]);
  const email = text(projection["email"]);
  const phone = text(projection["phone"]);
  return {
    name:
      name !== ""
        ? name
        : text(projection["email"]) !== ""
          ? text(projection["email"])
          : "Website lead",
    ...(email !== "" ? { email: [email] } : {}),
    ...(phone !== "" ? { phone: [phone] } : {}),
  };
}

export const pipedriveConnectorDefinition: ConnectorDefinition = {
  connectorType: "pipedrive",
  title: "Pipedrive",
  description:
    "Creates a Pipedrive person + deal from the CMS lead via the v1 API with an api_token; persons are deduped by email/phone search.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
    },
  },
  secrets: [
    {
      name: "api_token",
      description: "Pipedrive API token (Settings → Personal → API)",
    },
  ],
  testable: true,
  actions: [
    {
      actionType: "intake_lead",
      description: "Create a Pipedrive person and an associated deal from the CMS lead",
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
        fields: [...PIPEDRIVE_LEAD_PROJECTION_FIELDS],
      },
    },
  ],
};

function failure(response: OutboundHttpResponse, prefix: string): ReturnType<typeof actionFailed> {
  const detail = response.body.slice(0, 200);
  if (response.status === 401 || response.status === 403) {
    return actionFailed({
      retryable: false,
      httpStatus: response.status,
      providerErrorCode: `${prefix}_AUTH_FAILED`,
      errorMessage: "Pipedrive rejected the api_token",
    });
  }
  if (response.status === 429 || response.status >= 500) {
    return actionFailed({
      retryable: true,
      httpStatus: response.status,
      providerErrorCode: `${prefix}_RATE_LIMITED`,
      errorMessage: `Pipedrive returned HTTP ${String(response.status)}`,
    });
  }
  return actionFailed({
    retryable: false,
    httpStatus: response.status,
    providerErrorCode: `${prefix}_HTTP_${String(response.status)}`,
    errorMessage: detail === "" ? `HTTP ${String(response.status)}` : detail,
  });
}

export function createPipedriveConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  const get = async (
    path: string,
    token: string,
    timeoutMs: number,
  ): Promise<OutboundHttpResponse> =>
    http({
      method: "GET",
      url: `https://api.pipedrive.com${path}${path.includes("?") ? "&" : "?"}api_token=${encodeURIComponent(token)}`,
      timeoutMs,
    });

  const post = async (
    path: string,
    token: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<OutboundHttpResponse> =>
    http({
      method: "POST",
      url: `https://api.pipedrive.com${path}?api_token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs,
    });

  return {
    async execute(actionType, payload, ctx) {
      if (actionType !== "intake_lead") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown pipedrive action "${actionType}"`,
        });
      }
      const token = ctx.secrets["api_token"];
      if (token === undefined || token === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "PIPEDRIVE_NO_TOKEN",
          errorMessage: "the Pipedrive api_token is not configured",
        });
      }
      if (text(payload["lead_id"]) === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "PIPEDRIVE_PAYLOAD_INVALID",
          errorMessage: "mapped payload lacks lead_id",
        });
      }
      const projection = ctx.projection ?? {};
      const timeoutMs =
        typeof ctx.instance.config["timeout_ms"] === "number"
          ? (ctx.instance.config["timeout_ms"] as number)
          : PIPEDRIVE_TIMEOUT_DEFAULT;

      // 1. Person — dedupe by exact email/phone search (no create
      // idempotency key exists in Pipedrive v1).
      // ponytail: sequential search+create; Pipedrive search v1 has no
      // term-type filter — first exact match wins.
      const email = text(projection["email"]);
      const phone = text(projection["phone"]);
      const searchTerm = email !== "" ? email : phone;
      let personId = "";
      try {
        if (searchTerm !== "") {
          const search = await get(
            `/v1/persons/search?term=${encodeURIComponent(searchTerm)}`,
            token,
            timeoutMs,
          );
          if (search.status >= 200 && search.status < 300) {
            const items =
              (
                JSON.parse(search.body) as {
                  data?: { items?: { item?: { id?: unknown } }[] };
                }
              ).data?.items ?? [];
            const hit = items.find((item) => item.item?.id !== undefined);
            if (hit !== undefined) personId = idOf(hit.item?.id);
          } else {
            return failure(search, "PIPEDRIVE_PERSON_SEARCH");
          }
        }
        if (personId === "") {
          const created = await post(
            "/v1/persons",
            token,
            pipedrivePersonBody(projection),
            timeoutMs,
          );
          if (created.status < 200 || created.status >= 300) {
            return failure(created, "PIPEDRIVE_PERSON");
          }
          personId = idOf((JSON.parse(created.body) as { data?: { id?: unknown } }).data?.id);
        }
      } catch (cause) {
        return networkFailure(cause, "Pipedrive");
      }
      if (personId === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "PIPEDRIVE_PERSON_NO_ID",
          errorMessage: "Pipedrive accepted the person but returned no id",
        });
      }

      // 2. Deal for the person.
      let dealId: string;
      try {
        const created = await post(
          "/v1/deals",
          token,
          { title: leadTitle(projection), person_id: Number(personId) },
          timeoutMs,
        );
        if (created.status < 200 || created.status >= 300) {
          return failure(created, "PIPEDRIVE_DEAL");
        }
        dealId = idOf((JSON.parse(created.body) as { data?: { id?: unknown } }).data?.id);
      } catch (cause) {
        return networkFailure(cause, "Pipedrive");
      }
      if (dealId === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "PIPEDRIVE_DEAL_NO_ID",
          errorMessage: "Pipedrive accepted the deal but returned no id",
        });
      }

      // 3. The immutable presentation rides a deal note. Non-retryable on
      // failure: a retry would duplicate the already-created deal.
      const presentation = text(projection["presentation"]);
      if (presentation !== "") {
        try {
          const note = await post(
            "/v1/notes",
            token,
            { content: presentation, deal_id: Number(dealId) },
            timeoutMs,
          );
          if (note.status < 200 || note.status >= 300) {
            return actionFailed({
              retryable: false,
              httpStatus: note.status,
              providerErrorCode: `PIPEDRIVE_NOTE_HTTP_${String(note.status)}`,
              errorMessage: `deal ${dealId} created but the presentation note failed (HTTP ${String(note.status)}) — fix manually, do not retry`,
            });
          }
        } catch (cause) {
          return networkFailure(cause, "Pipedrive");
        }
      }
      return actionSucceeded(dealId);
    },

    async test(ctx) {
      const token = ctx.secrets["api_token"];
      if (token === undefined || token === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "PIPEDRIVE_NO_TOKEN",
          errorMessage: "the Pipedrive api_token is not configured",
        });
      }
      try {
        const response = await get("/v1/userInfo", token, 10_000);
        if (response.status === 200) return actionSucceeded();
        return failure(response, "PIPEDRIVE_TEST");
      } catch (cause) {
        return networkFailure(cause, "Pipedrive");
      }
    },
  };
}
