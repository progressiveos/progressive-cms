// ShareCRM (纷享销客 / FXiaoKe) lead connector: pushes new CMS leads as
// LeadsObj records through the open platform v2 data API. Auth = client
// credentials (appId + appSecret + permanentCode) exchanged per delivery
// for an access token; data calls carry Bearer + x-fs-ea + x-fs-userid
// headers and a thirdTraceId UUID per request. Non-zero errorCode is the
// failure contract (errorMessage is explicitly not for logic).
// Docs: developer.fxiaoke.com/openapi_v2.
import { randomUUID } from "node:crypto";
import type { ConnectorDefinition } from "./connectors.js";
import { leadTitle } from "./hubspot.js";
import {
  type ActionExecutionContext,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp, type OutboundHttpResponse } from "./transport.js";

const SHARECRM_TIMEOUT_DEFAULT = 15_000;
const SHARECRM_CLOUD_DEFAULT = "www.fxiaoke.com";

export const SHARECRM_LEAD_PROJECTION_FIELDS = [
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

/** LeadsObj object_data. Field api_names (name/phone/email/remark) are
 * the standard Leads describe defaults; overrides exist in config because
 * tenants rename fields. */
export function sharecrmLeadBody(input: {
  readonly projection: Readonly<Record<string, unknown>>;
  readonly phoneField: string;
  readonly emailField: string;
  readonly remarkField: string;
}): { data: { object_data: Record<string, string> } } {
  const { projection } = input;
  const objectData: Record<string, string> = {
    dataObjectApiName: "LeadsObj",
    name: leadTitle(projection),
  };
  const email = text(projection["email"]);
  const phone = text(projection["phone"]);
  const presentation = text(projection["presentation"]);
  if (email !== "" && input.emailField !== "") objectData[input.emailField] = email;
  if (phone !== "" && input.phoneField !== "") objectData[input.phoneField] = phone;
  if (presentation !== "" && input.remarkField !== "") objectData[input.remarkField] = presentation;
  return { data: { object_data: objectData } };
}

export const sharecrmConnectorDefinition: ConnectorDefinition = {
  connectorType: "sharecrm",
  title: "ShareCRM (FXiaoKe)",
  description:
    "Creates a ShareCRM lead (LeadsObj) from the CMS lead via the FXiaoKe open platform v2 data API with client credentials.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      cloud_domain: { type: "string", maxLength: 120 },
      user_id: { type: "string", maxLength: 64 },
      phone_field: { type: "string", maxLength: 64 },
      email_field: { type: "string", maxLength: 64 },
      remark_field: { type: "string", maxLength: 64 },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
    },
    required: ["user_id"],
  },
  secrets: [
    { name: "app_id", description: "FXiaoKe自建应用 AppId (FSAID_…)" },
    { name: "app_secret", description: "FXiaoKe AppSecret" },
    { name: "permanent_code", description: "FXiaoKe permanent authorization code (永久授权码)" },
  ],
  testable: true,
  actions: [
    {
      actionType: "intake_lead",
      description: "Create a ShareCRM lead from the CMS lead",
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
        fields: [...SHARECRM_LEAD_PROJECTION_FIELDS],
      },
    },
  ],
};

export function createSharecrmConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  /** Client-credentials token exchange. FXiaoKe rates this endpoint at
   * 10 calls/min and recommends caching for 6600s — a per-delivery
   * exchange keeps the runtime stateless; lead volume in a CMS instance
   * sits far below the cap. */
  const accessToken = async (
    cloud: string,
    ctx: ActionExecutionContext,
    timeoutMs: number,
  ): Promise<
    { token: string; ea: string } | { failure: Awaited<ReturnType<typeof actionFailed>> }
  > => {
    const appId = ctx.secrets["app_id"];
    const appSecret = ctx.secrets["app_secret"];
    const permanentCode = ctx.secrets["permanent_code"];
    if (
      appId === undefined ||
      appId === "" ||
      appSecret === undefined ||
      appSecret === "" ||
      permanentCode === undefined ||
      permanentCode === ""
    ) {
      return {
        failure: actionFailed({
          retryable: false,
          providerErrorCode: "SHARECRM_NO_CREDENTIALS",
          errorMessage: "app_id, app_secret and permanent_code must all be configured",
        }),
      };
    }
    const response = await http({
      method: "POST",
      url: `https://${cloud}/oauth2.0/token?thirdTraceId=${randomUUID()}`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId,
        appSecret,
        permanentCode,
        grantType: "app_secret",
      }),
      timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        failure: actionFailed({
          retryable: response.status === 429 || response.status >= 500,
          httpStatus: response.status,
          providerErrorCode: `SHARECRM_TOKEN_HTTP_${String(response.status)}`,
          errorMessage: `ShareCRM token endpoint returned HTTP ${String(response.status)}`,
        }),
      };
    }
    const parsed = JSON.parse(response.body) as {
      errorCode?: unknown;
      accessToken?: unknown;
      ea?: unknown;
    };
    if (parsed.errorCode !== 0) {
      return {
        failure: actionFailed({
          // 20016 = token expired mid-flight per FXiaoKe docs — retryable.
          retryable: parsed.errorCode === 20016,
          providerErrorCode: `SHARECRM_TOKEN_ERROR_${String(parsed.errorCode ?? "?")}`,
          errorMessage: `ShareCRM token exchange failed (errorCode ${String(parsed.errorCode ?? "?")})`,
        }),
      };
    }
    return { token: String(parsed.accessToken ?? ""), ea: String(parsed.ea ?? "") };
  };

  return {
    async execute(actionType, payload, ctx) {
      if (actionType !== "intake_lead") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown sharecrm action "${actionType}"`,
        });
      }
      if (text(payload["lead_id"]) === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "SHARECRM_PAYLOAD_INVALID",
          errorMessage: "mapped payload lacks lead_id",
        });
      }
      const userId = text(ctx.instance.config["user_id"]);
      if (userId === "") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "SHARECRM_CONFIG_INVALID",
          errorMessage:
            "user_id (员工ID, used as x-fs-userid) is required in the connection config",
        });
      }
      const cloud =
        text(ctx.instance.config["cloud_domain"]) === ""
          ? SHARECRM_CLOUD_DEFAULT
          : text(ctx.instance.config["cloud_domain"])
              .replace(/^https?:\/\//, "")
              .replace(/\/+$/, "");
      const timeoutMs =
        typeof ctx.instance.config["timeout_ms"] === "number"
          ? (ctx.instance.config["timeout_ms"] as number)
          : SHARECRM_TIMEOUT_DEFAULT;

      let token: string;
      let ea: string;
      try {
        const issued = await accessToken(cloud, ctx, timeoutMs);
        if ("failure" in issued) return issued.failure;
        token = issued.token;
        ea = issued.ea;
      } catch (cause) {
        return networkFailure(cause, "ShareCRM");
      }

      try {
        const response = await http({
          method: "POST",
          url: `https://${cloud}/cgi/crm/v2/data/create?thirdTraceId=${randomUUID()}`,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-fs-ea": ea,
            "x-fs-userid": userId,
          },
          body: JSON.stringify(
            sharecrmLeadBody({
              projection: ctx.projection ?? {},
              phoneField:
                text(ctx.instance.config["phone_field"]) === ""
                  ? "phone"
                  : text(ctx.instance.config["phone_field"]),
              emailField:
                text(ctx.instance.config["email_field"]) === ""
                  ? "email"
                  : text(ctx.instance.config["email_field"]),
              remarkField:
                text(ctx.instance.config["remark_field"]) === ""
                  ? "remark"
                  : text(ctx.instance.config["remark_field"]),
            }),
          ),
          timeoutMs,
        });
        if (response.status < 200 || response.status >= 300) {
          const status = response.status;
          return actionFailed({
            retryable: status === 429 || status >= 500,
            httpStatus: status,
            providerErrorCode: `SHARECRM_HTTP_${String(status)}`,
            errorMessage: `ShareCRM returned HTTP ${String(status)}`,
          });
        }
        const parsed = JSON.parse(response.body) as { errorCode?: unknown; dataId?: unknown };
        if (parsed.errorCode !== 0) {
          return actionFailed({
            retryable: false,
            providerErrorCode: `SHARECRM_ERROR_${String(parsed.errorCode ?? "?")}`,
            errorMessage: `ShareCRM rejected the lead (errorCode ${String(parsed.errorCode ?? "?")})`,
          });
        }
        const dataId = text(parsed.dataId);
        return actionSucceeded(dataId === "" ? undefined : dataId);
      } catch (cause) {
        return networkFailure(cause, "ShareCRM");
      }
    },

    async test(ctx) {
      const cloud =
        text(ctx.instance.config["cloud_domain"]) === ""
          ? SHARECRM_CLOUD_DEFAULT
          : text(ctx.instance.config["cloud_domain"])
              .replace(/^https?:\/\//, "")
              .replace(/\/+$/, "");
      try {
        const issued = await accessToken(cloud, ctx, 10_000);
        if ("failure" in issued) return issued.failure;
        return actionSucceeded();
      } catch (cause) {
        return networkFailure(cause, "ShareCRM");
      }
    },
  };
}
