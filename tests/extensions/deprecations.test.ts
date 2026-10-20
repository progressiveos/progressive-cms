// PCMS-EXT-T011 — Deprecation registry.
// Acceptance (Master Plan M14): deprecated supported contract visible,
// replacement/removal metadata complete, and a minor removal without a
// valid policy fails the compatibility gate (assertRemovalPolicyCompliant
// is the gate primitive the update preflight and contract diff share).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRemovalPolicyCompliant,
  createDeprecationRegistry,
  type DeprecationRecord,
  ExtensionError,
} from "@pcms/extensions/internal";

const record: DeprecationRecord = {
  id: "rest_api.entries.legacy_status_field",
  contract: "rest_api",
  item: "GET /entries/{entryId} field legacy_status",
  introduced: "1.0.0",
  deprecated_in: "1.1.0",
  replacement: "GET /entries/{entryId} field state",
  planned_removal_major: 2,
  migration_tool: "cms content migrate legacy-status",
  status: "active",
  usage_key: "rest:entries:legacy_status",
  documentation: "docs/deprecations/legacy-status.md",
};

test("deprecation records carry the full machine-readable metadata", () => {
  const registry = createDeprecationRegistry([record]);
  const stored = registry.get("rest_api.entries.legacy_status_field");
  assert.equal(stored?.deprecated_in, "1.1.0");
  assert.equal(stored?.replacement, "GET /entries/{entryId} field state");
  assert.equal(stored?.planned_removal_major, 2);
  assert.equal(stored?.usage_key, "rest:entries:legacy_status");
  assert.deepEqual(registry.byContract("rest_api"), [record]);
  assert.deepEqual(registry.activeUsageKeys(), ["rest:entries:legacy_status"]);
});

test("registry discovery is deterministic and duplicate ids collide", () => {
  const registry = createDeprecationRegistry([
    record,
    {
      ...record,
      id: "aaa.something.else",
      contract: "mcp",
      item: "tool cms_legacy_tool",
      replacement: "tool cms_new_tool",
      planned_removal_major: 3,
    },
  ]);
  assert.deepEqual(
    registry.list().map((entry) => entry.id),
    ["aaa.something.else", "rest_api.entries.legacy_status_field"],
  );
  assert.throws(
    () => registry.register(record),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_REGISTRATION_CONFLICT",
  );
});

test("invalid records fail closed: bad semver, no replacement, junk ids", () => {
  const registry = createDeprecationRegistry();
  assert.throws(
    () => registry.register({ ...record, deprecated_in: "latest" }),
    (error: unknown) => error instanceof ExtensionError,
  );
  assert.throws(
    () =>
      registry.register({
        ...record,
        id: "rest_api.entries.no_replacement",
        replacement: undefined,
      } as unknown as DeprecationRecord),
    (error: unknown) => error instanceof ExtensionError,
  );
  assert.throws(
    () => registry.register({ ...record, id: "Not Valid" }),
    (error: unknown) => error instanceof ExtensionError,
  );
  assert.throws(
    () => registry.register({ ...record, planned_removal_major: 0 }),
    (error: unknown) => error instanceof ExtensionError,
  );
});

test("minor removal without a valid policy fails the compatibility gate", () => {
  // No deprecation record at all — a minor must not remove anything public.
  assert.throws(
    () =>
      assertRemovalPolicyCompliant(undefined, {
        removalVersion: "1.1.0",
        isMajorRelease: false,
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "UPDATE_COMPATIBILITY_BLOCKED",
  );
  // With a record promising removal in major 2 — a minor is still blocked.
  assert.throws(
    () =>
      assertRemovalPolicyCompliant(record, {
        removalVersion: "1.1.0",
        isMajorRelease: false,
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "UPDATE_COMPATIBILITY_BLOCKED",
  );
  // Early major (before the promised one) is blocked as well.
  assert.throws(
    () =>
      assertRemovalPolicyCompliant(record, {
        removalVersion: "1.9.0",
        isMajorRelease: true,
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "UPDATE_COMPATIBILITY_BLOCKED",
  );
});

test("removal inside the promised major passes the gate", () => {
  assertRemovalPolicyCompliant(record, {
    removalVersion: "2.0.0",
    isMajorRelease: true,
  });
  // Undeprecated removal is legal in a major release (with review).
  assertRemovalPolicyCompliant(undefined, {
    removalVersion: "2.0.0",
    isMajorRelease: true,
  });
});
