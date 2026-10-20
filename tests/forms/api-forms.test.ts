// PCMS-FORM-T020 — REST/MCP surface for forms (Forms spec §12/§36/§37):
// public anonymous submit over the real transport with the reliability
// invariant proven against the actual publication_outbox table, definition
// discovery scoping, abuse controls end-to-end, quiz flow, MCP discovery
// tools.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApplicationServices,
  bindOperations,
  createApiFastify,
  createApiV1,
  makeDiscoveryRoutes,
  makeFormsRoutes,
  makeMutationRoutes,
} from "@pcms/api";
import { createLogger } from "@pcms/core";
import { findTool } from "@pcms/mcp";
import type { FastifyInstance } from "fastify";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

function stubLogger() {
  return createLogger({ level: "error", sink: () => {} });
}

async function makeApp(t: { after: (fn: () => void) => void }): Promise<{
  app: ApplicationServices;
  fastify: FastifyInstance;
}> {
  const { app } = await createApiFixture(t);
  const fastify: FastifyInstance = createApiFastify(() => "req_forms_test");
  await fastify.register(
    createApiV1([...makeDiscoveryRoutes(), ...makeMutationRoutes(), ...makeFormsRoutes()]),
    { application: app, logger: stubLogger(), cookieSecure: false },
  );
  await fastify.ready();
  return { app, fastify };
}

async function bearerFor(app: ApplicationServices, scopes: readonly string[]): Promise<string> {
  const account = await app.machineIdentity.createServiceAccount({
    name: `forms-sa-${Math.random().toString(36).slice(2, 8)}`,
    purpose: "forms api test",
    allowedScopes: [...scopes],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [...scopes],
    ttlMilliseconds: 3_600_000,
  });
  return token.rawSecret;
}

const CONTACT = {
  key: "api_contact",
  title: "Контакты",
  fields: [
    { key: "email", type: "email", label: "E", required: true },
    { key: "message", type: "text", label: "M", required: true, max_length: 500 },
    {
      key: "privacy_ok",
      type: "consent",
      label: "Согласие",
      required: true,
      consent_key: "privacy",
      consent_text: "Согласен",
      policy_reference: "policy:privacy@1",
    },
  ],
  settings: {
    lead_policy: { create_lead: true, email_from: "email", summary_from: "message" },
    spam_policy: { honeypot_field: "company_website" },
    success_behavior: { type: "message", message: "OK!" },
  },
};

async function createContactForm(app: ApplicationServices): Promise<string> {
  const response = await fastifyOf(app).inject({
    method: "POST",
    url: "/api/v1/forms",
    headers: {
      authorization: `Bearer ${await bearerFor(app, ["forms.manage_definition"])}`,
      "content-type": "application/json",
    },
    payload: CONTACT,
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { id: string }).id;
}

// Small helper: each test builds its own fastify bound to its own app.
const fastifyCache = new WeakMap<ApplicationServices, FastifyInstance>();
function fastifyOf(app: ApplicationServices): FastifyInstance {
  const existing = fastifyCache.get(app);
  if (existing !== undefined) return existing;
  throw new Error("fastify not registered for this app");
}

test("definition management and discovery: create via API, scope-gated reads", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  fastifyCache.set(app, fastify);
  const formId = await createContactForm(app);

  const noScope = await fastify.inject({
    method: "GET",
    url: "/api/v1/forms",
    headers: { authorization: `Bearer ${await bearerFor(app, ["search.admin"])}` },
  });
  assert.equal(noScope.statusCode, 403, noScope.body);
  assert.equal(
    (noScope.json() as { error: { code: string } }).error.code,
    "AUTH_PERMISSION_DENIED",
  );

  const reader = await fastify.inject({
    method: "GET",
    url: "/api/v1/forms",
    headers: { authorization: `Bearer ${await bearerFor(app, ["forms.read_definition"])}` },
  });
  assert.equal(reader.statusCode, 200);
  const list = reader.json() as { items: { id: string; key: string; schema_version: number }[] };
  assert.ok(list.items.some((item) => item.id === formId && item.schema_version === 1));
});

test("public submit over REST: 200, persisted state, FormSubmitted + LeadCreated in the real outbox", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  fastifyCache.set(app, fastify);
  const formId = await createContactForm(app);

  const submitted = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/forms/${formId}/submit`,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: {
      values: {
        email: "user@example.com",
        message: "Привет",
        privacy_ok: true,
        company_website: "",
      },
      submission_token: "tok-rest-1",
    },
  });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const result = submitted.json() as {
    submission_id: string;
    status: string;
    lead_id: string | null;
    success: { message: string };
  };
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.success.message, "OK!");
  assert.ok(result.lead_id !== null);

  // The reliability invariant, checked against the REAL outbox table.
  const outbox = await app.pool.query<{ event_type: string; payload: unknown }>(
    `SELECT event_type, payload FROM publication_outbox
     WHERE (event_type = 'FormSubmitted' AND aggregate_id = $1)
        OR (event_type = 'LeadCreated' AND payload->>'source_id' = $1)
     ORDER BY event_type`,
    [result.submission_id],
  );
  assert.deepEqual(outbox.rows.map((row) => row.event_type).sort(), [
    "FormSubmitted",
    "LeadCreated",
  ]);
  assert.ok(!JSON.stringify(outbox.rows).includes("user@example.com"), "no PII in outbox payloads");
});

test("definition stats over REST with read-only token: real counts, uuid lead join (0.1.192 regression)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  fastifyCache.set(app, fastify);
  const formId = await createContactForm(app);

  const submitted = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/forms/${formId}/submit`,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: {
      values: {
        email: "stats@example.com",
        message: "Раз",
        privacy_ok: true,
        company_website: "",
      },
      submission_token: "tok-stats-1",
    },
  });
  assert.equal(submitted.statusCode, 200, submitted.body);

  const manage = `Bearer ${await bearerFor(app, ["quizzes.manage_definition", "quizzes.read_definition"])}`;
  const created = await fastify.inject({
    method: "POST",
    url: "/api/v1/quizzes",
    headers: { authorization: manage, "content-type": "application/json" },
    payload: {
      key: "api_quiz_stats",
      title: "Квиз",
      steps: [{ id: "s1", questions: [{ id: "q1", type: "boolean", label: "Q", required: true }] }],
      scoring_rules: [{ question_id: "q1", operator: "eq", value: true, points: 7 }],
      outcomes: [{ id: "yes", title: "Да!", min_score: 7 }],
      settings: { lead_policy: { create_lead: true } },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const quizId = (created.json() as { id: string }).id;

  const started = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/${quizId}/start`,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: {},
  });
  assert.equal(started.statusCode, 200, started.body);
  const run = started.json() as { quiz_run_id: string; resume_token: string };
  const answered = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/runs/${run.quiz_run_id}/answer`,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { resume_token: run.resume_token, question_id: "q1", value: true },
  });
  assert.equal(answered.statusCode, 200, answered.body);
  const completed = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/runs/${run.quiz_run_id}/complete`,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { resume_token: run.resume_token },
  });
  assert.equal(completed.statusCode, 200, completed.body);

  const formStats = await fastify.inject({
    method: "GET",
    url: `/api/v1/forms/${formId}/stats`,
    headers: { authorization: `Bearer ${await bearerFor(app, ["forms.read_definition"])}` },
  });
  assert.equal(formStats.statusCode, 200, formStats.body);
  assert.deepEqual(formStats.json(), { primary: 1, completed: 0, leads: 1 });

  const quizStats = await fastify.inject({
    method: "GET",
    url: `/api/v1/quizzes/${quizId}/stats`,
    headers: { authorization: manage },
  });
  assert.equal(quizStats.statusCode, 200, quizStats.body);
  assert.deepEqual(quizStats.json(), { primary: 1, completed: 1, leads: 1 });
});

test("public submit abuse controls: origin, validation, honeypot, rate limit", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  fastifyCache.set(app, fastify);
  const formId = await createContactForm(app);
  const url = `/api/v1/public/forms/${formId}/submit`;
  const submit = (payload: object, headers: Record<string, string> = {}) =>
    fastify.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", ...headers },
      payload,
    });

  const crossOrigin = await submit(
    { values: { email: "a@b.co", message: "m", privacy_ok: true } },
    { origin: "https://evil.example", host: "localhost:3000" },
  );
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(
    (crossOrigin.json() as { error: { code: string } }).error.code,
    "FORM_ORIGIN_DENIED",
  );

  const invalid = await submit({ values: { email: "nope", message: "m", privacy_ok: true } });
  assert.equal(invalid.statusCode, 422);
  assert.equal((invalid.json() as { error: { code: string } }).error.code, "FORM_VALUES_INVALID");

  const spam = await submit({
    values: {
      email: "bot@spam.io",
      message: "buy",
      privacy_ok: true,
      company_website: "http://spam.io",
    },
  });
  assert.equal(spam.statusCode, 200);
  assert.equal((spam.json() as { status: string }).status, "SPAM");
  const spamOutbox = await app.pool.query(
    `SELECT id FROM publication_outbox WHERE aggregate_id = $1`,
    [(spam.json() as { submission_id: string }).submission_id],
  );
  assert.equal(spamOutbox.rowCount, 0, "spam emits no events");

  // Bucket: capacity 5 for this process+IP; the two submits above consumed 2
  // (cross-origin threw before the guard, invalid + spam + one more consumed).
  let throttled = 0;
  for (let i = 0; i < 10; i++) {
    const response = await submit({
      values: { email: `flood${i}@example.com`, message: "flood", privacy_ok: true },
    });
    if (response.statusCode === 429) {
      throttled += 1;
      assert.equal(
        (response.json() as { error: { code: string } }).error.code,
        "FORM_RATE_LIMITED",
      );
    } else {
      assert.ok([200, 422].includes(response.statusCode), response.body);
    }
  }
  assert.ok(throttled > 0, "burst eventually throttled");
});

test("public quiz flow over REST with server-computed outcome; MCP discovery tools scoped", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  fastifyCache.set(app, fastify);
  const manage = `Bearer ${await bearerFor(app, ["quizzes.manage_definition", "quizzes.read_definition"])}`;
  const created = await fastify.inject({
    method: "POST",
    url: "/api/v1/quizzes",
    headers: { authorization: manage, "content-type": "application/json" },
    payload: {
      key: "api_quiz",
      title: "Квиз",
      steps: [{ id: "s1", questions: [{ id: "q1", type: "boolean", label: "Q", required: true }] }],
      scoring_rules: [{ question_id: "q1", operator: "eq", value: true, points: 7 }],
      outcomes: [{ id: "yes", title: "Да!", min_score: 7 }],
      settings: { lead_policy: { create_lead: true } },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const quizId = (created.json() as { id: string }).id;

  const schema = await fastify.inject({
    method: "GET",
    url: `/api/v1/public/quizzes/${quizId}/schema`,
  });
  assert.equal(schema.statusCode, 200);
  const schemaBody = schema.json() as { steps: unknown[] };
  assert.equal(schemaBody.steps.length, 1);
  assert.ok(
    !JSON.stringify(schemaBody).includes("points"),
    "public schema has no scoring internals",
  );

  const started = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/${quizId}/start`,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: {},
  });
  assert.equal(started.statusCode, 200, started.body);
  const run = started.json() as { quiz_run_id: string; resume_token: string };

  const answered = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/runs/${run.quiz_run_id}/answer`,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { resume_token: run.resume_token, question_id: "q1", value: true },
  });
  assert.equal(answered.statusCode, 200);
  assert.equal((answered.json() as { next_step: unknown }).next_step, null);

  const completed = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/runs/${run.quiz_run_id}/complete`,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    payload: { resume_token: run.resume_token },
  });
  assert.equal(completed.statusCode, 200, completed.body);
  const completion = completed.json() as { score: number | null; outcome: { id: string } | null };
  assert.equal(completion.score, 7);
  assert.equal(completion.outcome?.id, "yes");

  // MCP discovery tools, invoked directly with a scoped actor context.
  const operations = bindOperations(app);
  const reader = scopedActor(["quizzes.read_definition"]);
  const tool = findTool("cms_get_quiz_public_schema");
  assert.ok(tool, "cms_get_quiz_public_schema tool exists");
  const toolResult = (await tool.run(operations, apiContextOf(reader, "mcp"), {
    quiz_id: quizId,
  })) as {
    quiz_definition_id: string;
  };
  assert.equal(toolResult.quiz_definition_id, quizId);

  await assert.rejects(
    () =>
      tool.run(operations, apiContextOf(scopedActor(["search.admin"]), "mcp"), {
        quiz_id: quizId,
      }),
    (error: unknown) => (error as { code?: string }).code === "AUTH_PERMISSION_DENIED",
  );
});
