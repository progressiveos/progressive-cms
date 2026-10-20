// Deterministic payload canonicalization + hashing (PCMS-PUB-T004 semantics,
// types introduced T001). Identical canonical payloads must produce identical
// hashes regardless of object insertion order, whitespace or volatile data
// (owner instruction #14 / spec §51).
import { createHash } from "node:crypto";
import { RevisionError } from "./errors.js";

/**
 * Canonical JSON: object keys deep-sorted by Unicode code units, no
 * whitespace, standard JSON number/string/bool/null serialization.
 * Non-JSON-representable values (cycles, BigInt, functions, symbols) are
 * rejected with REVISION_PAYLOAD_NOT_SERIALIZABLE — silently coercing them
 * would break hash determinism.
 */
export function canonicalJsonString(value: unknown): string {
  const parts: string[] = [];
  writeCanonical(value, parts, 0);
  return parts.join("");
}

function writeCanonical(value: unknown, out: string[], depth: number): void {
  if (depth > 128) {
    throw new RevisionError(
      "REVISION_PAYLOAD_NOT_SERIALIZABLE",
      "payload nesting exceeds 128 levels",
    );
  }
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new RevisionError(
          "REVISION_PAYLOAD_NOT_SERIALIZABLE",
          "NaN/Infinity are not canonical JSON numbers",
        );
      }
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "bigint":
    case "function":
    case "symbol":
      throw new RevisionError(
        "REVISION_PAYLOAD_NOT_SERIALIZABLE",
        `values of type ${typeof value} have no canonical JSON form`,
      );
    case "object":
      break;
    default:
      throw new RevisionError(
        "REVISION_PAYLOAD_NOT_SERIALIZABLE",
        `value of type ${typeof value} is not serializable`,
      );
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(",");
      writeCanonical(value[i], out, depth + 1);
    }
    out.push("]");
    return;
  }
  if (value instanceof Date) {
    out.push(JSON.stringify(value.toISOString()));
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  out.push("{");
  let first = true;
  for (const key of keys) {
    const member = record[key];
    if (member === undefined) continue; // JSON semantics: undefined members vanish
    if (!first) out.push(",");
    first = false;
    out.push(JSON.stringify(key), ":");
    writeCanonical(member, out, depth + 1);
  }
  out.push("}");
}

/** SHA-256 hex digest of the canonical JSON form. */
export function hashCanonicalPayload(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}
