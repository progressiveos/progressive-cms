// Nextcloud Talk connector (PCMS-INT-T009; Integrations spec §10).
// post_message against a self-hosted Nextcloud Talk room — an ordinary
// OCS API client with no Progressive-OS-specific infrastructure. Tests run
// against a deterministic fake HTTP transport.

import type { ConnectorDefinition } from "./connectors.js";
import {
  type ActionExecutionContext,
  type ActionResult,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp } from "./transport.js";

export const talkConnectorDefinition: ConnectorDefinition = {
  connectorType: "nextcloud-talk",
  title: "Nextcloud Talk",
  description: "Posts messages into a self-hosted Nextcloud Talk room",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      base_url: { type: "string", format: "uri", maxLength: 300 },
      room_token: { type: "string", maxLength: 64 },
    },
    required: ["base_url", "room_token"],
  },
  secrets: [
    { name: "user", description: "Talk user id secret name" },
    { name: "password", description: "Talk user password / app token secret name" },
  ],
  actions: [
    {
      actionType: "post_message",
      description: "Post a message into the configured room",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          message: { type: "string", maxLength: 32000 },
        },
        required: ["message"],
      },
    },
  ],
  testable: true,
};

interface OcsResponse {
  ocs?: { meta?: { status?: string; statuscode?: number; message?: string } };
}

export function createTalkConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  function normalize(response: { status: number; body: string }, hostLabel: string): ActionResult {
    let parsed: OcsResponse = {};
    try {
      parsed = JSON.parse(response.body) as OcsResponse;
    } catch {
      // Non-JSON body: fall through to HTTP status handling.
    }
    const meta = parsed.ocs?.meta;
    const statusCode = meta?.statuscode ?? response.status;
    const ok = response.status >= 200 && response.status < 300 && statusCode < 400;
    if (ok) return actionSucceeded();
    const code = `TALK_${statusCode}`;
    return actionFailed({
      // OCS-level rejections (auth, unknown room) are permanent config
      // errors; 5xx and 429 remain transient.
      retryable: response.status === 429 || response.status >= 500,
      providerErrorCode: code,
      errorMessage: (meta?.message ?? `${hostLabel} returned ${response.status}`).slice(0, 200),
      httpStatus: response.status,
    });
  }
  return {
    async execute(
      actionType: string,
      payload: Readonly<Record<string, unknown>>,
      ctx: ActionExecutionContext,
    ): Promise<ActionResult> {
      if (actionType !== "post_message") {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown talk action "${actionType}"`,
        });
      }
      const config = ctx.instance.config;
      const baseUrl = (config["base_url"] as string).replace(/\/+$/, "");
      const roomToken = config["room_token"] as string;
      const credentials = Buffer.from(
        `${ctx.secrets["user"]}:${ctx.secrets["password"]}`,
        "utf8",
      ).toString("base64");
      try {
        const response = await http({
          method: "POST",
          url: `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/room/${roomToken}/message`,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "OCS-APIRequest": "true",
            authorization: `Basic ${credentials}`,
          },
          body: JSON.stringify({ message: payload["message"] }),
          timeoutMs: 10_000,
        });
        return normalize(response, "nextcloud-talk");
      } catch (error) {
        return networkFailure(error, "nextcloud-talk");
      }
    },
    async test(ctx: ActionExecutionContext): Promise<ActionResult> {
      // Safe probe: fetch the room participants — proves URL, room and
      // credentials without posting.
      const config = ctx.instance.config;
      const baseUrl = (config["base_url"] as string).replace(/\/+$/, "");
      const roomToken = config["room_token"] as string;
      const credentials = Buffer.from(
        `${ctx.secrets["user"]}:${ctx.secrets["password"]}`,
        "utf8",
      ).toString("base64");
      try {
        const response = await http({
          method: "GET",
          url: `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/room/${roomToken}/participants`,
          headers: {
            accept: "application/json",
            "OCS-APIRequest": "true",
            authorization: `Basic ${credentials}`,
          },
          timeoutMs: 10_000,
        });
        return normalize(response, "nextcloud-talk");
      } catch (error) {
        return networkFailure(error, "nextcloud-talk");
      }
    },
  };
}
