// PCMS-EXT-T002 — Controlled registry infrastructure.
// Acceptance (Master Plan M14): controlled registrations, duplicate/collision
// semantics, enable/disable registration boundary. Invariants (spec §51):
// no arbitrary hook surface, no last-wins collisions, a disabled extension
// registers nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  composeExtensionRegistrations,
  createExtensionCatalog,
  defineExtensionArtifact,
  ExtensionError,
  type ExtensionManifest,
  manifestFingerprint,
  resolveHandler,
  validateExtensionManifest,
} from "@pcms/extensions/internal";

const referenceDoc = JSON.parse(
  readFileSync("fixtures/extensions/manifest-v2/valid-reference.json", "utf8"),
) as ExtensionManifest;

function artifact(
  overrides: Partial<Record<keyof typeof referenceDoc, unknown>> & { id?: string },
  module: Record<string, unknown> = {},
) {
  return defineExtensionArtifact({
    manifest: { ...referenceDoc, ...overrides },
    module,
    migrationsDir: `/trusted/deployed/${overrides.id ?? referenceDoc.id}/migrations`,
  });
}

test("catalog registers deployed artifacts and rejects duplicate ids", () => {
  const catalog = createExtensionCatalog();
  catalog.register(artifact({ id: "com.example.alpha" }));
  assert.equal(catalog.has("com.example.alpha"), true);
  assert.deepEqual(
    catalog.list().map((entry) => entry.manifest.id),
    ["com.example.alpha"],
  );
  assert.throws(
    () => catalog.register(artifact({ id: "com.example.alpha", name: "Second" })),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_ALREADY_DEPLOYED",
  );
});

test("defineExtensionArtifact is the only trusted path and validates manifests", () => {
  assert.throws(
    () =>
      defineExtensionArtifact({
        manifest: { ...referenceDoc, version: "not-semver" },
        module: {},
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_MANIFEST_INVALID",
  );
  // Declared migrations must be bound by the deployment.
  assert.throws(
    () => defineExtensionArtifact({ manifest: referenceDoc, module: {} }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_DEPLOYMENT_INVALID",
  );
  const bound = defineExtensionArtifact({
    manifest: referenceDoc,
    module: {},
    migrationsDir: "/trusted/deployed/site-basics/migrations",
  });
  assert.equal(bound.migrationsDir, "/trusted/deployed/site-basics/migrations");
});

test("handler resolution is fail-closed on named exports only", () => {
  const entry = artifact({ id: "com.example.handlers" }, { onEntryPublished: () => "ok" });
  const fn = resolveHandler(entry, "onEntryPublished");
  assert.equal(typeof fn, "function");
  assert.throws(
    () => resolveHandler(entry, "missingHandler"),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_HANDLER_UNRESOLVED",
  );
});

test("composition: enabled extension registers, disabled registers nothing", () => {
  const catalog = createExtensionCatalog();
  catalog.register(artifact({ id: "com.example.enabled" }));
  catalog.register(artifact({ id: "com.example.disabled" }));

  // The caller passes only enabled ids — a disabled extension is simply not
  // in the set, so it contributes nothing to the composed registrations.
  const enabled = composeExtensionRegistrations(catalog, ["com.example.enabled"]);
  assert.ok(enabled.registrations.length > 0);
  assert.ok(enabled.registrations.every((r) => r.extensionId === "com.example.enabled"));

  const empty = composeExtensionRegistrations(catalog, []);
  assert.deepEqual(empty.registrations, []);
});

test("composition: enabled-but-undeployed ids are surfaced, not silently ignored", () => {
  const catalog = createExtensionCatalog();
  const result = composeExtensionRegistrations(catalog, ["com.example.ghost"]);
  assert.deepEqual(result.undeployed, ["com.example.ghost"]);
  assert.deepEqual(result.registrations, []);
});

test("composition: collision fails closed — no last-wins", () => {
  const catalog = createExtensionCatalog();
  catalog.register(artifact({ id: "com.example.first" }));
  catalog.register(
    artifact(
      {
        id: "com.example.second",
        registrations: { blocks: [{ block_type: "site-basics.banner" }] },
      },
      {},
    ),
  );
  assert.throws(
    () => composeExtensionRegistrations(catalog, ["com.example.first", "com.example.second"]),
    (error: unknown) => {
      if (!(error instanceof ExtensionError) || error.code !== "EXTENSION_REGISTRATION_CONFLICT") {
        return false;
      }
      assert.equal(error.details?.owner, "com.example.first");
      assert.equal(error.details?.challenger, "com.example.second");
      return true;
    },
  );
});

test("composition is deterministic regardless of enabled-id order", () => {
  const manifest = validateExtensionManifest(referenceDoc);
  assert.equal(manifest.ok, true);
  const catalog = createExtensionCatalog();
  catalog.register(
    artifact({ id: "com.example.aaa", registrations: { blocks: [{ block_type: "aaa.block" }] } }),
  );
  catalog.register(
    artifact({ id: "com.example.bbb", registrations: { blocks: [{ block_type: "bbb.block" }] } }),
  );
  const a = composeExtensionRegistrations(catalog, ["com.example.bbb", "com.example.aaa"]);
  const b = composeExtensionRegistrations(catalog, ["com.example.aaa", "com.example.bbb"]);
  assert.deepEqual(a, b);
  const ids = a.registrations.map((r) => r.extensionId);
  assert.deepEqual(ids, [...ids].sort());
});

test("manifest fingerprint is deterministic and distinct per content", () => {
  const first = manifestFingerprint(validateOrThrow(referenceDoc));
  const second = manifestFingerprint(validateOrThrow(referenceDoc));
  assert.equal(first, second);
  const changed = manifestFingerprint(validateOrThrow({ ...referenceDoc, version: "1.2.4" }));
  assert.notEqual(first, changed);
});

function validateOrThrow(doc: unknown): ExtensionManifest {
  const result = validateExtensionManifest(doc);
  if (!result.ok)
    throw new Error(`fixture manifest became invalid: ${JSON.stringify(result.issues)}`);
  return result.manifest;
}
