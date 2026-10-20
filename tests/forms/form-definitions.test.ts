// PCMS-FORM-T002 — FormDefinition service over real PostgreSQL: stable
// identity + immutable versions, fail-secure validation, archive lifecycle.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { createFormDefinitionService, FormsError } from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CONTACT_FIELDS = [
  { key: "name", type: "text", label: "Имя", required: true, max_length: 200 },
  { key: "email", type: "email", label: "E-mail", required: true },
  { key: "message", type: "textarea", label: "Сообщение", required: true, max_length: 5000 },
  {
    key: "privacy_ok",
    type: "consent",
    label: "Согласие на обработку",
    required: true,
    consent_key: "privacy_policy",
    consent_text: "Я согласен с политикой обработки персональных данных",
    policy_reference: "policy:privacy@1",
  },
];

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

test("createDefinition stores a stable identity with immutable version 1", async (t) => {
  const pool = await setup(t);
  const forms = createFormDefinitionService(pool);
  const created = await forms.createDefinition({
    key: "contact",
    title: "Связаться с нами",
    fields: CONTACT_FIELDS,
    settings: {
      success_behavior: { type: "message", message: "Спасибо! Мы свяжемся с вами." },
      lead_policy: {
        create_lead: true,
        email_from: "email",
        name_from: "name",
        summary_from: "message",
      },
      spam_policy: { honeypot_field: "company_website" },
      retention: { mode: "anonymize", after_days: 365 },
    },
  });
  assert.ok(created.id.length > 0);
  assert.equal(created.key, "contact");
  assert.equal(created.schema_version, 1);
  assert.equal(created.status, "ACTIVE");
  assert.equal(created.fields.length, CONTACT_FIELDS.length);
  assert.equal(created.settings.lead_policy?.email_from, "email");

  const loaded = await forms.getDefinition(created.id);
  assert.deepEqual(loaded, created);
  const byKey = await forms.getDefinitionByKey("contact");
  assert.equal(byKey.id, created.id);
});

test("addVersion appends the next immutable version and history stays reconstructable", async (t) => {
  const pool = await setup(t);
  const forms = createFormDefinitionService(pool);
  const v1 = await forms.createDefinition({
    key: "callback",
    title: "Обратный звонок",
    fields: CONTACT_FIELDS,
  });
  const v2 = await forms.addVersion({
    form_definition_id: v1.id,
    title: "Обратный звонок v2",
    fields: [...CONTACT_FIELDS, { key: "phone", type: "phone", label: "Телефон", required: true }],
  });
  assert.equal(v2.schema_version, 2);
  assert.equal(v2.fields.length, CONTACT_FIELDS.length + 1);
  assert.equal(v2.id, v1.id, "identity stays stable across versions");

  const historical = await forms.getVersion(v1.id, 1);
  assert.equal(historical.schema_version, 1);
  assert.equal(historical.fields.length, CONTACT_FIELDS.length, "old version is untouched");
  assert.equal((await forms.getDefinition(v1.id)).schema_version, 2);
});

test("duplicate key is rejected with FORM_KEY_TAKEN (409 class)", async (t) => {
  const pool = await setup(t);
  const forms = createFormDefinitionService(pool);
  await forms.createDefinition({
    key: "service_request",
    title: "Заявка на услугу",
    fields: CONTACT_FIELDS,
  });
  await assert.rejects(
    () =>
      forms.createDefinition({ key: "service_request", title: "Дубль", fields: CONTACT_FIELDS }),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_KEY_TAKEN",
  );
});

test("fail-secure definition validation", async (t) => {
  const pool = await setup(t);
  const forms = createFormDefinitionService(pool);
  const cases: readonly { readonly input: object; readonly code: string }[] = [
    {
      input: { key: "Bad-Key", title: "x", fields: CONTACT_FIELDS },
      code: "FORM_DEFINITION_INVALID",
    },
    { input: { key: "ok", title: "", fields: CONTACT_FIELDS }, code: "FORM_DEFINITION_INVALID" },
    { input: { key: "ok", title: "x", fields: [] }, code: "FORM_DEFINITION_INVALID" },
    {
      input: { key: "ok", title: "x", fields: [{ key: "a", type: "file", label: "A" }] },
      code: "FORM_FIELD_UNSUPPORTED",
    },
    {
      input: {
        key: "ok",
        title: "x",
        fields: [
          { key: "a", type: "text", label: "A" },
          { key: "a", type: "text", label: "A2" },
        ],
      },
      code: "FORM_DEFINITION_INVALID",
    },
    {
      input: {
        key: "ok",
        title: "x",
        fields: [{ key: "a", type: "consent", label: "C", consent_key: "k" }],
      },
      code: "FORM_DEFINITION_INVALID",
    },
    {
      input: { key: "ok", title: "x", fields: CONTACT_FIELDS, settings: { unknown_knob: true } },
      code: "FORM_DEFINITION_INVALID",
    },
    {
      input: {
        key: "ok",
        title: "x",
        fields: CONTACT_FIELDS,
        settings: { lead_policy: { email_from: "missing_field" } },
      },
      code: "FORM_DEFINITION_INVALID",
    },
    {
      input: {
        key: "ok",
        title: "x",
        fields: CONTACT_FIELDS,
        settings: { spam_policy: { honeypot_field: "name" } },
      },
      code: "FORM_DEFINITION_INVALID",
    },
    {
      input: {
        key: "ok",
        title: "x",
        fields: CONTACT_FIELDS,
        settings: { retention: { mode: "delete" } },
      },
      code: "FORM_DEFINITION_INVALID",
    },
    {
      input: {
        key: "ok",
        title: "x",
        fields: CONTACT_FIELDS,
        settings: {
          success_behavior: { type: "redirect_external_trusted", url: "http://evil.example" },
        },
      },
      code: "FORM_DEFINITION_INVALID",
    },
  ];
  for (const { input, code } of cases) {
    await assert.rejects(
      () => forms.createDefinition(input as never),
      (error: unknown) => error instanceof FormsError && error.code === code,
      JSON.stringify(input),
    );
  }
});

test("archive lifecycle hides definitions from the ACTIVE list without deleting them", async (t) => {
  const pool = await setup(t);
  const forms = createFormDefinitionService(pool);
  const created = await forms.createDefinition({
    key: "legacy",
    title: "Устаревшая",
    fields: CONTACT_FIELDS,
  });
  const archived = await forms.setArchived(created.id, true);
  assert.equal(archived.status, "ARCHIVED");
  const active = await forms.listDefinitions({ status: "ACTIVE" });
  assert.ok(!active.some((definition) => definition.id === created.id));
  const all = await forms.listDefinitions();
  assert.ok(all.some((definition) => definition.id === created.id));
});

test("unknown definition ids/versions are FORM_DEFINITION_NOT_FOUND (no existence oracle via errors)", async (t) => {
  const pool = await setup(t);
  const forms = createFormDefinitionService(pool);
  await assert.rejects(
    () => forms.getDefinition("01970000-0000-7000-8000-000000000000"),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_DEFINITION_NOT_FOUND",
  );
  const created = await forms.createDefinition({ key: "tiny", title: "T", fields: CONTACT_FIELDS });
  await assert.rejects(
    () => forms.getVersion(created.id, 99),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_DEFINITION_NOT_FOUND",
  );
});
