// Consent snapshot semantics (PCMS-FORM-T010; Forms spec §21/§31). A consent
// decision must be historically reconstructable: at submit time the exact
// consent text / policy reference / definition version are COPIED into the
// submission, so later definition edits never rewrite history. verifyEntry
// re-derives the expected snapshot from any historical definition version and
// reports drift — no "hidden row" tricks.
import type { FormDefinitionVersionRecord, FormFieldDefinition } from "./form-definitions.js";

export interface ConsentSnapshotEntry {
  /** Stable consent identity (spec §21). */
  readonly consent_key: string;
  /** Which field carried the decision. */
  readonly field_key: string;
  readonly accepted: boolean;
  /** When the decision was made (submission time, ISO). */
  readonly accepted_at: string;
  /** Exact consent text shown to the user, from the accepted version. */
  readonly text: string | null;
  /** Policy document reference, from the accepted version. */
  readonly policy_reference: string | null;
  /** Definition schema_version the text/policy came from. */
  readonly schema_version: number;
}

export interface ConsentDrift {
  readonly consent_key: string;
  readonly field: string;
  readonly expected: string | null;
  readonly snapshot: string | null;
}

/**
 * Builds the snapshot from consent-type fields (definition order) and the
 * validated submission values. `accepted_at` is the server clock at accept
 * time — never a client claim.
 */
export function buildConsentSnapshot(
  consent_fields: readonly FormFieldDefinition[],
  values: Readonly<Record<string, unknown>>,
  options: { readonly acceptedAt: Date; readonly schemaVersion: number },
): ConsentSnapshotEntry[] {
  return consent_fields.map((field) => ({
    consent_key: field.consent_key ?? field.key,
    field_key: field.key,
    accepted: values[field.key] === true,
    accepted_at: options.acceptedAt.toISOString(),
    text: field.consent_text ?? null,
    policy_reference: field.policy_reference ?? null,
    schema_version: options.schemaVersion,
  }));
}

/**
 * Re-derives the snapshot a definition version WOULD have produced and
 * compares texts/policies against a stored entry. Used by retention/audit
 * flows to prove what the user saw at acceptance time.
 */
export function verifyConsentSnapshot(
  entry: ConsentSnapshotEntry,
  version: Pick<FormDefinitionVersionRecord, "fields" | "schema_version">,
): { readonly matches: boolean; readonly drift: readonly ConsentDrift[] } {
  const field = version.fields.find(
    (candidate) =>
      candidate.type === "consent" &&
      (candidate.consent_key ?? candidate.key) === entry.consent_key,
  );
  const drift: ConsentDrift[] = [];
  if (!field) {
    drift.push({
      consent_key: entry.consent_key,
      field: entry.field_key,
      expected: null,
      snapshot: entry.text,
    });
    return { matches: false, drift };
  }
  const expectedText = field.consent_text ?? null;
  const expectedPolicy = field.policy_reference ?? null;
  if (expectedText !== entry.text) {
    drift.push({
      consent_key: entry.consent_key,
      field: entry.field_key,
      expected: expectedText,
      snapshot: entry.text,
    });
  }
  if (expectedPolicy !== entry.policy_reference) {
    drift.push({
      consent_key: entry.consent_key,
      field: entry.field_key,
      expected: expectedPolicy,
      snapshot: entry.policy_reference,
    });
  }
  return { matches: drift.length === 0, drift };
}
