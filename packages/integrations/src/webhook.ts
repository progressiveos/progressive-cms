// Generic HTTP/Webhook connector (PCMS-INT-T010; Integrations spec §11).
// The universal escape hatch for rare systems — a bounded declarative
// request template, NOT an arbitrary code runner. Every outbound URL is
// checked by the injected SSRF guard (T011); without a guard the connector
// refuses to send (fail-secure).
import { createHmac } from "node:crypto";
import type { ConnectorDefinition } from "./connectors.js";
import {
  type ActionExecutionContext,
  type ActionResult,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp } from "./transport.js";

/** SSRF gate port — the real implementation is ssrf.ts (PCMS-INT-T011). */
export interface UrlGuard {
  assertAllowed(url: string, redirectPolicy: "follow" | "none"): Promise<void>;
}

export const webhookConnectorDefinition: ConnectorDefinition = {
  connectorType: "webhook-http",
  title: "Generic HTTP/Webhook",
  description: "Calls an arbitrary HTTP endpoint with a mapped JSON payload",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", format: "uri", maxLength: 2000 },
      method: { enum: ["GET", "POST", "PUT", "PATCH"] },
      // Literal (non-secret) headers; secret header values come from refs.
      headers: { type: "object", additionalProperties: true },
      // header name -> secret name (e.g. Authorization -> CRM_API_KEY).
      secret_headers: { type: "object", additionalProperties: true },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 60000 },
      expected_status_min: { type: "integer", minimum: 200, maximum: 599 },
      expected_status_max: { type: "integer", minimum: 200, maximum: 599 },
      redirect_policy: { enum: ["follow", "none"] },
      signing: {
        type: "object",
        additionalProperties: false,
        properties: {
          header: { type: "string", maxLength: 100 },
          secret_ref: { type: "string", maxLength: 128 },
        },
        required: ["header", "secret_ref"],
      },
    },
    required: ["url"],
  },
  // Signing/header secrets are referenced DYNAMICALLY from config
  // (secret_headers values, signing.secret_ref); the dispatcher resolves
  // every instance.secretRefs entry into the execution context.
  secrets: [],
  actions: [
    {
      actionType: "request",
      description: "Send the mapped payload as the request body (GET omits it)",
      payloadSchema: { type: "object", additionalProperties: true },
    },
    {
      actionType: "notify",
      description: "Send {text} as a JSON body {text}",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", maxLength: 10000 } },
        required: ["text"],
      },
    },
  ],
  testable: true,
};

export function createWebhookConnectorRuntime(
  http: OutboundHttp,
  guard: UrlGuard,
): ConnectorRuntime {
  async function execute(
    actionType: string,
    payload: Readonly<Record<string, unknown>>,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult> {
    if (actionType !== "request" && actionType !== "notify") {
      return actionFailed({
        retryable: false,
        providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
        errorMessage: `unknown webhook action "${actionType}"`,
      });
    }
    const config = ctx.instance.config;
    const url = config["url"] as string;
    const method = (config["method"] ?? "POST") as "GET" | "POST" | "PUT" | "PATCH";
    const redirectPolicy = (config["redirect_policy"] ?? "follow") as "follow" | "none";
    // Fail-secure SSRF gate: an unwired guard means no outbound calls.
    try {
      await guard.assertAllowed(url, redirectPolicy);
    } catch (error) {
      return actionFailed({
        retryable: false,
        providerErrorCode:
          error instanceof Error && "code" in error
            ? String((error as { code: string }).code)
            : "INTEGRATION_URL_BLOCKED",
        errorMessage: `blocked by SSRF policy: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
      });
    }
    const headers: Record<string, string> = { accept: "application/json" };
    for (const [name, value] of Object.entries(
      (config["headers"] ?? {}) as Record<string, unknown>,
    )) {
      if (typeof value === "string") headers[name.toLowerCase()] = value;
    }
    for (const [name, secretName] of Object.entries(
      (config["secret_headers"] ?? {}) as Record<string, string>,
    )) {
      const value = ctx.secrets[secretName];
      if (value === undefined) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_SECRET_MISSING",
          errorMessage: `secret "${secretName}" for header "${name}" is not loaded`,
        });
      }
      headers[name.toLowerCase()] = value;
    }
    const bodyObject =
      actionType === "notify" ? { text: payload["text"] } : (payload as Record<string, unknown>);
    const hasBody = method !== "GET";
    const body = hasBody ? JSON.stringify(bodyObject) : undefined;
    if (body !== undefined) headers["content-type"] = "application/json";
    const signing = config["signing"] as { header?: string; secret_ref?: string } | undefined;
    if (signing !== undefined && body !== undefined) {
      const secret = ctx.secrets[signing.secret_ref ?? ""];
      if (secret === undefined) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_SECRET_MISSING",
          errorMessage: `signing secret "${signing.secret_ref}" is not loaded`,
        });
      }
      headers[(signing.header ?? "x-signature").toLowerCase()] = createHmac("sha256", secret)
        .update(body)
        .digest("hex");
    }
    try {
      const response = await http({
        method,
        url,
        headers,
        ...(body === undefined ? {} : { body }),
        redirectPolicy,
        timeoutMs:
          typeof config["timeout_ms"] === "number" ? (config["timeout_ms"] as number) : 10_000,
      });
      const min =
        typeof config["expected_status_min"] === "number"
          ? (config["expected_status_min"] as number)
          : 200;
      const max =
        typeof config["expected_status_max"] === "number"
          ? (config["expected_status_max"] as number)
          : 299;
      const ok = response.status >= min && response.status <= max;
      if (ok) return actionSucceeded();
      return actionFailed({
        retryable: response.status === 429 || response.status >= 500,
        providerErrorCode: `WEBHOOK_HTTP_${response.status}`,
        errorMessage: `endpoint returned ${response.status}`,
        httpStatus: response.status,
      });
    } catch (error) {
      return networkFailure(error, new URL(url).host);
    }
  }
  return {
    execute,
    async test(ctx: ActionExecutionContext): Promise<ActionResult> {
      // Safe probe: URL-policy check only — never sends a test request to a
      // third-party system from the admin UI (spec §40).
      try {
        await guard.assertAllowed((ctx.instance.config["url"] as string) ?? "", "follow");
        return actionSucceeded();
      } catch (error) {
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_URL_BLOCKED",
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
      }
    },
  };
}
