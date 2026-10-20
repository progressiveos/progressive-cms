// Server-side form value validation (PCMS-FORM-T003; Forms spec §5/§8/§37).
// The server is the only source of truth: client-side checks are UX only.
// Everything here is allowlist/bound based — unknown fields are rejected, not
// ignored, and every string is length-capped before any pattern runs.
import { FormsError } from "./errors.js";
import {
  FORM_PATTERN_MAX_SUBJECT_LENGTH,
  type FormFieldDefinition,
  type FormFieldType,
} from "./form-definitions.js";
import { asRecord } from "./validate.js";

export interface FieldViolation {
  readonly key: string;
  readonly code: string;
  readonly message: string;
}

/** Absolute per-value cap independent of definition settings (defense in
 * depth against oversized bodies; the transport adds its own bodyLimit). */
const ABSOLUTE_MAX_TEXT_LENGTH = 100_000;
const DEFAULT_MAX_TEXT_LENGTH = 5_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9\s()-]{4,31}$/;

function violation(key: string, code: string, message: string): FieldViolation {
  return { key, code, message };
}

function asText(field: FormFieldDefinition, value: unknown): string {
  if (typeof value !== "string") {
    throw violation(field.key, "type", "must be a string");
  }
  if (value.length > ABSOLUTE_MAX_TEXT_LENGTH) {
    throw violation(
      field.key,
      "too_large",
      `must be at most ${ABSOLUTE_MAX_TEXT_LENGTH} characters`,
    );
  }
  return value.trim();
}

function checkLength(field: FormFieldDefinition, text: string): void {
  const min = field.min_length ?? 0;
  const max = field.max_length ?? DEFAULT_MAX_TEXT_LENGTH;
  if (text.length < min)
    throw violation(field.key, "too_short", `must be at least ${min} characters`);
  if (text.length > max)
    throw violation(field.key, "too_long", `must be at most ${max} characters`);
}

function checkPattern(field: FormFieldDefinition, text: string): void {
  if (field.pattern === undefined) return;
  // Safety net for the definition-compile ReDoS bound (F-43): definitions
  // stored before that rule may pair a pattern with a larger max_length —
  // never run the author-supplied regex on an over-long public subject.
  if (text.length > FORM_PATTERN_MAX_SUBJECT_LENGTH) {
    throw violation(field.key, "pattern", "value too long for pattern check");
  }
  if (!new RegExp(field.pattern).test(text)) {
    throw violation(field.key, "pattern", "does not match the required format");
  }
}

function optionValues(field: FormFieldDefinition): Set<string> {
  return new Set((field.options ?? []).map((option) => option.value));
}

function singleChoice(field: FormFieldDefinition, value: unknown): string {
  const text = asText(field, value);
  if (!optionValues(field).has(text)) {
    throw violation(field.key, "enum", "value is not in the allowed list");
  }
  return text;
}

function normalizeOne(field: FormFieldDefinition, value: unknown): unknown {
  const type: FormFieldType = field.type;
  switch (type) {
    case "text":
    case "textarea": {
      const text = asText(field, value);
      checkLength(field, text);
      checkPattern(field, text);
      return text;
    }
    case "email": {
      const text = asText(field, value);
      checkLength(field, text);
      if (!EMAIL_RE.test(text))
        throw violation(field.key, "email", "must be a valid e-mail address");
      return text.toLowerCase();
    }
    case "phone": {
      const text = asText(field, value);
      if (!PHONE_RE.test(text)) throw violation(field.key, "phone", "must be a valid phone number");
      return text;
    }
    case "number": {
      const numeric =
        typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
      if (!Number.isFinite(numeric))
        throw violation(field.key, "number", "must be a finite number");
      if (field.min !== undefined && numeric < field.min) {
        throw violation(field.key, "min", `must be >= ${field.min}`);
      }
      if (field.max !== undefined && numeric > field.max) {
        throw violation(field.key, "max", `must be <= ${field.max}`);
      }
      return numeric;
    }
    case "select":
    case "radio":
      return singleChoice(field, value);
    case "checkbox": {
      if (typeof value !== "boolean") throw violation(field.key, "type", "must be a boolean");
      if (field.required === true && value !== true) {
        throw violation(field.key, "required", "must be checked");
      }
      return value;
    }
    case "checkbox_group": {
      if (!Array.isArray(value)) throw violation(field.key, "type", "must be an array of values");
      if (value.length > 1000) throw violation(field.key, "too_large", "too many values");
      const allowed = optionValues(field);
      const normalized: string[] = [];
      for (const entry of value) {
        const text = typeof entry === "string" ? entry.trim() : "";
        if (!allowed.has(text))
          throw violation(field.key, "enum", "value is not in the allowed list");
        if (!normalized.includes(text)) normalized.push(text);
      }
      if (field.required === true && normalized.length === 0) {
        throw violation(field.key, "required", "must include at least one value");
      }
      return normalized;
    }
    case "hidden_controlled": {
      // Server-controlled value: the submitted value must equal the pinned
      // expected_value exactly (no client improvisation).
      const text = asText(field, value);
      if (text !== field.expected_value) {
        throw violation(field.key, "controlled", "value is not accepted");
      }
      return text;
    }
    case "consent": {
      if (typeof value !== "boolean") throw violation(field.key, "type", "must be a boolean");
      if (field.required === true && value !== true) {
        throw violation(field.key, "consent_required", "consent must be accepted");
      }
      return value;
    }
  }
}

export interface ValidateFormValuesResult {
  /** Normalized field key → value (only submitted, valid fields). */
  readonly values: Record<string, unknown>;
  /** Consent-type fields in definition order (input for consent snapshots). */
  readonly consent_fields: readonly FormFieldDefinition[];
}

/**
 * Validates a public values bag against a definition's field set. Throws
 * FORM_VALUES_INVALID with per-field violations; required-but-missing consent
 * surfaces as a `consent_required` violation on the field.
 */
export function validateFormValues(
  fields: readonly FormFieldDefinition[],
  rawValues: unknown,
): ValidateFormValuesResult {
  const bag = asRecord(rawValues, "FORM_VALUES_INVALID", "values");
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const unknown = Object.keys(bag).filter((key) => !byKey.has(key));
  if (unknown.length > 0) {
    throw new FormsError("FORM_VALUES_INVALID", "values contain unknown fields", {
      details: {
        violations: unknown.map((key) => violation(key, "unknown_field", "field is not defined")),
      },
    });
  }
  const violations: FieldViolation[] = [];
  const values: Record<string, unknown> = {};
  const consent_fields: FormFieldDefinition[] = [];
  for (const field of fields) {
    if (field.type === "consent") consent_fields.push(field);
    const present = Object.hasOwn(bag, field.key);
    const value = present ? bag[field.key] : undefined;
    const empty = value === undefined || value === null || value === "" || value === false;
    if (!present || (empty && field.type !== "checkbox" && field.type !== "consent")) {
      if (field.required === true) {
        violations.push(violation(field.key, "required", "is required"));
      }
      continue;
    }
    if (empty && (field.type === "checkbox" || field.type === "consent")) {
      if (field.required === true) {
        violations.push(
          violation(
            field.key,
            field.type === "consent" ? "consent_required" : "required",
            field.type === "consent" ? "consent must be accepted" : "must be checked",
          ),
        );
      }
      continue;
    }
    try {
      values[field.key] = normalizeOne(field, value);
    } catch (error) {
      if (typeof error === "object" && error !== null && "key" in error && "code" in error) {
        violations.push(error as FieldViolation);
      } else {
        throw error;
      }
    }
  }
  if (violations.length > 0) {
    throw new FormsError("FORM_VALUES_INVALID", "form values failed validation", {
      details: { violations },
    });
  }
  return { values, consent_fields };
}
