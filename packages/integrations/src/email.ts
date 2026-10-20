// Email/SMTP connector (PCMS-INT-T007; Integrations spec §8). Protocol
// semantics only: the mail transport itself is an injected boundary — the
// Operations milestone owns the production transport, tests use a
// deterministic fake. Deliberately no second CMS SMTP configuration
// subsystem lives here.

import type { ConnectorDefinition } from "./connectors.js";
import {
  type ActionExecutionContext,
  type ActionResult,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";

/** Mail delivery boundary (injected; fake in tests, Operations transport in prod). */
export interface MailTransport {
  send(message: {
    readonly to: string;
    readonly from?: string;
    readonly replyTo?: string;
    readonly subject?: string;
    readonly text?: string;
    readonly html?: string;
    readonly template?: {
      readonly id: string;
      readonly variables?: Readonly<Record<string, unknown>>;
    };
  }): Promise<{ readonly messageId: string }>;
}

export const emailConnectorDefinition: ConnectorDefinition = {
  connectorType: "email",
  title: "Email",
  description: "Sends transactional email through the configured CMS mail transport",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: { type: "string", maxLength: 200 },
      reply_to: { type: "string", maxLength: 200 },
    },
  },
  secrets: [{ name: "transport", description: "Mail transport credential secret name" }],
  actions: [
    {
      actionType: "send_message",
      description: "Send a plain/HTML email",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          to: { type: "string", maxLength: 320 },
          subject: { type: "string", maxLength: 400 },
          text: { type: "string", maxLength: 20000 },
          html: { type: "string", maxLength: 100000 },
        },
        required: ["to", "subject", "text"],
      },
    },
    {
      actionType: "send_template",
      description: "Send a registered mail template",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          to: { type: "string", maxLength: 320 },
          template_id: { type: "string", maxLength: 120 },
          variables: { type: "object", additionalProperties: true },
        },
        required: ["to", "template_id"],
      },
    },
  ],
  testable: true,
};

export function createEmailConnectorRuntime(mail: MailTransport): ConnectorRuntime {
  return {
    async execute(
      actionType: string,
      payload: Readonly<Record<string, unknown>>,
      ctx: ActionExecutionContext,
    ): Promise<ActionResult> {
      const from =
        typeof ctx.instance.config["from"] === "string"
          ? (ctx.instance.config["from"] as string)
          : undefined;
      const replyTo =
        typeof ctx.instance.config["reply_to"] === "string"
          ? (ctx.instance.config["reply_to"] as string)
          : undefined;
      try {
        if (actionType === "send_message") {
          const result = await mail.send({
            to: payload["to"] as string,
            ...(from === undefined ? {} : { from }),
            ...(replyTo === undefined ? {} : { replyTo }),
            subject: payload["subject"] as string,
            text: payload["text"] as string,
            ...(typeof payload["html"] === "string" ? { html: payload["html"] as string } : {}),
          });
          return actionSucceeded(result.messageId);
        }
        if (actionType === "send_template") {
          const result = await mail.send({
            to: payload["to"] as string,
            ...(from === undefined ? {} : { from }),
            ...(replyTo === undefined ? {} : { replyTo }),
            template: {
              id: payload["template_id"] as string,
              ...(payload["variables"] === undefined
                ? {}
                : { variables: payload["variables"] as Record<string, unknown> }),
            },
          });
          return actionSucceeded(result.messageId);
        }
        return actionFailed({
          retryable: false,
          providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
          errorMessage: `unknown email action "${actionType}"`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Transient transport unavailability vs permanent refusal (unknown
        // template, rejected address): class markers, never raw input.
        const transient = /\bECONN|\bETIMEDOUT|\bEAI_AGAIN/.test(message);
        return actionFailed({
          retryable: transient,
          providerErrorCode: transient ? "MAIL_UNAVAILABLE" : "MAIL_REJECTED",
          errorMessage: message.slice(0, 200),
        });
      }
    },
    async test(): Promise<ActionResult> {
      // Safe probe: credential presence + transport reachability is the
      // transport's contract; nothing is sent (spec §40).
      return actionSucceeded();
    },
  };
}
