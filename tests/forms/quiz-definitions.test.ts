// PCMS-FORM-T004 — QuizDefinition service: stable identity, immutable
// versions, declarative branching/scoring/outcome documents (no arbitrary
// code), lead/retention settings validated against the step graph.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { createQuizDefinitionService, FormsError } from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const BRANCHING_QUIZ = {
  steps: [
    {
      id: "intro",
      title: "Пара вопросов",
      questions: [
        {
          id: "service_interest",
          type: "single_choice",
          label: "Что вас интересует?",
          required: true,
          options: [
            { value: "cleaning", label: "Уборка" },
            { value: "repair", label: "Ремонт" },
          ],
        },
        { id: "area", type: "number", label: "Площадь, м²", min: 1, max: 10_000 },
      ],
    },
    {
      id: "cleaning_details",
      questions: [
        {
          id: "rooms",
          type: "single_choice",
          label: "Комнат",
          required: true,
          options: [
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3p", label: "3+" },
          ],
        },
      ],
    },
    {
      id: "contact",
      questions: [{ id: "phone", type: "text", label: "Телефон", required: true, max_length: 32 }],
    },
  ],
  branching_rules: [
    {
      from_step: "intro",
      when: [{ question_id: "service_interest", operator: "eq", value: "cleaning" }],
      goto_step: "cleaning_details",
    },
    {
      from_step: "intro",
      when: [{ question_id: "service_interest", operator: "eq", value: "repair" }],
      goto_step: "contact",
    },
  ],
  scoring_rules: [
    { question_id: "area", operator: "gte", value: 100, points: 20 },
    { question_id: "rooms", operator: "eq", value: "3p", points: 10 },
  ],
  outcomes: [
    { id: "hot", title: "Горячая заявка", min_score: 20, lead_classification: "hot" },
    {
      id: "warm",
      title: "Тёплая заявка",
      min_score: 5,
      max_score: 19,
      lead_classification: "warm",
    },
    { id: "cold", title: "Холодная заявка", lead_classification: "cold" },
  ],
  settings: {
    lead_policy: { create_lead: true, summary_from_answer: "phone" },
    retention: { mode: "delete", after_days: 180 },
  },
};

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

test("createDefinition persists the full declarative document; identity is stable", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const quizzes = createQuizDefinitionService(pool);
  const created = await quizzes.createDefinition({
    key: "service_calc",
    title: "Подбор услуги",
    ...BRANCHING_QUIZ,
  });
  assert.equal(created.schema_version, 1);
  assert.equal(created.steps.length, 3);
  assert.equal(created.branching_rules.length, 2);
  assert.equal(created.scoring_rules.length, 2);
  assert.equal(created.outcomes.length, 3);
  assert.deepEqual(await quizzes.getDefinition(created.id), created);
  assert.equal((await quizzes.getDefinitionByKey("service_calc")).id, created.id);
});

test("addVersion appends immutable history; prior version reconstructable", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const quizzes = createQuizDefinitionService(pool);
  const v1 = await quizzes.createDefinition({
    key: "simple_quiz",
    title: "Простой квиз",
    steps: BRANCHING_QUIZ.steps,
  });
  const v2 = await quizzes.addVersion({
    quiz_definition_id: v1.id,
    ...BRANCHING_QUIZ,
    title: "Простой квиз v2",
  });
  assert.equal(v2.schema_version, 2);
  assert.equal(v2.branching_rules.length, 2);
  const historical = await quizzes.getVersion(v1.id, 1);
  assert.equal(historical.branching_rules.length, 0);
  assert.equal(historical.outcomes.length, 0);
});

test("declarative documents are validated against the step graph", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const quizzes = createQuizDefinitionService(pool);
  const cases: readonly { readonly input: object; readonly code: string }[] = [
    { input: { key: "q1", title: "Q", steps: [] }, code: "QUIZ_DEFINITION_INVALID" },
    {
      input: {
        key: "q1",
        title: "Q",
        steps: [{ id: "s", questions: [{ id: "x", type: "rating", label: "X" }] }],
      },
      code: "QUIZ_QUESTION_UNSUPPORTED",
    },
    {
      input: {
        key: "q1",
        title: "Q",
        steps: BRANCHING_QUIZ.steps,
        branching_rules: [
          {
            from_step: "intro",
            when: [{ question_id: "nonexistent", operator: "eq", value: "x" }],
            goto_step: "contact",
          },
        ],
      },
      code: "QUIZ_DEFINITION_INVALID",
    },
    {
      input: {
        key: "q1",
        title: "Q",
        steps: BRANCHING_QUIZ.steps,
        scoring_rules: [{ question_id: "area", operator: "regex_match", points: 5 }],
      },
      code: "QUIZ_DEFINITION_INVALID",
    },
    {
      input: {
        key: "q1",
        title: "Q",
        steps: BRANCHING_QUIZ.steps,
        outcomes: [
          { id: "hot", title: "A", min_score: 10 },
          { id: "hot", title: "B", min_score: 1 },
        ],
      },
      code: "QUIZ_DEFINITION_INVALID",
    },
    {
      input: {
        key: "q1",
        title: "Q",
        steps: BRANCHING_QUIZ.steps,
        settings: { lead_policy: { summary_from_answer: "ghost" } },
      },
      code: "QUIZ_DEFINITION_INVALID",
    },
    {
      input: {
        key: "q1",
        title: "Q",
        steps: BRANCHING_QUIZ.steps,
        branching_rules: [
          {
            from_step: "intro",
            when: [{ question_id: "area", operator: "eq", value: 1 }],
            goto_step: "ghost_step",
          },
        ],
      },
      code: "QUIZ_DEFINITION_INVALID",
    },
  ];
  for (const { input, code } of cases) {
    await assert.rejects(
      () => quizzes.createDefinition(input as never),
      (error: unknown) => error instanceof FormsError && error.code === code,
      JSON.stringify(input),
    );
  }
});

test("duplicate quiz key is QUIZ_KEY_TAKEN; archive lifecycle works", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const quizzes = createQuizDefinitionService(pool);
  const created = await quizzes.createDefinition({
    key: "dup_quiz",
    title: "Q",
    steps: BRANCHING_QUIZ.steps,
  });
  await assert.rejects(
    () => quizzes.createDefinition({ key: "dup_quiz", title: "Q2", steps: BRANCHING_QUIZ.steps }),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_KEY_TAKEN",
  );
  const archived = await quizzes.setArchived(created.id, true);
  assert.equal(archived.status, "ARCHIVED");
  const active = await quizzes.listDefinitions({ status: "ACTIVE" });
  assert.ok(!active.some((quiz) => quiz.id === created.id));
});
