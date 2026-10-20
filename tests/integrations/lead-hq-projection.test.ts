// PCMS → Progressive HQ, Phase 1 proof (owner refinement §3): BEFORE any
// immutability machinery, prove exactly which fields that reach the HQ body
// can change after a lead is created. Findings pinned here:
//
//   1. Lead status changes (the only LeadService mutation command) do NOT
//      touch any of the eight HQ-projected fields — the outbound body stays
//      byte-identical, so a retry after "HQ accepted, response lost, status
//      changed" replays cleanly.
//   2. Retention anonymize NULLs name/email/phone and empties summary — the
//      body CHANGES. Live re-projection therefore never resends the old PII
//      after anonymization; the resulting HQ 409 stays a visible conflict.
//      (Deliberately NOT solved with a PII snapshot — that would create a
//      second copy of personal data that retention can never reach.)
//   3. Retention delete / vanished lead → projection unavailable → permanent
//      dispatch failure. Nothing is sent.
//
// No admissible path edits contact fields in place (LeadService has no such
// command; only retention touches them). Conclusion: no snapshot table; the
// existing live re-projection satisfies the owner's rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createFormsDomainServices,
  createLeadService,
  createPublicFormService,
  createRetentionService,
} from "@pcms/forms";
import { HQ_LEAD_PROJECTION_FIELDS, hqIntakeEnvelope } from "@pcms/integrations";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const CLOCK = { now: () => NOW };
const noopOutbox = { async write() {} };

async function setup(t: { after: (fn: () => void) => void }): Promise<{
  pool: DbPool;
  domain: ReturnType<typeof createFormsDomainServices>;
  formId: Promise<string>;
}> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const domain = createFormsDomainServices(pool);
  const formId = domain.definitions
    .createDefinition({
      key: "hq_proof_form",
      title: "Форма для доказательства HQ-проекции",
      fields: [
        { key: "name", type: "text", label: "Имя", required: true },
        { key: "email", type: "email", label: "E", required: true },
        { key: "phone", type: "text", label: "Телефон", required: false },
        { key: "message", type: "textarea", label: "Сообщение", required: true, max_length: 30000 },
      ],
      settings: {
        lead_policy: {
          create_lead: true,
          name_from: "name",
          email_from: "email",
          phone_from: "phone",
          summary_from: "message",
          classification: "hq-proof",
        },
        retention: { mode: "anonymize", after_days: 30 },
      },
    })
    .then((d) => d.id);
  return { pool, domain, formId };
}

/** Mirrors the dispatcher's per-attempt projection (forms-source.ts):
 * fetch the live lead, keep only the connector's projected fields. */
async function projectLead(pool: DbPool, leadId: string): Promise<Record<string, unknown>> {
  const leads = createLeadService(pool);
  const lead = await leads.getLead(leadId);
  const full: Record<string, unknown> = {
    lead_id: lead.id,
    source_type: lead.source_type,
    source_id: lead.source_id,
    status: lead.status,
    classification: lead.classification,
    created_at: lead.created_at,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    summary: lead.summary,
    attribution: lead.attribution,
  };
  return Object.fromEntries(
    Object.entries(full).filter(([key]) =>
      (HQ_LEAD_PROJECTION_FIELDS as readonly string[]).includes(key),
    ),
  );
}

function outboundBody(
  projection: Readonly<Record<string, unknown>>,
  leadId: string,
  sourceSite: string,
): string {
  // Exactly what the connector stringifies per attempt (progressive-hq.ts):
  // JSON of the envelope built from the attempt's projection.
  return JSON.stringify(hqIntakeEnvelope({ leadId, sourceSite, projection }));
}

test("HQ projection proof: status change never affects the outbound body", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain, formId } = await setup(t);
  const forms = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain,
  });
  const submitted = await forms.submit({
    form_definition_id: await formId,
    values: {
      name: "Иван Петров",
      email: "ivan@example.com",
      phone: "+7 912 000-00-00",
      message: "Нужна уборка квартиры, звоните вечером",
    },
    submission_token: "tok-hq-proof-1",
    submitter: { ip: "203.0.113.10", user_agent: "Proof/1.0" },
  });
  assert.ok(submitted.lead_id, "lead created by lead_policy");

  const before = await projectLead(pool, submitted.lead_id);
  const bodyBefore = outboundBody(before, submitted.lead_id, "spangar");

  // The only in-place mutation command: status transitions.
  const leads = createLeadService(pool);
  for (const status of ["VIEWED", "PROCESSED", "ARCHIVED"] as const) {
    await leads.setStatus(submitted.lead_id, status);
  }
  const after = await projectLead(pool, submitted.lead_id);
  const bodyAfter = outboundBody(after, submitted.lead_id, "spangar");

  assert.deepEqual(after, before, "status transitions never touch HQ-projected fields");
  assert.equal(bodyAfter, bodyBefore, "outbound body byte-identical across status changes");
  assert.equal(before["status"], undefined, "status is deliberately not projected to HQ");
});

test("HQ projection proof: two consecutive projections of an untouched lead are byte-identical", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain, formId } = await setup(t);
  const forms = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain,
  });
  const submitted = await forms.submit({
    form_definition_id: await formId,
    values: {
      name: "Мария Смирнова",
      email: "maria@example.com",
      message: "Вопрос по услуге",
    },
    submission_token: "tok-hq-proof-2",
  });
  assert.ok(submitted.lead_id, "lead created by lead_policy");
  const projection = await projectLead(pool, submitted.lead_id);
  const first = outboundBody(projection, submitted.lead_id, "spangar");
  const second = outboundBody(projection, submitted.lead_id, "spangar");
  assert.equal(first, second);
});

test("HQ projection proof: retention anonymize clears PII fields — body changes, old PII is not resent", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain, formId } = await setup(t);
  const forms = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain,
  });
  const submitted = await forms.submit({
    form_definition_id: await formId,
    values: {
      name: "Старый Клиент",
      email: "old@example.com",
      phone: "+7 900 111-22-33",
      message: "Старая заявка",
    },
    submission_token: "tok-hq-proof-3",
    submitter: { ip: "203.0.113.11", user_agent: "Proof/1.0" },
  });
  assert.ok(submitted.lead_id, "lead created by lead_policy");
  const bodyBefore = outboundBody(
    await projectLead(pool, submitted.lead_id),
    submitted.lead_id,
    "spangar",
  );
  assert.match(bodyBefore, /Старый Клиент/);
  assert.match(bodyBefore, /old@example\.com/);

  // Backdate beyond the retention window and run the real retention sweep.
  await pool.query(`UPDATE forms_submissions SET submitted_at = $2 WHERE id = $1`, [
    submitted.submission_id,
    new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000),
  ]);
  const stats = await createRetentionService(pool, { clock: CLOCK }).sweep();
  assert.equal(stats.leads_anonymized, 1);

  const lead = await createLeadService(pool).getLead(submitted.lead_id);
  assert.equal(lead.name, null);
  assert.equal(lead.email, null);
  assert.equal(lead.phone, null);
  assert.equal(lead.summary, "");

  const bodyAfter = outboundBody(
    await projectLead(pool, submitted.lead_id),
    submitted.lead_id,
    "spangar",
  );
  assert.notEqual(bodyAfter, bodyBefore, "anonymization changes the outbound body");
  assert.doesNotMatch(bodyAfter, /old@example\.com/, "old PII is never re-projected");
  // The live re-projection therefore sends the anonymized body on retry; HQ
  // answers 409 (hash differs) and the delivery stays a visible conflict —
  // by owner rule, NOT masked as success and NOT retried with a PII snapshot.
});

test("HQ projection proof: deleted lead → projection unavailable (permanent dispatch failure)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain, formId } = await setup(t);
  const forms = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain,
  });
  const submitted = await forms.submit({
    form_definition_id: await formId,
    values: { name: "X", email: "x@example.com", message: "delete me" },
    submission_token: "tok-hq-proof-4",
  });
  const deletedLeadId: string = submitted.lead_id as string;
  // Retention "delete" removes the lead row (mirrored here by the same SQL
  // the retention sweep executes for mode=delete).
  await pool.query(`DELETE FROM forms_leads WHERE id = $1`, [deletedLeadId]);
  await assert.rejects(
    projectLead(pool, deletedLeadId),
    (error: unknown) => error instanceof Error && /not found/i.test(error.message),
  );
});

test("HQ projection proof: presentation carries labeled answers and is immutable to definition edits", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain, formId } = await setup(t);
  const forms = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain,
  });
  const submitted = await forms.submit({
    form_definition_id: await formId,
    values: {
      name: "Иван Петров",
      email: "ivan@example.com",
      phone: "+7 912 000-00-00",
      message: "Нужна уборка трёхкомнатной квартиры, подъезд пятый",
    },
    submission_token: "tok-hq-proof-5",
  });
  assert.ok(submitted.lead_id);
  const lead = await createLeadService(pool).getLead(submitted.lead_id);
  assert.match(lead.presentation, /Form "[^"]+"/);
  assert.match(lead.presentation, /Имя: Иван Петров/);
  assert.match(lead.presentation, /E: ivan@example\.com/);
  assert.match(lead.presentation, /Телефон: \+7 912 000-00-00/);
  assert.match(lead.presentation, /Сообщение: Нужна уборка/);

  // Editing the definition (title/labels) afterwards must NOT change the
  // stored representation nor the outbound body.
  const bodyBefore = outboundBody(
    await projectLead(pool, submitted.lead_id),
    submitted.lead_id,
    "spangar",
  );
  await pool.query(
    `UPDATE forms_form_definitions SET title = 'Переименованная форма' WHERE id = $1`,
    [await formId],
  );
  const leadAfterEdit = await createLeadService(pool).getLead(submitted.lead_id);
  assert.match(leadAfterEdit.presentation, /Form "[^"]+"/);
  assert.doesNotMatch(leadAfterEdit.presentation, /Переименованная/);
  const bodyAfter = outboundBody(
    await projectLead(pool, submitted.lead_id),
    submitted.lead_id,
    "spangar",
  );
  assert.equal(bodyAfter, bodyBefore, "representation is immutable after definition edits");
});

test("HQ projection proof: oversized submissions truncate with an explicit marker", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain } = await setup(t);
  // No summary_from: the oversized answer must flow into the presentation
  // (bounded at 20k with a marker), not into the 2000-char lead summary.
  const formId = domain.definitions
    .createDefinition({
      key: "hq_proof_trunc",
      title: "Форма с очень длинным ответом",
      fields: [
        { key: "name", type: "text", label: "Имя", required: true },
        { key: "email", type: "email", label: "E", required: true },
        { key: "message", type: "textarea", label: "Сообщение", required: true, max_length: 30000 },
      ],
      settings: {
        lead_policy: { create_lead: true, name_from: "name", email_from: "email" },
      },
    })
    .then((d) => d.id);
  const forms = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain,
  });
  const submitted = await forms.submit({
    form_definition_id: await formId,
    values: {
      name: "X",
      email: "x@example.com",
      message: "п".repeat(25_000),
    },
    submission_token: "tok-hq-proof-6",
  });
  assert.ok(submitted.lead_id);
  const lead = await createLeadService(pool).getLead(submitted.lead_id);
  assert.ok(lead.presentation.length <= 20_000, "bounded by the explicit limit");
  assert.match(
    lead.presentation,
    /\u043f+…\[truncated\]/,
    "per-answer bound with a visible marker",
  );
  assert.ok(lead.presentation.length < 25_000 + 100, "no unbounded 25k answer leaked");
});

test("HQ projection proof: presentation carries the consent fact and the source page", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain } = await setup(t);
  const forms = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain,
  });
  const formId = await domain.definitions
    .createDefinition({
      key: "hq_consent_source_form",
      title: "Форма с консентом",
      fields: [
        { key: "name", type: "text", label: "Имя", required: true },
        {
          key: "consent",
          type: "consent",
          label: "Согласен с политикой конфиденциальности",
          required: true,
          consent_key: "privacy_policy",
          consent_text: "Нажимая «Отправить», вы принимаете политику конфиденциальности.",
        },
      ],
      settings: {
        lead_policy: { create_lead: true, name_from: "name", classification: "hq-proof" },
      },
    })
    .then((d) => d.id);
  const sourceUrl =
    "https://spangar.example.test/uslugi/?utm_source=vk&email=private%40example.com&gclid=secret";
  const submitted = await forms.submit({
    form_definition_id: formId,
    values: { name: "Иван Петров", consent: true },
    source_url: sourceUrl,
    submission_token: "tok-hq-proof-7",
  });
  assert.ok(submitted.lead_id);
  const lead = await createLeadService(pool).getLead(submitted.lead_id);
  assert.equal(
    lead.presentation.match(/Source: (.+)/)?.[1],
    "/uslugi/",
    "only the source pathname is included in the HQ presentation",
  );
  assert.doesNotMatch(
    lead.presentation,
    /spangar\.example\.test|utm_source|private%40example\.com|gclid/,
  );
  const storedSubmission = await pool.query(
    `SELECT source_url_snapshot FROM forms_submissions WHERE id = $1`,
    [submitted.submission_id],
  );
  assert.equal(
    storedSubmission.rows[0]?.source_url_snapshot,
    sourceUrl,
    "the full source URL remains in the local PCMS snapshot",
  );
  assert.match(
    lead.presentation,
    /Согласен с политикой конфиденциальности: yes/,
    "the consent fact rides the presentation",
  );

  // No consent line without an answered consent (optional case): a consent
  // absent from the payload must not fabricate a fact.
  const optionalFormId = await domain.definitions
    .createDefinition({
      key: "hq_optional_consent_form",
      title: "Форма с опциональным консентом",
      fields: [
        { key: "name", type: "text", label: "Имя", required: true },
        {
          key: "consent",
          type: "consent",
          label: "Согласен на рассылку",
          required: false,
          consent_key: "marketing",
          consent_text: "Согласие на маркетинговые рассылки.",
        },
      ],
      settings: { lead_policy: { create_lead: true, name_from: "name" } },
    })
    .then((d) => d.id);
  const noConsent = await forms.submit({
    form_definition_id: optionalFormId,
    values: { name: "Мария Смирнова" },
    submission_token: "tok-hq-proof-8",
  });
  assert.ok(noConsent.lead_id);
  const noConsentLead = await createLeadService(pool).getLead(noConsent.lead_id!);
  assert.doesNotMatch(
    noConsentLead.presentation,
    /Согласен на рассылку/,
    "unchecked optional consent produces no fact line",
  );
  assert.doesNotMatch(noConsentLead.presentation, /Source:/, "no source line without source_url");
});
test("MKT-010: attribution captured, frozen on the lead, byte-stable, gated by send_attribution", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, domain, forms, formId } = await setupAttribution(t);
  const submitted = await forms.submit({
    form_definition_id: formId,
    values: {
      name: "Иван Петров",
      email: "ivan@example.com",
      message: "Нужен ангар",
      phone: "+7 912 000-00-00",
    },
    attribution: {
      utm_source: "vk",
      utm_medium: "cpc",
      landing_path: "/uslugi/",
      referrer_host: "vk.com",
      utm_email: "ignored@example.com",
      gclid: "noise",
    },
    submission_token: "tok-mkt010-1",
  });
  assert.ok(submitted.lead_id);
  const lead = await createLeadService(pool).getLead(submitted.lead_id!);
  assert.equal(lead.attribution?.interaction_kind, "form");
  assert.equal(lead.attribution?.form_key, formId, "form_key = the stable definition id");
  assert.equal(lead.attribution?.utm_source, "vk");
  assert.equal(lead.attribution?.referrer_host, "vk.com");
  assert.ok(!JSON.stringify(lead.attribution).includes("ignored@example.com"));
  assert.ok(!JSON.stringify(lead.attribution).includes("gclid"));

  // A NEW definition version keeps the same form_key (versions are not new
  // definitions).
  await domain.definitions.addVersion({
    form_definition_id: formId,
    title: "Форма v2",
    fields: [
      { key: "name", type: "text", label: "Имя", required: true },
      { key: "email", type: "email", label: "E", required: true },
    ],
    settings: {
      lead_policy: { create_lead: true, name_from: "name", classification: "hq-proof" },
    },
  });
  const submittedV2 = await forms.submit({
    form_definition_id: formId,
    values: { name: "Мария Смирнова", email: "maria@example.com" },
    attribution: { utm_source: "yandex", landing_path: "/" },
    submission_token: "tok-mkt010-2",
  });
  const leadV2 = await createLeadService(pool).getLead(submittedV2.lead_id!);
  assert.equal(leadV2.attribution?.form_key, formId, "same key across definition versions");
  assert.equal(leadV2.attribution?.utm_source, "yandex");

  // Envelope gating: flag OFF → no attribution key at all (current HQ
  // extra=forbid contract stays satisfied); flag ON → data.attribution is
  // the frozen snapshot; a pre-MKT-010 lead sends null, never a recompute.
  const flagOff = await envelopeOf(pool, submitted.lead_id, false);
  assert.equal("attribution" in flagOff.data, false, "flag off: no key, bytes unchanged");
  const flagOn = await envelopeOf(pool, submitted.lead_id, true);
  assert.deepEqual(flagOn.data.attribution, lead.attribution);
  // Byte-stability with attribution: same lead projected twice → identical.
  assert.equal(
    JSON.stringify(await envelopeOf(pool, submitted.lead_id, true)),
    JSON.stringify(await envelopeOf(pool, submitted.lead_id, true)),
  );
  // A pre-MKT-010 lead (attribution column null) sends null, never a
  // recompute from current URLs.
  await pool.query(`UPDATE forms_leads SET attribution = NULL WHERE id = $1`, [
    submittedV2.lead_id!,
  ]);
  const legacy = await envelopeOf(pool, submittedV2.lead_id!, true);
  assert.equal(legacy.data.attribution, null);
});

/** Same projection discipline as projectLead, then the connector envelope. */
async function envelopeOf(
  pool: DbPool,
  leadId: string,
  includeAttribution: boolean,
): Promise<{ data: Record<string, unknown> }> {
  const projection = await projectLead(pool, leadId);
  return hqIntakeEnvelope({
    leadId,
    sourceSite: "spangar",
    projection,
    includeAttribution,
  }) as { data: Record<string, unknown> };
}

async function setupAttribution(t: { after: (fn: () => void) => void }): Promise<{
  pool: DbPool;
  domain: ReturnType<typeof createFormsDomainServices>;
  forms: ReturnType<typeof createPublicFormService>;
  formId: string;
}> {
  const base = await setup(t);
  const forms = createPublicFormService(base.pool, {
    clock: CLOCK,
    outbox: noopOutbox,
    domain: base.domain,
  });
  return { ...base, forms, formId: await base.formId };
}
