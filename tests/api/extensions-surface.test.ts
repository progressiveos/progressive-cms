// PCMS-EXT-T019 — machine discovery + lifecycle REST surfaces.
// Acceptance (Master Plan M14): the application layer exposes
// contract versions, capabilities, extensions, per-extension compatibility,
// deprecations and the read-only update preflight; privileged lifecycle
// operations are permission-gated (extensions.manage) and audited;
// update apply fails closed without the M15 adapter.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createCapabilityRegistry,
  createExtensionCatalog,
  defineExtensionArtifact,
} from "@pcms/extensions/internal";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";

const manifestDoc = JSON.parse(
  readFileSync("tests/fixtures/reference-site-extension/manifest.json", "utf8"),
) as unknown;

const webResearchManifest = JSON.parse(
  readFileSync("extensions/progressive-web-research/manifest.json", "utf8"),
) as unknown;

test("discovery surfaces report contracts, capabilities, deprecations and extensions", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await createApiFixture(t);
  const ctx = apiContextOf(ownerActor());

  const api = await import("@pcms/api");
  const versions = await api.getContractVersions(fixture.app, ctx);
  assert.ok(versions.items.length >= 9);
  assert.ok(versions.items.some((entry: { key: string }) => entry.key === "extension_contract"));

  const capabilities = await api.getCapabilities(fixture.app, ctx);
  assert.ok(
    capabilities.items.some(
      (entry: { capability: string }) => entry.capability === "theme-contract",
    ),
  );

  const deprecations = await api.listDeprecations(fixture.app, ctx);
  assert.deepEqual(deprecations.items, []);

  const list = await api.listExtensions(fixture.app, ctx);
  assert.deepEqual(list.items, []);

  const report = await api.getCompatibilityReport(fixture.app, ctx);
  assert.ok(["READY", "READY_WITH_WARNINGS", "BLOCKED"].includes(report.outcome));
});

test("permission gate: an actor without extensions.manage cannot discover or mutate", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await createApiFixture(t);
  const ctx = apiContextOf(scopedActor(["content.read"]));
  const api = await import("@pcms/api");
  await assert.rejects(() => api.getContractVersions(fixture.app, ctx));
  await assert.rejects(() =>
    api.installExtension(fixture.app, ctx, { extension_id: "com.example.x" }),
  );
});

test("lifecycle via application ops: install → enable → disable → uninstall (audited)", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: manifestDoc,
      module: { onEntryPublished: async () => {}, validatePublication: () => [] },
      migrationsDir: "tests/fixtures/reference-site-extension/migrations",
    }),
  );
  const fixture = await createApiFixture(t, {
    extensionCatalog: catalog,
    extensionSystemCapabilities: (() => {
      const caps = createCapabilityRegistry();
      caps.provide({ key: "theme-contract", version: "1.0.0", provider: "cms:themes" });
      return caps;
    })(),
  });
  const api = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());

  const installed = await api.installExtension(fixture.app, ctx, {
    extension_id: "com.example.reference-site",
    config: {},
  });
  assert.equal(installed.state, "INSTALLED");
  assert.deepEqual(installed.applied_migrations, ["0001_create_notes"]);

  const enabled = await api.enableExtension(fixture.app, ctx, {
    extension_id: "com.example.reference-site",
  });
  assert.equal(enabled.state, "ENABLED");

  const compatibility = await api.getExtensionCompatibility(fixture.app, ctx, {
    extension_id: "com.example.reference-site",
  });
  assert.ok(compatibility.issues.every((issue: { blocking: boolean }) => !issue.blocking));

  const disabled = await api.disableExtension(fixture.app, ctx, {
    extension_id: "com.example.reference-site",
  });
  assert.equal(disabled.state, "DISABLED");

  const uninstalled = await api.uninstallExtension(fixture.app, ctx, {
    extension_id: "com.example.reference-site",
  });
  assert.equal(uninstalled.data_policy, "retain");

  // Audit trail exists for every privileged operation.
  const audit = await fixture.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM auth_security_events WHERE event_type LIKE 'EXTENSION%'",
  );
  assert.equal(Number(audit.rows[0]?.count ?? "0"), 4);
});

test("immediate operation revoke on disable (gate E2): the next list() drops operations, no TTL wait", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const opsManifest = {
    id: "progressive.test-ops",
    name: "Test Ops",
    version: "1.0.0",
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    data_policy: "drop",
    entrypoint: { type: "module" },
    permissions: ["media.generate"],
    requires: [],
    provides: [],
    registrations: {
      operations: [
        {
          operation_id: "op-a",
          permission: "media.generate",
          mutation: false,
          title: "A",
          input_schema: { type: "object", additionalProperties: true },
          output_schema: { type: "object", additionalProperties: true },
          handler: "opA",
        },
        {
          operation_id: "op-b",
          permission: "media.generate",
          mutation: false,
          title: "B",
          input_schema: { type: "object", additionalProperties: true },
          output_schema: { type: "object", additionalProperties: true },
          handler: "opB",
        },
      ],
    },
  } as unknown;
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: opsManifest,
      module: { opA: async () => ({}), opB: async () => ({}) },
    }),
  );
  const fixture = await createApiFixture(t, { extensionCatalog: catalog });
  const api = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());

  await api.installExtension(fixture.app, ctx, { extension_id: "progressive.test-ops" });
  await api.enableExtension(fixture.app, ctx, { extension_id: "progressive.test-ops" });
  assert.equal((await fixture.app.extensionOperations.list()).length, 2);

  // The revoke must be immediate: lifecycle ops invalidate the composed
  // operation cache (2026-10-10 fix — previously list() served a stale
  // compiled set until an invoke refreshed it after 30s).
  await api.disableExtension(fixture.app, ctx, { extension_id: "progressive.test-ops" });
  assert.equal((await fixture.app.extensionOperations.list()).length, 0);
});

test("inter-process revoke (ADR-0017 R3): a disable in one instance bites in another without local invalidation", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const opsManifest = {
    id: "progressive.test-revoke",
    name: "Test Revoke",
    version: "1.0.0",
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    data_policy: "drop",
    entrypoint: { type: "module" },
    permissions: ["media.generate"],
    requires: [],
    provides: [],
    registrations: {
      operations: [
        {
          operation_id: "ping",
          permission: "media.generate",
          mutation: false,
          title: "Ping",
          input_schema: { type: "object", additionalProperties: true },
          output_schema: { type: "object", additionalProperties: true },
          handler: "ping",
        },
      ],
    },
  } as unknown;
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: opsManifest,
      module: { ping: async () => ({}) },
    }),
  );
  const fixture = await createApiFixture(t, { extensionCatalog: catalog });
  const api = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());

  await api.installExtension(fixture.app, ctx, { extension_id: "progressive.test-revoke" });
  await api.enableExtension(fixture.app, ctx, { extension_id: "progressive.test-revoke" });

  // Two independent service instances = two processes: each holds its own
  // composed cache; the ONLY shared state is the database (revision + rows).
  const sharedInput = {
    catalog,
    enabledIds: () => fixture.app.extensions.lifecycle.enabledIds(),
    lifecycleRevision: () => fixture.app.extensions.lifecycle.revision(),
  };
  const webA = api.createExtensionOperationsService(sharedInput);
  const webB = api.createExtensionOperationsService(sharedInput);
  assert.equal((await webA.list()).length, 1); // A's cache now holds revision N
  assert.equal((await webB.list()).length, 1); // B's cache too

  // Web A disables (bumps the authoritative revision in the DB).
  await api.disableExtension(fixture.app, ctx, { extension_id: "progressive.test-revoke" });

  // Web B must refuse the operation on its very next touch — no local
  // invalidation happened in B; the revision gate does the revoke.
  assert.equal((await webB.list()).length, 0);
  await assert.rejects(
    () => webB.invoke(fixture.app, ctx, "progressive.test-revoke", "ping", {}),
    (error: unknown) => (error as { code?: string }).code === "EXTENSION_OPERATION_UNKNOWN",
  );
});

test("R1: an unregistered permission outside a declared namespace fails composition", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: {
        id: "progressive.test.badns",
        name: "Bad Namespace",
        version: "1.0.0",
        extension_contract: "2.0",
        cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
        entrypoint: { type: "module" },
        permissions: ["shop.orders.read"], // not platform-registered, no namespace declared
        requires: [],
        provides: [],
        registrations: {},
        data_policy: "drop",
      },
      module: {},
    }),
  );
  await assert.rejects(
    () => createApiFixture(t, { extensionCatalog: catalog }),
    (error: unknown) =>
      (error as { code?: string }).code === "EXTENSION_PERMISSION_UNREGISTERED" ||
      (error instanceof Error && error.message.includes("unregistered permission")),
  );
});

test("R1: a trusted package registers its own namespace keys; no implicit grants follow", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: {
        id: "progressive.test.shoptest",
        name: "Shop Test",
        version: "1.0.0",
        extension_contract: "2.0",
        cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
        entrypoint: { type: "module" },
        permission_namespace: "shoptest",
        permissions: ["shoptest.orders.read"],
        requires: [],
        provides: [],
        registrations: {},
        data_policy: "drop",
      },
      module: {},
    }),
  );
  const fixture = await createApiFixture(t, { extensionCatalog: catalog });
  const auth = await import("@pcms/auth");
  t.after(() => auth.resetExtensionPermissionsForTests());
  // The namespace key is now registered — grantable, enforceable, discoverable.
  assert.equal(auth.isRegisteredPermission("shoptest.orders.read"), true);
  // …and NO existing role bundle gained it implicitly.
  for (const role of auth.BUILTIN_ROLE_KEYS) {
    assert.equal(auth.builtinRolePermissions(role).includes("shoptest.orders.read"), false, role);
  }
  // A key outside the declared namespace still fails closed.
  assert.equal(auth.isRegisteredPermission("other.keys.read"), false);
});

test("update surfaces: preflight works with a configured manifest; apply fails closed", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const updateManifest = {
    manifest_version: "1",
    version: "0.0.1",
    required_runtime: { node: ">=24.21 <25", postgres: ">=14 <17" },
    core_db_migrations: [],
    supports_extension_contracts: ["2.0"],
    contract_versions: { theme_contract: "1.0.0", extension_contract: "2.0" },
    backup_required: false,
    rollback_policy: "rollback_safe",
  };
  const fixture = await createApiFixture(t, { updateManifest });
  const api = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());
  const preflight = await api.getUpdatePreflight(fixture.app, ctx);
  assert.equal(preflight.target.version, "0.0.1");

  await assert.rejects(
    () => api.applyUpdate(fixture.app, ctx, { manifest: updateManifest }),
    (error: unknown) =>
      (error as { code?: string } | null)?.code === "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE",
  );
  // The failed attempt stays inspectable in history.
  const history = await fixture.pool.query<{ status: string; failure_code: string }>(
    "SELECT status, failure_code FROM pcms_update_history ORDER BY started_at DESC LIMIT 1",
  );
  assert.equal(history.rows[0]?.status, "FAILED");
  assert.equal(history.rows[0]?.failure_code, "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE");
});

test("extension config update merges: network-only change preserves search/fetch keys (PCMS-WEB-RESEARCH §95)", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: webResearchManifest,
      module: { search: async () => ({}), fetchPage: async () => ({}) },
    }),
  );
  const fixture = await createApiFixture(t, {
    extensionCatalog: catalog,
    extensionSystemCapabilities: (() => {
      const caps = createCapabilityRegistry();
      caps.provide({ key: "theme-contract", version: "1.0.0", provider: "cms:themes" });
      return caps;
    })(),
  });
  const api = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());

  await api.installExtension(fixture.app, ctx, {
    extension_id: "progressive.web-research",
    config: {
      "xmlstock.user_id": "user-1",
      "search.engine": "google",
      "fetch.max_extracted_chars": 42000,
      network: { mode: "direct" },
    },
  });

  const updated = await api.updateExtensionConfigOp(fixture.app, ctx, {
    extension_id: "progressive.web-research",
    config: { network: { mode: "socks5", proxy_host: "192.0.2.10", proxy_port: 1080 } },
  });
  // Sibling top-level keys survive a network-only update.
  assert.equal(updated.config["xmlstock.user_id"], "user-1");
  assert.equal(updated.config["search.engine"], "google");
  assert.equal(updated.config["fetch.max_extracted_chars"], 42000);
  assert.equal((updated.config["network"] as Record<string, unknown>)["mode"], "socks5");

  // Secret-slot keys can never be written through the config op.
  const withSecretAttempt = await api.updateExtensionConfigOp(fixture.app, ctx, {
    extension_id: "progressive.web-research",
    config: {
      "search.engine": "yandex",
      "xmlstock.api_key": { $secret_ref: "xmlstock.api_key" },
    },
  });
  assert.equal(withSecretAttempt.config["search.engine"], "yandex");
  // A forged $secret_ref from the config payload is dropped — secret slots
  // are created only through the dedicated (write-only, audited) secrets op.
  assert.equal(withSecretAttempt.config["xmlstock.api_key"], undefined);
});

test("clearing a secret slot removes the dangling $secret_ref from stored config (§143)", async (t) => {
  if (process.env.PCMS_TEST_DATABASE_URL === undefined)
    return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { deriveKeyForTesting, createSecretBox } = await import("@pcms/auth");
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: webResearchManifest,
      module: { search: async () => ({}), fetchPage: async () => ({}) },
    }),
  );
  const fixture = await createApiFixture(t, {
    extensionCatalog: catalog,
    runtimeSecretBox: createSecretBox(deriveKeyForTesting("web-research-clear-test")),
    extensionSystemCapabilities: (() => {
      const caps = createCapabilityRegistry();
      caps.provide({ key: "theme-contract", version: "1.0.0", provider: "cms:themes" });
      return caps;
    })(),
  });
  const api = await import("@pcms/api");
  const ctx = apiContextOf(ownerActor());

  await api.installExtension(fixture.app, ctx, {
    extension_id: "progressive.web-research",
    config: { "xmlstock.user_id": "u1" },
  });
  await api.setExtensionSecretOp(fixture.app, ctx, {
    extension_id: "progressive.web-research",
    slot: "xmlstock.api_key",
    value: "secret-value",
  });
  // Set wires the ref into the STORED config (public reads strip refs).
  const rawConfig = () =>
    fixture.app.extensions.lifecycle
      .getInstallation("progressive.web-research")
      .then(
        (installation: { config: Record<string, unknown> } | undefined) =>
          installation?.config ?? {},
      );
  assert.deepEqual((await rawConfig())["xmlstock.api_key"], { $secret_ref: "xmlstock.api_key" });

  await api.clearExtensionSecretOp(fixture.app, ctx, {
    extension_id: "progressive.web-research",
    slot: "xmlstock.api_key",
  });
  // The dangling ref must be gone — otherwise the runtime resolver throws
  // EXTENSION_SECRET_REF_UNRESOLVED and the whole extension degrades to null.
  assert.equal((await rawConfig())["xmlstock.api_key"], undefined);
  assert.equal((await rawConfig())["xmlstock.user_id"], "u1");
});
