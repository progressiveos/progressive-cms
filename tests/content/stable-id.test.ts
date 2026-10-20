// PCMS-CONT-T002 — stable ID type/generator for Entry/Block/Repeater item.
// Acceptance: round-trip + uniqueness tests (Content spec §4 — opaque,
// unique, independent of title/slug/path, safe for public APIs).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type EntryId,
  isStableId,
  newEntryId,
  newRepeaterItemId,
  newStableId,
  type RepeaterItemId,
  type StableId,
  stableIdAs,
} from "@pcms/content";

test("generated IDs are canonical lowercase UUIDv7 strings", () => {
  const id = newStableId();
  assert.equal(typeof id, "string");
  assert.equal(id, id.toLowerCase());
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("validator accepts generated IDs and rejects non-canonical or foreign shapes", () => {
  assert.equal(isStableId(newStableId()), true);
  // RFC 4122 v4 (not v7): wrong version nibble.
  assert.equal(isStableId("9b2f1c8a-3f4e-4a5b-8c6d-7e8f9a0b1c2d"), false);
  // Version 7 but wrong variant bits.
  assert.equal(isStableId("018f6d2c-5f31-7abc-1def-2a3b4c5d6e7f"), false);
  // Uppercase spelling is not canonical — stable links must not drift.
  assert.equal(isStableId("018F6D2C-5F31-7ABC-8DEF-2A3B4C5D6E7F"), false);
  assert.equal(isStableId("018f6d2c5f317abc8def2a3b4c5d6e7f"), false); // no dashes
  assert.equal(isStableId(""), false);
  assert.equal(isStableId(123), false);
  assert.equal(isStableId(null), false);
  assert.equal(isStableId({}), false);
});

test("round-trip: string conversion and JSON survive identity exactly", () => {
  const id = newStableId();
  assert.equal(String(id), id);
  const json = JSON.stringify({ id });
  assert.equal((JSON.parse(json) as { id: string }).id, id);
  // Validation of the parsed value returns the identical text form.
  const parsed: unknown = JSON.parse(json) as { id: string };
  assert.ok(isStableId((parsed as { id: string }).id));
  assert.equal((parsed as { id: string }).id, id);
});

test("uniqueness: 10 000 IDs are pairwise distinct", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) seen.add(newStableId());
  assert.equal(seen.size, 10_000);
});

test("IDs are roughly time-ordered (UUIDv7 timestamp locality)", () => {
  const timestampOf = (id: string): number =>
    Number(BigInt(`0x${id.replaceAll("-", "").slice(0, 12)}`));
  const a = timestampOf(newStableId());
  const b = timestampOf(newStableId());
  assert.ok(b >= a, "later-generated ID must not have an earlier timestamp");
  // Timestamp embeds the current Unix time within a small tolerance.
  const delta = a - Date.now();
  assert.ok(Math.abs(delta) < 5_000, `timestamp drifted ${delta}ms from wall clock`);
});

test("entity-branded IDs are distinct types over the same canonical form", () => {
  const entry: EntryId = newEntryId();
  const item: RepeaterItemId = newRepeaterItemId();
  for (const id of [entry, item]) assert.equal(isStableId(id), true);
  // Runtime narrowing keeps only canonical strings, per entity brand.
  assert.ok(stableIdAs(entry, (v) => v as EntryId) !== null);
  assert.equal(
    stableIdAs("not-an-id", (v) => v as EntryId),
    null,
  );
});

test("IDs do not derive from content data (opaque identity)", () => {
  // Same title/slug must never correlate to the same generated ID.
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const entry: EntryId = newEntryId();
    ids.add(entry);
  }
  assert.equal(ids.size, 100);
  const asGeneric: StableId = newStableId();
  assert.notEqual(asGeneric, "about"); // identity is never a slug
});
