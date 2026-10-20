// PCMS-FORM-T008 — QuizRun/QuizAnswer persistence: STARTED→COMPLETED lifecycle
// with guarded transitions, token-bound run lookup (no enumeration), answer
// upsert (last wins), and transactional atomicity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createQuizDefinitionService,
  createQuizRunService,
  FormsError,
  type QuizDefinition,
} from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function setup(t: {
  after: (fn: () => void) => void;
}): Promise<{ pool: DbPool; quiz: QuizDefinition }> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const quiz = await createQuizDefinitionService(pool).createDefinition({
    key: "runs_quiz",
    title: "Квиз",
    steps: [
      {
        id: "s1",
        questions: [
          {
            id: "q1",
            type: "single_choice",
            label: "Q1",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
        ],
      },
    ],
  });
  return { pool, quiz };
}

const expiresSoon = (): Date => new Date(Date.now() + 30 * 60_000);

test("insertRun creates a STARTED run; read model never exposes the token hash", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, quiz } = await setup(t);
  const runs = createQuizRunService(pool);
  const run = await runs.insertRun({
    quiz_definition_id: quiz.id,
    quiz_schema_version: quiz.schema_version,
    session_token_hash: sha256("resume-token-1"),
    session_expires_at: expiresSoon(),
  });
  assert.equal(run.state, "STARTED");
  assert.equal(run.score, null);
  assert.equal("session_token_hash" in run, false, "token hash stays internal");
  assert.deepEqual(await runs.getRun(run.id), run);
});

test("findRunByToken matches only the exact (id, token) pair — no enumeration", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, quiz } = await setup(t);
  const runs = createQuizRunService(pool);
  const run = await runs.insertRun({
    quiz_definition_id: quiz.id,
    quiz_schema_version: 1,
    session_token_hash: sha256("correct-token"),
    session_expires_at: expiresSoon(),
  });
  const other = await runs.insertRun({
    quiz_definition_id: quiz.id,
    quiz_schema_version: 1,
    session_token_hash: sha256("other-run-token"),
    session_expires_at: expiresSoon(),
  });
  assert.equal((await runs.findRunByToken(run.id, sha256("correct-token")))?.id, run.id);
  assert.equal(
    await runs.findRunByToken(run.id, sha256("wrong-token")),
    null,
    "wrong token → null",
  );
  assert.equal(
    await runs.findRunByToken(other.id, sha256("correct-token")),
    null,
    "cross-run token → null",
  );
});

test("answers upsert per question (last wins) and list in answer order", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, quiz } = await setup(t);
  const runs = createQuizRunService(pool);
  const run = await runs.insertRun({
    quiz_definition_id: quiz.id,
    quiz_schema_version: 1,
    session_token_hash: sha256("t"),
    session_expires_at: expiresSoon(),
  });
  await runs.upsertAnswer(run.id, "q1", "a");
  await runs.upsertAnswer(run.id, "q1", "b");
  const answers = await runs.listAnswers(run.id);
  assert.equal(answers.length, 1, "one row per question");
  assert.equal(answers[0]!.value, "b");
});

test("completeRun stores server-computed score/outcome and is guarded to STARTED", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, quiz } = await setup(t);
  const runs = createQuizRunService(pool);
  const run = await runs.insertRun({
    quiz_definition_id: quiz.id,
    quiz_schema_version: 1,
    session_token_hash: sha256("t2"),
    session_expires_at: expiresSoon(),
  });
  const completed = await runs.completeRun(run.id, { score: 42, outcome_id: "hot" });
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.score, 42);
  assert.equal(completed.outcome_id, "hot");
  assert.ok(completed.completed_at !== null);

  // Re-complete replays the same record (idempotent retry).
  const again = await runs.completeRun(run.id, { score: 1, outcome_id: "cold" });
  assert.equal(again.score, 42, "first completion is authoritative");

  // Fresh run marked EXPIRED cannot be completed afterwards.
  const expired = await runs.insertRun({
    quiz_definition_id: quiz.id,
    quiz_schema_version: 1,
    session_token_hash: sha256("t3"),
    session_expires_at: new Date(Date.now() - 1000),
  });
  await runs.markRun(expired.id, "EXPIRED");
  await assert.rejects(
    () => runs.completeRun(expired.id, { score: 0, outcome_id: null }),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_RUN_STATE_INVALID",
  );
});

test("attachLead binds exactly once; list filters by definition and state", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, quiz } = await setup(t);
  const runs = createQuizRunService(pool);
  const leadRun = await runs.insertRun({
    quiz_definition_id: quiz.id,
    quiz_schema_version: 1,
    session_token_hash: sha256("t4"),
    session_expires_at: expiresSoon(),
  });
  await runs.attachLead(leadRun.id, "01970000-0000-7000-8000-0000000000aa");
  await assert.rejects(
    () => runs.attachLead(leadRun.id, "01970000-0000-7000-8000-0000000000bb"),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_RUN_STATE_INVALID",
  );
  const started = await runs.listRuns({ quiz_definition_id: quiz.id, state: "STARTED" });
  assert.ok(started.some((run) => run.id === leadRun.id && run.lead_id !== null));
  const abandoned = await runs.listRuns({ state: "ABANDONED" });
  assert.equal(abandoned.length, 0);
});

test("transactional answer+complete roll back together", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, quiz } = await setup(t);
  const runs = createQuizRunService(pool);
  const run = await runs.insertRun({
    quiz_definition_id: quiz.id,
    quiz_schema_version: 1,
    session_token_hash: sha256("t5"),
    session_expires_at: expiresSoon(),
  });
  await assert.rejects(() =>
    pool.withTransaction(async (tx) => {
      await runs.upsertAnswer(run.id, "q1", "a", { executor: tx });
      await runs.completeRun(run.id, { score: 1, outcome_id: null }, { executor: tx });
      throw new Error("simulated outbox failure");
    }),
  );
  const fresh = await runs.getRun(run.id);
  assert.equal(fresh.state, "STARTED");
  assert.equal((await runs.listAnswers(run.id)).length, 0, "answers rolled back with the run");
});
