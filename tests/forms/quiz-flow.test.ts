// PCMS-FORM-T012 — public quiz run services (Forms spec §11–§17): server-
// driven multi-step flow, declarative branching, authoritative scoring with
// outcomes, lead from quiz, abandoned runs, score tampering and resume-token
// abuse attempts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Clock,
  createDbPool,
  type DbPool,
  fixedClock,
  loadMigrations,
  migrateDatabase,
} from "@pcms/core";
import {
  createFormsDomainServices,
  createPublicQuizService,
  FormsError,
  type FormsOutboxEventInput,
  type FormsOutboxPort,
  type QuizPublicService,
} from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CLOCK: Clock = fixedClock(new Date("2026-09-20T12:00:00.000Z"));

interface Fixture {
  readonly pool: DbPool;
  readonly events: readonly FormsOutboxEventInput[];
  readonly quiz: QuizPublicService;
  readonly domain: ReturnType<typeof createFormsDomainServices>;
  readonly branchingQuizId: Promise<string>;
}

async function setup(t: { after: (fn: () => void) => void }): Promise<Fixture> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
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
  const quiz = createPublicQuizService(pool, { clock: CLOCK, outbox, domain });
  const branchingQuizId = domain.quizzes
    .createDefinition({
      key: "service_calc",
      title: "Подбор услуги",
      steps: [
        {
          id: "intro",
          title: "Начало",
          questions: [
            {
              id: "service",
              type: "single_choice",
              label: "Что нужно?",
              required: true,
              options: [
                { value: "cleaning", label: "Уборка" },
                { value: "repair", label: "Ремонт" },
              ],
            },
          ],
        },
        {
          id: "cleaning",
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
            { id: "area", type: "number", label: "Площадь", min: 1, max: 10_000 },
          ],
        },
      ],
      branching_rules: [
        {
          from_step: "intro",
          when: [{ question_id: "service", operator: "eq", value: "cleaning" }],
          goto_step: "cleaning",
        },
        {
          from_step: "intro",
          when: [{ question_id: "service", operator: "eq", value: "repair" }],
          goto_step: "contact",
        },
      ],
      scoring_rules: [
        { question_id: "area", operator: "gte", value: 100, points: 20 },
        { question_id: "rooms", operator: "eq", value: "3p", points: 10 },
      ],
      outcomes: [
        {
          id: "hot",
          title: "Горячая заявка",
          description: "Перезвоним в течение часа",
          min_score: 20,
          lead_classification: "hot",
        },
        {
          id: "warm",
          title: "Тёплая заявка",
          min_score: 1,
          max_score: 19,
          lead_classification: "warm",
        },
        { id: "cold", title: "Холодная заявка", lead_classification: "cold" },
      ],
      settings: { lead_policy: { create_lead: true, summary_from_answer: "phone" } },
    })
    .then((definition) => definition.id);
  return { pool, events, quiz, domain, branchingQuizId };
}

test("multi-step quiz: server drives steps; answers persist; branching skips the cleaning step for repair", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const started = await fixture.quiz.start({ quiz_definition_id: await fixture.branchingQuizId });
  assert.equal(started.step.step_id, "intro");
  assert.equal(started.step.questions[0]!.id, "service");
  assert.ok(started.resume_token.length >= 40, "high-entropy opaque token");
  assert.match(
    started.resume_token,
    /^[A-Za-z0-9_-]{40,}$/,
    "base64url: opaque, no encoded identity",
  );

  const afterIntro = await fixture.quiz.answer({
    quiz_run_id: started.quiz_run_id,
    resume_token: started.resume_token,
    question_id: "service",
    value: "repair",
  });
  assert.equal(afterIntro.next_step?.step_id, "contact", "branching jumps over the cleaning step");

  const afterPhone = await fixture.quiz.answer({
    quiz_run_id: started.quiz_run_id,
    resume_token: started.resume_token,
    question_id: "phone",
    value: "+7 912 000-11-22",
  });
  assert.equal(afterPhone.next_step, null, "no more steps — client may complete");

  const completed = await fixture.quiz.complete({
    quiz_run_id: started.quiz_run_id,
    resume_token: started.resume_token,
  });
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.outcome?.id, "cold", "area unanswered → 0 points → cold");
  assert.ok(completed.lead_id !== null, "lead created per policy");

  const completedEvent = fixture.events.find((event) => event.eventType === "QuizCompleted");
  assert.ok(completedEvent);
  assert.deepEqual(
    completedEvent.payload,
    {
      quiz_run_id: started.quiz_run_id,
      quiz_definition_id: await fixture.branchingQuizId,
      quiz_schema_version: 1,
      outcome_id: "cold",
      score: 0,
    },
    "routing-safe payload; no answers, no phone number",
  );
  const lead = await fixture.domain.leads.getLead(completed.lead_id!);
  assert.equal(lead.phone, null, "quiz lead carries no copied PII unless policy maps it");
  assert.equal(lead.classification, "cold");
});

test("scored quiz with outcomes: score is computed server-side, hot outcome + lead classification", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const quizId = await fixture.branchingQuizId;
  const run = await fixture.quiz.start({ quiz_definition_id: quizId });
  const token = run.resume_token;
  await fixture.quiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: token,
    question_id: "service",
    value: "cleaning",
  });
  await fixture.quiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: token,
    question_id: "rooms",
    value: "3p",
  });
  await fixture.quiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: token,
    question_id: "phone",
    value: "+7 000",
  });
  await fixture.quiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: token,
    question_id: "area",
    value: 150,
  });
  const completed = await fixture.quiz.complete({
    quiz_run_id: run.quiz_run_id,
    resume_token: token,
  });
  assert.equal(completed.score, 30);
  assert.equal(completed.outcome?.id, "hot");
  const lead = await fixture.domain.leads.getLead(completed.lead_id!);
  assert.equal(lead.classification, "hot", "outcome lead_classification wins");
  assert.equal(lead.source_type, "QUIZ_RUN");
});

test("client-supplied score/outcome can never enter the computation (tamper protection)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const quizId = await fixture.branchingQuizId;
  const run = await fixture.quiz.start({ quiz_definition_id: quizId });
  // The API surface has no parameters for score/outcome — an attempted
  // tamper payload is just an unknown question to the server.
  await assert.rejects(
    () =>
      fixture.quiz.answer({
        quiz_run_id: run.quiz_run_id,
        resume_token: run.resume_token,
        question_id: "score",
        value: 9999,
      }),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_ANSWER_INVALID",
  );
  await assert.rejects(
    () =>
      fixture.quiz.answer({
        quiz_run_id: run.quiz_run_id,
        resume_token: run.resume_token,
        question_id: "rooms",
        value: "not-an-option",
      }),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_ANSWER_INVALID",
  );
});

test("resume token abuse: wrong token, cross-run token and unknown id all fail closed", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const quizId = await fixture.branchingQuizId;
  const runA = await fixture.quiz.start({ quiz_definition_id: quizId });
  const runB = await fixture.quiz.start({ quiz_definition_id: quizId });
  const wrongToken = { quiz_run_id: runA.quiz_run_id, resume_token: runB.resume_token };
  await assert.rejects(
    () => fixture.quiz.answer({ ...wrongToken, question_id: "service", value: "cleaning" }),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_RUN_NOT_FOUND",
  );
  await assert.rejects(
    () => fixture.quiz.complete({ quiz_run_id: runA.quiz_run_id, resume_token: "totally-made-up" }),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_RUN_NOT_FOUND",
  );
  // Run A still intact and owned by its own token.
  const ok = await fixture.quiz.answer({
    quiz_run_id: runA.quiz_run_id,
    resume_token: runA.resume_token,
    question_id: "service",
    value: "cleaning",
  });
  assert.equal(ok.next_step?.step_id, "cleaning");
});

test("abandoned quiz: explicit exit marks ABANDONED without events; completed run cannot be abandoned", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const quizId = await fixture.branchingQuizId;
  const run = await fixture.quiz.start({ quiz_definition_id: quizId });
  const abandoned = await fixture.quiz.abandon({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
  });
  assert.equal(abandoned.state, "ABANDONED");
  assert.equal(fixture.events.filter((event) => event.eventType === "QuizCompleted").length, 0);
  await assert.rejects(
    () => fixture.quiz.complete({ quiz_run_id: run.quiz_run_id, resume_token: run.resume_token }),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_RUN_STATE_INVALID",
  );
  assert.equal((await fixture.domain.runs.listRuns({ state: "ABANDONED" })).length, 1);
});

test("complete is idempotent: retry replays the stored outcome without new events or leads", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const quizId = await fixture.branchingQuizId;
  const run = await fixture.quiz.start({ quiz_definition_id: quizId });
  for (const [question, value] of [
    ["service", "repair"],
    ["phone", "+7 111"],
  ] as const) {
    await fixture.quiz.answer({
      quiz_run_id: run.quiz_run_id,
      resume_token: run.resume_token,
      question_id: question,
      value,
    });
  }
  const first = await fixture.quiz.complete({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
  });
  const retry = await fixture.quiz.complete({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
  });
  assert.deepEqual(retry, first);
  const completions = fixture.events.filter((event) => event.eventType === "QuizCompleted").length;
  assert.equal(completions, 1);
  const leads = await fixture.domain.leads.listLeads({});
  assert.equal(leads.length, 1);
});

test("required questions on visited steps gate completion", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const quizId = await fixture.branchingQuizId;
  const run = await fixture.quiz.start({ quiz_definition_id: quizId });
  await fixture.quiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
    question_id: "service",
    value: "repair",
  });
  await assert.rejects(
    () => fixture.quiz.complete({ quiz_run_id: run.quiz_run_id, resume_token: run.resume_token }),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_ANSWER_INVALID",
  );
  assert.equal(fixture.events.length, 0, "no event for incomplete runs");
});

test("public schema exposes steps/questions only — no branching, scoring or outcome internals", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const schema = await fixture.quiz.getPublicSchema(await fixture.branchingQuizId);
  assert.equal(schema.quiz_schema_version, 1);
  assert.equal(schema.steps.length, 3);
  const serialized = JSON.stringify(schema);
  assert.ok(!serialized.includes("goto_step"));
  assert.ok(!serialized.includes("points"));
  assert.ok(!serialized.includes("min_score"));
  assert.ok(!serialized.includes("branching"));
});
