// PCMS-FORM-T017 — retention/anonymize/delete (Forms spec §30/§31): real PII
// destruction with preserved technical metadata, provenance-lead cleanup,
// explicit indefinite retention, and expired STARTED runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Clock, type DbPool, fixedClock } from "@pcms/core";
import {
  createFormsDomainServices,
  createPublicFormService,
  createPublicQuizService,
  createRetentionService,
  type FormsOutboxPort,
} from "@pcms/forms";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const CLOCK: Clock = fixedClock(NOW);
const noopOutbox: FormsOutboxPort = { async write() {} };

interface Fixture {
  readonly pool: DbPool;
  readonly domain: ReturnType<typeof createFormsDomainServices>;
  readonly formId: Promise<string>;
  readonly quizId: Promise<string>;
}

async function setup(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
  const { pool } = await rollbackApiFixture(t, {});
  const domain = createFormsDomainServices(pool);
  const fields = [
    { key: "email", type: "email", label: "E", required: true },
    { key: "message", type: "text", label: "M", required: true },
  ];
  const formId = domain.definitions
    .createDefinition({
      key: "retention_form",
      title: "Форма с retention",
      fields,
      settings: {
        lead_policy: { create_lead: true, email_from: "email", summary_from: "message" },
        retention: { mode: "anonymize", after_days: 30 },
      },
    })
    .then((d) => d.id);
  await formId;
  const quizId = domain.quizzes
    .createDefinition({
      key: "retention_quiz",
      title: "Квиз с retention",
      steps: [{ id: "s1", questions: [{ id: "q1", type: "text", label: "Q", required: true }] }],
      settings: { retention: { mode: "delete", after_days: 7 } },
    })
    .then((d) => d.id);
  await quizId;
  return { pool, domain, formId, quizId };
}

test("anonymize mode destroys payload/consent/ip/ua but keeps technical metadata; lead PII cleared", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const forms = createPublicFormService(fixture.pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain: fixture.domain,
  });
  const formId = await fixture.formId;
  const old = await forms.submit({
    form_definition_id: formId,
    values: { email: "old@example.com", message: "старое сообщение" },
    attribution: { utm_source: "vk", landing_path: "/old/" },
    submission_token: "tok-old",
    submitter: { ip: "203.0.113.9", user_agent: "OldAgent/1.0" },
  });
  // Backdate the old submission beyond the retention window.
  await fixture.pool.query(`UPDATE forms_submissions SET submitted_at = $2 WHERE id = $1`, [
    old.submission_id,
    new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000),
  ]);
  const fresh = await forms.submit({
    form_definition_id: formId,
    values: { email: "new@example.com", message: "свежее" },
  });

  const stats = await createRetentionService(fixture.pool, { clock: CLOCK }).sweep();
  assert.equal(stats.forms_anonymized, 1);

  const anonymized = await fixture.domain.submissions.getSubmission(old.submission_id);
  assert.deepEqual(anonymized.payload, {}, "PII payload destroyed");
  assert.deepEqual(anonymized.consent_snapshot, []);
  assert.ok(anonymized.anonymized_at !== null);
  assert.equal(anonymized.status, "ACCEPTED", "technical/audit metadata preserved");
  assert.ok(anonymized.submitted_at < NOW.toISOString());
  assert.equal(anonymized.attribution, null, "source attribution is cleared too");

  const kept = await fixture.domain.submissions.getSubmission(fresh.submission_id);
  assert.deepEqual(
    kept.payload,
    { email: "new@example.com", message: "свежее" },
    "fresh data untouched",
  );

  const lead = await fixture.domain.leads.getLead(old.lead_id!);
  assert.equal(lead.email, null);
  assert.equal(lead.summary, "", "lead summary (from payload) cleared");
  assert.equal(lead.status, "NEW", "business metadata stays");
  assert.equal(lead.attribution, null);
});

test("quiz anonymize mode clears its frozen attribution snapshot", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const quizDefinition = await fixture.domain.quizzes.createDefinition({
    key: "anonymize_attribution_quiz",
    title: "Quiz with retained attribution",
    steps: [{ id: "s1", questions: [{ id: "q1", type: "text", label: "Q", required: true }] }],
    settings: { retention: { mode: "anonymize", after_days: 30 } },
  });
  const quiz = createPublicQuizService(fixture.pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain: fixture.domain,
  });
  const started = await quiz.start({
    quiz_definition_id: quizDefinition.id,
    attribution: { utm_source: "vk", landing_path: "/quiz/" },
  });
  await fixture.pool.query(`UPDATE forms_quiz_runs SET started_at = $2 WHERE id = $1`, [
    started.quiz_run_id,
    new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000),
  ]);

  const stats = await createRetentionService(fixture.pool, { clock: CLOCK }).sweep();
  assert.equal(stats.quiz_runs_anonymized, 1);
  const run = await fixture.domain.runs.getRun(started.quiz_run_id);
  assert.equal(run.attribution, null);
  assert.ok(run.anonymized_at !== null);
});

test("delete mode removes quiz runs, answers and their provenance leads entirely", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const quizId = await fixture.quizId;
  const quiz = createPublicQuizService(fixture.pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain: fixture.domain,
  });
  const quizSettings = fixture.domain.quizzes;
  await quizSettings.addVersion({
    quiz_definition_id: quizId,
    steps: [{ id: "s1", questions: [{ id: "q1", type: "text", label: "Q", required: true }] }],
    settings: { lead_policy: { create_lead: true }, retention: { mode: "delete", after_days: 7 } },
  });
  const started = await quiz.start({ quiz_definition_id: quizId });
  await quiz.answer({
    quiz_run_id: started.quiz_run_id,
    resume_token: started.resume_token,
    question_id: "q1",
    value: "мой ответ",
  });
  const completed = await quiz.complete({
    quiz_run_id: started.quiz_run_id,
    resume_token: started.resume_token,
  });
  assert.ok(completed.lead_id !== null);
  await fixture.pool.query(`UPDATE forms_quiz_runs SET started_at = $2 WHERE id = $1`, [
    started.quiz_run_id,
    new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
  ]);

  const stats = await createRetentionService(fixture.pool, { clock: CLOCK }).sweep();
  assert.equal(stats.quiz_runs_deleted, 1);
  assert.equal(stats.leads_deleted, 1);
  await assert.rejects(() => fixture.domain.runs.getRun(started.quiz_run_id));
  await assert.rejects(() => fixture.domain.leads.getLead(completed.lead_id!));
  const answers = await fixture.domain.runs.listAnswers(started.quiz_run_id).catch(() => []);
  assert.equal(answers.length, 0, "answers cascaded away with the run");
});

test("explicit retain mode keeps data forever; sweep marks expired STARTED runs", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const forms = createPublicFormService(fixture.pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain: fixture.domain,
  });
  const formId = await fixture.formId;
  // A definition without retention policy = explicit retain (default).
  const retainedDef = await fixture.domain.definitions.createDefinition({
    key: "forever_form",
    title: "Храним всегда",
    fields: [{ key: "email", type: "email", label: "E", required: true }],
  });
  const kept = await forms.submit({
    form_definition_id: retainedDef.id,
    values: { email: "keep@example.com" },
  });
  await fixture.pool.query(`UPDATE forms_submissions SET submitted_at = $2 WHERE id = $1`, [
    kept.submission_id,
    new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000),
  ]);

  const quiz = createPublicQuizService(fixture.pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain: fixture.domain,
  });
  const staleRun = await quiz.start({ quiz_definition_id: await fixture.quizId });
  await fixture.pool.query(`UPDATE forms_quiz_runs SET session_expires_at = $2 WHERE id = $1`, [
    staleRun.quiz_run_id,
    new Date(NOW.getTime() - 1000),
  ]);

  const stats = await createRetentionService(fixture.pool, { clock: CLOCK }).sweep();
  assert.equal(stats.forms_deleted + stats.forms_anonymized, 0, "retained definition untouched");
  assert.equal(stats.quiz_runs_expired, 1);
  assert.equal((await fixture.domain.runs.getRun(staleRun.quiz_run_id)).state, "EXPIRED");
  const stillThere = await fixture.domain.submissions.getSubmission(kept.submission_id);
  assert.equal(stillThere.payload.email, "keep@example.com");
});

for (const mode of ["anonymize", "delete", "retain"] as const) {
  test(`archived form and quiz preserve ${mode} retention policy`, async (t) => {
    if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
    const fixture = await setup(t);
    const formId = await fixture.formId;
    const quizId = await fixture.quizId;
    await fixture.domain.definitions.addVersion({
      form_definition_id: formId,
      fields: [{ key: "email", type: "email", label: "Email", required: true }],
      settings: {
        retention: { mode, after_days: 7 },
        lead_policy: { create_lead: true, email_from: "email" },
      },
    });
    await fixture.domain.quizzes.addVersion({
      quiz_definition_id: quizId,
      steps: [{ id: "s1", questions: [{ id: "q1", type: "text", label: "Q", required: true }] }],
      settings: { retention: { mode, after_days: 7 }, lead_policy: { create_lead: true } },
    });
    const forms = createPublicFormService(fixture.pool, {
      clock: CLOCK,
      outbox: noopOutbox,
      domain: fixture.domain,
    });
    const quiz = createPublicQuizService(fixture.pool, {
      clock: CLOCK,
      outbox: noopOutbox,
      domain: fixture.domain,
    });
    const submission = await forms.submit({
      form_definition_id: formId,
      values: { email: "archived@example.com" },
    });
    const started = await quiz.start({ quiz_definition_id: quizId });
    await quiz.answer({
      quiz_run_id: started.quiz_run_id,
      resume_token: started.resume_token,
      question_id: "q1",
      value: "retained answer",
    });
    const completed = await quiz.complete({
      quiz_run_id: started.quiz_run_id,
      resume_token: started.resume_token,
    });
    const submissionLeadId = submission.lead_id;
    const quizLeadId = completed.lead_id;
    assert.ok(submissionLeadId);
    assert.ok(quizLeadId);
    const oldDate = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    await fixture.pool.query("UPDATE forms_submissions SET submitted_at = $2 WHERE id = $1", [
      submission.submission_id,
      oldDate,
    ]);
    await fixture.pool.query("UPDATE forms_quiz_runs SET started_at = $2 WHERE id = $1", [
      started.quiz_run_id,
      oldDate,
    ]);
    await fixture.domain.definitions.setArchived(formId, true);
    await fixture.domain.quizzes.setArchived(quizId, true);

    const retention = createRetentionService(fixture.pool, { clock: CLOCK });
    const stats = await retention.sweep();
    assert.equal(stats.forms_anonymized, mode === "anonymize" ? 1 : 0);
    assert.equal(stats.quiz_runs_anonymized, mode === "anonymize" ? 1 : 0);
    assert.equal(stats.forms_deleted, mode === "delete" ? 1 : 0);
    assert.equal(stats.quiz_runs_deleted, mode === "delete" ? 1 : 0);
    assert.equal(stats.leads_deleted, mode === "delete" ? 2 : 0);
    if (mode === "delete") {
      await assert.rejects(() =>
        fixture.domain.submissions.getSubmission(submission.submission_id),
      );
      await assert.rejects(() => fixture.domain.runs.getRun(started.quiz_run_id));
      await assert.rejects(() => fixture.domain.leads.getLead(submissionLeadId));
      await assert.rejects(() => fixture.domain.leads.getLead(quizLeadId));
    } else {
      const form = await fixture.domain.submissions.getSubmission(submission.submission_id);
      const run = await fixture.domain.runs.getRun(started.quiz_run_id);
      const answers = await fixture.domain.runs.listAnswers(started.quiz_run_id);
      const lead = await fixture.domain.leads.getLead(submissionLeadId);
      assert.deepEqual(form.payload, mode === "anonymize" ? {} : { email: "archived@example.com" });
      assert.equal(run.anonymized_at !== null, mode === "anonymize");
      assert.equal(answers.length, mode === "anonymize" ? 0 : 1);
      assert.equal(lead.email, mode === "anonymize" ? null : "archived@example.com");
      assert.equal(stats.leads_anonymized, mode === "anonymize" ? 2 : 0);
    }
    assert.deepEqual(await retention.sweep(), {
      forms_anonymized: 0,
      forms_deleted: 0,
      quiz_runs_anonymized: 0,
      quiz_runs_deleted: 0,
      leads_anonymized: 0,
      leads_deleted: 0,
      quiz_runs_expired: 0,
    });
  });
}
