// PCMS-INT-T007..T010 — first-party connectors over deterministic fake
// transports: email send/template, telegram escaping + error
// normalization + no token leakage, Talk OCS semantics, webhook request
// template + SSRF refusal. No test touches a public network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { newStableId } from "@pcms/core";
import {
  type ActionExecutionContext,
  createEmailConnectorRuntime,
  createTalkConnectorRuntime,
  createTelegramConnectorRuntime,
  createWebhookConnectorRuntime,
  emailConnectorDefinition,
  escapeForParseMode,
  type MailTransport,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
  talkConnectorDefinition,
  telegramConnectorDefinition,
  webhookConnectorDefinition,
} from "@pcms/integrations";

function ctxFor(
  config: Record<string, unknown>,
  secrets: Record<string, string> = {},
): ActionExecutionContext {
  return {
    instance: {
      id: newStableId(),
      connectorType: "x",
      name: "conn-under-test",
      enabled: true,
      config,
      secretRefs: {},
      siteKey: null,
      environment: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    secrets,
  };
}

test("email connector: send_message and send_template reach the transport", async () => {
  const sent: unknown[] = [];
  const mail: MailTransport = {
    async send(message) {
      sent.push(message);
      return { messageId: "m-1" };
    },
  };
  const runtime = createEmailConnectorRuntime(mail);
  const ctx = ctxFor({ from: "cms@example.com" }, { transport: "MAIL_KEY" });
  const first = await runtime.execute(
    "send_message",
    { to: "ops@example.com", subject: "s", text: "hello" },
    ctx,
  );
  assert.equal(first.ok, true);
  await runtime.execute("send_template", { to: "ops@example.com", template_id: "welcome" }, ctx);
  assert.deepEqual(sent[0], {
    to: "ops@example.com",
    from: "cms@example.com",
    subject: "s",
    text: "hello",
  });
  assert.deepEqual(sent[1], {
    to: "ops@example.com",
    from: "cms@example.com",
    template: { id: "welcome" },
  });
  // Unknown action → permanent, named.
  const bad = await runtime.execute("nope", {}, ctx);
  assert.equal(bad.retryable, false);
  assert.equal(bad.providerErrorCode, "INTEGRATION_ACTION_UNKNOWN");
});

test("telegram connector: escapes by parse mode and normalizes provider errors", async () => {
  assert.equal(escapeForParseMode("a<b>&", "HTML"), "a&lt;b&gt;&amp;");
  assert.equal(escapeForParseMode("a.b!c", "MarkdownV2"), "a\\.b\\!c");
  assert.equal(escapeForParseMode("plain_text", ""), "plain_text");

  const calls: OutboundHttpRequest[] = [];
  const http = async (request: OutboundHttpRequest): Promise<OutboundHttpResponse> => {
    calls.push(request);
    return { status: 200, body: '{"ok":false,"error_code":400,"description":"chat not found"}' };
  };
  const runtime = createTelegramConnectorRuntime(http);
  const ctx = ctxFor(
    { default_chat_id: "42", parse_mode: "HTML" },
    { bot_token: "SUPER-SECRET-TOKEN" },
  );
  const result = await runtime.execute("send_message", { text: "<b>hi</b>" }, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.providerErrorCode, "TELEGRAM_400");
  assert.equal(result.retryable, false);
  assert.equal(result.errorMessage, "chat not found");
  // Escaped body + token on the URL path, but never in the error surface.
  assert.ok(String(calls[0]?.body).includes("&lt;b&gt;hi&lt;/b&gt;"));
  assert.ok(String(calls[0]?.url).includes("SUPER-SECRET-TOKEN"));
  assert.ok(!JSON.stringify(result).includes("SUPER-SECRET-TOKEN"));
  // 429 → retryable.
  const http429 = async (): Promise<OutboundHttpResponse> => ({
    status: 429,
    body: '{"ok":false,"error_code":429,"description":"Too Many Requests"}',
  });
  const throttled = await createTelegramConnectorRuntime(http429).execute(
    "send_message",
    { text: "x" },
    ctx,
  );
  assert.equal(throttled.retryable, true);
});

test("talk connector: OCS envelope normalization + basic auth from secrets", async () => {
  const calls: OutboundHttpRequest[] = [];
  const http = async (request: OutboundHttpRequest): Promise<OutboundHttpResponse> => {
    calls.push(request);
    return {
      status: 200,
      body: '{"ocs":{"meta":{"status":"failure","statuscode":404,"message":"room not found"}}}',
    };
  };
  const runtime = createTalkConnectorRuntime(http);
  const ctx = ctxFor(
    { base_url: "https://cloud.example.com/", room_token: "rm1" },
    { user: "svc", password: "pw" },
  );
  const result = await runtime.execute("post_message", { message: "hello room" }, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.providerErrorCode, "TALK_404");
  assert.equal(result.errorMessage, "room not found");
  assert.ok(
    calls[0]?.url.startsWith(
      "https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/room/rm1/message",
    ),
  );
  assert.equal(calls[0]?.headers?.["OCS-APIRequest"], "true");
  const expectedAuth = Buffer.from("svc:pw", "utf8").toString("base64");
  assert.equal(calls[0]?.headers?.authorization, `Basic ${expectedAuth}`);
});

test("webhook connector: template request, secret headers, signing, SSRF refusal", async () => {
  const calls: OutboundHttpRequest[] = [];
  const http = async (request: OutboundHttpRequest): Promise<OutboundHttpResponse> => {
    calls.push(request);
    return { status: 200, body: '{"received":true}' };
  };
  const allowedUrls: string[] = [];
  const guard = {
    async assertAllowed(url: string) {
      if (!allowedUrls.includes(url)) {
        throw Object.assign(new Error("host is not allowed"), { code: "INTEGRATION_URL_BLOCKED" });
      }
    },
  };
  const runtime = createWebhookConnectorRuntime(http, guard);
  const ctx = ctxFor(
    {
      url: "https://crm.example.com/hooks/cms",
      method: "POST",
      headers: { "x-tenant": "acme" },
      secret_headers: { authorization: "CRM_API_KEY" },
      signing: { header: "x-signature", secret_ref: "CRM_SIGNING" },
    },
    { CRM_API_KEY: "key-123", CRM_SIGNING: "hmac-secret" },
  );
  // Guard not (yet) allowing → refused, permanent.
  const blocked = await runtime.execute("notify", { text: "x" }, ctx);
  assert.equal(blocked.ok, false);
  void blocked;
  assert.equal(blocked.providerErrorCode, "INTEGRATION_URL_BLOCKED");
  assert.equal(blocked.retryable, false);

  allowedUrls.push("https://crm.example.com/hooks/cms"); // remains allowed for the sub-cases below
  const ok = await runtime.execute("notify", { text: "hello" }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(calls[0]?.headers?.["x-tenant"], "acme");
  assert.equal(calls[0]?.headers?.authorization, "key-123");
  assert.equal(calls[0]?.body, '{"text":"hello"}');
  assert.equal(calls[0]?.headers?.["x-signature"]?.length, 64); // hmac-sha256 hex

  // Secret header without a loaded secret → permanent config failure.
  const noSecret = await runtime.execute("notify", { text: "x" }, ctxFor(ctx.instance.config, {}));
  assert.equal(noSecret.providerErrorCode, "INTEGRATION_SECRET_MISSING");
});

test("first-party connector set v1 registers all definitions", async () => {
  const { createConnectorRegistry, registerFirstPartyConnectorDefinitionsV1 } = await import(
    "@pcms/integrations"
  );
  const registry = createConnectorRegistry();
  registerFirstPartyConnectorDefinitionsV1(registry);
  assert.deepEqual(
    registry.list().map((definition) => definition.connectorType),
    [
      "amocrm",
      "bitrix24",
      "email",
      "hubspot",
      "nextcloud-talk",
      "pipedrive",
      "progressive-hq",
      "salesforce",
      "sharecrm",
      "telegram",
      "webhook-http",
      "zoho-crm",
    ],
  );
  // Every action payload schema is machine-checkable (bounded shapes).
  for (const definition of registry.list()) {
    for (const action of definition.actions) {
      assert.equal(typeof action.payloadSchema, "object");
    }
  }
});
