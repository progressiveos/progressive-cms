// Zoho CRM lead connector: pushes new CMS leads into Zoho CRM as a
// contact + associated deal through the REST v3 API. Auth = refresh token
// + client credentials exchanged per delivery for an access token
// (POST https://accounts.{region}/oauth/v2/token); the response's
// api_domain hosts the data calls. Lookup association follows the official
// contract: "Contact_Name": { "id": "<contact id>" }.
// Docs: zoho.com/crm/developer/docs/api/v3.
import type { ConnectorDefinition } from "./connectors.js";
import { leadTitle } from "./hubspot.js";
import {
  type ActionExecutionContext,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp, type OutboundHttpResponse } from "./transport.js";

const ZOHO_TIMEOUT_DEFAULT = 15_000;
const ZOHO_STAGE_DEFAULT = "Qualification";

export const ZOHO_LEAD_PROJECTION_FIELDS = [
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

/** Contact payload. Last_Name is the only required Contacts field in
 * Zoho; fall back email → neutral name when the lead is anonymous. */
export function zohoContactBody(projection: Readonly<Record<string, unknown>>): {
  data: Record<string, string>[];
} {
  const name = text(projection["name"]);
  const email = text(projection["email"]);
  const phone = text(projection["phone"]);
  const data: Record<string, string> = {
    Last_Name: name !== "" ? name : email !== "" ? email : "Website lead",
  };
  if (email !== "") data["Email"] = email;
  if (phone !== "") data["Phone"] = phone;
  return { data: [data] };
}

export function zohoDealBody(input: {
  readonly projection: Readonly<Record<string, unknown>>;
  readonly contactId: string;
  readonly stage: string;
}): { data: Record<string, unknown>[] } {
  const presentation = text(input.projection["presentation"]);
  return {
    data: [
      {
        Deal_Name: leadTitle(input.projection),
        Stage: input.stage,
        Contact_Name: { id: input.contactId },
        ...(presentation !== "" ? { Description: presentation } : {}),
      },
    ],
  };
}

export const zohoCrmConnectorDefinition: ConnectorDefinition = {
  connectorType: "zoho-crm",
  title: "Zoho CRM",
  description:
    "Creates a Zoho CRM contact + associated deal from the CMS lead via REST v3 with a refresh token + client credentials.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      region: { type: "string", maxLength: 20, description: "zoho.com | zoho.eu | zoho.in | ..." },
      stage: { type: "string", maxLength: 64 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
    },
  },
  secrets: [
    {
      name: "refresh_token",
      description: "Zoho OAuth refresh token (scope ZohoCRM.modules.CREATE)",
    },
    { name: "client_id", description: "Zoho API client id" },
    { name: "client_secret", description: "Zoho API client secret" },
  ],
  testable: true,
  actions: [
    {
      actionType: "intake_lead",
      description: "Create a Zoho CRM contact and an associated deal from the CMS lead",
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
        fields: [...ZOHO_LEAD_PROJECTION_FIELDS],
      },
    },
  ],
};

export function createZohoCrmConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  /** Exchanges the refresh token for an access token; returns the token
   * and the api_domain reported by Zoho (region-correct data host). */
  const accessToken = async (
    ctx: ActionExecutionContext,
    timeoutMs: number,
  ): Promise<{ token: string; apiDomain: string } | import("./runtime.js").ActionResult> => {
    const region =
      text(ctx.instance.config["region"]) === "" ? "zoho.com" : text(ctx.instance.config["region"]);
    const refreshToken = ctx.secrets["refresh_token"];
    const clientId = ctx.secrets["client_id"];
    const clientSecret = ctx.secrets["client_secret"];
    if (
      refreshToken === undefined ||
      refreshToken === "" ||
      clientId === undefined ||
      clientId === "" ||
      clientSecret === undefined ||
      clientSecret === ""
    ) {
      return actionFailed({
        retryable: false,
        providerErrorCode: "ZOHO_NO_CREDENTIALS",
        errorMessage: "refresh_token, client_id and client_secret must all be configured",
      });
    }
    const response = await http({
      method: "POST",
      url:
        `https://accounts.${region}/oauth/v2/token` +
        `?refresh_token=${encodeURIComponent(refreshToken)}` +
        `&client_id=${encodeURIComponent(clientId)}` +
        `&client_secret=${encodeURIComponent(clientSecret)}` +
        `&grant_type=refresh_token`,
      timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      return actionFailed({
        retryable: response.status >= 500 || response.status === 429,
        httpStatus: response.status,
        providerErrorCode: `ZOHO_TOKEN_HTTP_${String(response.status)}`,
        errorMessage: `Zoho token endpoint returned HTTP ${String(response.status)}`,
      });
    }
    const parsed = JSON.parse(response.body) as { access_token?: unknown; api_domain?: unknown };
    const token = idOf(parsed.access_token);
    if (token === "") {
      return actionFailed({
        retryable: false,
        providerErrorCode: "ZOHO_TOKEN_REJECTED",
        errorMessage: "Zoho issued no access token — check refresh_token/client credentials",
      });
    }
    const apiDomain =
      text(parsed.api_domain) === "" ? `https://www.${region}` : text(parsed.api_domain);
    return { token, apiDomain };
  };

  return {
    async execute(actionType, payload, ctx) {
      if (actionType !== "intake_lead") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown zoho-crm action "${actionType}"`,
        });
      }
      if (text(payload["lead_id"]) === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "ZOHO_PAYLOAD_INVALID",
          errorMessage: "mapped payload lacks lead_id",
        });
      }
      const projection = ctx.projection ?? {};
      const timeoutMs =
        typeof ctx.instance.config["timeout_ms"] === "number"
          ? (ctx.instance.config["timeout_ms"] as number)
          : ZOHO_TIMEOUT_DEFAULT;

      let token: string;
      let apiDomain: string;
      try {
        const issued = await accessToken(ctx, timeoutMs);
        if (!("token" in issued)) return issued;
        token = issued.token;
        apiDomain = issued.apiDomain;
      } catch (cause) {
        return networkFailure(cause, "Zoho");
      }

      const call = async (
        module: "Contacts" | "Deals",
        body: unknown,
      ): Promise<OutboundHttpResponse> =>
        http({
          method: "POST",
          url: `${apiDomain}/crm/v3/${module}`,
          headers: {
            "content-type": "application/json",
            authorization: `Zoho-oauthtoken ${token}`,
          },
          body: JSON.stringify(body),
          timeoutMs,
        });

      // 1. Contact.
      let contactId: string;
      try {
        const response = await call("Contacts", zohoContactBody(projection));
        if (response.status < 200 || response.status >= 300) {
          return dataFailure(response, "ZOHO_CONTACT");
        }
        const parsed = JSON.parse(response.body) as {
          data?: { details?: { id?: unknown } }[];
        };
        contactId = idOf(parsed.data?.[0]?.details?.id);
      } catch (cause) {
        return networkFailure(cause, "Zoho");
      }
      if (contactId === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "ZOHO_CONTACT_NO_ID",
          errorMessage: "Zoho accepted the contact but returned no id",
        });
      }

      // 2. Deal associated through the Contact_Name lookup.
      try {
        const response = await call(
          "Deals",
          zohoDealBody({
            projection,
            contactId,
            stage:
              text(ctx.instance.config["stage"]) === ""
                ? ZOHO_STAGE_DEFAULT
                : text(ctx.instance.config["stage"]),
          }),
        );
        if (response.status < 200 || response.status >= 300) {
          return dataFailure(response, "ZOHO_DEAL");
        }
        const parsed = JSON.parse(response.body) as {
          data?: { details?: { id?: unknown } }[];
        };
        return actionSucceeded(idOf(parsed.data?.[0]?.details?.id) || undefined);
      } catch (cause) {
        return networkFailure(cause, "Zoho");
      }
    },

    async test(ctx) {
      try {
        const issued = await accessToken(ctx, 10_000);
        if (!("token" in issued)) return issued;
        return actionSucceeded();
      } catch (cause) {
        return networkFailure(cause, "Zoho");
      }
    },
  };
}

function dataFailure(
  response: OutboundHttpResponse,
  prefix: string,
): ReturnType<typeof actionFailed> {
  if (response.status === 401) {
    return actionFailed({
      retryable: false,
      httpStatus: response.status,
      providerErrorCode: `${prefix}_AUTH_FAILED`,
      errorMessage: "Zoho rejected the access token",
    });
  }
  if (response.status === 429 || response.status >= 500) {
    return actionFailed({
      retryable: true,
      httpStatus: response.status,
      providerErrorCode: `${prefix}_RATE_LIMITED`,
      errorMessage: `Zoho returned HTTP ${String(response.status)}`,
    });
  }
  const detail = response.body.slice(0, 200);
  return actionFailed({
    retryable: false,
    httpStatus: response.status,
    providerErrorCode: `${prefix}_HTTP_${String(response.status)}`,
    errorMessage: detail === "" ? `HTTP ${String(response.status)}` : detail,
  });
}
