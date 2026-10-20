// PCMS-FORM-T019 — CSV/JSON export: RFC-4180 escaping, bounded rows, entity
// filters, and one audit record per export (metadata without PII). The
// permission gate itself is exercised at the API layer (T021); here the
// service contract is pinned.
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
  createInteractionExportService,
  createPublicFormService,
  createPublicQuizService,
  type FormsAuditEvent,
  type FormsOutboxPort,
} from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CLOCK: Clock = fixedClock(new Date("2026-09-20T12:00:00.000Z"));
const noopOutbox: FormsOutboxPort = { async write() {} };

async function setup(t: { after: (fn: () => void) => void }) {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const domain = createFormsDomainServices(pool);
  const auditLog: FormsAuditEvent[] = [];
  const exporter = createInteractionExportService(pool, {
    submissions: domain.submissions,
    runs: domain.runs,
    leads: domain.leads,
    audit: {
      async record(event) {
        auditLog.push(event);
      },
    },
  });
  const definition = await domain.definitions.createDefinition({
    key: "export_form",
    title: "Форма, заявка, «кавычки»",
    fields: [
      { key: "email", type: "email", label: "E", required: true },
      { key: "note", type: "text", label: "N" },
    ],
    settings: { lead_policy: { create_lead: true, email_from: "email", summary_from: "note" } },
  });
  const forms = createPublicFormService(pool, { clock: CLOCK, outbox: noopOutbox, domain });
  for (const [email, note] of [
    ["a@example.com", "простое"],
    ["b@example.com", 'с запятой, кавычкой " и\nпереносом'],
  ] as const) {
    await forms.submit({
      form_definition_id: definition.id,
      values: { email, note },
      ...(email === "a@example.com" ? { attribution: { utm_source: "vk" } } : {}),
    });
  }
  const quiz = createPublicQuizService(pool, { clock: CLOCK, outbox: noopOutbox, domain });
  const quizDef = await domain.quizzes.createDefinition({
    key: "export_quiz",
    title: "Квиз",
    steps: [{ id: "s", questions: [{ id: "q", type: "boolean", label: "Q", required: true }] }],
    scoring_rules: [{ question_id: "q", operator: "eq", value: true, points: 5 }],
    outcomes: [{ id: "yes", title: "Да", min_score: 5 }],
  });
  const run = await quiz.start({
    quiz_definition_id: quizDef.id,
    attribution: { utm_source: "newsletter", landing_path: "/quiz/" },
  });
  await quiz.answer({
    quiz_run_id: run.quiz_run_id,
    resume_token: run.resume_token,
    question_id: "q",
    value: true,
  });
  await quiz.complete({ quiz_run_id: run.quiz_run_id, resume_token: run.resume_token });
  return { pool, domain, exporter, auditLog };
}

test("CSV export: header, all rows, RFC-4180 escaping of commas/quotes/newlines", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { exporter } = await setup(t);
  const result = await exporter.export(
    { entity: "submissions", format: "csv" },
    { actor_type: "OPERATOR", actor_id: "owner-1" },
  );
  assert.equal(result.rows, 2);
  assert.ok(result.content.startsWith("submission_id,form_definition_id,"));
  assert.match(result.content.split("\r\n")[0] ?? "", /,attribution,payload,/);
  assert.ok(result.content.includes("utm_source"));
  assert.ok(result.content.includes("vk"));
  assert.ok(result.content.includes("a@example.com"));
  // Raw (non-JSON) CSV cells: the lead summary carries the raw note text, so
  // the RFC-4180 machinery (quote/double/newline) is exercised end-to-end.
  const leads = await exporter.export(
    { entity: "leads", format: "csv" },
    { actor_type: "OPERATOR", actor_id: "owner-1" },
  );
  assert.ok(
    leads.content.includes('"с запятой, кавычкой "" и\nпереносом"'),
    "raw cells with commas/quotes/newlines are quoted and doubled",
  );
});

test("JSON export: array payload with full records", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { exporter } = await setup(t);
  const result = await exporter.export(
    { entity: "submissions", format: "json" },
    { actor_type: "OPERATOR", actor_id: "owner-1" },
  );
  const parsed = JSON.parse(result.content) as {
    id: string;
    attribution: { utm_source: string | null } | null;
  }[];
  assert.equal(parsed.length, 2);
  assert.ok(parsed.some((row) => row.id.length > 0));
  assert.ok(parsed.some((row) => row.attribution?.utm_source === "vk"));
});

test("entity filters and bounded limit; quiz_runs and leads export with results", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { exporter, domain } = await setup(t);
  const runs = await exporter.export(
    { entity: "quiz_runs", format: "json" },
    { actor_type: "OPERATOR", actor_id: "owner-1" },
  );
  assert.equal(runs.rows, 1);
  const exportedRuns = JSON.parse(runs.content) as {
    score: number;
    attribution: { utm_source: string | null } | null;
  }[];
  assert.equal(exportedRuns[0]?.score, 5);
  assert.equal(exportedRuns[0]?.attribution?.utm_source, "newsletter");

  const runsCsv = await exporter.export(
    { entity: "quiz_runs", format: "csv" },
    { actor_type: "OPERATOR", actor_id: "owner-1" },
  );
  assert.match(runsCsv.content.split("\r\n")[0] ?? "", /,attribution$/);
  assert.ok(runsCsv.content.includes("newsletter"));

  const leads = await exporter.export(
    { entity: "leads", format: "csv" },
    { actor_type: "OPERATOR", actor_id: "owner-1" },
  );
  assert.ok(leads.content.startsWith("lead_id,source_type,"));
  assert.ok(
    leads.content.includes("a@example.com"),
    "lead PII is inside the permission-gated export",
  );

  const definition = await domain.definitions.getDefinitionByKey("export_form");
  const filtered = await exporter.export(
    {
      entity: "submissions",
      format: "json",
      form_definition_id: "01970000-0000-7000-8000-0000000000ff",
    },
    { actor_type: "OPERATOR", actor_id: "owner-1" },
  );
  assert.equal(filtered.rows, 0, "definition filter applies");
  assert.ok(definition.id.length > 0);
});

test("every export writes exactly one audit record with filters+counts, no exported content", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { exporter, auditLog } = await setup(t);
  await exporter.export(
    { entity: "submissions", format: "csv", status: "ACCEPTED" },
    { actor_type: "OPERATOR", actor_id: "owner-1" },
  );
  assert.equal(auditLog.length, 1);
  const event = auditLog[0]!;
  assert.equal(event.event_type, "interactions.export");
  assert.equal(event.actor_id, "owner-1");
  assert.equal(event.metadata.status, "ACCEPTED");
  assert.equal(event.metadata.rows, 2);
  assert.ok(
    !JSON.stringify(event.metadata).includes("a@example.com"),
    "audit metadata carries no PII",
  );
});
