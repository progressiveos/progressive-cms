// Canonical application-layer composition for M09 tests (PCMS-API-T001).
// Mirrors tests/helpers/publication-composition.ts at the application layer:
// one createApplicationServices() call wires every subsystem; transports
// under test call the same operations REST/MCP/CLI would.

import { type ApplicationServices, createApplicationServices } from "@pcms/api";
import { type ActorContext, PERMISSION_REGISTRY, systemActor } from "@pcms/auth";
import {
  createDbPool,
  type DbPool,
  fixedClock,
  loadMigrations,
  migrateDatabase,
  type ResolvedSecrets,
} from "@pcms/core";
import { LocalMediaStorage } from "@pcms/media";
import type { PaymentProvider } from "@pcms/payments";
import type { TestDatabase } from "./testdb.js";

export const API_CLOCK = fixedClock(new Date("2026-09-19T12:00:00.000Z"));

export function connectionInfoOf(db: TestDatabase) {
  return {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    ...(db.connection.password === undefined ? {} : { password: db.connection.password }),
    sslMode: "disable" as const,
  };
}

/** An actor holding every registered permission (operator-like test subject). */
export function ownerActor(id = "test-owner"): ActorContext {
  return {
    type: "OPERATOR",
    id,
    permissions: new Set(PERMISSION_REGISTRY.map((definition) => definition.key)),
    siteKey: null,
    environment: null,
    strength: { factors: ["local_operator"], authenticatedAt: API_CLOCK.now(), mfaAt: null },
    sessionId: null,
  };
}

export function scopedActor(permissions: readonly string[], id = "svc-agent"): ActorContext {
  return {
    type: "SERVICE_ACCOUNT",
    id,
    permissions: new Set(permissions),
    siteKey: null,
    environment: "dev",
    strength: { factors: ["access_token"], authenticatedAt: API_CLOCK.now(), mfaAt: null },
    sessionId: null,
  };
}

export function apiContextOf(
  actor: ActorContext,
  transport: "rest" | "mcp" | "cli" = "rest",
  requestId = "req_test_0001",
) {
  return { actor, transport, requestId };
}

export interface ApiTestFixture {
  readonly db: TestDatabase;
  readonly pool: DbPool;
  readonly app: ApplicationServices;
}

/**
 * Bootstraps the application layer over a disposable database with the
 * reference content types; runs migrations. Caller owns pool teardown via
 * t.after.
 */
export async function createApiFixture(
  t: { after: (fn: () => void) => void },
  options: {
    readonly contentTypeDefinitions?: Parameters<
      typeof createApplicationServices
    >[0]["contentTypeDefinitions"];
    readonly themeDir?: string;
    readonly seoEnvironment?: "production" | "staging" | "development";
    /** null → compose WITHOUT a preview secret (unavailable-path tests). */
    readonly previewSecret?: string | null;
    readonly secrets?: ResolvedSecrets;
    /** Encryptor for Admin-managed runtime secrets (PCMS-OPS-T130/T131). */
    readonly runtimeSecretBox?: import("@pcms/integrations").IntegrationSecretBox;
    /** Privileged SSRF policy override (hermetic HQ E2E on loopback). */
    readonly integrationHttpPolicy?: import("@pcms/integrations").SsrfPolicy;
    readonly paymentProviders?: readonly PaymentProvider[];
    readonly registerFakePaymentProvider?: boolean;
    readonly extensionCatalog?: Parameters<typeof createApplicationServices>[0]["extensionCatalog"];
    readonly extensionSystemCapabilities?: Parameters<
      typeof createApplicationServices
    >[0]["extensionSystemCapabilities"];
    readonly updateManifest?: unknown;
    /** Media storage roots (tmp dirs) + theme presets for ingest tests. */
    readonly mediaRoots?: { readonly storage: string; readonly quarantine: string };
    readonly mediaPresets?: readonly unknown[];
    /** Registry composition options (Task 2026-10-05 Registry Admin UX). */
    readonly registryBaseUrl?: string;
    readonly registryIncomingDir?: string;
  } = {},
): Promise<ApiTestFixture> {
  const { createTestDatabase, testDatabaseConfigured } = await import("./testdb.js");
  if (!testDatabaseConfigured()) {
    throw new Error("PCMS_TEST_DATABASE_URL is not set");
  }
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 8,
    connectionTimeoutMilliseconds: 5000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const app = createApplicationServices({
    pool,
    clock: API_CLOCK,
    ...(options.contentTypeDefinitions === undefined
      ? {}
      : { contentTypeDefinitions: options.contentTypeDefinitions }),
    ...(options.themeDir === undefined ? {} : { themeDir: options.themeDir }),
    ...(options.seoEnvironment === undefined ? {} : { seoEnvironment: options.seoEnvironment }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.runtimeSecretBox === undefined
      ? {}
      : { runtimeSecretBox: options.runtimeSecretBox }),
    ...(options.integrationHttpPolicy === undefined
      ? {}
      : { integrationHttpPolicy: options.integrationHttpPolicy }),
    ...(options.paymentProviders === undefined
      ? {}
      : { paymentProviders: options.paymentProviders }),
    ...(options.registerFakePaymentProvider === undefined
      ? {}
      : { registerFakePaymentProvider: options.registerFakePaymentProvider }),
    ...(options.extensionCatalog === undefined
      ? {}
      : { extensionCatalog: options.extensionCatalog }),
    ...(options.extensionSystemCapabilities === undefined
      ? {}
      : { extensionSystemCapabilities: options.extensionSystemCapabilities }),
    ...(options.updateManifest === undefined ? {} : { updateManifest: options.updateManifest }),
    ...(options.mediaRoots === undefined
      ? {}
      : {
          mediaStorage: new LocalMediaStorage({ root: options.mediaRoots.storage }),
          mediaQuarantine: new LocalMediaStorage({ root: options.mediaRoots.quarantine }),
        }),
    ...(options.mediaPresets === undefined ? {} : { mediaPresets: options.mediaPresets }),
    ...(options.registryBaseUrl === undefined ? {} : { registryBaseUrl: options.registryBaseUrl }),
    ...(options.registryIncomingDir === undefined
      ? {}
      : { registryIncomingDir: options.registryIncomingDir }),
    ...(options.previewSecret === null
      ? {}
      : {
          previewSecret: options.previewSecret ?? "test-preview-secret-0123456789abcdef0123456789",
        }),
  });
  return { db, pool, app };
}

/** Convenience: a permit-all system actor context (transport-independent). */
export function systemContext() {
  return apiContextOf(systemActor("test-system"));
}
