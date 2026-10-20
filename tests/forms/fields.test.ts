// PCMS-FORM-T003 — server-side value validation for every v1 field type
// (Forms spec §5/§8): required, length, safe pattern, email/phone shape,
// numeric bounds, enum allowlists, consent, hidden_controlled, plus abuse
// cases (unknown fields, oversized values).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FormFieldDefinition } from "@pcms/forms";
import { FormsError, validateFieldDefinition, validateFormValues } from "@pcms/forms";

function violationsOf(fn: () => unknown): { key: string; code: string }[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof FormsError && error.code === "FORM_VALUES_INVALID") {
      const violations = (error.details as { violations: { key: string; code: string }[] })
        .violations;
      return violations;
    }
    throw error;
  }
  return [];
}

function check(fields: FormFieldDefinition[], values: unknown): Record<string, unknown> {
  return validateFormValues(fields, values).values;
}

test("text family: required, length bounds, safe pattern", () => {
  const fields = [
    { key: "name", type: "text", label: "N", required: true, min_length: 2, max_length: 5 },
    { key: "sku", type: "text", label: "S", pattern: "^[A-Z]{3}-[0-9]{3}$" },
  ] as unknown as FormFieldDefinition[];
  assert.deepEqual(check(fields, { name: "  Юра  ", sku: "ABC-123" }), {
    name: "Юра",
    sku: "ABC-123",
  });
  const missing = violationsOf(() => check(fields, { sku: "ABC-123" }));
  assert.deepEqual(
    missing.map((v) => ({ key: v.key, code: v.code })),
    [{ key: "name", code: "required" }],
  );
  assert.ok(
    violationsOf(() => check(fields, { name: "Ю", sku: "ABC-123" })).some(
      (v) => v.code === "too_short",
    ),
  );
  assert.ok(
    violationsOf(() => check(fields, { name: "Юрий-Георгий!", sku: "ABC-123" })).some(
      (v) => v.code === "too_long",
    ),
  );
  assert.ok(
    violationsOf(() => check(fields, { name: "Юра", sku: "nope" })).some(
      (v) => v.code === "pattern",
    ),
  );
  assert.ok(
    violationsOf(() => check(fields, { name: 42, sku: "ABC-123" })).some((v) => v.code === "type"),
  );
});

test("email/phone: format enforced server-side", () => {
  const fields = [
    { key: "email", type: "email", label: "E", required: true },
    { key: "phone", type: "phone", label: "P" },
  ] as unknown as FormFieldDefinition[];
  const ok = check(fields, { email: "User@Example.COM", phone: "+7 (912) 123-45-67" });
  assert.equal(ok.email, "user@example.com", "emails normalize to lower case");
  assert.equal(ok.phone, "+7 (912) 123-45-67");
  assert.ok(
    violationsOf(() => check(fields, { email: "not-an-email" })).some((v) => v.code === "email"),
  );
  assert.ok(
    violationsOf(() => check(fields, { email: "a@b.c", phone: "abc" })).some(
      (v) => v.code === "phone",
    ),
  );
});

test("number: coercion, bounds; select/radio/checkbox_group: enum allowlist", () => {
  const fields = [
    { key: "area", type: "number", label: "A", min: 10, max: 100 },
    {
      key: "service",
      type: "select",
      label: "S",
      required: true,
      options: [
        { value: "clean", label: "Уборка" },
        { value: "fix", label: "Ремонт" },
      ],
    },
    {
      key: "contact_kind",
      type: "radio",
      label: "R",
      options: [
        { value: "phone", label: "П" },
        { value: "email", label: "Э" },
      ],
    },
    {
      key: "days",
      type: "checkbox_group",
      label: "D",
      options: [
        { value: "mon", label: "Пн" },
        { value: "tue", label: "Вт" },
      ],
    },
  ] as unknown as FormFieldDefinition[];
  const ok = check(fields, {
    area: " 42 ",
    service: "clean",
    contact_kind: "phone",
    days: ["tue", "mon", "tue"],
  });
  assert.equal(ok.area, 42);
  assert.deepEqual(ok.days, ["tue", "mon"], "allowlist + dedupe, order preserved");
  assert.ok(
    violationsOf(() => check(fields, { area: 5, service: "clean" })).some((v) => v.code === "min"),
  );
  assert.ok(
    violationsOf(() => check(fields, { area: 101, service: "clean" })).some(
      (v) => v.code === "max",
    ),
  );
  assert.ok(violationsOf(() => check(fields, { service: "hack" })).some((v) => v.code === "enum"));
  assert.ok(
    violationsOf(() => check(fields, { service: "clean", days: ["sun"] })).some(
      (v) => v.code === "enum",
    ),
  );
});

test("checkbox, consent, hidden_controlled semantics", () => {
  const fields = [
    { key: "subscribe", type: "checkbox", label: "S" },
    { key: "terms_ok", type: "checkbox", label: "T", required: true },
    { key: "privacy_ok", type: "consent", label: "P", required: true, consent_key: "privacy" },
    { key: "campaign", type: "hidden_controlled", label: "C", expected_value: "landing-42" },
  ] as unknown as FormFieldDefinition[];
  const ok = check(fields, {
    subscribe: true,
    terms_ok: true,
    privacy_ok: true,
    campaign: "landing-42",
  });
  assert.deepEqual(ok, {
    subscribe: true,
    terms_ok: true,
    privacy_ok: true,
    campaign: "landing-42",
  });
  assert.ok(
    violationsOf(() =>
      check(fields, { terms_ok: false, privacy_ok: true, campaign: "landing-42" }),
    ).some((v) => v.code === "required"),
  );
  assert.ok(
    violationsOf(() =>
      check(fields, { terms_ok: true, privacy_ok: false, campaign: "landing-42" }),
    ).some((v) => v.code === "consent_required"),
  );
  assert.ok(
    violationsOf(() =>
      check(fields, { terms_ok: true, privacy_ok: true, campaign: "tampered" }),
    ).some((v) => v.code === "controlled"),
  );
});

test("unknown fields are rejected, not ignored (no smuggling)", () => {
  const fields = [{ key: "name", type: "text", label: "N" }] as unknown as FormFieldDefinition[];
  try {
    check(fields, { name: "a", is_admin: true });
    assert.fail("must reject unknown fields");
  } catch (error) {
    assert.ok(error instanceof FormsError);
    assert.equal(error.code, "FORM_VALUES_INVALID");
    const violations = (error.details as { violations: { key: string; code: string }[] })
      .violations;
    assert.deepEqual(
      violations.map((v) => ({ key: v.key, code: v.code })),
      [{ key: "is_admin", code: "unknown_field" }],
    );
  }
});

test("multiple violations accumulate into one FORM_VALUES_INVALID error", () => {
  const fields = [
    { key: "a", type: "email", label: "A", required: true },
    { key: "b", type: "phone", label: "B", required: true },
  ] as unknown as FormFieldDefinition[];
  const violations = violationsOf(() => check(fields, { a: "nope", b: "nope" }));
  assert.deepEqual(violations.map((v) => v.key).sort(), ["a", "b"]);
});

test("definition-level field validation still guards against unsafe definitions", () => {
  assert.throws(() =>
    validateFieldDefinition({ key: "x", type: "text", label: "L", max_length: 2, min_length: 5 }),
  );
  assert.throws(() =>
    validateFieldDefinition({ key: "x", type: "text", label: "L", pattern: "(" }),
  );
  assert.throws(() =>
    validateFieldDefinition({
      key: "x",
      type: "select",
      label: "L",
      options: [
        { value: "a", label: "A" },
        { value: "a", label: "A2" },
      ],
    }),
  );
});
