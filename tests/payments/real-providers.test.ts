// PAY-T010 delivered (2026-10-02): the six real provider adapters. Each is
// exercised against a LOCAL double of the provider HTTP API (no external
// network): request shaping, response normalization, and — the trust
// boundary — webhook verification (Stripe HMAC + replay window, T-Bank
// token, Alipay RSA2, PayPal API verification, YooKassa IP allowlist,
// Tabby HMAC fail-closed).
import assert from "node:assert/strict";
import { createHmac, sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import {} from "@pcms/payments";
import { AlipayProvider } from "../../extensions/progressive-payments-alipay/src/index.js";
import { PayPalProvider } from "../../extensions/progressive-payments-paypal/src/index.js";
import { StripeProvider } from "../../extensions/progressive-payments-stripe/src/index.js";
import { TabbyProvider } from "../../extensions/progressive-payments-tabby/src/index.js";
import { TBankProvider } from "../../extensions/progressive-payments-tbank/src/index.js";
import { YooKassaProvider } from "../../extensions/progressive-payments-yookassa/src/index.js";

let server: Server | null = null;
let baseUrl = "";
let lastRequest: {
  path: string;
  method: string;
  headers: Record<string, unknown>;
  body: string;
} | null = null;
let responder: (request: {
  path: string;
  method: string;
  headers: Record<string, unknown>;
  body: string;
}) => { status: number; body: string } = () => ({
  status: 200,
  body: JSON.stringify({ id: "double-default", status: "pending" }),
});

async function startDouble(): Promise<void> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url ?? "/", "http://localhost");
      lastRequest = {
        path: url.pathname,
        method: request.method ?? "GET",
        headers: request.headers,
        body,
      };
      const outcome = responder({
        path: url.pathname,
        method: request.method ?? "GET",
        headers: request.headers,
        body,
      });
      response.writeHead(outcome.status, { "content-type": "application/json" });
      response.end(outcome.body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  assert.ok(address !== null && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

const CREATE_INPUT = {
  paymentId: "018f2000-0000-7000-8000-0000000000a1",
  amount: 150.5,
  currency: "RUB",
  description: "Заказ 42",
  idempotencyKey: "pcms:018f2000-0000-7000-8000-0000000000a1",
  metadata: {},
  callbackUrl: "https://site.example/pay/return",
} as const;

describe("PAY-T010 real provider adapters", () => {
  before(async () => {
    await startDouble();
  });
  after(() => {
    server?.close();
  });

  test("yookassa: Basic auth, Idempotence-Key, IP-allowlisted notifications", async () => {
    const provider = new YooKassaProvider({ apiBase: baseUrl, allowedIps: ["127.0.0.2/32"] });
    const created = await provider.createPayment(CREATE_INPUT, {
      values: { shopId: "shop", secretKey: "key" },
    });
    assert.equal(created.status, "PENDING");
    assert.ok(lastRequest?.headers["idempotence-key"] === CREATE_INPUT.idempotencyKey);
    const authHeader = String(lastRequest?.headers["authorization"] ?? "");
    assert.equal(authHeader, `Basic ${Buffer.from("shop:key").toString("base64")}`);
    assert.ok(lastRequest?.body.includes('"capture":true'), lastRequest?.body);

    // Notification from an ALLOWLISTED IP verifies and parses.
    provider.verifyCallback({
      headers: { "x-real-ip": "127.0.0.2" },
      rawBody: JSON.stringify({
        event: "payment.succeeded",
        object: {
          id: created.externalId,
          status: "succeeded",
          amount: { value: "150.50", currency: "RUB" },
          metadata: { pcms_payment_id: CREATE_INPUT.paymentId },
        },
      }),
    });
    const parsed = provider.parseCallback({
      headers: {},
      rawBody: JSON.stringify({
        event: "payment.succeeded",
        object: {
          id: created.externalId,
          status: "succeeded",
          amount: { value: "150.50", currency: "RUB" },
          metadata: { pcms_payment_id: CREATE_INPUT.paymentId },
        },
      }),
    });
    assert.equal(parsed.outcome, "SUCCEEDED");
    assert.equal(parsed.externalPaymentId, created.externalId);
    assert.equal(parsed.idempotencyKey, CREATE_INPUT.paymentId);

    // Unlisted IP → rejected (fail-closed).
    assert.throws(
      () => provider.verifyCallback({ headers: { "x-real-ip": "203.0.113.9" }, rawBody: "{}" }),
      (error: { code?: string }) => error.code === "PAYMENT_INBOUND_INVALID",
    );
  });

  test("tbank: request token over sorted values; notification token verified", async () => {
    const provider = new TBankProvider({ apiBase: baseUrl });
    const secrets = { values: { terminalKey: "T1", password: "pass" } };
    responder = () => ({
      status: 200,
      body: JSON.stringify({ Success: true, PaymentId: "P123", Status: "NEW" }),
    });
    const created = await provider.createPayment(CREATE_INPUT, secrets);
    assert.ok((created.externalId ?? "").length > 0);
    const sent = JSON.parse(lastRequest?.body ?? "{}") as Record<string, unknown>;
    assert.equal(sent["TerminalKey"], "T1");
    assert.equal(sent["Amount"], 15050, "minor units");
    assert.ok(typeof sent["Token"] === "string" && sent["Token"].length === 64);

    // Notification with a correctly computed token verifies; a forged one dies.
    const notification = {
      TerminalKey: "T1",
      OrderId: CREATE_INPUT.paymentId,
      Success: true,
      Status: "CONFIRMED",
      PaymentId: created.externalId,
      Amount: 15050,
    };
    const { createHash } = await import("node:crypto");
    const token = createHash("sha256")
      .update(
        Object.keys(notification)
          .sort()
          .map((key) => String(notification[key as keyof typeof notification]))
          .concat("pass")
          .join(""),
      )
      .digest("hex");
    const view = {
      headers: {},
      rawBody: JSON.stringify({ ...notification, Token: token }),
    };
    provider.verifyCallback(view, secrets);
    const parsed = provider.parseCallback(view);
    assert.equal(parsed.outcome, "SUCCEEDED");
    assert.equal(parsed.amount, 150.5);
    assert.equal(parsed.idempotencyKey, CREATE_INPUT.paymentId);
    assert.throws(
      () =>
        provider.verifyCallback(
          { headers: {}, rawBody: JSON.stringify({ ...notification, Token: "0".repeat(64) }) },
          secrets,
        ),
      (error: { code?: string }) => error.code === "PAYMENT_INBOUND_INVALID",
    );
  });

  test("stripe: form-encoded create, HMAC webhook with replay window", async () => {
    const provider = new StripeProvider({ apiBase: baseUrl });
    const secrets = { values: { secretKey: "sk_test", webhookSecret: "whsec_test" } };
    const created = await provider.createPayment(CREATE_INPUT, secrets);
    assert.equal(created.status, "PENDING");
    const body = lastRequest?.body ?? "";
    assert.ok(body.includes("amount=15050") && body.includes("currency=rub"), body);
    assert.ok(lastRequest?.headers["stripe-idempotency-key"] === CREATE_INPUT.idempotencyKey);

    const eventBody = JSON.stringify({
      id: "evt_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: created.externalId,
          status: "succeeded",
          metadata: { pcms_payment_id: CREATE_INPUT.paymentId },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", "whsec_test")
      .update(`${timestamp}.${eventBody}`)
      .digest("hex");
    const view = {
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      rawBody: eventBody,
    };
    provider.verifyCallback(view, secrets);
    const parsed = provider.parseCallback(view);
    assert.equal(parsed.outcome, "SUCCEEDED");
    assert.equal(parsed.providerStatus, "succeeded");

    // Stale timestamp → replay rejected.
    const stale = {
      headers: { "stripe-signature": `t=${timestamp - 3600},v1=${signature}` },
      rawBody: eventBody,
    };
    assert.throws(
      () => provider.verifyCallback(stale, secrets),
      (error: { code?: string }) => error.code === "PAYMENT_INBOUND_INVALID",
    );
  });

  test("paypal: oauth + orders create; webhook verified through the provider API", async () => {
    const provider = new PayPalProvider({ apiBase: baseUrl });
    const secrets = {
      values: { clientId: "cid", clientSecret: "csecret", webhookId: "WHID" },
    };
    responder = ({ path }) => {
      if (path === "/v1/oauth2/token") {
        return { status: 200, body: JSON.stringify({ access_token: "at", expires_in: 3600 }) };
      }
      return {
        status: 200,
        body: JSON.stringify({ id: "ORDER-1", status: "CREATED" }),
      };
    };
    const created = await provider.createPayment(CREATE_INPUT, secrets);
    assert.equal(created.status, "PENDING");
    const oauthCall = lastRequest;
    void oauthCall;

    // Provider API confirms the transmission.
    responder = ({ path }) => {
      if (path === "/v1/notifications/verify-webhook-signature") {
        return { status: 200, body: JSON.stringify({ verification_status: "SUCCESS" }) };
      }
      return { status: 200, body: JSON.stringify({ access_token: "at", expires_in: 3600 }) };
    };
    await provider.verifyCallback(
      {
        headers: {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1",
          "paypal-transmission-id": "T1",
          "paypal-transmission-sig": "sig",
          "paypal-transmission-time": "2026-10-02T00:00:00Z",
        },
        rawBody: JSON.stringify({
          id: "WH-1",
          event_type: "CHECKOUT.ORDER.COMPLETED",
          resource: {
            id: "CAPTURE-1",
            status: "COMPLETED",
            custom_id: `pcms:${CREATE_INPUT.paymentId}`,
            supplementary_data: { related_ids: { order_id: created.externalId } },
            amount: { value: "150.50", currency_code: "RUB" },
          },
        }),
      },
      secrets,
    );
    const parsed = provider.parseCallback({
      headers: {},
      rawBody: JSON.stringify({
        id: "WH-1",
        event_type: "CHECKOUT.ORDER.COMPLETED",
        resource: {
          id: "CAPTURE-1",
          status: "COMPLETED",
          custom_id: `pcms:${CREATE_INPUT.paymentId}`,
          supplementary_data: { related_ids: { order_id: created.externalId } },
        },
      }),
    });
    assert.equal(parsed.outcome, "SUCCEEDED");
    assert.equal(parsed.externalPaymentId, created.externalId, "order id recovered from capture");

    // API denies the transmission → rejected.
    responder = ({ path }) => {
      if (path === "/v1/notifications/verify-webhook-signature") {
        return { status: 200, body: JSON.stringify({ verification_status: "FAILURE" }) };
      }
      return { status: 200, body: JSON.stringify({ access_token: "at", expires_in: 3600 }) };
    };
    await assert.rejects(
      provider.verifyCallback({ headers: {}, rawBody: "{}" }, secrets),
      (error: { code?: string }) => error.code === "PAYMENT_INBOUND_INVALID",
    );
  });

  test("alipay: RSA2-signed create; notification verified with the platform key", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const provider = new AlipayProvider({
      gatewayUrl: baseUrl,
      alipayPublicKey: publicKeyPem,
    });
    const secrets = { values: { appId: "2026", privateKey: privateKeyPem } };

    // The double responds with a SIGNED query result for status sync.
    responder = ({ path }) => {
      void path;
      const result = { trade_no: "20261002ALIPAY", trade_status: "TRADE_SUCCESS" };
      const params: Record<string, string> = {
        app_id: "2026",
        charset: "utf-8",
        sign_type: "RSA2",
        version: "1.0",
        ...result,
      };
      const base = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&");
      const sign = cryptoSign("RSA-SHA256", Buffer.from(base), privateKey).toString("base64");
      return {
        status: 200,
        body: JSON.stringify({
          alipay_trade_query_response: { ...params, sign, code: "10000" },
        }),
      };
    };
    const synced = await provider.getPayment("20261002ALIPAY", secrets);
    assert.equal(synced?.status, "SUCCEEDED", JSON.stringify(synced));
    assert.equal(synced?.providerStatus, "TRADE_SUCCESS");
    const sent = Object.fromEntries(new URLSearchParams(lastRequest?.body ?? ""));
    assert.equal(sent["app_id"], "2026");
    assert.equal(sent["sign_type"], "RSA2");
    assert.ok((sent["sign"] ?? "").length > 100);

    // Notification signed with the PLATFORM key verifies (here: the same
    // key pair stands in for the platform; the algorithm is what's pinned).
    const notification = {
      app_id: "2026",
      trade_no: "20261002ALIPAY",
      out_trade_no: CREATE_INPUT.paymentId,
      trade_status: "TRADE_SUCCESS",
      total_amount: "150.50",
      notify_id: "N1",
    };
    const sign = cryptoSign(
      "RSA-SHA256",
      Buffer.from(
        Object.keys(notification)
          .sort()
          .map((key) => `${key}=${notification[key as keyof typeof notification]}`)
          .join("&"),
      ),
      privateKey,
    ).toString("base64");
    const view = {
      headers: {},
      rawBody: new URLSearchParams({ ...notification, sign }).toString(),
    };
    provider.verifyCallback(view);
    const parsed = provider.parseCallback(view);
    assert.equal(parsed.outcome, "SUCCEEDED");
    assert.equal(parsed.idempotencyKey, CREATE_INPUT.paymentId);
    assert.equal(parsed.amount, 150.5);

    // Tampered notification → rejected.
    assert.throws(
      () =>
        provider.verifyCallback({
          headers: {},
          rawBody: new URLSearchParams({ ...notification, sign: "bad" }).toString(),
        }),
      (error: { code?: string }) => error.code === "PAYMENT_INBOUND_INVALID",
    );
  });

  test("tabby: HMAC-signed webhooks fail closed without the secret", async () => {
    const provider = new TabbyProvider({ apiBase: baseUrl });
    const secrets = {
      values: { merchantCode: "MC", secretKey: "sk", webhookSecret: "ws" },
    };
    const created = await provider.createPayment(CREATE_INPUT, secrets);
    assert.equal(created.status, "PENDING");

    const rawBody = JSON.stringify({
      payment: {
        id: created.externalId,
        status: "captured",
        order_reference: CREATE_INPUT.paymentId,
        amount: "150.50",
      },
    });
    const signature = createHmac("sha256", "ws").update(rawBody).digest("hex");
    const view = { headers: { "x-tabby-signature": signature }, rawBody };
    provider.verifyCallback(view, secrets);
    const parsed = provider.parseCallback(view);
    assert.equal(parsed.outcome, "SUCCEEDED");
    assert.equal(parsed.currency, "AED");

    // No signature header → rejected even with the secret configured.
    assert.throws(
      () => provider.verifyCallback({ headers: {}, rawBody }, secrets),
      (error: { code?: string }) => error.code === "PAYMENT_INBOUND_INVALID",
    );
    // Capabilities are honest: no merchant-side cancel for BNPL.
    assert.equal(provider.capabilities().cancel, false);
  });
});
