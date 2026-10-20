// PCMS-FORM-T011 — public form submission application service (Forms spec
// §3/§8/§23/§27/§28): server-authoritative validation, duplicate-submit
// safety, honeypot spam path, lead creation per policy, and the reliability
// invariant — FormSubmitted/LeadCreated land in the SAME transaction as the
// persisted state, with routing-safe payloads only (no PII).
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
  createPublicFormService,
  FormsError,
  type FormsOutboxEventInput,
  type FormsOutboxPort,
  type PublicFormSubmitInput,
} from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CLOCK: Clock = fixedClock(new Date("2026-09-20T12:00:00.000Z"));
type SubmitInput = Omit<PublicFormSubmitInput, "form_definition_id">;

interface Fixture {
  readonly pool: DbPool;
  readonly events: readonly FormsOutboxEventInput[];
  readonly submit: (
    input: SubmitInput,
  ) => ReturnType<ReturnType<typeof createPublicFormService>["submit"]>;
  readonly domain: ReturnType<typeof createFormsDomainServices>;
}

async function setup(
  t: { after: (fn: () => void) => void },
  formSettings?: object,
): Promise<Fixture> {
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
  const forms = createPublicFormService(pool, { clock: CLOCK, outbox, domain });
  const definition = await domain.definitions.createDefinition({
    key: "contact",
    title: "Связаться с нами",
    fields: [
      { key: "name", type: "text", label: "Имя", required: true, max_length: 200 },
      { key: "email", type: "email", label: "E-mail", required: true },
      { key: "phone", type: "phone", label: "Телефон" },
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
      success_behavior: { type: "message", message: "Спасибо!" },
      lead_policy: {
        create_lead: true,
        classification: "warm",
        name_from: "name",
        email_from: "email",
        phone_from: "phone",
        summary_from: "message",
      },
      spam_policy: { honeypot_field: "company_website" },
      ...formSettings,
    },
  });
  return {
    pool,
    events,
    domain,
    submit: (input) => forms.submit({ ...input, form_definition_id: definition.id }),
  };
}

test("simple contact form: accepted, persisted before event, PII-free event payload", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const result = await fixture.submit({
    values: {
      name: "Иван",
      email: "ivan@example.com",
      message: "Нужна консультация",
      privacy_ok: true,
      company_website: "",
    },
    submission_token: "client-random-abc",
    submitter: { ip: "203.0.113.5", user_agent: "TestAgent/1.0" },
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.duplicate, false);
  assert.equal(result.success.type, "message");

  const stored = await fixture.domain.submissions.getSubmission(result.submission_id);
  assert.equal(stored.payload.email, "ivan@example.com", "payload holds PII (permission-gated)");
  assert.ok(stored.submitted_at.length > 0);
  assert.equal(stored.spam_reasons.length, 0);
  assert.equal(stored.consent_snapshot.length, 1);
  assert.equal((stored.consent_snapshot[0] as { accepted: boolean }).accepted, true);

  // Persistence and event are one transaction: after commit both exist.
  assert.equal(fixture.events.length, 2, "FormSubmitted + LeadCreated");
  const submitted = fixture.events.find((event) => event.eventType === "FormSubmitted")!;
  assert.equal(submitted.aggregate, "form_submission");
  assert.deepEqual(submitted.payload, {
    submission_id: result.submission_id,
    form_definition_id: stored.form_definition_id,
    form_schema_version: 1,
  });
  const payloadJson = JSON.stringify(submitted.payload);
  assert.ok(!payloadJson.includes("ivan@example.com"), "no PII in generic event payload");
  assert.ok(!payloadJson.includes("Нужна консультация"), "no form payload in generic event");
});

test("callback form variant: lead created from phone with policy classification", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const result = await fixture.submit({
    values: {
      name: "Мария",
      email: "maria@example.com",
      phone: "+7 912 555-00-11",
      message: "Перезвоните",
      privacy_ok: true,
    },
  });
  assert.ok(result.lead_id !== null, "lead created per policy");
  const lead = await fixture.domain.leads.getLead(result.lead_id!);
  assert.equal(lead.source_type, "FORM_SUBMISSION");
  assert.equal(lead.phone, "+7 912 555-00-11");
  assert.equal(lead.classification, "warm");
  assert.equal(lead.summary, "Перезвоните");
});

test("duplicate submit replays the original submission and emits no new events", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const values = { name: "Иван", email: "ivan@example.com", message: "Раз", privacy_ok: true };
  const first = await fixture.submit({ values, submission_token: "same-token" });
  const retry = await fixture.submit({
    values: { ...values, message: "Два" },
    submission_token: "same-token",
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.submission_id, first.submission_id);
  assert.equal(fixture.events.length, 2, "no additional business events on retry");

  const submissions = await fixture.domain.submissions.listSubmissions({});
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]!.payload.message, "Раз", "original payload preserved");
});

test("consent required: missing consent is rejected, nothing persisted, no event", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  await assert.rejects(
    () =>
      fixture.submit({
        values: {
          name: "Иван",
          email: "ivan@example.com",
          message: "Без согласия",
          privacy_ok: false,
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof FormsError);
      assert.equal(error.code, "FORM_VALUES_INVALID");
      const violations = (error.details as { violations: { key: string; code: string }[] })
        .violations;
      assert.ok(
        violations.some(
          (violation) => violation.key === "privacy_ok" && violation.code === "consent_required",
        ),
      );
      return true;
    },
  );
  assert.equal(fixture.events.length, 0);
  assert.equal((await fixture.domain.submissions.listSubmissions({})).length, 0);
});

test("validation failure: unknown field smuggling rejected, zero persistence side effects", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  await assert.rejects(
    () =>
      fixture.submit({
        values: { name: "x", email: "a@b.co", message: "m", privacy_ok: true, is_admin: "1" },
      }),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_VALUES_INVALID",
  );
  assert.equal(fixture.events.length, 0);
});

test("honeypot: submission stored as SPAM, no lead, no FormSubmitted event", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await setup(t);
  const result = await fixture.submit({
    values: {
      name: "Bot",
      email: "bot@spam.io",
      message: "Buy now",
      privacy_ok: true,
      company_website: "http://spam.io",
    },
  });
  assert.equal(result.status, "SPAM");
  assert.equal(result.lead_id, null);
  assert.equal(fixture.events.length, 0, "spam never reaches Integration Hub");
  const stored = await fixture.domain.submissions.getSubmission(result.submission_id);
  assert.equal(stored.status, "SPAM");
  assert.deepEqual(stored.spam_reasons, ["honeypot"]);
  assert.deepEqual(stored.payload, {}, "harvest content dropped");
});

test("transactional atomicity: outbox failure rolls the whole interaction back", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const domain = createFormsDomainServices(pool);
  const failingOutbox: FormsOutboxPort = {
    async write() {
      throw new Error("simulated outbox outage");
    },
  };
  const forms = createPublicFormService(pool, { clock: CLOCK, outbox: failingOutbox, domain });
  const definition = await domain.definitions.createDefinition({
    key: "atomic",
    title: "A",
    fields: [{ key: "email", type: "email", label: "E", required: true }],
  });
  await assert.rejects(
    () => forms.submit({ form_definition_id: definition.id, values: { email: "a@b.co" } }),
    /simulated outbox outage/,
  );
  assert.equal(
    (await domain.submissions.listSubmissions({})).length,
    0,
    "no submission without its event",
  );
  assert.equal((await domain.leads.listLeads({})).length, 0, "no lead without its event");
});
