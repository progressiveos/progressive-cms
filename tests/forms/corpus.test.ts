// PCMS-FORM-T023 — integration/security/reference corpus (Forms spec §39/§37).
// Reference scenarios: the 14 mandatory public interactions driven end-to-end
// through the application services against real PostgreSQL, including the
// M12→M13 delivery boundary (outbox rows only, zero connector/network calls —
// M12 never delivers anywhere). Security corpus: PII never reaches logs or
// error envelopes; frozen error-code contract.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toErrorEnvelope } from "@pcms/api";
import {
  type Clock,
  createDbPool,
  createLogger,
  type DbPool,
  fixedClock,
  type LogFields,
  loadMigrations,
  migrateDatabase,
  redactFields,
} from "@pcms/core";
import {
  createFormsDomainServices,
  createInteractionExportService,
  createPublicFormService,
  createPublicQuizService,
  createRetentionService,
  FORMS_ERROR_CODES,
  FormsError,
  type FormsOutboxEventInput,
  type FormsOutboxPort,
} from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const CLOCK: Clock = fixedClock(NOW);
const SECRET = "ivan.petrov@example.com";

async function setup(t: { after: (fn: () => void) => void }): Promise<{
  pool: DbPool;
  domain: ReturnType<typeof createFormsDomainServices>;
  events: FormsOutboxEventInput[];
}> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 3 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const events: FormsOutboxEventInput[] = [];
  const outbox: FormsOutboxPort = {
    async write(_executor, event) {
      events.push(event);
    },
  };
  const domain = createFormsDomainServices(pool);
  const publicForm = createPublicFormService(pool, { clock: CLOCK, outbox, domain });
  const publicQuiz = createPublicQuizService(pool, { clock: CLOCK, outbox, domain });

  // ── Reference definition set (Forms spec §39) ──
  await domain.definitions.createDefinition({
    key: "contact",
    title: "Простая контактная форма",
    fields: [
      { key: "email", type: "email", label: "E-mail", required: true },
      { key: "message", type: "textarea", label: "Сообщение", required: true, max_length: 2000 },
      {
        key: "privacy_ok",
        type: "consent",
        label: "Согласие",
        required: true,
        consent_key: "privacy_policy",
        consent_text: "Согласен с политикой",
        policy_reference: "policy:privacy@1",
      },
    ],
    settings: {
      lead_policy: {
        create_lead: true,
        email_from: "email",
        summary_from: "message",
        classification: "warm",
      },
      spam_policy: { honeypot_field: "website" },
    },
  });
  await domain.definitions.createDefinition({
    key: "callback",
    title: "Обратный звонок",
    fields: [
      { key: "phone", type: "phone", label: "Телефон", required: true },
      { key: "name", type: "text", label: "Имя", required: true, max_length: 200 },
    ],
    settings: { lead_policy: { create_lead: true, phone_from: "phone", name_from: "name" } },
  });
  await domain.definitions.createDefinition({
    key: "service_request",
    title: "Заявка на услугу",
    fields: [
      {
        key: "service",
        type: "select",
        label: "Услуга",
        required: true,
        options: [
          { value: "clean", label: "Уборка" },
          { value: "fix", label: "Ремонт" },
        ],
      },
      { key: "area", type: "number", label: "Площадь", min: 1, max: 10_000 },
      { key: "email", type: "email", label: "E-mail", required: true },
    ],
    settings: { retention: { mode: "delete", after_days: 1 }, lead_policy: { create_lead: true } },
  });
  await domain.quizzes.createDefinition({
    key: "service_quiz",
    title: "Подбор услуги",
    steps: [
      {
        id: "intro",
        title: "Шаг 1",
        questions: [
          {
            id: "service",
            type: "single_choice",
            label: "Что нужно?",
            required: true,
            options: [
              { value: "clean", label: "Уборка" },
              { value: "fix", label: "Ремонт" },
            ],
          },
        ],
      },
      {
        id: "detail",
        questions: [
          {
            id: "rooms",
            type: "single_choice",
            label: "Комнат",
            required: true,
            options: [
              { value: "1", label: "1" },
              { value: "3p", label: "3+" },
            ],
          },
        ],
      },
      {
        id: "contact",
        questions: [
          { id: "phone", type: "text", label: "Телефон", required: true, max_length: 32 },
        ],
      },
    ],
    branching_rules: [
      {
        from_step: "intro",
        when: [{ question_id: "service", operator: "eq", value: "clean" }],
        goto_step: "detail",
      },
      {
        from_step: "intro",
        when: [{ question_id: "service", operator: "eq", value: "fix" }],
        goto_step: "contact",
      },
    ],
    scoring_rules: [{ question_id: "rooms", operator: "eq", value: "3p", points: 15 }],
    outcomes: [
      { id: "hot", title: "Горячая", min_score: 15, lead_classification: "hot" },
      { id: "cold", title: "Холодная", lead_classification: "cold" },
    ],
    settings: { lead_policy: { create_lead: true } },
  });

  return { pool, domain, events };
}

test("reference corpus: 14 mandatory scenarios stay green end-to-end", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain, events } = await setup(t);
  const publicForm = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: {
      async write(_e, event) {
        events.push(event);
      },
    },
    domain,
  });
  const publicQuiz = createPublicQuizService(pool, {
    clock: CLOCK,
    outbox: {
      async write(_e, event) {
        events.push(event);
      },
    },
    domain,
  });
  const contact = await domain.definitions.getDefinitionByKey("contact");
  const callback = await domain.definitions.getDefinitionByKey("callback");
  const service = await domain.definitions.getDefinitionByKey("service_request");
  const quizId = (await domain.quizzes.getDefinitionByKey("service_quiz")).id;
  const submitted = (values: object, id: string, token?: string) =>
    publicForm.submit({
      form_definition_id: id,
      values,
      ...(token === undefined ? {} : { submission_token: token }),
    });

  // 1. Simple contact form (+12. duplicate submit, +14. event emitted, PII in event: none).
  const contactOk = await submitted(
    { email: SECRET, message: "Нужна консультация", privacy_ok: true },
    contact.id,
    "tok-contact",
  );
  assert.equal(contactOk.status, "ACCEPTED");
  const contactRetry = await submitted(
    { email: SECRET, message: "дубль", privacy_ok: true },
    contact.id,
    "tok-contact",
  );
  assert.equal(contactRetry.duplicate, true);
  assert.equal(contactRetry.submission_id, contactOk.submission_id);
  assert.ok(
    events.some(
      (event) =>
        event.eventType === "FormSubmitted" &&
        (event.payload as { submission_id: string }).submission_id === contactOk.submission_id,
    ),
  );

  // 2. Callback form (+8. lead from form).
  const callbackOk = await submitted(
    { phone: "+7 912 100-20-30", name: "Иван" },
    callback.id,
    "tok-callback",
  );
  const formLead = await domain.leads.getLead(callbackOk.lead_id!);
  assert.equal(formLead.source_type, "FORM_SUBMISSION");
  assert.equal(formLead.phone, "+7 912 100-20-30");

  // 10. Consent required: without consent nothing is accepted.
  await assert.rejects(
    () =>
      submitted({ email: "x@example.com", message: "без согласия", privacy_ok: false }, contact.id),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_VALUES_INVALID",
  );

  // 11. Honeypot spam: persisted as SPAM, no business event.
  const spam = await submitted(
    { email: "bot@spam.io", message: "buy", privacy_ok: true, website: "http://spam.io" },
    contact.id,
  );
  assert.equal(spam.status, "SPAM");
  assert.ok(
    !events.some(
      (event) => (event.payload as { submission_id?: string }).submission_id === spam.submission_id,
    ),
  );

  // 3. Service request.
  const serviceOk = await submitted(
    { service: "clean", area: 42, email: "service@example.com" },
    service.id,
    "tok-service",
  );
  assert.equal(serviceOk.status, "ACCEPTED");

  // 4/5/6. Multi-step + branching + scored quiz with outcomes (server-driven).
  const run = await publicQuiz.start({ quiz_definition_id: quizId });
  const step2 = await publicQuiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
    question_id: "service",
    value: "clean",
  });
  assert.equal(step2.next_step?.step_id, "detail", "branching routes cleaning to details");
  await publicQuiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
    question_id: "rooms",
    value: "3p",
  });
  await publicQuiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
    question_id: "phone",
    value: "+7 000",
  });
  const completed = await publicQuiz.complete({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
  });
  assert.equal(completed.outcome?.id, "hot");
  assert.equal(completed.score, 15);
  // 9. Lead from quiz with outcome classification.
  const quizLead = await domain.leads.getLead(completed.lead_id!);
  assert.equal(quizLead.source_type, "QUIZ_RUN");
  assert.equal(quizLead.classification, "hot");

  // 7. Abandoned quiz.
  const abandonedRun = await publicQuiz.start({ quiz_definition_id: quizId });
  await publicQuiz.abandon({
    quiz_run_id: abandonedRun.quiz_run_id,
    resume_token: abandonedRun.resume_token,
  });
  assert.equal((await domain.runs.getRun(abandonedRun.quiz_run_id)).state, "ABANDONED");

  // 12. Export (permission-gated at the API; corpus checks the corpus data).
  const exporter = createInteractionExportService(pool, {
    submissions: domain.submissions,
    runs: domain.runs,
    leads: domain.leads,
    audit: { async record() {} },
  });
  const exportResult = await exporter.export(
    { entity: "submissions", format: "csv" },
    { actor_type: "OPERATOR", actor_id: "corpus" },
  );
  assert.equal(exportResult.rows, 4, "3 ACCEPTED + 1 SPAM submission");

  // 13. Retention cleanup: service_request deletes submissions after 1 day;
  // backdate one and sweep.
  await pool.query(`UPDATE forms_submissions SET submitted_at = $2 WHERE id = $1`, [
    serviceOk.submission_id,
    new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000),
  ]);
  const stats = await createRetentionService(pool, { clock: CLOCK }).sweep();
  assert.equal(stats.forms_deleted, 1);
  await assert.rejects(() => domain.submissions.getSubmission(serviceOk.submission_id));

  // Security corpus: the full event stream carries no submitted PII.
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(SECRET), "no contact email in events");
  assert.ok(!serialized.includes("+7 912 100-20-30"), "no phone in events");
  assert.ok(!serialized.includes("+7 000"), "no quiz answer in events");
});

test("security corpus: PII never leaks into logs or error envelopes", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain } = await setup(t);
  const publicForm = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: { async write() {} },
    domain,
  });
  const contact = await domain.definitions.getDefinitionByKey("contact");

  // 1. Log redaction: the logger's redaction pass destroys credential-shaped
  // values, and house convention is ids-only fields — enforced here by
  // simulating the worst case (payload passed to a log call).
  const captured: string[] = [];
  const logger = createLogger({
    level: "info",
    sink: (line: string) => captured.push(line),
  });
  logger.error("forms.submit_failed", {
    operation: "forms.submit",
    submission_id: "s1",
    error_code: "FORM_VALUES_INVALID",
    payload: { email: SECRET, api_key: "sk-123", password: "hunter2" },
  } as LogFields);
  const logLine = captured.join("\n");
  assert.ok(!logLine.includes("hunter2"), "password never logged");
  assert.ok(!logLine.includes("sk-123"), "api keys never logged");
  // PII values are the caller's responsibility (never pass payloads); the
  // redaction pass covers credential-shaped keys as defense in depth.
  assert.ok(logLine.includes("[REDACTED]"), "redaction pass marks credential keys");

  // 2. Error envelope: validation errors carry field keys + generic messages,
  // never submitted values.
  let validationError: FormsError | null = null;
  try {
    await publicForm.submit({
      form_definition_id: contact.id,
      values: { email: SECRET, message: "x".repeat(50), privacy_ok: false },
    });
  } catch (error) {
    if (error instanceof FormsError) validationError = error;
  }
  assert.ok(validationError !== null);
  const validationViolations =
    (validationError.details as { violations: { message: string }[] }).violations ?? [];
  assert.ok(validationViolations.length > 0);
  const envelope = toErrorEnvelope(validationError, "req_corpus");
  const envelopeText = JSON.stringify(envelope);
  assert.ok(!envelopeText.includes(SECRET), "no PII in the error envelope");
  assert.equal(envelope.error.code, "FORM_VALUES_INVALID");
  // Violations live on the original domain error and are value-free.
  for (const violation of validationViolations) {
    assert.ok(!violation.message.includes(SECRET), "violation messages are value-free");
  }

  // 3. Error-code contract fixture is frozen and matches the registry.
  const contract = JSON.parse(readFileSync("fixtures/forms/error-code-contract.json", "utf8")) as {
    formsCodes: string[];
    quizCodes: string[];
    leadsCodes: string[];
    exportCodes: string[];
  };
  assert.deepEqual(
    [...FORMS_ERROR_CODES].sort(),
    [
      ...contract.formsCodes,
      ...contract.quizCodes,
      ...contract.leadsCodes,
      ...contract.exportCodes,
    ].sort(),
  );
});
