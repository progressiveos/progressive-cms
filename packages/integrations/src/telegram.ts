// Telegram connector (PCMS-INT-T008; Integrations spec §9). send_message
// over the Bot API with parse-mode-aware escaping, provider error
// normalization and strict token hygiene: the bot token never appears in
// delivery history, error summaries or logs — only the plain host label.

import type { ConnectorDefinition } from "./connectors.js";
import {
  type ActionExecutionContext,
  type ActionResult,
  actionFailed,
  actionSucceeded,
  type ConnectorRuntime,
} from "./runtime.js";
import { networkFailure, type OutboundHttp } from "./transport.js";

export type TelegramParseMode = "" | "MarkdownV2" | "HTML";

const MARKDOWNV2_SPECIALS = "_*[]()~`>#+-=|{}.!\\";

/** Escapes message text for the configured parse mode (spec §9). */
export function escapeForParseMode(text: string, parseMode: TelegramParseMode): string {
  if (parseMode === "HTML") {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  if (parseMode === "MarkdownV2") {
    let out = "";
    for (const ch of text) out += MARKDOWNV2_SPECIALS.includes(ch) ? `\\${ch}` : ch;
    return out;
  }
  return text;
}

export const telegramConnectorDefinition: ConnectorDefinition = {
  connectorType: "telegram",
  title: "Telegram",
  description: "Delivers messages through a Telegram bot",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      default_chat_id: { type: "string", maxLength: 64 },
      parse_mode: { enum: ["", "MarkdownV2", "HTML"] },
      disable_web_page_preview: { type: "boolean" },
    },
  },
  secrets: [{ name: "bot_token", description: "Telegram bot token secret name" }],
  actions: [
    {
      actionType: "send_message",
      description: "Send a text message to the configured/default chat",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", maxLength: 4096 },
          chat_id: { type: "string", maxLength: 64 },
          message_thread_id: { type: "string", maxLength: 64 },
        },
        required: ["text"],
      },
    },
  ],
  testable: true,
};

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  error_code?: number;
  result?: { message_id?: number };
}

export function createTelegramConnectorRuntime(http: OutboundHttp): ConnectorRuntime {
  async function execute(
    actionType: string,
    payload: Readonly<Record<string, unknown>>,
    ctx: ActionExecutionContext,
  ): Promise<ActionResult> {
    if (actionType !== "send_message") {
      return actionFailed({
        retryable: false,
        providerErrorCode: "INTEGRATION_ACTION_UNKNOWN",
        errorMessage: `unknown telegram action "${actionType}"`,
      });
    }
    const token = ctx.secrets["bot_token"];
    const parseMode = (ctx.instance.config["parse_mode"] ?? "") as TelegramParseMode;
    const chatId =
      (typeof payload["chat_id"] === "string" && (payload["chat_id"] as string)) ||
      (typeof ctx.instance.config["default_chat_id"] === "string"
        ? (ctx.instance.config["default_chat_id"] as string)
        : "");
    if (chatId === "") {
      return actionFailed({
        retryable: false,
        providerErrorCode: "TELEGRAM_NO_DESTINATION",
        errorMessage: "no chat_id in payload or default_chat_id in config",
      });
    }
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: escapeForParseMode(payload["text"] as string, parseMode),
    };
    if (parseMode !== "") body["parse_mode"] = parseMode;
    if (typeof payload["message_thread_id"] === "string") {
      body["message_thread_id"] = payload["message_thread_id"];
    }
    if (ctx.instance.config["disable_web_page_preview"] === true) {
      body["disable_web_page_preview"] = true;
    }
    try {
      // Token rides the URL path per Bot API; the URL is never logged.
      const response = await http({
        method: "POST",
        url: `https://api.telegram.org/bot${token}/sendMessage`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 10_000,
      });
      const parsed = JSON.parse(response.body) as TelegramApiResponse;
      if (parsed.ok === true) {
        const messageId = parsed.result?.message_id;
        return actionSucceeded(messageId === undefined ? undefined : String(messageId));
      }
      const code = parsed.error_code ?? response.status;
      return actionFailed({
        retryable: code === 429 || code >= 500,
        providerErrorCode: `TELEGRAM_${code}`,
        // Only the provider's own description; never request material.
        errorMessage: (parsed.description ?? `telegram error ${code}`).slice(0, 200),
        httpStatus: response.status,
      });
    } catch (error) {
      return networkFailure(error, "api.telegram.org");
    }
  }
  return {
    execute,
    async test(ctx: ActionExecutionContext): Promise<ActionResult> {
      // Safe probe (spec §40): Bot API getMe proves the credential without
      // sending anything to a chat.
      try {
        const response = await http({
          method: "GET",
          url: `https://api.telegram.org/bot${ctx.secrets["bot_token"]}/getMe`,
          timeoutMs: 10_000,
        });
        const parsed = JSON.parse(response.body) as TelegramApiResponse;
        if (parsed.ok === true) return actionSucceeded();
        const code = parsed.error_code ?? response.status;
        return actionFailed({
          retryable: code === 429 || code >= 500,
          providerErrorCode: `TELEGRAM_${code}`,
          errorMessage: (parsed.description ?? `telegram error ${code}`).slice(0, 200),
          httpStatus: response.status,
        });
      } catch (error) {
        return networkFailure(error, "api.telegram.org");
      }
    },
  };
}
