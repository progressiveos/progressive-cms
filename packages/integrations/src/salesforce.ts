// Salesforce lead connector: pushes new CMS leads as Lead sObjects through
// the REST API. Auth = OAuth2 client-credentials flow of a Connected App
// (POST {loginUrl}/services/oauth2/token, form-encoded) — the recommended
// server-to-server grant; the response's instance_url hosts the data
// calls. Leads are deduped by an exact-email SOQL query before create
// (Salesforce has no create idempotency key); the immutable presentation
// rides the Lead Description.
// Docs: developer.salesforce.com/docs (REST API, Lead sObject).
import type { ConnectorDefinition } from "./connectors.js";
import { leadTitle } from "./hubspot.js";
import {
  type ActionExecutionContext,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp, type OutboundHttpResponse } from "./transport.js";

const SALESFORCE_TIMEOUT_DEFAULT = 15_000;
/** Bare host — the runtime prepends https:// after normalizing the config. */
const SALESFORCE_LOGIN_DEFAULT = "login.salesforce.com";
const SALESFORCE_API_VERSION = "v60.0";

export const SALESFORCE_LEAD_PROJECTION_FIELDS = [
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

export function salesforceLeadBody(input: {
  readonly projection: Readonly<Record<string, unknown>>;
  readonly company: string;
}): Record<string, string> {
  const { projection } = input;
  const name = text(projection["name"]);
  const email = text(projection["email"]);
  const phone = text(projection["phone"]);
  const presentation = text(projection["presentation"]);
  const summary = text(projection["summary"]);
  const description = [summary !== "" ? summary : "", presentation !== "" ? presentation : ""]
    .filter((part) => part !== "")
    .join("\n\n");
  return {
    LastName: name !== "" ? name : email !== "" ? email : "Website lead",
    Company: input.company,
    ...(email !== "" ? { Email: email } : {}),
    ...(phone !== "" ? { Phone: phone } : {}),
    ...(description !== "" ? { Description: description } : {}),
  };
}

export const salesforceConnectorDefinition: ConnectorDefinition = {
  connectorType: "salesforce",
  title: "Salesforce",
  description:
    "Creates a Salesforce Lead from the CMS lead via the REST API with a Connected App client-credentials flow; leads are deduped by an exact-email query.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      login_url: { type: "string", maxLength: 200 },
      company: { type: "string", maxLength: 120 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
    },
  },
  secrets: [
    {
      name: "client_id",
      description:
        "Connected App consumer key (Client Credentials Flow enabled, run-as user assigned)",
    },
    { name: "client_secret", description: "Connected App consumer secret" },
  ],
  testable: true,
  actions: [
    {
      actionType: "intake_lead",
      description: "Create a Salesforce Lead from the CMS lead",
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
        fields: [...SALESFORCE_LEAD_PROJECTION_FIELDS],
      },
    },
  ],
};

function dataFailure(
  response: OutboundHttpResponse,
  prefix: string,
): ReturnType<typeof actionFailed> {
  if (response.status === 401 || response.status === 403) {
    return actionFailed({
      retryable: false,
      httpStatus: response.status,
      providerErrorCode: `${prefix}_AUTH_FAILED`,
      errorMessage: "Salesforce rejected the access token (expired or the app lost approval?)",
    });
  }
  if (response.status === 429 || response.status >= 500) {
    return actionFailed({
      retryable: true,
      httpStatus: response.status,
      providerErrorCode: `${prefix}_RATE_LIMITED`,
      errorMessage: `Salesforce returned HTTP ${String(response.status)}`,
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

export function createSalesforceConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  /** Client-credentials token exchange; the response's instance_url is the
   * org-specific data host for every subsequent call. */
  const accessToken = async (
    ctx: ActionExecutionContext,
    timeoutMs: number,
  ): Promise<
    { token: string; instanceUrl: string } | { failure: ReturnType<typeof actionFailed> }
  > => {
    const clientId = ctx.secrets["client_id"];
    const clientSecret = ctx.secrets["client_secret"];
    if (
      clientId === undefined ||
      clientId === "" ||
      clientSecret === undefined ||
      clientSecret === ""
    ) {
      return {
        failure: actionFailed({
          retryable: false,
          providerErrorCode: "SALESFORCE_NO_CREDENTIALS",
          errorMessage: "client_id and client_secret must both be configured",
        }),
      };
    }
    const loginUrl =
      text(ctx.instance.config["login_url"]) === ""
        ? SALESFORCE_LOGIN_DEFAULT
        : text(ctx.instance.config["login_url"])
            .replace(/^https?:\/\//, "")
            .replace(/\/+$/, "");
    const response = await http({
      method: "POST",
      url: `https://${loginUrl}/services/oauth2/token`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        failure: actionFailed({
          retryable: response.status === 429 || response.status >= 500,
          httpStatus: response.status,
          providerErrorCode: `SALESFORCE_TOKEN_HTTP_${String(response.status)}`,
          errorMessage: `Salesforce token endpoint returned HTTP ${String(response.status)} — check the Connected App credentials and Client Credentials Flow enablement`,
        }),
      };
    }
    const parsed = JSON.parse(response.body) as { access_token?: unknown; instance_url?: unknown };
    const token = idOf(parsed.access_token);
    if (token === "") {
      return {
        failure: actionFailed({
          retryable: false,
          providerErrorCode: "SALESFORCE_TOKEN_REJECTED",
          errorMessage: "Salesforce issued no access token",
        }),
      };
    }
    return {
      token,
      instanceUrl: text(parsed.instance_url).replace(/\/+$/, ""),
    };
  };

  return {
    async execute(actionType, payload, ctx) {
      if (actionType !== "intake_lead") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown salesforce action "${actionType}"`,
        });
      }
      if (text(payload["lead_id"]) === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "SALESFORCE_PAYLOAD_INVALID",
          errorMessage: "mapped payload lacks lead_id",
        });
      }
      const projection = ctx.projection ?? {};
      const timeoutMs =
        typeof ctx.instance.config["timeout_ms"] === "number"
          ? (ctx.instance.config["timeout_ms"] as number)
          : SALESFORCE_TIMEOUT_DEFAULT;

      let token: string;
      let instanceUrl: string;
      try {
        const issued = await accessToken(ctx, timeoutMs);
        if ("failure" in issued) return issued.failure;
        token = issued.token;
        instanceUrl = issued.instanceUrl;
      } catch (cause) {
        return networkFailure(cause, "Salesforce");
      }
      if (instanceUrl === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "SALESFORCE_NO_INSTANCE_URL",
          errorMessage: "the token response carried no instance_url",
        });
      }

      const call = async (path: string, body?: string): Promise<OutboundHttpResponse> =>
        http({
          method: body === undefined ? "GET" : "POST",
          url: `${instanceUrl}/services/data/${SALESFORCE_API_VERSION}${path}`,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
          timeoutMs,
        });

      // 1. Dedupe: an exact-email Lead query (no create idempotency key
      // exists in Salesforce). No email → straight to create.
      const email = text(projection["email"]);
      try {
        if (email !== "") {
          const query = await call(
            `/query?q=${encodeURIComponent(`SELECT Id FROM Lead WHERE Email = '${email.replaceAll("'", "''")}' LIMIT 1`)}`,
          );
          if (query.status < 200 || query.status >= 300) {
            return dataFailure(query, "SALESFORCE_QUERY");
          }
          const records =
            (JSON.parse(query.body) as { records?: { Id?: unknown }[] }).records ?? [];
          const existing = records[0]?.Id;
          if (existing !== undefined && existing !== null) {
            return actionSucceeded(String(existing));
          }
        }

        // 2. Create the Lead.
        const created = await call(
          "/sobjects/Lead",
          JSON.stringify(
            salesforceLeadBody({
              projection,
              company:
                text(ctx.instance.config["company"]) === ""
                  ? "Website lead"
                  : text(ctx.instance.config["company"]),
            }),
          ),
        );
        if (created.status < 200 || created.status >= 300) {
          return dataFailure(created, "SALESFORCE_LEAD");
        }
        const leadId = idOf((JSON.parse(created.body) as { id?: unknown }).id);
        return actionSucceeded(leadId === "" ? undefined : leadId);
      } catch (cause) {
        return networkFailure(cause, "Salesforce");
      }
    },

    async test(ctx) {
      try {
        const issued = await accessToken(ctx, 10_000);
        if ("failure" in issued) return issued.failure;
        return actionSucceeded();
      } catch (cause) {
        return networkFailure(cause, "Salesforce");
      }
    },
  };
}
