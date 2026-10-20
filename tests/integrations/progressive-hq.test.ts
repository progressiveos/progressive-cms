// Progressive HQ connector (owner integration task): envelope mapping, HMAC
// request signing, idempotent event ids, retry classification, and the
// execution-projection discipline — PII reaches the connector at delivery
// time only and NEVER persists into the delivery payload.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  type ActionExecutionContext,
  createProgressiveHqConnectorRuntime,
  hqEventId,
  hqIntakeEnvelope,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
  progressiveHqConnectorDefinition,
} from "@pcms/integrations";

const INSTANCE = {
  id: "00000000-0000-0000-0000-000000000001",
  connectorType: "progressive-hq",
  name: "HQ",
  enabled: true,
  config: { base_url: "https://hq.example.com", slug: "spangar-site", source_site: "spangar" },
  secretRefs: {},
} as never;

function ctx(projection: Record<string, unknown>): ActionExecutionContext {
  return { instance: INSTANCE, secrets: { signing_secret: "hq-webhook-secret" }, projection };
}

const LEAD = {
  lead_id: "lead-1",
  source_type: "FORM_SUBMISSION",
  source_id: "sub-1",
  classification: "consulting",
  created_at: "2026-09-25T10:00:00.000Z",
  name: "Иван Иванов",
  email: "ivan@example.ru",
  phone: "+7 900 000-00-00",
  summary: "Нужен ангар",
};

test("envelope maps lead fields onto the HQ intake contract", () => {
  const envelope = hqIntakeEnvelope({ leadId: "lead-1", sourceSite: "spangar", projection: LEAD });
  assert.equal(envelope["schema_version"], 1);
  assert.equal(envelope["event_type"], "intake.received");
  assert.equal(envelope["occurred_at"], "2026-09-25T10:00:00.000Z");
  const data = envelope["data"] as Record<string, unknown>;
  assert.equal(data["person_name"], "Иван Иванов");
  assert.equal(data["email"], "ivan@example.ru");
  assert.equal(data["phone"], "+7 900 000-00-00");
  assert.equal(data["initial_message"], "Нужен ангар");
  assert.equal(data["detected_need"], "consulting");
  assert.equal(data["acquisition_source"], "Progressive CMS / spangar");
  assert.equal(data["source_reference"], "lead-1");
});

test("envelope is byte-stable across retries (no wall-clock in the payload)", () => {
  const a = JSON.stringify(
    hqIntakeEnvelope({ leadId: "lead-1", sourceSite: "spangar", projection: LEAD }),
  );
  const b = JSON.stringify(
    hqIntakeEnvelope({ leadId: "lead-1", sourceSite: "spangar", projection: LEAD }),
  );
  assert.equal(a, b, "same lead + projection must produce identical bytes (HQ replay dedup)");
});

test("lead without a summary falls back to a deterministic message", () => {
  const envelope = hqIntakeEnvelope({
    leadId: "lead-2",
    sourceSite: "",
    projection: { source_type: "QUIZ_RUN", source_id: "run-9" },
  });
  const data = envelope["data"] as Record<string, unknown>;
  assert.equal(data["initial_message"], "QUIZ_RUN run-9");
  assert.equal(envelope["occurred_at"], null);
});

test("event id is stable, site-scoped and matches the HQ charset", () => {
  assert.equal(hqEventId("spangar", "lead-1"), "pcms:spangar:lead-1");
  assert.equal(hqEventId("", "lead-1"), "pcms:lead-1");
  assert.equal(hqEventId("spangar site", "lead-1"), "pcms:spangar-site:lead-1");
  assert.ok(hqEventId("spangar", "lead-1").length <= 255);
});

/** Fake transport capturing requests; scripts one response per call. */
function fakeHttp(responses: OutboundHttpResponse[]): {
  readonly requests: OutboundHttpRequest[];
  readonly http: (request: OutboundHttpRequest) => Promise<OutboundHttpResponse>;
} {
  const requests: OutboundHttpRequest[] = [];
  return {
    requests,
    async http(request) {
      requests.push(request);
      const next = responses.shift();
      if (next === undefined) throw new Error("script exhausted");
      return next;
    },
  };
}

test("execute signs the request and returns the HQ intake id", async () => {
  const fake = fakeHttp([
    {
      status: 201,
      body: JSON.stringify({
        status: "processed",
        result: { intake_record_id: "hq-intake-77" },
        replayed: false,
      }),
    },
  ]);
  const runtime = createProgressiveHqConnectorRuntime(fake.http);
  const outcome = await runtime.execute("intake_lead", { lead_id: "lead-1" }, ctx(LEAD));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.externalId, "hq-intake-77");

  const request = fake.requests[0]!;
  assert.equal(request.url, "https://hq.example.com/api/v1/integrations/inbound/spangar-site");
  assert.equal(request.headers?.["x-phq-event-id"], "pcms:spangar:lead-1");
  const timestamp = request.headers?.["x-phq-timestamp"];
  assert.ok(/^\d+$/.test(timestamp ?? ""), "unix-seconds timestamp");
  const expected = createHmac("sha256", "hq-webhook-secret")
    .update(`${timestamp}.${request.headers?.["x-phq-event-id"]}.${request.body}`)
    .digest("hex");
  assert.equal(request.headers?.["x-phq-signature"], `sha256=${expected}`);
  // PII rides the signed body — not the persisted payload, and no secret or
  // signature material leaks into result metadata.
  assert.ok((request.body ?? "").includes("ivan@example.ru"));
  assert.ok(!JSON.stringify(outcome).includes("hq-webhook-secret"));
});

test("execute classifies HQ responses: 409 permanent, 5xx/429 retryable", async () => {
  const runtime = createProgressiveHqConnectorRuntime(
    fakeHttp([
      { status: 409, body: JSON.stringify({ detail: "event id reused with different payload" }) },
      { status: 503, body: "overloaded" },
      { status: 429, body: "{}" },
    ]).http,
  );
  const conflict = await runtime.execute("intake_lead", { lead_id: "lead-1" }, ctx(LEAD));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.retryable, false);
  assert.equal(conflict.providerErrorCode, "HQ_EVENT_CONFLICT");

  const serverError = await runtime.execute("intake_lead", { lead_id: "lead-1" }, ctx(LEAD));
  assert.equal(serverError.retryable, true);
  const rateLimited = await runtime.execute("intake_lead", { lead_id: "lead-1" }, ctx(LEAD));
  assert.equal(rateLimited.retryable, true);
});

test("connector test: reachability, then signed dry-run probe (nothing stored on strict HQ)", async () => {
  const fake = fakeHttp([
    { status: 200, body: JSON.stringify({ name: "Progressive HQ" }) },
    { status: 422, body: JSON.stringify({ detail: "Некорректный envelope входящего события" }) },
  ]);
  const runtime = createProgressiveHqConnectorRuntime(fake.http);
  const outcome = await runtime.test(ctx(LEAD));
  assert.equal(outcome.ok, true, "422-after-signature is the strict-HQ pass");
  assert.equal(fake.requests.length, 2);

  const reachability = fake.requests[0]!;
  assert.equal(reachability.method, "GET");
  assert.equal(reachability.url, "https://hq.example.com/api/v1/about");

  const probe = fake.requests[1]!;
  assert.equal(probe.method, "POST");
  assert.equal(probe.url, "https://hq.example.com/api/v1/integrations/inbound/spangar-site");
  assert.equal(probe.headers?.["x-phq-dry-run"], "1");
  assert.equal(probe.headers?.["x-phq-event-id"], "pcms:spangar:probe");
  const timestamp = probe.headers?.["x-phq-timestamp"];
  const expected = createHmac("sha256", "hq-webhook-secret")
    .update(`${timestamp}.${probe.headers?.["x-phq-event-id"]}.${probe.body}`)
    .digest("hex");
  assert.equal(probe.headers?.["x-phq-signature"], `sha256=${expected}`);
  const probeEnvelope = JSON.parse(probe.body ?? "{}") as Record<string, unknown>;
  assert.equal(probeEnvelope["dry_run"], true, "forbidden field forces the safe 422 path");
  // Probe carries no lead PII.
  assert.ok(!(probe.body ?? "").includes("ivan@example.ru"));
  assert.ok(!JSON.stringify(outcome).includes("hq-webhook-secret"));
});

test("connector test: dry-run-capable HQ answers dry_run_ok", async () => {
  const fake = fakeHttp([
    { status: 200, body: "{}" },
    { status: 200, body: JSON.stringify({ status: "dry_run_ok", external_event_id: "x" }) },
  ]);
  const runtime = createProgressiveHqConnectorRuntime(fake.http);
  const outcome = await runtime.test(ctx(LEAD));
  assert.equal(outcome.ok, true);
});

test("connector test: probe without slug/secret stays reachability-only", async () => {
  const fake = fakeHttp([{ status: 200, body: "{}" }]);
  const runtime = createProgressiveHqConnectorRuntime(fake.http);
  const outcome = await runtime.test({
    instance: INSTANCE,
    secrets: {},
    projection: LEAD,
  });
  assert.equal(outcome.ok, true);
  assert.equal(fake.requests.length, 1, "no signed probe without a secret");
});

test("connector test probe classifies failures: 401 secret, 404 slug, stored probe", async () => {
  const badSecret = createProgressiveHqConnectorRuntime(
    fakeHttp([
      { status: 200, body: "{}" },
      { status: 401, body: JSON.stringify({ detail: "Некорректная подпись webhook" }) },
    ]).http,
  );
  const auth = await badSecret.test(ctx(LEAD));
  assert.equal(auth.ok, false);
  assert.equal(auth.retryable, false);
  assert.equal(auth.providerErrorCode, "HQ_PROBE_AUTH");

  const missing = createProgressiveHqConnectorRuntime(
    fakeHttp([
      { status: 200, body: "{}" },
      { status: 404, body: JSON.stringify({ detail: "Inbound endpoint не найден" }) },
    ]).http,
  );
  const endpoint = await missing.test(ctx(LEAD));
  assert.equal(endpoint.ok, false);
  assert.equal(endpoint.providerErrorCode, "HQ_ENDPOINT_MISSING");

  const lenient = createProgressiveHqConnectorRuntime(
    fakeHttp([
      { status: 200, body: "{}" },
      { status: 201, body: JSON.stringify({ status: "processed", result: {} }) },
    ]).http,
  );
  const stored = await lenient.test(ctx(LEAD));
  assert.equal(stored.ok, false, "an endpoint that STORES the probe is not the expected HQ");
  assert.equal(stored.providerErrorCode, "HQ_PROBE_STORED");
});

test("connector test: /about outage still fails before the probe", async () => {
  const fake = fakeHttp([{ status: 503, body: "down" }]);
  const runtime = createProgressiveHqConnectorRuntime(fake.http);
  const outcome = await runtime.test(ctx(LEAD));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retryable, true);
  assert.equal(fake.requests.length, 1);
});

test("execute: body revision pins the attribution format per delivery", async () => {
  const withAttr = fakeHttp([
    {
      status: 201,
      body: JSON.stringify({ status: "processed", result: { intake_record_id: "hq-1" } }),
    },
  ]);
  const runtime = createProgressiveHqConnectorRuntime(withAttr.http);
  const projection = {
    ...LEAD,
    attribution: { interaction_kind: "form", form_key: "f", utm_source: "vk" },
  };
  const outcome = await runtime.execute(
    "intake_lead",
    { lead_id: "lead-1" },
    { ...ctx(projection), bodyRevision: 2 },
  );
  assert.equal(outcome.ok, true);
  const envelope = JSON.parse(withAttr.requests[0]?.body ?? "{}") as {
    data: Record<string, unknown>;
  };
  assert.deepEqual(
    envelope.data.attribution,
    projection.attribution,
    "revision 2 → attribution rides",
  );

  const legacy = fakeHttp([
    {
      status: 201,
      body: JSON.stringify({ status: "processed", result: { intake_record_id: "hq-2" } }),
    },
  ]);
  const legacyRuntime = createProgressiveHqConnectorRuntime(legacy.http);
  await legacyRuntime.execute(
    "intake_lead",
    { lead_id: "lead-1" },
    { ...ctx(projection), bodyRevision: 1 },
  );
  const legacyEnvelope = JSON.parse(legacy.requests[0]?.body ?? "{}") as {
    data: Record<string, unknown>;
  };
  assert.equal(
    "attribution" in legacyEnvelope.data,
    false,
    "revision 1 (old delivery retry) → legacy bytes, no attribution key",
  );
});

test("execute: non-object JSON and non-string intake ids are rejected, not coerced", async () => {
  for (const body of [
    "null",
    "201",
    '"text"',
    "[]",
    '{"result":{"intake_record_id":123}}',
    '{"result":{"intake_record_id":null}}',
    '{"result":{"intake_record_id":"   "}}',
    '{"result":"bare-string"}',
  ]) {
    const fake = fakeHttp([{ status: 200, body }]);
    const runtime = createProgressiveHqConnectorRuntime(fake.http);
    const outcome = await runtime.execute("intake_lead", { lead_id: "lead-1" }, ctx(LEAD));
    assert.equal(outcome.ok, false, JSON.stringify(body));
    assert.equal(outcome.providerErrorCode, "HQ_RESPONSE_INVALID", JSON.stringify(body));
    assert.equal(outcome.externalId, undefined, JSON.stringify(body));
  }
  // A real string id still passes.
  const ok = fakeHttp([
    {
      status: 201,
      body: JSON.stringify({ status: "processed", result: { intake_record_id: "hq-77" } }),
    },
  ]);
  const good = await createProgressiveHqConnectorRuntime(ok.http).execute(
    "intake_lead",
    { lead_id: "lead-1" },
    ctx(LEAD),
  );
  assert.equal(good.ok, true);
  assert.equal(good.externalId, "hq-77");
});

test("execute: 2xx without result.intake_record_id is NOT a confirmed delivery", async () => {
  for (const body of ['{"status":"processed"}', "not-json", '{"result":{}}']) {
    const fake = fakeHttp([{ status: 201, body }]);
    const runtime = createProgressiveHqConnectorRuntime(fake.http);
    const outcome = await runtime.execute("intake_lead", { lead_id: "lead-1" }, ctx(LEAD));
    assert.equal(outcome.ok, false, JSON.stringify(body));
    assert.equal(outcome.retryable, false, "HQ already committed — retry would replay, not heal");
    assert.equal(outcome.providerErrorCode, "HQ_RESPONSE_INVALID");
  }
});

test("definition declares the execution projection and required intake fields", () => {
  const action = progressiveHqConnectorDefinition.actions[0]!;
  assert.equal(action.actionType, "intake_lead");
  assert.equal(action.executionProjection?.aggregate, "lead");
  assert.equal(action.executionProjection?.idFromPayload, "lead_id");
  assert.ok(action.executionProjection?.fields.includes("email"));
  assert.ok(action.executionProjection?.fields.includes("phone"));
  assert.equal(
    progressiveHqConnectorDefinition.secrets.some((secret) => secret.name === "signing_secret"),
    true,
  );
});

test("malformed contact values fail BEFORE the HTTP request (typed, permanent, not sent)", async () => {
  const fake = fakeHttp([]);
  const runtime = createProgressiveHqConnectorRuntime(fake.http);
  const badEmail = await runtime.execute(
    "intake_lead",
    { lead_id: "lead-1" },
    ctx({ ...LEAD, email: "не почта" }),
  );
  assert.equal(badEmail.ok, false);
  assert.equal(badEmail.retryable, false);
  assert.equal(badEmail.providerErrorCode, "HQ_CONTACT_FORMAT_INVALID");
  assert.equal(fake.requests.length, 0, "nothing was sent");

  const badPhone = await runtime.execute(
    "intake_lead",
    { lead_id: "lead-1" },
    ctx({ ...LEAD, phone: "позвоните позже" }),
  );
  assert.equal(badPhone.ok, false);
  assert.equal(badPhone.providerErrorCode, "HQ_CONTACT_FORMAT_INVALID");
  assert.equal(fake.requests.length, 0, "nothing was sent");
});

test("well-formed contacts still pass the pre-send format gate", async () => {
  const fake = fakeHttp([
    {
      status: 201,
      body: JSON.stringify({ status: "processed", result: { intake_record_id: "hq-1" } }),
    },
  ]);
  const runtime = createProgressiveHqConnectorRuntime(fake.http);
  const result = await runtime.execute("intake_lead", { lead_id: "lead-1" }, ctx(LEAD));
  assert.equal(result.ok, true);
  assert.equal(fake.requests.length, 1);
});

test("initial_message prefers the readable presentation over the raw summary", () => {
  const withPresentation = hqIntakeEnvelope({
    leadId: "lead-9",
    sourceSite: "spangar",
    projection: {
      ...LEAD,
      presentation: "Форма «Заявка»\nИмя: Иван Иванов\nСообщение: Нужен ангар",
    },
  });
  const data = withPresentation["data"] as Record<string, unknown>;
  const initialMessage = String(data["initial_message"]);
  assert.match(initialMessage, /Форма «Заявка»/);
  assert.match(initialMessage, /Имя: Иван Иванов/);

  const withoutPresentation = hqIntakeEnvelope({
    leadId: "lead-9",
    sourceSite: "spangar",
    projection: { source_type: "QUIZ_RUN", source_id: "run-9", summary: "Краткий итог" },
  });
  const fallbackData = withoutPresentation["data"] as Record<string, unknown>;
  assert.equal(fallbackData["initial_message"], "Краткий итог");
});
