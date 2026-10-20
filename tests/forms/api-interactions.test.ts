// PCMS-FORM-T021 — privileged interactions/leads APIs (Forms spec §29/§32/
// §36): scope-gated history reads, lead lifecycle with atomic LeadStatusChanged,
// entity-scoped export authorization with audit records in the security-event
// stream.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ApplicationServices,
  bindOperations,
  createApiFastify,
  createApiV1,
  makeDiscoveryRoutes,
  makeFormsRoutes,
  makeInteractionsRoutes,
  makeMutationRoutes,
} from "@pcms/api";
import { createLogger } from "@pcms/core";
import type { FastifyInstance } from "fastify";
import { apiContextOf, createApiFixture, scopedActor } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

function stubLogger() {
  return createLogger({ level: "error", sink: () => {} });
}

const fastifyCache = new WeakMap<ApplicationServices, FastifyInstance>();

async function makeApp(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t);
  const fastify: FastifyInstance = createApiFastify(() => "req_interactions_test");
  await fastify.register(
    createApiV1([
      ...makeDiscoveryRoutes(),
      ...makeMutationRoutes(),
      ...makeFormsRoutes(),
      ...makeInteractionsRoutes(),
    ]),
    { application: app, logger: stubLogger(), cookieSecure: false },
  );
  await fastify.ready();
  fastifyCache.set(app, fastify);
  return { app, fastify };
}

async function bearerFor(app: ApplicationServices, scopes: readonly string[]): Promise<string> {
  const account = await app.machineIdentity.createServiceAccount({
    name: `int-sa-${Math.random().toString(36).slice(2, 8)}`,
    purpose: "interactions api test",
    allowedScopes: [...scopes],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [...scopes],
    ttlMilliseconds: 3_600_000,
  });
  return token.rawSecret;
}

async function seed(
  app: ApplicationServices,
  fastify: FastifyInstance,
): Promise<{ submissionId: string; leadId: string; runId: string }> {
  const owner = `Bearer ${await bearerFor(app, ["forms.manage_definition", "quizzes.manage_definition"])}`;
  const form = await fastify.inject({
    method: "POST",
    url: "/api/v1/forms",
    headers: { authorization: owner, "content-type": "application/json" },
    payload: {
      key: `seed_form_${Math.random().toString(36).slice(2, 6)}`,
      title: "Форма",
      fields: [
        { key: "email", type: "email", label: "E", required: true },
        { key: "message", type: "text", label: "M", required: true },
      ],
      settings: {
        lead_policy: { create_lead: true, email_from: "email", summary_from: "message" },
      },
    },
  });
  assert.equal(form.statusCode, 201, form.body);
  const formId = (form.json() as { id: string }).id;

  const submitted = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/forms/${formId}/submit`,
    headers: { "content-type": "application/json" },
    payload: {
      values: { email: "seed@example.com", message: "заявка" },
      submission_token: "seed-tok",
    },
  });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const submission = submitted.json() as { submission_id: string; lead_id: string | null };
  assert.ok(submission.lead_id !== null);

  const quiz = await fastify.inject({
    method: "POST",
    url: "/api/v1/quizzes",
    headers: { authorization: owner, "content-type": "application/json" },
    payload: {
      key: `seed_quiz_${Math.random().toString(36).slice(2, 6)}`,
      title: "Квиз",
      steps: [{ id: "s1", questions: [{ id: "q1", type: "boolean", label: "Q", required: true }] }],
    },
  });
  assert.equal(quiz.statusCode, 201, quiz.body);
  const quizId = (quiz.json() as { id: string }).id;
  const started = await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/${quizId}/start`,
    headers: { "content-type": "application/json" },
    payload: {},
  });
  const run = started.json() as { quiz_run_id: string; resume_token: string };
  await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/runs/${run.quiz_run_id}/answer`,
    headers: { "content-type": "application/json" },
    payload: { resume_token: run.resume_token, question_id: "q1", value: true },
  });
  await fastify.inject({
    method: "POST",
    url: `/api/v1/public/quizzes/runs/${run.quiz_run_id}/complete`,
    headers: { "content-type": "application/json" },
    payload: { resume_token: run.resume_token },
  });

  return {
    submissionId: submission.submission_id,
    leadId: submission.lead_id!,
    runId: run.quiz_run_id,
  };
}

test("submission/quiz-run history is scope-gated and readable with answers and payload", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  const seeded = await seed(app, fastify);
  const reader = `Bearer ${await bearerFor(app, ["interactions.read"])}`;

  const denied = await fastify.inject({
    method: "GET",
    url: "/api/v1/interactions/submissions",
    headers: { authorization: `Bearer ${await bearerFor(app, ["forms.read_definition"])}` },
  });
  assert.equal(denied.statusCode, 403);

  const submissions = await fastify.inject({
    method: "GET",
    url: "/api/v1/interactions/submissions",
    headers: { authorization: reader },
  });
  assert.equal(submissions.statusCode, 200);
  const submissionPage = submissions.json() as {
    items: { id: string }[];
    has_more: boolean;
    next_cursor: string | null;
  };
  assert.ok(submissionPage.items.some((item) => item.id === seeded.submissionId));

  const one = await fastify.inject({
    method: "GET",
    url: `/api/v1/interactions/submissions/${seeded.submissionId}`,
    headers: { authorization: reader },
  });
  assert.equal(one.statusCode, 200);
  assert.equal((one.json() as { payload: { email: string } }).payload.email, "seed@example.com");

  const run = await fastify.inject({
    method: "GET",
    url: `/api/v1/interactions/quiz-runs/${seeded.runId}`,
    headers: { authorization: reader },
  });
  assert.equal(run.statusCode, 200);
  const runBody = run.json() as { state: string; answers: unknown[]; session_token_hash?: string };
  assert.equal(runBody.state, "COMPLETED");
  assert.equal(runBody.answers.length, 1);
  assert.ok(!("session_token_hash" in runBody), "token hash never leaves the domain");
});

test("lead reads need leads.read (interactions.read is not enough); status change emits LeadStatusChanged", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  const seeded = await seed(app, fastify);

  const interactionsOnly = await fastify.inject({
    method: "GET",
    url: "/api/v1/interactions/leads",
    headers: {
      authorization: `Bearer ${await bearerFor(app, ["interactions.read", "interactions.manage", "interactions.export"])}`,
    },
  });
  assert.equal(interactionsOnly.statusCode, 403, "PII boundary: interactions.* cannot read leads");

  const leadReader = `Bearer ${await bearerFor(app, ["leads.read", "leads.manage"])}`;
  const leads = await fastify.inject({
    method: "GET",
    url: "/api/v1/interactions/leads",
    headers: { authorization: leadReader },
  });
  assert.equal(leads.statusCode, 200);
  assert.ok(
    (leads.json() as { items: { id: string }[] }).items.some((item) => item.id === seeded.leadId),
  );

  const patched = await fastify.inject({
    method: "PATCH",
    url: `/api/v1/interactions/leads/${seeded.leadId}`,
    headers: { authorization: leadReader, "content-type": "application/json" },
    payload: { status: "VIEWED" },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const transition = patched.json() as { previous_status: string; status: string };
  assert.equal(transition.previous_status, "NEW");
  assert.equal(transition.status, "VIEWED");

  const outbox = await app.pool.query(
    `SELECT payload FROM publication_outbox WHERE event_type = 'LeadStatusChanged' AND aggregate_id = $1`,
    [seeded.leadId],
  );
  assert.equal(outbox.rowCount, 1);
  const payload = outbox.rows[0]!.payload as {
    lead_id: string;
    previous_status: string;
    status: string;
  };
  assert.equal(payload.previous_status, "NEW");
  assert.equal(payload.status, "VIEWED");
  assert.equal(payload.lead_id, seeded.leadId);
});

test("export is entity-scoped (leads need leads.export) and audited in the security-event stream", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  const seeded = await seed(app, fastify);

  const submissionsExport = await fastify.inject({
    method: "POST",
    url: "/api/v1/interactions/export",
    headers: {
      authorization: `Bearer ${await bearerFor(app, ["interactions.export"])}`,
      "content-type": "application/json",
    },
    payload: { entity: "submissions", format: "csv" },
  });
  assert.equal(submissionsExport.statusCode, 200);
  assert.match(String(submissionsExport.headers["content-type"]), /text\/csv/);
  assert.ok(submissionsExport.body.includes("seed@example.com"));
  assert.equal(submissionsExport.headers["x-pcms-export-rows"], "1");

  const leadsDenied = await fastify.inject({
    method: "POST",
    url: "/api/v1/interactions/export",
    headers: {
      authorization: `Bearer ${await bearerFor(app, ["interactions.export"])}`,
      "content-type": "application/json",
    },
    payload: { entity: "leads", format: "csv" },
  });
  assert.equal(leadsDenied.statusCode, 403, "leads export requires leads.export");

  const leadsExport = await fastify.inject({
    method: "POST",
    url: "/api/v1/interactions/export",
    headers: {
      authorization: `Bearer ${await bearerFor(app, ["interactions.export", "leads.export"])}`,
      "content-type": "application/json",
    },
    payload: { entity: "leads", format: "json" },
  });
  assert.equal(leadsExport.statusCode, 200);

  // Audit: security events recorded for each successful export.
  const audit = await app.pool.query<{ event_type: string; metadata: Record<string, unknown> }>(
    `SELECT event_type, metadata FROM auth_security_events WHERE event_type = 'INTERACTIONS_EXPORT' ORDER BY created_at`,
  );
  assert.ok(audit.rowCount !== null && audit.rowCount >= 2, "both successful exports audited");
  const entities = audit.rows.map((row) => row.metadata.entity);
  assert.deepEqual(entities.includes("leads"), true);
  assert.ok(
    !JSON.stringify(audit.rows).includes("seed@example.com"),
    "audit metadata carries no PII",
  );
  assert.ok(seeded.submissionId.length > 0);
});

test("MCP privileged tools honor scopes and surfaces lead lifecycle", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify } = await makeApp(t);
  const seeded = await seed(app, fastify);
  const operations = bindOperations(app);
  const leadAgent = apiContextOf(scopedActor(["leads.read", "leads.manage"]), "mcp");

  const listLeads = (await (
    await import("@pcms/mcp")
  )
    .findTool("cms_list_leads")!
    .run(leadAgent ? operations : operations, leadAgent, {})) as {
    items: { id: string }[];
  };
  assert.ok(listLeads.items.some((item) => item.id === seeded.leadId));

  const transition = (await (
    await import("@pcms/mcp")
  )
    .findTool("cms_update_lead_status")!
    .run(operations, leadAgent, {
      lead_id: seeded.leadId,
      status: "PROCESSED",
    })) as { status: string };
  assert.equal(transition.status, "PROCESSED");

  const submissionsAgent = apiContextOf(scopedActor(["interactions.read"]), "mcp");
  const runs = (await (
    await import("@pcms/mcp")
  )
    .findTool("cms_list_quiz_runs")!
    .run(operations, submissionsAgent, {})) as {
    items: { id: string }[];
  };
  assert.ok(runs.items.some((item) => item.id === seeded.runId));
});
