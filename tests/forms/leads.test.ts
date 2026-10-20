// PCMS-FORM-T009 — Lead model + source provenance: exactly one lead per
// originating interaction (FORM_SUBMISSION / QUIZ_RUN), lightweight record
// without interaction history, status lifecycle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { createLeadService, FormsError } from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

test("lead from form submission and lead from quiz run keep distinct provenance", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const leads = createLeadService(pool);
  const fromForm = await leads.createLead({
    source_type: "FORM_SUBMISSION",
    source_id: "01970000-0000-7000-8000-000000000001",
    name: "Иван Петров",
    email: "ivan@example.com",
    phone: "+7 912 000-00-00",
    summary: "Заявка на уборку 3-к квартиры",
    classification: "hot",
  });
  assert.equal(fromForm.created, true);
  assert.equal(fromForm.lead.status, "NEW");
  assert.equal(fromForm.lead.source_type, "FORM_SUBMISSION");

  const fromQuiz = await leads.createLead({
    source_type: "QUIZ_RUN",
    source_id: "01970000-0000-7000-8000-000000000002",
    summary: "Квиз «Подбор услуги»: исход hot",
    classification: "hot",
  });
  assert.equal(fromQuiz.created, true);
  assert.equal(fromQuiz.lead.source_type, "QUIZ_RUN");

  const bySource = await leads.findBySource(
    "FORM_SUBMISSION",
    "01970000-0000-7000-8000-000000000001",
  );
  assert.equal(bySource?.id, fromForm.lead.id);
});

test("retry/replay cannot spawn a duplicate lead for the same interaction", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const leads = createLeadService(pool);
  const first = await leads.createLead({
    source_type: "FORM_SUBMISSION",
    source_id: "01970000-0000-7000-8000-000000000003",
    summary: "первая",
  });
  const replay = await leads.createLead({
    source_type: "FORM_SUBMISSION",
    source_id: "01970000-0000-7000-8000-000000000003",
    summary: "повтор",
  });
  assert.equal(replay.created, false);
  assert.equal(replay.lead.id, first.lead.id);
  assert.equal(replay.lead.summary, "первая", "original record is authoritative");
});

test("status lifecycle + list filters; unknown lead is LEAD_NOT_FOUND", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const leads = createLeadService(pool);
  const { lead } = await leads.createLead({
    source_type: "QUIZ_RUN",
    source_id: "01970000-0000-7000-8000-000000000004",
  });
  const viewed = await leads.setStatus(lead.id, "VIEWED");
  assert.equal(viewed.status, "VIEWED");
  await leads.setStatus(lead.id, "PROCESSED");
  const processed = await leads.listLeads({ status: "PROCESSED" });
  assert.ok(processed.some((row) => row.id === lead.id));

  await assert.rejects(
    () => leads.getLead("01970000-0000-7000-8000-000000000009"),
    (error: unknown) => error instanceof FormsError && error.code === "LEAD_NOT_FOUND",
  );
  await assert.rejects(
    () => leads.setStatus(lead.id, "MAYBE" as never),
    (error: unknown) => error instanceof FormsError && error.code === "LEAD_STATUS_INVALID",
  );
});
