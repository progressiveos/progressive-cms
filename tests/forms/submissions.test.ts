// PCMS-FORM-T007 — FormSubmission persistence: historical payload pinned to
// the accepted definition version, duplicate-token protection, keyset lists,
// status lifecycle, and transactional insert (rollback discards everything).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createFormDefinitionService,
  createFormSubmissionService,
  type FormDefinition,
  FormsError,
} from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function setup(t: {
  after: (fn: () => void) => void;
}): Promise<{ pool: DbPool; definition: FormDefinition }> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const definition = await createFormDefinitionService(pool).createDefinition({
    key: "contact",
    title: "Контакты",
    fields: [{ key: "email", type: "email", label: "E-mail", required: true }],
  });
  return { pool, definition };
}

test("insert + get: historical record pins definition id and schema version", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, definition } = await setup(t);
  const submissions = createFormSubmissionService(pool);
  const { submission } = await submissions.insertSubmission({
    form_definition_id: definition.id,
    form_schema_version: definition.schema_version,
    status: "ACCEPTED",
    payload: { email: "user@example.com" },
    consent_snapshot: [{ consent_key: "privacy", accepted: true }],
    submission_token_hash: sha256("token-1"),
    submit_ip_hash: sha256("203.0.113.9"),
    user_agent: "Mozilla/5.0 (test)",
  });
  assert.equal(submission.status, "ACCEPTED");
  assert.equal(submission.form_schema_version, 1);
  assert.deepEqual(submission.payload, { email: "user@example.com" });
  assert.equal(
    "submission_token_hash" in submission,
    false,
    "raw/hashed token is not part of the read model",
  );
  const loaded = await submissions.getSubmission(submission.id);
  assert.deepEqual(loaded, submission);
});

test("duplicate submit token replays the original submission without a second row", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, definition } = await setup(t);
  const submissions = createFormSubmissionService(pool);
  const first = await submissions.insertSubmission({
    form_definition_id: definition.id,
    form_schema_version: 1,
    status: "ACCEPTED",
    payload: { email: "first@example.com" },
    consent_snapshot: [],
    submission_token_hash: sha256("same-token"),
  });
  const second = await submissions.insertSubmission({
    form_definition_id: definition.id,
    form_schema_version: 1,
    status: "ACCEPTED",
    payload: { email: "second@example.com" },
    consent_snapshot: [],
    submission_token_hash: sha256("same-token"),
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.submission.id, first.submission.id, "retry replays the original");
  assert.deepEqual(second.submission.payload, { email: "first@example.com" });
  const all = await submissions.listSubmissions({ form_definition_id: definition.id });
  assert.equal(all.length, 1, "no accidental duplicate business record");
});

test("transactional insert rolls back with the caller's transaction (atomicity invariant)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, definition } = await setup(t);
  const submissions = createFormSubmissionService(pool);
  await assert.rejects(() =>
    pool.withTransaction(async (tx) => {
      await submissions.insertSubmission(
        {
          form_definition_id: definition.id,
          form_schema_version: 1,
          status: "ACCEPTED",
          payload: { email: "rolled-back@example.com" },
          consent_snapshot: [],
        },
        { executor: tx },
      );
      throw new Error("simulated failure after insert (e.g. outbox write)");
    }),
  );
  const all = await submissions.listSubmissions({ form_definition_id: definition.id });
  assert.equal(all.length, 0, "no submission survives a failed transaction");
});

test("list: keyset pagination, definition/status filters, bounded limit", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, definition } = await setup(t);
  const other = await createFormDefinitionService(pool).createDefinition({
    key: "other",
    title: "Другая",
    fields: [{ key: "email", type: "email", label: "E" }],
  });
  const submissions = createFormSubmissionService(pool);
  for (let i = 0; i < 5; i++) {
    await submissions.insertSubmission(
      {
        form_definition_id: definition.id,
        form_schema_version: 1,
        status: "ACCEPTED",
        payload: { email: `u${i}@example.com` },
        consent_snapshot: [],
      },
      { submittedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) },
    );
  }
  await submissions.insertSubmission({
    form_definition_id: other.id,
    form_schema_version: 1,
    status: "SPAM",
    payload: {},
    consent_snapshot: [],
    spam_reasons: ["honeypot"],
  });

  const page1 = await submissions.listSubmissions({ form_definition_id: definition.id, limit: 3 });
  assert.equal(page1.length, 3);
  assert.equal(page1[0]!.payload.email, "u4@example.com", "newest first");
  const page2 = await submissions.listSubmissions({
    form_definition_id: definition.id,
    limit: 3,
    before: {
      submitted_at: page1[page1.length - 1]!.submitted_at,
      id: page1[page1.length - 1]!.id,
    },
  });
  assert.equal(page2.length, 2);
  assert.ok(!page2.some((row) => page1.some((p1) => p1.id === row.id)), "pages do not overlap");

  const spam = await submissions.listSubmissions({ status: "SPAM" });
  assert.equal(spam.length, 1);
  assert.deepEqual(spam[0]!.spam_reasons, ["honeypot"]);
});

test("status lifecycle ACCEPTED → ARCHIVED; unknown ids are FORM_SUBMISSION_NOT_FOUND", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, definition } = await setup(t);
  const submissions = createFormSubmissionService(pool);
  const { submission } = await submissions.insertSubmission({
    form_definition_id: definition.id,
    form_schema_version: 1,
    status: "ACCEPTED",
    payload: {},
    consent_snapshot: [],
  });
  const archived = await submissions.setStatus(submission.id, "ARCHIVED");
  assert.equal(archived.status, "ARCHIVED");
  await assert.rejects(
    () => submissions.getSubmission("01970000-0000-7000-8000-000000000000"),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_SUBMISSION_NOT_FOUND",
  );
});
