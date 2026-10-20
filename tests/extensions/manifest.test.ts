// CORE-PREPUBLIC-01 — Extension manifest v2 public contract.
// Acceptance (Master Plan M14): valid reference manifest accepted, bad ID
// rejected, invalid semver rejected, unknown/invalid registration rejected,
// unsafe shape rejected. The JSON Schema document is part of the contract:
// it must accept exactly the manifests the validator accepts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  EXTENSION_CONTRACT_VERSION,
  EXTENSION_MANIFEST_ISSUE_CODES,
  EXTENSION_MANIFEST_SCHEMA,
  type ExtensionManifestIssueCode,
  validateExtensionManifest,
} from "@pcms/extensions";

const FIXTURES = "fixtures/extensions/manifest-v2";

test("valid reference manifest is accepted and normalized (PCMS-EXT-T001)", () => {
  const doc = JSON.parse(readFileSync(join(FIXTURES, "valid-reference.json"), "utf8"));
  const result = validateExtensionManifest(doc);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.id, "com.example.site-basics");
  assert.equal(result.manifest.extension_contract, EXTENSION_CONTRACT_VERSION);
  // Normalization: omitted registration categories materialize as empty.
  assert.deepEqual(result.manifest.registrations.field_types, []);
  assert.deepEqual(result.manifest.registrations.providers, []);
  // Data policy defaults to the safe value.
  assert.equal(result.manifest.data_policy, "retain");
});

test("published JSON Schema is a stable contract artifact (PCMS-EXT-T001)", () => {
  // The schema document is the machine-readable manifest contract; it must
  // stay fail-closed and independently consumable.
  const schema = EXTENSION_MANIFEST_SCHEMA as unknown as Record<string, unknown>;
  assert.equal(schema.$id, "https://progressive-cms.dev/schemas/extension-manifest-v2.json");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "id",
    "name",
    "version",
    "extension_contract",
    "cms_compatibility",
    "entrypoint",
    "registrations",
  ]);
  // Round-trips as JSON without loss (documented wire format).
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
});

test("the pre-public 1.0 manifest contract is rejected", () => {
  const document = JSON.parse(readFileSync(join(FIXTURES, "valid-reference.json"), "utf8"));
  const result = validateExtensionManifest({ ...document, extension_contract: "1.0" });
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(result.issues.some((issue) => issue.code === "MANIFEST_CONTRACT_UNSUPPORTED"));
});

test("HTTP route schema accepts PATCH for public mutations", () => {
  const document = JSON.parse(readFileSync(join(FIXTURES, "valid-reference.json"), "utf8"));
  const result = validateExtensionManifest({
    ...document,
    registrations: {
      http_routes: [
        {
          route_id: "patch-item",
          method: "PATCH",
          path: "items/:slug",
          visibility: "public",
          handler: "patchItem",
        },
      ],
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok ? null : result.issues));
});

test("every invalid fixture is rejected with the expected stable issue codes", () => {
  const expected: Record<string, { codes: ExtensionManifestIssueCode[]; paths: string[] }> = {
    "invalid-id.json": { codes: ["MANIFEST_ID_INVALID"], paths: ["id"] },
    "invalid-reserved-id.json": { codes: ["MANIFEST_ID_RESERVED"], paths: ["id"] },
    "invalid-semver.json": {
      codes: [
        "MANIFEST_VERSION_INVALID",
        "MANIFEST_CMS_COMPATIBILITY_INVALID",
        "MANIFEST_REQUIRES_INVALID",
        "MANIFEST_PROVIDES_INVALID",
      ],
      paths: ["version", "cms_compatibility", "requires[0].range", "provides[0].version"],
    },
    "unknown-field.json": { codes: ["MANIFEST_UNKNOWN_FIELD"], paths: ["runtime_hacks"] },
    "unknown-registration.json": {
      codes: ["MANIFEST_UNKNOWN_FIELD"],
      paths: ["registrations.beforeEverything"],
    },
    "unsafe-entrypoint.json": {
      codes: ["MANIFEST_UNKNOWN_FIELD", "MANIFEST_REGISTRATIONS_INVALID"],
      paths: ["entrypoint.path", "registrations.event_subscriptions[0].handler"],
    },
  };
  for (const [file, expectation] of Object.entries(expected)) {
    const doc = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"));
    const result = validateExtensionManifest(doc);
    assert.equal(result.ok, false, `${file} must be rejected`);
    if (result.ok) return;
    const codes = result.issues.map((issue) => issue.code);
    for (const code of expectation.codes) {
      assert.ok(codes.includes(code), `${file}: expected issue ${code}, got ${codes.join(", ")}`);
    }
    for (const path of expectation.paths) {
      assert.ok(
        result.issues.some((issue) => issue.path === path),
        `${file}: expected issue at ${path}`,
      );
    }
    for (const issue of result.issues) {
      assert.ok(
        EXTENSION_MANIFEST_ISSUE_CODES.includes(issue.code),
        `${file}: issue code ${issue.code} is not part of the stable contract`,
      );
    }
  }
});

test("semantic layer: reserved ids and duplicates fail even in structurally valid shapes", () => {
  const base = {
    id: "com.example.dup",
    name: "Dup",
    version: "1.0.0",
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    entrypoint: { type: "module" },
    registrations: {},
  };
  const duplicateProvide = validateExtensionManifest({
    ...base,
    provides: [
      { capability: "search.provider", version: "1.0.0" },
      { capability: "search.provider", version: "2.0.0" },
    ],
  });
  assert.equal(duplicateProvide.ok, false);
  if (!duplicateProvide.ok) {
    assert.ok(duplicateProvide.issues.some((issue) => issue.code === "MANIFEST_DUPLICATE"));
  }
  const duplicateSubscription = validateExtensionManifest({
    ...base,
    registrations: {
      event_subscriptions: [
        { subscription_id: "same", event_type: "EntryPublished", handler: "a" },
        { subscription_id: "same", event_type: "MediaUploaded", handler: "b" },
      ],
    },
  });
  assert.equal(duplicateSubscription.ok, false);
  if (!duplicateSubscription.ok) {
    assert.ok(duplicateSubscription.issues.some((issue) => issue.code === "MANIFEST_DUPLICATE"));
  }
});

test("unsafe config schema keywords are rejected (bounded SDK subset)", () => {
  const result = validateExtensionManifest({
    id: "com.example.schema",
    name: "Schema",
    version: "1.0.0",
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    config_schema: { type: "object", $ref: "https://evil.example/schema.json" },
    entrypoint: { type: "module" },
    registrations: {},
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.issues.some(
        (issue) => issue.code === "MANIFEST_CONFIG_SCHEMA_INVALID" && issue.path.includes("$ref"),
      ),
    );
  }
});

test("non-object and oversized documents are rejected before schema evaluation", () => {
  for (const bad of [null, 42, "manifest", []]) {
    const result = validateExtensionManifest(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issues[0]?.code, "MANIFEST_NOT_OBJECT");
    }
  }
  const huge = validateExtensionManifest({
    id: "com.example.huge",
    name: "x".repeat(300 * 1024),
    version: "1.0.0",
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    entrypoint: { type: "module" },
    registrations: {},
  });
  assert.equal(huge.ok, false);
  if (!huge.ok) {
    assert.equal(huge.issues[0]?.code, "MANIFEST_TOO_LARGE");
  }
});

test("all invalid manifest fixtures in the corpus stay rejected (corpus safety)", () => {
  // Guards against a fixture being edited into acceptance: the corpus
  // directory must contain only the known-valid reference plus rejects.
  const files = readdirSync(FIXTURES).sort();
  assert.deepEqual(files, [
    "invalid-id.json",
    "invalid-reserved-id.json",
    "invalid-semver.json",
    "unknown-field.json",
    "unknown-registration.json",
    "unsafe-entrypoint.json",
    "valid-reference.json",
  ]);
  for (const file of files.filter(
    (name) =>
      name.startsWith("invalid-") || name.startsWith("unsafe") || name.startsWith("unknown"),
  )) {
    const result = validateExtensionManifest(
      JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
    );
    assert.equal(result.ok, false, `${file} must stay rejected`);
  }
});
