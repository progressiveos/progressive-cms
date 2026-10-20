// PCMS-EXT-T010 — CMS/config/contract version registries.
// Acceptance (Master Plan M14): doctor/machine discovery sees deterministic
// versions. Values flow from each subsystem's canonical constant; the
// registry fails closed on duplicates and invalid CMS versions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BLOCK_DOCUMENT_SCHEMA_VERSION } from "@pcms/blocks";
import { CONFIG_SCHEMA_VERSION } from "@pcms/core";
import {
  createContractVersionRegistry,
  createSystemContractVersionRegistry,
  discoverCmsVersion,
  EXTENSION_CONTRACT_VERSION,
  ExtensionError,
  SUPPORTED_POSTGRES_RANGE,
} from "@pcms/extensions/internal";
import { SEARCH_INDEX_VERSION } from "@pcms/search";
import { THEME_CONTRACT_VERSION } from "@pcms/themes";
import { coerce, satisfies } from "semver";

test("system registry exposes every canonical contract version deterministically", () => {
  const cmsVersion = discoverCmsVersion(JSON.parse(readFileSync("package.json", "utf8")));
  const registry = createSystemContractVersionRegistry({
    cmsVersion,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    extensionContractVersion: EXTENSION_CONTRACT_VERSION,
    restApiVersion: "1.0.0",
    mcpProtocolVersion: "2024-11-05",
    themeContractVersion: THEME_CONTRACT_VERSION,
    blockDocumentSchemaVersion: BLOCK_DOCUMENT_SCHEMA_VERSION,
    searchIndexVersion: SEARCH_INDEX_VERSION,
    bundleVersion: 1,
    pcpubVersion: 1,
    pcmdVersion: 1,
  });
  const keys = registry.list().map((entry) => entry.key);
  assert.deepEqual(keys, [
    "block_document",
    "bundle",
    "cms",
    "config_schema",
    "extension_contract",
    "mcp",
    "pcmd",
    "pcpub",
    "rest_api",
    "search_index",
    "theme_contract",
  ]);
  // Deterministic across calls.
  const again = createSystemContractVersionRegistry({
    cmsVersion,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    extensionContractVersion: EXTENSION_CONTRACT_VERSION,
    restApiVersion: "1.0.0",
    mcpProtocolVersion: "2024-11-05",
    themeContractVersion: THEME_CONTRACT_VERSION,
    blockDocumentSchemaVersion: BLOCK_DOCUMENT_SCHEMA_VERSION,
    searchIndexVersion: SEARCH_INDEX_VERSION,
    bundleVersion: 1,
    pcpubVersion: 1,
    pcmdVersion: 1,
  });
  assert.deepEqual(
    registry.list().map((entry) => [entry.key, entry.version]),
    again.list().map((entry) => [entry.key, entry.version]),
  );
  // Values come from the canonical constants, not copies (versions are
  // normalized to strings on the wire).
  assert.equal(registry.get("theme_contract")?.version, THEME_CONTRACT_VERSION);
  assert.equal(registry.get("block_document")?.version, String(BLOCK_DOCUMENT_SCHEMA_VERSION));
  assert.equal(registry.get("extension_contract")?.version, EXTENSION_CONTRACT_VERSION);
  assert.equal(registry.get("config_schema")?.version, String(CONFIG_SCHEMA_VERSION));
});

test("CMS version discovery accepts the deployed release document and rejects junk", () => {
  assert.equal(discoverCmsVersion({ name: "progressive-cms", version: "0.0.0" }), "0.0.0");
  for (const bad of [undefined, {}, { version: "not-semver" }, { version: 42 }]) {
    assert.throws(
      () => discoverCmsVersion(bad),
      (error: unknown) =>
        error instanceof ExtensionError && error.code === "EXTENSION_MANIFEST_INVALID",
    );
  }
});

test("duplicate contract keys conflict instead of silently overriding", () => {
  const registry = createContractVersionRegistry();
  registry.register({ key: "theme_contract", version: "1.0.0", source: "cms:themes" });
  assert.throws(
    () => registry.register({ key: "theme_contract", version: "9.9.9", source: "cms:other" }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_REGISTRATION_CONFLICT",
  );
});

test("PCMS-OPS-T107: runtime gates cover the proven production PostgreSQL majors", () => {
  // Dev/integration runs PostgreSQL 16; the M15 production contour (pg1)
  // runs 18.x on Ubuntu 26.04. Both must satisfy the supported range; an
  // unproven future major (19) must not.
  // SELECT version() reports two-part majors ("18.6" on Ubuntu); the
  // compatibility scanner coerces partial versions — mirror that here.
  assert.equal(satisfies(coerce("16.9") ?? "16.9.0", SUPPORTED_POSTGRES_RANGE), true);
  assert.equal(satisfies(coerce("18.6") ?? "18.6.0", SUPPORTED_POSTGRES_RANGE), true);
  assert.equal(satisfies(coerce("19.0") ?? "19.0.0", SUPPORTED_POSTGRES_RANGE), false);
  assert.equal(satisfies(coerce("13.14") ?? "13.14.0", SUPPORTED_POSTGRES_RANGE), false);
});
