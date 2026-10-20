// Bounded condition + payload-mapping model (PCMS-INT-T003; Integrations
// spec §13/§14/§16). Typed operators only — no eval, no arbitrary
// expressions, no JS, no SQL, no shell. Fields are dotted paths into the
// SAFE event metadata (routing-safe fixtures; no PII by contract).
import { IntegrationError } from "./errors.js";

export type ConditionOperator = "eq" | "neq" | "in" | "exists" | "gt" | "gte" | "lt" | "lte";

/** Bounded retry policy per binding (spec §19/§20). */
export interface FailurePolicy {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
}

export interface BindingCondition {
  readonly field: string;
  readonly op: ConditionOperator;
  /** Required for all ops except exists (where boolean true/false). */
  readonly value?: unknown;
}

const FIELD_SEGMENT = /^[a-z_][a-z0-9_]*$/i;
const MAX_PATH_DEPTH = 5;
const MAX_CONDITIONS = 16;
const MAX_IN_VALUES = 20;

function assertFieldPath(path: unknown, label: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 120) {
    throw new IntegrationError("INTEGRATION_CONDITION_INVALID", `${label} must be a dotted path`);
  }
  const segments = path.split(".");
  if (segments.length > MAX_PATH_DEPTH || segments.some((s) => !FIELD_SEGMENT.test(s))) {
    throw new IntegrationError(
      "INTEGRATION_CONDITION_INVALID",
      `${label} "${path}" is not a bounded dotted path`,
    );
  }
  return path;
}

/** Validates the declarative condition list; throws on anything untyped. */
export function validateConditions(conditions: unknown): readonly BindingCondition[] {
  if (conditions === undefined || conditions === null) return [];
  if (!Array.isArray(conditions) || conditions.length > MAX_CONDITIONS) {
    throw new IntegrationError(
      "INTEGRATION_CONDITION_INVALID",
      `conditions must be an array of at most ${MAX_CONDITIONS}`,
    );
  }
  return conditions.map((entry, index): BindingCondition => {
    if (typeof entry !== "object" || entry === null) {
      throw new IntegrationError(
        "INTEGRATION_CONDITION_INVALID",
        `conditions/${index} not an object`,
      );
    }
    const raw = entry as Record<string, unknown>;
    const field = assertFieldPath(raw["field"], `conditions/${index}.field`);
    const op = raw["op"];
    if (
      op !== "eq" &&
      op !== "neq" &&
      op !== "in" &&
      op !== "exists" &&
      op !== "gt" &&
      op !== "gte" &&
      op !== "lt" &&
      op !== "lte"
    ) {
      throw new IntegrationError(
        "INTEGRATION_CONDITION_INVALID",
        `conditions/${index}.op "${String(op)}" is not a supported operator`,
      );
    }
    if (op === "exists") {
      if (typeof raw["value"] !== "boolean") {
        throw new IntegrationError(
          "INTEGRATION_CONDITION_INVALID",
          `conditions/${index}: exists requires a boolean value`,
        );
      }
      return { field, op, value: raw["value"] as boolean };
    }
    if (raw["value"] === undefined) {
      throw new IntegrationError(
        "INTEGRATION_CONDITION_INVALID",
        `conditions/${index}: value required for ${op}`,
      );
    }
    if (op === "in") {
      if (
        !Array.isArray(raw["value"]) ||
        raw["value"].length === 0 ||
        raw["value"].length > MAX_IN_VALUES
      ) {
        throw new IntegrationError(
          "INTEGRATION_CONDITION_INVALID",
          `conditions/${index}: in requires 1–${MAX_IN_VALUES} values`,
        );
      }
      return { field, op, value: [...raw["value"]] };
    }
    if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
      // Typed ordered comparison: numbers only, both sides (spec §14).
      if (typeof raw["value"] !== "number" || !Number.isFinite(raw["value"])) {
        throw new IntegrationError(
          "INTEGRATION_CONDITION_INVALID",
          `conditions/${index}: ${op} requires a finite number`,
        );
      }
      return { field, op, value: raw["value"] as number };
    }
    return { field, op, value: raw["value"] as unknown };
  });
}

/** Reads a dotted path from plain JSON data (arrays addressed by index). */
export function readPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** All conditions must hold (AND). Unknown fields behave as absent. */
export function evaluateConditions(
  conditions: readonly BindingCondition[],
  data: unknown,
): boolean {
  return conditions.every((condition) => {
    const actual = readPath(data, condition.field);
    switch (condition.op) {
      case "exists":
        return (actual !== undefined) === (condition.value === true);
      case "eq":
        return jsonEqual(actual, condition.value);
      case "neq":
        return !jsonEqual(actual, condition.value);
      case "in":
        return (
          Array.isArray(condition.value) &&
          condition.value.some((option) => jsonEqual(actual, option))
        );
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        if (typeof actual !== "number" || typeof condition.value !== "number") return false;
        if (condition.op === "gt") return actual > condition.value;
        if (condition.op === "gte") return actual >= condition.value;
        if (condition.op === "lt") return actual < condition.value;
        return actual <= condition.value;
      default:
        return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Payload mapping (spec §16): declarative, allowlisted sources only.
// ---------------------------------------------------------------------------

export type MappingValue =
  | { readonly $event: string }
  | { readonly $project: string }
  | { readonly $literal: unknown };

export type PayloadMapping = Readonly<Record<string, MappingValue>>;

const MAX_MAPPING_ENTRIES = 32;
const MAX_LITERAL_CHARS = 2000;

/** Validates a mapping table; target paths and source refs are bounded. */
export function validatePayloadMapping(mapping: unknown): PayloadMapping {
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
    throw new IntegrationError("INTEGRATION_BINDING_INVALID", "payload_mapping must be an object");
  }
  const entries = Object.entries(mapping as Record<string, unknown>);
  if (entries.length > MAX_MAPPING_ENTRIES) {
    throw new IntegrationError(
      "INTEGRATION_BINDING_INVALID",
      `payload_mapping exceeds ${MAX_MAPPING_ENTRIES} entries`,
    );
  }
  const out: Record<string, MappingValue> = {};
  for (const [target, source] of entries) {
    assertFieldPath(target, `payload_mapping target "${target}"`);
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      throw new IntegrationError(
        "INTEGRATION_BINDING_INVALID",
        `payload_mapping/${target}: source must be {$event|$project|$literal}`,
      );
    }
    const keys = Object.keys(source);
    if (keys.length !== 1) {
      throw new IntegrationError(
        "INTEGRATION_BINDING_INVALID",
        `payload_mapping/${target}: exactly one of $event/$project/$literal`,
      );
    }
    const [kind] = keys as [keyof MappingValue];
    const value = (source as Record<string, unknown>)[kind];
    if (kind === "$event" || kind === "$project") {
      assertFieldPath(value, `payload_mapping/${target}.${kind}`);
      out[target] = { [kind]: value } as MappingValue;
    } else if (kind === "$literal") {
      const literal = JSON.stringify(value ?? null);
      if (literal === undefined || literal.length > MAX_LITERAL_CHARS) {
        throw new IntegrationError(
          "INTEGRATION_BINDING_INVALID",
          `payload_mapping/${target}: literal exceeds ${MAX_LITERAL_CHARS} chars`,
        );
      }
      out[target] = { $literal: value as unknown };
    } else {
      throw new IntegrationError(
        "INTEGRATION_BINDING_INVALID",
        `payload_mapping/${target}: unknown source "${String(kind)}"`,
      );
    }
  }
  return out;
}

/**
 * Resolves a mapping against the event payload and the injected projection.
 * `$project` without a projection source is a configuration failure — the
 * composition layer did not wire the projection boundary (spec §6).
 */
export function resolvePayloadMapping(
  mapping: PayloadMapping,
  eventPayload: unknown,
  projection: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [target, source] of Object.entries(mapping)) {
    if ("$event" in source) {
      out[target] = readPath(eventPayload, source.$event);
    } else if ("$project" in source) {
      if (projection === null) {
        throw new IntegrationError(
          "INTEGRATION_PROJECTION_UNAVAILABLE",
          `mapping target "${target}" needs a projected field but no projection source is wired`,
        );
      }
      out[target] = readPath(projection, source.$project);
    } else {
      out[target] = source.$literal;
    }
  }
  return out;
}
