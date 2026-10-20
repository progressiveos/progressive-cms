// PCMS-EXT-T018 — Reference site extension vertical slice.
// Acceptance (Master Plan M14): deployed in trusted catalog, manifest
// validates, install (applies its own migration), enable, capability
// visible, event/validator contribution works, disable removes the
// contribution, uninstall retain preserves data, and no Core patch
// (public-surface import guard).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  systemClock,
} from "@pcms/core";
import {
  composeExtensionRegistrations,
  createCapabilityRegistry,
  createExtensionCatalog,
  createExtensionConfigSpace,
  createExtensionEventConsumer,
  createExtensionLifecycleService,
  createSystemContractVersionRegistry,
  createValidatorExtensionPoint,
  defineExtensionArtifact,
  type ExtensionEventHandler,
  type ExtensionEventSubscriptionSpec,
  type ExtensionLifecycleService,
  mergeOutboxHandlers,
  registerValidatorContributions,
  validateExtensionConfig,
  validateExtensionManifest,
} from "@pcms/extensions/internal";
import { createOutboxConsumer, createOutboxService, writeOutboxEvent } from "@pcms/publication";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const EXTENSION_DIR = "tests/fixtures/reference-site-extension";
const NOTES_TABLE = "com_example_reference_site_notes";

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

/** Builds the trusted catalog exactly as a composition root would. */
function buildCatalog(pool: DbPool, config: Record<string, unknown>) {
  const manifestDoc = JSON.parse(readFileSync(`${EXTENSION_DIR}/manifest.json`, "utf8"));
  const validation = validateExtensionManifest(manifestDoc);
  assert.equal(validation.ok, true, "reference manifest must validate");
  // Trusted deployment path: import the module and bind its dependencies.
  // (Dynamic import keeps the artifact binding explicit.)
  const moduleUrl = new URL(`../../${EXTENSION_DIR}/src/index.ts`, import.meta.url);
  return import(moduleUrl.href).then((module) => {
    const catalog = createExtensionCatalog();
    catalog.register(
      defineExtensionArtifact({
        manifest: manifestDoc,
        module: module.createReferenceSiteExtensionModule({ pool, config }),
        migrationsDir: `${EXTENSION_DIR}/migrations`,
      }),
    );
    return { catalog, manifest: validation.ok ? validation.manifest : undefined };
  });
}

async function buildService(
  pool: DbPool,
  config: Record<string, unknown>,
): Promise<{
  service: ExtensionLifecycleService;
  catalog: Awaited<ReturnType<typeof buildCatalog>>["catalog"];
}> {
  const { catalog } = await buildCatalog(pool, config);
  const system = createCapabilityRegistry();
  system.provide({ key: "theme-contract", version: "1.0.0", provider: "cms:themes" });
  const service = createExtensionLifecycleService({
    pool,
    clock: systemClock,
    coreVersion: "1.0.0-rc.1",
    catalog,
    systemCapabilities: system,
  });
  return { service, catalog };
}

test("manifest validates and the config schema accepts the shipped defaults", async () => {
  const manifestDoc = JSON.parse(readFileSync(`${EXTENSION_DIR}/manifest.json`, "utf8"));
  const validation = validateExtensionManifest(manifestDoc);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const config = validateExtensionConfig({
    extensionId: validation.manifest.id,
    schema: validation.manifest.config_schema,
    config: {},
  });
  assert.equal(config.ok, true);
});

test("vertical slice: install → migrate → enable → capability → events/validators → disable → uninstall retain", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const pool = await setup(t);
  const config = { note_template: "release: {title}" };
  const { service, catalog } = await buildService(pool, config);

  // Install applies the extension-owned migration (separate ledger).
  const install = await service.install({ extensionId: "com.example.reference-site", config });
  assert.deepEqual(install.appliedMigrations, ["0001_create_notes"]);
  const ledger = await pool.query(
    `SELECT name FROM pcms_extension_migrations WHERE extension_id = 'com.example.reference-site'`,
  );
  assert.deepEqual(
    ledger.rows.map((row) => row.name),
    ["0001_create_notes"],
  );

  // Enable.
  await service.enable("com.example.reference-site");

  // Capability is visible through deterministic composition.
  const enabledIds = await service.enabledIds();
  assert.deepEqual(enabledIds, ["com.example.reference-site"]);
  const composition = composeExtensionRegistrations(catalog, enabledIds);
  assert.ok(composition.undeployed.length === 0);
  const provides = catalog.get("com.example.reference-site")?.manifest.provides ?? [];
  const capabilities = createCapabilityRegistry();
  capabilities.provide({ key: "theme-contract", version: "1.0.0", provider: "cms:themes" });
  for (const provision of provides) {
    capabilities.provide({
      key: provision.capability,
      version: provision.version,
      provider: "com.example.reference-site",
    });
  }
  assert.ok(capabilities.has("com.example.reference-site.notes"));

  // Event contribution through the shared fanout (M13 sim rides along).
  const m13Seen: string[] = [];
  const subscriptions: ExtensionEventSubscriptionSpec[] = [];
  for (const entry of composition.registrations) {
    if (entry.kind !== "event_subscription") continue;
    const handler = catalog.get(entry.extensionId)?.module[entry.handler];
    if (typeof handler !== "function") throw new Error("handler must be a function");
    subscriptions.push({
      extensionId: entry.extensionId,
      subscriptionId: entry.subscriptionId,
      eventType: entry.eventType,
      handler: handler as ExtensionEventHandler,
    });
  }
  const eventConsumer = createExtensionEventConsumer({
    pool,
    clock: systemClock,
    subscriptions,
  });
  const handlers = mergeOutboxHandlers([
    {
      EntryPublished: async (event) => {
        m13Seen.push(event.id);
      },
    },
    { EntryPublished: (event) => eventConsumer.handle(event) },
  ]);
  const outbox = createOutboxService(pool, { clock: systemClock });
  const outboxConsumer = createOutboxConsumer(outbox, handlers);
  await writeOutboxEvent(pool, {
    aggregate: "entry",
    aggregateId: "entry-77",
    eventType: "EntryPublished",
    payload: { title: "Hello world" },
  });
  await outboxConsumer.processBatch(10);
  const notes = await pool.query<{ note: string }>(
    `SELECT note FROM ${NOTES_TABLE} WHERE entry_id = 'entry-77'`,
  );
  assert.equal(notes.rows.length, 1, "extension wrote exactly one note");
  assert.equal(notes.rows[0]?.note, "release: Hello world");
  assert.equal(m13Seen.length, 1, "M13-style consumer was not robbed");

  // Validator contribution via the typed publication point.
  const publicationPoint = createValidatorExtensionPoint<
    { candidates: readonly { candidateIndex?: number; title?: string }[] },
    { code: string; severity: "error" | "warning"; message: string }
  >({ name: "publication", contractVersion: "1.0.0" });
  const validatorInputs: {
    artifact: NonNullable<ReturnType<typeof catalog.get>>;
    registration: {
      point: "publication";
      validator_id: string;
      handler: string;
    };
  }[] = [];
  for (const entry of composition.registrations) {
    if (entry.kind !== "validator" || entry.point !== "publication") continue;
    const artifact = catalog.get(entry.extensionId);
    if (artifact === undefined) continue;
    validatorInputs.push({
      artifact,
      registration: {
        point: "publication",
        validator_id: entry.validatorId,
        handler: entry.handler,
      },
    });
  }
  registerValidatorContributions(publicationPoint, validatorInputs);
  const issues = publicationPoint.run({ candidates: [{ candidateIndex: 0, title: " " }] });
  assert.ok(issues.some((issue) => issue.code === "REFERENCE_SITE_TITLE_REQUIRED"));

  // Disable removes the contribution from composition.
  await service.disable("com.example.reference-site");
  const afterDisable = composeExtensionRegistrations(catalog, await service.enabledIds());
  assert.deepEqual(afterDisable.registrations, []);

  // Uninstall with the retain policy preserves the extension's data.
  await service.uninstall({ extensionId: "com.example.reference-site" });
  const preserved = await pool.query<{ note: string }>(
    `SELECT note FROM ${NOTES_TABLE} WHERE entry_id = 'entry-77'`,
  );
  assert.equal(preserved.rows.length, 1, "retain policy must keep business data");
});

test("no Core patch: the artifact imports only the public extension surface", async () => {
  const source = readFileSync(`${EXTENSION_DIR}/src/index.ts`, "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
  for (const specifier of imports) {
    if (specifier.startsWith(".")) continue; // relative artifact files
    assert.match(
      specifier,
      /^@pcms\/(extensions|core)$/,
      `forbidden import in reference extension: ${specifier}`,
    );
  }
  // The manifest cannot smuggle entrypoint paths either (the pool-bound
  // module factory is a named export declaration, not a path).
  const manifestDoc = JSON.parse(readFileSync(`${EXTENSION_DIR}/manifest.json`, "utf8"));
  assert.deepEqual(manifestDoc.entrypoint, {
    type: "module",
    factory: "createReferenceSiteExtensionModule",
  });
  assert.ok(!JSON.stringify(manifestDoc).includes(".."), "manifest carries no path references");
});

test("contract versions registry includes the extension contract (discovery readiness)", () => {
  const registry = createSystemContractVersionRegistry({
    cmsVersion: "0.0.0",
    configSchemaVersion: 1,
    extensionContractVersion: "2.0",
    restApiVersion: "1.0.0",
    mcpProtocolVersion: "2024-11-05",
    themeContractVersion: "1.0.0",
    blockDocumentSchemaVersion: 1,
    searchIndexVersion: 1,
    bundleVersion: 1,
    pcpubVersion: 1,
    pcmdVersion: 1,
  });
  assert.equal(registry.get("extension_contract")?.version, "2.0");
  // Config space keeps the extension config namespaced.
  const space = createExtensionConfigSpace();
  space.set("com.example.reference-site", { note_template: "x" });
  assert.equal(space.get("com.example.reference-site")?.note_template, "x");
});
