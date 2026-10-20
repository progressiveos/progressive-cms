// ADR-0013 §52 (PCMS-MPA-T003/T004/T005) — extension runtime contributions:
// typed application operations (REST/MCP share one handler, permission
// enforced per operation, gone after disable) and consumed media provider
// registrations (configured state from the secret resolver, instance only
// when configured). Unit-level composition checks + lifecycle integration.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  type ApplicationServices,
  assertExtensionPermissionsRegistered,
  buildExtensionMcpTools,
  createExtensionOperationsService,
  createMediaProvidersService,
  type OperationContext,
} from "@pcms/api";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import type { ExtensionLifecycleService } from "@pcms/extensions/internal";
import {
  composeExtensionRegistrations,
  createCapabilityRegistry,
  createExtensionCatalog,
  createExtensionLifecycleService,
  defineExtensionArtifact,
  type ExtensionManifest,
  validateExtensionManifest,
} from "@pcms/extensions/internal";
import type { MediaStockProvider } from "@pcms/media";
import { connectionInfo, createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const fixedClock = { now: () => new Date("2026-09-25T00:00:00.000Z") };

function manifestDoc(overrides: Record<string, unknown> & { id: string }) {
  return {
    name: "Test extension",
    version: "1.0.0",
    extension_contract: "2.0",
    cms_compatibility: ">=1.0.0-rc.1 <2.0.0",
    entrypoint: { type: "module" },
    registrations: {},
    ...overrides,
  };
}

const stockProviderModule = () => ({
  createProvider: (deps: { config: Record<string, unknown> }) => {
    const provider: MediaStockProvider = {
      providerId: "teststock",
      displayName: "Test Stock",
      capabilities: () => ({ providerId: "teststock", displayName: "Test Stock" }),
      search: async () => ({ candidates: [], nextCursor: null }),
      fetch: async () => {
        throw new Error("not used here");
      },
      testConnection: async () => ({ ok: true, message: null }),
    };
    void deps;
    return provider;
  },
});

async function setup(t: { after: (fn: () => void) => void }): Promise<DbPool> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

async function integration(t: { after: (fn: () => void) => void }) {
  if (!testDatabaseConfigured()) return null;
  return setup(t);
}

function fakeApp(permissions: ReadonlySet<string>): ApplicationServices {
  return {
    authorize(actor: { id: string }, permission: string): void {
      if (!permissions.has(permission)) {
        throw Object.assign(new Error("denied"), { code: "AUTH_PERMISSION_DENIED" });
      }
    },
  } as unknown as ApplicationServices;
}

const agentCtx: OperationContext = {
  actor: {
    type: "SERVICE_ACCOUNT",
    id: "agent-1",
    permissions: new Set<string>(["media.stock.search"]),
    siteKey: null,
    environment: null,
    strength: { factors: ["access_token"], authenticatedAt: new Date(), mfaAt: null },
    sessionId: null,
  },
  transport: "rest",
  requestId: "req-1",
};

function testManifest(): ExtensionManifest {
  const validation = validateExtensionManifest(
    manifestDoc({
      id: "com.test.contributions",
      permissions: ["media.stock.search", "media.stock.import"],
      config_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          api_key: { type: "object", format: "secret-ref" },
          proxy_password: { type: "object", format: "secret-ref" },
        },
      },
      registrations: {
        providers: [
          {
            registry: "media_stock_provider",
            provider_id: "teststock",
            title: "Test Stock",
            handler: "createProvider",
          },
        ],
        operations: [
          {
            operation_id: "echo",
            permission: "media.stock.search",
            mutation: false,
            title: "Echo the input",
            input_schema: { type: "object", additionalProperties: true },
            output_schema: {
              type: "object",
              additionalProperties: false,
              required: ["echo"],
              properties: { echo: { type: "boolean" } },
            },
            handler: "echoOperation",
          },
          {
            operation_id: "broken",
            permission: "media.stock.search",
            mutation: false,
            title: "Returns output violating its schema",
            input_schema: { type: "object", additionalProperties: true },
            output_schema: {
              type: "object",
              additionalProperties: false,
              required: ["echo"],
              properties: { echo: { type: "boolean" } },
            },
            handler: "brokenOperation",
          },
        ],
      },
    }),
  );
  assert.equal(validation.ok, true, JSON.stringify(validation.ok ? [] : validation.issues));
  return (validation as { manifest: ExtensionManifest }).manifest;
}

test("manifest accepts the new provider registries and operation registrations", () => {
  const manifest = testManifest();
  assert.equal(manifest.registrations.providers[0]?.registry, "media_stock_provider");
  assert.deepEqual(
    manifest.registrations.operations.map((operation) => operation.operation_id),
    ["echo", "broken"],
  );
});

test("manifest rejects duplicate operation ids and unknown registries", () => {
  const duplicate = validateExtensionManifest(
    manifestDoc({
      id: "com.test.dupe",
      registrations: {
        operations: [
          {
            operation_id: "same",
            permission: "media.read",
            mutation: false,
            title: "a",
            input_schema: { type: "object" },
            output_schema: { type: "object" },
            handler: "a",
          },
          {
            operation_id: "same",
            permission: "media.read",
            mutation: false,
            title: "b",
            input_schema: { type: "object" },
            output_schema: { type: "object" },
            handler: "b",
          },
        ],
      },
    }),
  );
  assert.equal(duplicate.ok, false);
  assert.ok(
    duplicate.ok === false &&
      duplicate.issues.some(
        (issue) => issue.code === "MANIFEST_DUPLICATE" && issue.path.includes("operations"),
      ),
  );
  const unknownRegistry = validateExtensionManifest(
    manifestDoc({
      id: "com.test.registry",
      registrations: {
        providers: [{ registry: "media_stock", provider_id: "x", handler: "x" }],
      },
    }),
  );
  assert.equal(unknownRegistry.ok, false);
});

test("composition fails closed on unregistered manifest/operation permissions", () => {
  const manifest = testManifest();
  assert.doesNotThrow(() => assertExtensionPermissionsRegistered(manifest));
  assert.throws(
    () =>
      assertExtensionPermissionsRegistered({
        id: "com.test.bad",
        permissions: ["not.a.real_key"],
        registrations: { operations: [], http_routes: [] },
      }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "EXTENSION_PERMISSION_UNREGISTERED",
  );
  assert.throws(
    () =>
      assertExtensionPermissionsRegistered({
        id: "com.test.bad",
        permissions: [],
        registrations: {
          operations: [
            {
              permission: "media.notregistered",
            },
          ],
          http_routes: [],
        },
      }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "EXTENSION_PERMISSION_UNREGISTERED",
  );
});

test("operations compose deterministically and derive collision-checked MCP tools", async () => {
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: testManifest(),
      module: {
        echoOperation: async (call: unknown) => ({ echo: true, got: call }),
        createProvider: () => ({}),
      },
    }),
  );
  const composition = composeExtensionRegistrations(catalog, ["com.test.contributions"]);
  const operation = composition.registrations.find((entry) => entry.kind === "operation");
  assert.ok(operation !== undefined && operation.kind === "operation");
  assert.equal(operation.permission, "media.stock.search");

  const app = {
    extensionOperations: {
      list: async () => [
        {
          extension_id: "com.test.contributions",
          operation_id: "echo",
          title: "Echo the input",
          permission: "media.stock.search",
          mutation: false,
          input_schema: { type: "object" },
          output_schema: { type: "object" },
        },
      ],
    },
  } as unknown as ApplicationServices;
  const tools = await buildExtensionMcpTools(app);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["cms_ext_com_test_contributions_echo"],
  );
  assert.equal(tools[0]?.mutation, false);
});

test("extension MCP tool derivation detects sanitizer collisions", async () => {
  const operations = [
    {
      extension_id: "a.b.c",
      operation_id: "op",
      title: "op",
      permission: "media.read",
      mutation: false,
      input_schema: { type: "object" },
      output_schema: { type: "object" },
    },
    {
      extension_id: "a.b-c",
      operation_id: "op",
      title: "op",
      permission: "media.read",
      mutation: false,
      input_schema: { type: "object" },
      output_schema: { type: "object" },
    },
  ];
  const app = {
    extensionOperations: { list: async () => operations },
  } as unknown as ApplicationServices;
  await assert.rejects(() => buildExtensionMcpTools(app), /collision/);
});

test("operations invoke: permission enforced, schemas enforced, gone after disable", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: testManifest(),
      module: {
        echoOperation: async (call: { input: { flag?: boolean } }) => ({
          echo: call.input.flag === true,
        }),
        brokenOperation: async () => ({ wrong: true }),
        createProvider: stockProviderModule().createProvider,
      },
    }),
  );
  const lifecycle = createExtensionLifecycleService({
    pool,
    clock: fixedClock,
    coreVersion: "1.0.0-rc.1",
    catalog,
    systemCapabilities: createCapabilityRegistry(),
  });
  await lifecycle.install({ extensionId: "com.test.contributions", config: {} });
  await lifecycle.enable("com.test.contributions");

  const operations = createExtensionOperationsService({
    catalog,
    enabledIds: () => lifecycle.enabledIds(),
    lifecycleRevision: () => lifecycle.revision(),
  });

  // Permission enforcement happens inside invoke (fail-closed).
  await assert.rejects(
    () =>
      operations.invoke(fakeApp(new Set<string>()), agentCtx, "com.test.contributions", "echo", {}),
    (error: unknown) => (error as { code?: string }).code === "AUTH_PERMISSION_DENIED",
  );
  // Happy path: handler runs once; REST and MCP both call exactly this.
  const result = (await operations.invoke(
    fakeApp(new Set<string>(["media.stock.search"])),
    agentCtx,
    "com.test.contributions",
    "echo",
    { flag: true },
  )) as { echo: boolean };
  assert.deepEqual(result, { echo: true });
  // Output schema is enforced fail-closed (server-side contract, not trust).
  await assert.rejects(
    () =>
      operations.invoke(
        fakeApp(new Set<string>(["media.stock.search"])),
        agentCtx,
        "com.test.contributions",
        "broken",
        {},
      ),
    (error: unknown) =>
      error instanceof ApiError && error.code === "EXTENSION_OPERATION_INVALID_OUTPUT",
  );

  const listed = await operations.list("com.test.contributions");
  assert.equal(listed.length, 2);
  assert.ok(listed.every((operation) => operation.permission === "media.stock.search"));

  await lifecycle.disable("com.test.contributions");
  const afterDisable = createExtensionOperationsService({
    catalog,
    enabledIds: () => lifecycle.enabledIds(),
    lifecycleRevision: () => lifecycle.revision(),
  });
  assert.equal((await afterDisable.list("com.test.contributions")).length, 0);
  await assert.rejects(
    () =>
      afterDisable.invoke(
        fakeApp(new Set<string>(["media.stock.search"])),
        agentCtx,
        "com.test.contributions",
        "echo",
        {},
      ),
    (error: unknown) => error instanceof ApiError && error.code === "EXTENSION_OPERATION_UNKNOWN",
  );
});

test("provider registries consume enabled registrations; configured follows secrets", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest: testManifest(),
      module: {
        echoOperation: async () => ({ echo: true }),
        createProvider: stockProviderModule().createProvider,
      },
    }),
  );
  const lifecycle = createExtensionLifecycleService({
    pool,
    clock: fixedClock,
    coreVersion: "1.0.0-rc.1",
    catalog,
    systemCapabilities: createCapabilityRegistry(),
  });
  await lifecycle.install({
    extensionId: "com.test.contributions",
    config: { api_key: { $secret_ref: "api_key" } },
  });
  await lifecycle.enable("com.test.contributions");

  const withoutResolver = createMediaProvidersService({
    catalog,
    lifecycle,
  });
  const unconfigured = await withoutResolver.list();
  assert.equal(unconfigured.length, 1);
  assert.equal(unconfigured[0]?.kind, "stock");
  assert.equal(unconfigured[0]?.configured, false);
  assert.equal(unconfigured[0]?.display_name, "Test Stock");
  assert.equal(await withoutResolver.stock("teststock"), null);

  // Regression (owner report 0.1.115): an enabled installation whose config
  // never mentions the secret slot must NOT report configured — the schema
  // declares format secret-ref, so the slot has to be actually stored.
  const emptyConfig = await lifecycle.listInstallations();
  const installation = emptyConfig.find((entry) => entry.extensionId === "com.test.contributions");
  if (installation !== undefined) {
    await lifecycle.install({ extensionId: "com.test.contributions", config: {} });
  }
  const withEmptyConfig = createMediaProvidersService({
    catalog,
    lifecycle,
    // resolver models the E3 store: the slot was never stored
    resolveSecret: async () => undefined,
  });
  assert.equal((await withEmptyConfig.list())[0]?.configured, false);
  assert.equal(await withEmptyConfig.stock("teststock"), null);
  // Restore the referenced config for the original assertions below.
  await lifecycle.install({
    extensionId: "com.test.contributions",
    config: { api_key: { $secret_ref: "api_key" } },
  });

  // Regression (owner report 0.1.116): a schema secret slot the config never
  // references (optional proxy_password) must NOT gate «configured» — a
  // stored key is enough. A REFERENCED slot that is not stored still fails.
  const referencedOnly = createMediaProvidersService({
    catalog,
    lifecycle,
    resolveSecret: async (_extensionId, name) => (name === "api_key" ? "secret-value" : undefined),
  });
  assert.equal((await referencedOnly.list())[0]?.configured, true);
  await lifecycle.install({
    extensionId: "com.test.contributions",
    config: {
      api_key: { $secret_ref: "api_key" },
      proxy_password: { $secret_ref: "proxy_password" },
    },
  });
  assert.equal((await referencedOnly.list())[0]?.configured, false);
  await lifecycle.install({
    extensionId: "com.test.contributions",
    config: { api_key: { $secret_ref: "api_key" } },
  });

  const withResolver = createMediaProvidersService({
    catalog,
    lifecycle,
    resolveSecret: async (_extensionId, name) => (name === "api_key" ? "secret-value" : undefined),
  });
  const configured = await withResolver.list();
  assert.equal(configured[0]?.configured, true);
  const instance = await withResolver.stock("teststock");
  assert.ok(instance !== null);
  assert.equal(instance.providerId, "teststock");

  // Disable ⇒ provider disappears from the registry entirely.
  await lifecycle.disable("com.test.contributions");
  const afterDisable = createMediaProvidersService({
    catalog,
    lifecycle,
    resolveSecret: async () => "secret-value",
  });
  assert.equal((await afterDisable.list()).length, 0);
  assert.equal(await afterDisable.stock("teststock"), null);
});

test("extension runtime secrets: set/resolve/clear + uninstall cascade", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const { createSecretBox } = await import("@pcms/auth");
  const {
    setExtensionRuntimeSecret,
    getExtensionRuntimeSecret,
    listExtensionRuntimeSecretSlots,
    clearExtensionRuntimeSecret,
  } = await import("@pcms/extensions/internal");
  const box = createSecretBox(Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"));
  await pool.query(
    `INSERT INTO pcms_extension_installations (extension_id, version, state, manifest_fingerprint)
     VALUES ('com.test.secrets', '1.0.0', 'ENABLED', 'fp') ON CONFLICT DO NOTHING`,
  );
  await setExtensionRuntimeSecret(pool, box, {
    extensionId: "com.test.secrets",
    slot: "api_key",
    value: "hunter2",
    actor: "admin-1",
  });
  assert.equal(
    await getExtensionRuntimeSecret(pool, box, "com.test.secrets", "api_key"),
    "hunter2",
  );
  assert.deepEqual(await listExtensionRuntimeSecretSlots(pool, "com.test.secrets"), ["api_key"]);
  assert.equal(
    await clearExtensionRuntimeSecret(pool, {
      extensionId: "com.test.secrets",
      slot: "api_key",
    }),
    true,
  );
  assert.equal(
    await getExtensionRuntimeSecret(pool, box, "com.test.secrets", "api_key"),
    undefined,
  );

  // Uninstall (installation row removal) cascades: stored secrets die with it.
  await setExtensionRuntimeSecret(pool, box, {
    extensionId: "com.test.secrets",
    slot: "api_key",
    value: "hunter2",
    actor: "admin-1",
  });
  await pool.query(
    `DELETE FROM pcms_extension_installations WHERE extension_id = 'com.test.secrets'`,
  );
  assert.deepEqual(await listExtensionRuntimeSecretSlots(pool, "com.test.secrets"), []);
});

test("provider adapter rebuilds with fresh config after invalidate (2026-09-29 incident)", async (t) => {
  const pool = await integration(t);
  if (pool === null) return;
  const holder: { config: Record<string, unknown> | null } = { config: null };
  // Raw document — defineExtensionArtifact validates it itself.
  const manifest = manifestDoc({
    id: "com.test.contributions",
    permissions: ["media.stock.search", "media.stock.import"],
    config_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        api_key: { type: "object", format: "secret-ref" },
        marker: { type: "string" },
      },
    },
    registrations: {
      providers: [
        {
          registry: "media_stock_provider",
          provider_id: "teststock",
          title: "Test Stock",
          handler: "createProvider",
        },
      ],
    },
  });
  const catalog = createExtensionCatalog();
  catalog.register(
    defineExtensionArtifact({
      manifest,
      module: {
        createProvider: (deps: { config: Record<string, unknown> }) => {
          holder.config = deps.config;
          return {
            providerId: "teststock",
            displayName: "Test Stock",
            capabilities: () => ({ providerId: "teststock", displayName: "Test Stock" }),
            search: async () => ({ candidates: [], nextCursor: null }),
            fetch: async () => {
              throw new Error("not used here");
            },
            testConnection: async () => ({ ok: true, message: null }),
          } as MediaStockProvider;
        },
      },
    }),
  );
  const lifecycle = createExtensionLifecycleService({
    pool,
    clock: fixedClock,
    coreVersion: "1.0.0-rc.1",
    catalog,
    systemCapabilities: createCapabilityRegistry(),
  });
  await lifecycle.install({
    extensionId: "com.test.contributions",
    config: { marker: "before", api_key: { $secret_ref: "api_key" } },
  });
  await lifecycle.enable("com.test.contributions");

  const service = createMediaProvidersService({
    catalog,
    lifecycle,
    resolveSecret: async () => "secret-value",
  });
  await service.stock("teststock");
  assert.equal(holder.config?.["marker"], "before");

  // Config update WITHOUT invalidate: the cached adapter keeps its snapshot
  // (this is exactly what made a freshly added model invisible on prod).
  await lifecycle.install({
    extensionId: "com.test.contributions",
    config: { marker: "after", api_key: { $secret_ref: "api_key" } },
  });
  await service.stock("teststock");
  assert.equal(holder.config?.["marker"], "before");

  // invalidate → next resolution rebuilds the adapter with the new config.
  service.invalidate("com.test.contributions");
  await service.stock("teststock");
  assert.equal(holder.config?.["marker"], "after");
});
