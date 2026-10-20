// PCMS-FORM-T010 — consent snapshot/version semantics: the decision is
// historically reconstructable even after the definition evolves (Forms spec
// §21); verification re-derives the expected snapshot from any version and
// flags drift.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  buildConsentSnapshot,
  type ConsentSnapshotEntry,
  createFormDefinitionService,
  type FormDefinition,
  validateFormValues,
  verifyConsentSnapshot,
} from "@pcms/forms";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const V1_CONSENT = {
  key: "privacy_ok",
  type: "consent",
  label: "Согласие",
  required: true,
  consent_key: "privacy_policy",
  consent_text: "Я согласен с политикой версии 1",
  policy_reference: "policy:privacy@1",
};

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
    key: "consent_form",
    title: "Форма с согласием",
    fields: [{ key: "email", type: "email", label: "E-mail", required: true }, V1_CONSENT],
  });
  return { pool, definition };
}

test("snapshot copies the exact text/policy from the accepted definition version", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, definition } = await setup(t);
  const { values, consent_fields } = validateFormValues(definition.fields, {
    email: "a@b.co",
    privacy_ok: true,
  });
  const snapshot = buildConsentSnapshot(consent_fields, values, {
    acceptedAt: new Date("2026-09-20T10:00:00Z"),
    schemaVersion: definition.schema_version,
  });
  assert.equal(snapshot.length, 1);
  const entry: ConsentSnapshotEntry = snapshot[0]!;
  assert.equal(entry.consent_key, "privacy_policy");
  assert.equal(entry.accepted, true);
  assert.equal(entry.text, "Я согласен с политикой версии 1");
  assert.equal(entry.policy_reference, "policy:privacy@1");
  assert.equal(entry.accepted_at, "2026-09-20T10:00:00.000Z", "server clock, not client claim");

  const verification = verifyConsentSnapshot(entry, {
    fields: definition.fields,
    schema_version: 1,
  });
  assert.deepEqual(verification, { matches: true, drift: [] });
});

test("definition evolution never rewrites history: v1 snapshot verifies against v1, drifts against v2", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { pool, definition } = await setup(t);
  const forms = createFormDefinitionService(pool);
  const { values, consent_fields } = validateFormValues(definition.fields, {
    email: "a@b.co",
    privacy_ok: true,
  });
  const v1Snapshot = buildConsentSnapshot(consent_fields, values, {
    acceptedAt: new Date("2026-09-20T10:00:00Z"),
    schemaVersion: 1,
  })[0]!;

  const v2 = await forms.addVersion({
    form_definition_id: definition.id,
    fields: [
      { key: "email", type: "email", label: "E-mail", required: true },
      {
        ...V1_CONSENT,
        consent_text: "Я согласен с политикой версии 2 (обновлённой)",
        policy_reference: "policy:privacy@2",
      },
    ],
  });
  assert.equal(v2.schema_version, 2);

  // Historical submission still reconstructs against the version it accepted.
  const historical = await forms.getVersion(definition.id, 1);
  assert.deepEqual(verifyConsentSnapshot(v1Snapshot, historical), { matches: true, drift: [] });

  // The same consent_key now carries different text → drift is explicit.
  const againstV2 = verifyConsentSnapshot(v1Snapshot, { fields: v2.fields, schema_version: 2 });
  assert.equal(againstV2.matches, false);
  assert.equal(againstV2.drift.length, 2);
  assert.equal(againstV2.drift[0]!.expected, "Я согласен с политикой версии 2 (обновлённой)");
  assert.equal(againstV2.drift[0]!.snapshot, "Я согласен с политикой версии 1");

  // A v2 submission snapshots the v2 text under the same consent_key.
  const v2Values = validateFormValues(v2.fields, { email: "a@b.co", privacy_ok: true });
  const v2Snapshot = buildConsentSnapshot(v2Values.consent_fields, v2Values.values, {
    acceptedAt: new Date("2026-09-21T10:00:00Z"),
    schemaVersion: 2,
  })[0]!;
  assert.equal(v2Snapshot.text, "Я согласен с политикой версии 2 (обновлённой)");
  assert.ok(v1Snapshot.accepted_at < v2Snapshot.accepted_at, "decisions stay temporally ordered");
});

test("declined optional consent still snapshots the declined decision", () => {
  const fields = [{ ...V1_CONSENT, required: false }];
  const { values, consent_fields } = validateFormValues(fields as never, { privacy_ok: false });
  const snapshot = buildConsentSnapshot(consent_fields, values, {
    acceptedAt: new Date("2026-09-20T10:00:00Z"),
    schemaVersion: 1,
  });
  assert.equal(snapshot[0]!.accepted, false, "a declined decision is recorded, not omitted");
});
