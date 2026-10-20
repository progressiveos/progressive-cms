// PCMS → Progressive HQ, Phase 2 (owner refinement §4): quiz contact
// mapping + consent gate. Rules proven here:
//   - name/email/phone come ONLY from explicitly mapped questions
//     (definition-time validation: existing question ids, text/boolean types);
//   - with consent_from configured, a not-true consent means NO lead row and
//     NO LeadCreated event — the quiz result stays in PCMS, HQ never sees a
//     silent anonymous intake from a declined consent;
//   - consent true → lead carries the mapped contact fields;
//   - no consent configured → lead with mapped contacts (back-compat).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { createFormsDomainServices, createPublicQuizService, FormsError } from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const NOW = new Date("2026-09-26T12:00:00.000Z");

interface Fixture {
  readonly pool: DbPool;
  readonly domain: ReturnType<typeof createFormsDomainServices>;
  readonly quiz: ReturnType<typeof createPublicQuizService>;
}

async function setupAsync(
  t: { after: (fn: () => void) => void },
  leadPolicy: Record<string, unknown>,
): Promise<{ fixture: Fixture; quizId: Promise<string> }> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const domain = createFormsDomainServices(pool);
  const quiz = createPublicQuizService(pool, {
    clock: { now: () => NOW },
    outbox: { async write() {} },
    domain,
  });
  const quizId = domain.quizzes
    .createDefinition({
      key: `hq_quiz_${Math.random().toString(36).slice(2, 8)}`,
      title: "Квиз с контактами",
      steps: [
        {
          id: "s1",
          questions: [
            { id: "area", type: "number", label: "Площадь", required: true },
            { id: "name", type: "text", label: "Имя", required: false },
            { id: "email", type: "text", label: "Email", required: false },
            { id: "phone", type: "text", label: "Телефон", required: false },
            { id: "consent", type: "boolean", label: "Согласие", required: false },
          ],
        },
      ],
      outcomes: [{ id: "done", title: "Готово" }],
      settings: { lead_policy: leadPolicy },
    } as Parameters<typeof domain.quizzes.createDefinition>[0])
    .then((d) => d.id);
  return { fixture: { pool, domain, quiz }, quizId };
}

async function runThrough(
  fixture: Fixture,
  quizId: string,
  answers: Record<string, unknown>,
): Promise<{ lead_id: string | null }> {
  const started = await fixture.quiz.start({ quiz_definition_id: quizId });
  for (const [question_id, value] of Object.entries(answers)) {
    await fixture.quiz.answer({
      quiz_run_id: started.quiz_run_id,
      resume_token: started.resume_token,
      question_id,
      value,
    });
  }
  return fixture.quiz.complete({
    quiz_run_id: started.quiz_run_id,
    resume_token: started.resume_token,
  });
}

test("consent denied → no lead, no LeadCreated event; quiz result still saved", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fixture, quizId } = await setupAsync(t, {
    create_lead: true,
    name_from: "name",
    email_from: "email",
    phone_from: "phone",
    consent_from: "consent",
    classification: "hq-pilot",
  });
  const completed = await runThrough(fixture, await quizId, {
    area: 50,
    name: "Иван Петров",
    email: "ivan@example.com",
    phone: "+7 912 000-00-00",
    consent: false,
  });
  assert.equal(completed.lead_id, null, "declined consent: no lead row at all");
  const leads = await fixture.domain.leads.listLeads({});
  assert.equal(leads.length, 0, "and no lead silently created");
});

test("consent given → lead carries exactly the mapped contact fields", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fixture, quizId } = await setupAsync(t, {
    create_lead: true,
    name_from: "name",
    email_from: "email",
    phone_from: "phone",
    consent_from: "consent",
  });
  const completed = await runThrough(fixture, await quizId, {
    area: 50,
    name: "Мария Смирнова",
    email: "maria@example.com",
    phone: "+7 921 555-66-77",
    consent: true,
  });
  assert.ok(completed.lead_id, "lead created on consent");
  const lead = await fixture.domain.leads.getLead(completed.lead_id!);
  assert.equal(lead.name, "Мария Смирнова");
  assert.equal(lead.email, "maria@example.com");
  assert.equal(lead.phone, "+7 921 555-66-77");
  // HQ initial_message is the WHOLE run (labels + answers + outcome), not
  // just contacts — every question of every step rides the presentation.
  assert.match(lead.presentation, /Quiz "Квиз с контактами" — outcome: Готово/);
  assert.match(lead.presentation, /Площадь: 50/);
  assert.match(lead.presentation, /Имя: Мария Смирнова/);
  assert.match(lead.presentation, /Email: maria@example\.com/);
  assert.match(lead.presentation, /Телефон: \+7 921 555-66-77/);
  assert.match(lead.presentation, /Согласие: yes/);
});

test("no consent question configured → mapped contacts copied (back-compat)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fixture, quizId } = await setupAsync(t, {
    create_lead: true,
    name_from: "name",
    email_from: "email",
  });
  const completed = await runThrough(fixture, await quizId, {
    area: 50,
    name: "Пётр Иванов",
    email: "petr@example.com",
  });
  assert.ok(completed.lead_id);
  const lead = await fixture.domain.leads.getLead(completed.lead_id!);
  assert.equal(lead.name, "Пётр Иванов");
  assert.equal(lead.email, "petr@example.com");
});

test("definition validation: contact mapping must reference questions of the right type", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const domain = createFormsDomainServices(pool);
  const base = {
    key: `hq_quiz_bad_${Math.random().toString(36).slice(2, 8)}`,
    title: "Квиз с неверным маппингом",
    steps: [
      {
        id: "s1",
        questions: [
          { id: "area", type: "number", label: "Площадь", required: true },
          { id: "email", type: "text", label: "Email", required: false },
          { id: "consent", type: "boolean", label: "Согласие", required: false },
        ],
      },
    ],
  } as Parameters<typeof domain.quizzes.createDefinition>[0];
  await assert.rejects(
    domain.quizzes.createDefinition({
      ...base,
      settings: { lead_policy: { create_lead: true, email_from: "area" } },
    }),
    (error: unknown) =>
      error instanceof FormsError &&
      error.code === "QUIZ_DEFINITION_INVALID" &&
      /must reference a text question/.test(error.message),
  );
  await assert.rejects(
    domain.quizzes.createDefinition({
      ...base,
      settings: { lead_policy: { create_lead: true, consent_from: "email" } },
    }),
    (error: unknown) =>
      error instanceof FormsError &&
      error.code === "QUIZ_DEFINITION_INVALID" &&
      /must reference a boolean question/.test(error.message),
  );
  await assert.rejects(
    domain.quizzes.createDefinition({
      ...base,
      settings: { lead_policy: { create_lead: true, email_from: "missing" } },
    }),
    (error: unknown) =>
      error instanceof FormsError &&
      error.code === "QUIZ_DEFINITION_INVALID" &&
      /references unknown question/.test(error.message),
  );
});

test("attribution: quiz start freezes the snapshot onto the run and the lead", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fixture, quizId } = await setupAsync(t, {
    create_lead: true,
    name_from: "name",
    consent_from: "consent",
    classification: "spangar-lead",
  });
  const id = await quizId;
  const started = await fixture.quiz.start({
    quiz_definition_id: id,
    attribution: {
      utm_source: "vk",
      utm_medium: "cpc",
      landing_path: "/kviz/",
      referrer_host: "t.me",
      utm_email: "ignored@example.com",
    },
  });
  for (const [question_id, value] of [
    ["area", 50],
    ["name", "Мария Смирнова"],
    ["consent", true],
  ] as const) {
    await fixture.quiz.answer({
      quiz_run_id: started.quiz_run_id,
      resume_token: started.resume_token,
      question_id,
      value,
    });
  }
  const completed = await fixture.quiz.complete({
    quiz_run_id: started.quiz_run_id,
    resume_token: started.resume_token,
  });
  assert.ok(completed.lead_id, "consent given → lead created");
  const lead = await fixture.domain.leads.getLead(completed.lead_id!);
  assert.equal(lead.attribution?.interaction_kind, "quiz");
  assert.equal(lead.attribution?.form_key, id, "quiz definition id, not the run id");
  assert.equal(lead.attribution?.utm_source, "vk");
  assert.equal(lead.attribution?.utm_medium, "cpc");
  assert.equal(lead.attribution?.landing_path, "/kviz/");
  assert.equal(lead.attribution?.referrer_host, "t.me");
  assert.ok(!JSON.stringify(lead.attribution).includes("ignored@example.com"));
});
