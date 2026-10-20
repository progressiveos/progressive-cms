// Generic stable opaque identity (PCMS-CONT-T002/T013; Content spec §4).
//
// Baseline §7: Core owns object identity. This module is the identity kernel
// every subsystem builds on: unique, independent of titles/slugs/paths, safe
// for public APIs, usable as stable cross-entity references.
//
// Format: UUIDv7 (RFC 9562) — canonical lowercase 8-4-4-4-12 hex, generated
// with node:crypto only (no dependency; same posture as ADR-0004). The
// embedded 48-bit Unix-millisecond timestamp keeps IDs roughly time-ordered
// (PostgreSQL B-tree locality, ADR-0002); 74 random bits make
// same-millisecond collisions negligible. Validators accept exactly the
// canonical form so stable links cannot drift between spellings.
import { randomBytes } from "node:crypto";

declare const stableIdBrand: unique symbol;
/** Generic opaque stable ID in canonical UUIDv7 form. */
export type StableId = string & { readonly [stableIdBrand]: "pcms.stable-id" };

const CANONICAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True when `value` is a canonical UUIDv7 stable ID string. */
export function isStableId(value: unknown): value is StableId {
  return typeof value === "string" && CANONICAL_RE.test(value);
}

/** Generates a fresh opaque stable ID (UUIDv7, canonical lowercase). */
export function newStableId(): StableId {
  const bytes = randomBytes(16);
  const nowMs = Date.now();
  // 48-bit big-endian Unix milliseconds (bytes 0–5).
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((BigInt(nowMs) >> BigInt(8 * (5 - i))) & 0xffn);
  }
  // Version 7 in the high nibble of byte 6; 12 random bits follow.
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  // 2-bit variant `10` in the top bits of byte 8; 62 random bits in total.
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-") as StableId;
}
