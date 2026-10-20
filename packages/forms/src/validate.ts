// Shared bounded-validation helpers (Forms spec §37: input size limits,
// allowlist discipline). Internal to @pcms/forms.
import { FormsError } from "./errors.js";

/** Stable machine keys: lowercase identifier, no HTML specials by design. */
const MACHINE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Selectable option values: looser than machine keys (digits-first such as
 * "1"/"3p" are legitimate), still attribute-safe and bounded. */
const OPTION_VALUE_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/;

export function assertOptionValue(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || !OPTION_VALUE_RE.test(value)) {
    throw new FormsError(code, `${label} must match ${OPTION_VALUE_RE.source}`);
  }
  return value;
}

export function assertMachineKey(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || !MACHINE_KEY_RE.test(value)) {
    throw new FormsError(code, `${label} must match ${MACHINE_KEY_RE.source}`);
  }
  return value;
}

/** Trims and bounds a string field; non-strings are rejected. */
export function boundedText(
  value: unknown,
  code: string,
  label: string,
  max: number,
  options?: { readonly min?: number },
): string {
  if (typeof value !== "string") throw new FormsError(code, `${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < (options?.min ?? 1)) {
    throw new FormsError(code, `${label} must be at least ${options?.min ?? 1} character(s)`);
  }
  if (trimmed.length > max)
    throw new FormsError(code, `${label} must be at most ${max} characters`);
  return trimmed;
}

export function optionalText(
  value: unknown,
  code: string,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedText(value, code, label, max, { min: 0 }) || undefined;
}

/** Fail-secure object shape: unknown keys are rejected, not ignored. */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new FormsError(code, `${label} has unsupported keys`, { details: { keys: unknown } });
  }
}

export function asRecord(value: unknown, code: string, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FormsError(code, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function boundedInt(
  value: unknown,
  code: string,
  label: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new FormsError(code, `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
  label: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new FormsError(code, `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export interface RetentionPolicyLike {
  readonly mode: "retain" | "anonymize" | "delete";
  readonly after_days?: number;
}

/**
 * Shared lead-policy retention block (forms and quizzes): mode oneOf +
 * after_days 1..36500, and after_days required unless mode is "retain".
 */
export function parseRetentionPolicy<T extends RetentionPolicyLike>(
  value: unknown,
  code: string,
): T {
  const rp = asRecord(value, code, "settings.retention");
  rejectUnknownKeys(rp, ["mode", "after_days"], code, "settings.retention");
  const mode = oneOf(
    rp.mode,
    ["retain", "anonymize", "delete"] as const,
    code,
    "settings.retention.mode",
  );
  const policy = { mode } as { -readonly [K in keyof T]?: T[K] };
  if (rp.after_days !== undefined) {
    policy.after_days = boundedInt(
      rp.after_days,
      code,
      "retention.after_days",
      1,
      36_500,
    ) as T["after_days"];
  }
  if (mode !== "retain" && policy.after_days === undefined) {
    throw new FormsError(code, `retention mode "${mode}" requires after_days`);
  }
  return policy as T;
}
