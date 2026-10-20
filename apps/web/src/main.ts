// pcms-web process (PCMS-OPS-T007) — HTTP composition root.
//
// M01: starts independently, owns a bounded pool sized by db.pool.webMax,
// logs structured request lines with request_id, shuts down gracefully.
// It never runs migrations (Operations spec §12). Since M09 it also mounts
// the REST /api/v1 transport over the shared application layer.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecretBox } from "@pcms/auth";
import { effectiveContentTypeDefinitions } from "@pcms/content";
import {
  type AppConfig,
  buildDbConnectionInfo,
  createDbPool,
  createLogger,
  type DbPool,
  installSignalHandlers,
  type Logger,
  loadConfig,
  loadSecrets,
  newRequestId,
  systemClock,
} from "@pcms/core";
import { resolveReleaseIdentity } from "@pcms/operations";
import type { FastifyInstance } from "fastify";
import { loadContentTypeDefinitions } from "./content-types.js";
import { healthRoutes } from "./health.js";
import { applyManagedMailSettings, buildMailSurface } from "./mail.js";
import { registerMaintenanceGate } from "./maintenance-gate.js";
import { createProductionUpdatePorts, resolveCurrentReleaseRoot } from "./update-adapters.js";

/** Config path is a deployment constant; exposed for adapter diagnostics. */
function configFilePathOf(options: {
  file?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): string {
  if (options.file !== undefined) return options.file;
  const fromEnv = options.env?.PCMS_CONFIG_FILE;
  if (fromEnv !== undefined) return fromEnv;
  return join(options.cwd ?? process.cwd(), "config", "pcms.json");
}

import {
  ApiError,
  authenticateRequest,
  bindOperations,
  buildExtensionMcpTools,
  createApiFastify,
  createApiV1,
  createApplicationServices,
  DEFAULT_PCPUB_LIMITS,
  makeAgentRoutes,
  makeAnalyticsRoutes,
  makeCollectionsRoutes,
  makeContentSchemaRoutes,
  makeDiscoveryRoutes,
  makeExtensionsRoutes,
  makeFormsRoutes,
  makeIntegrationsRoutes,
  makeInteractionsRoutes,
  makeLocalizationRoutes,
  makeMailRoutes,
  makeMaintenanceRoutes,
  makeMediaProviderRoutes,
  makeMutationRoutes,
  makeNotificationRoutes,
  makePaymentsRoutes,
  makePcpubBundleRoutes,
  makeRegistryRoutes,
  makeRoutingRoutes,
  makeSearchRoutes,
  makeSeoIndexNowRoutes,
  makeSkillsRoutes,
  makeThemeManageRoutes,
  readCmsVersionFromRelease,
  recoverThemeLifecycle,
  toErrorEnvelope,
} from "@pcms/api";
import type { ResolvedSecrets } from "@pcms/core";
import {
  createCapabilityRegistry,
  createExtensionLifecycleService,
} from "@pcms/extensions/internal";
import { createMcpServer, MCP_PROTOCOL_VERSION } from "@pcms/mcp";
import { LocalMediaStorage } from "@pcms/media";
import { createFirstPartyExtensionCatalog } from "../../../extensions/catalog.js";
import { registerAdminStatic } from "./admin.js";
import { registerFaviconRoute } from "./favicon.js";
import { registerMediaFilesRoute } from "./media-files.js";
import { registerPreviewRoute } from "./preview.js";
import { registerSeoFilesRoute } from "./seo-files.js";
import { registerSiteRoute } from "./site.js";
import { registerThemeFilesRoute } from "./theme-files.js";
import { loadThemePlacements } from "./theme-placements.js";
import { readThemeManifestPresets } from "./theme-presets.js";

/** Maps operator config onto the @pcms/publication limits shape. */
function pcpubLimitsFromConfig(pcpub: {
  limits?: {
    maxCompressedBytes?: number;
    maxUncompressedBytes?: number;
    maxDocuments?: number;
    maxAssets?: number;
    maxAssetBytes?: number;
  };
}): import("@pcms/publication").PcpubLimits {
  const defaults = DEFAULT_PCPUB_LIMITS;
  const limits = pcpub.limits ?? {};
  return {
    maxCompressedBytes: limits.maxCompressedBytes ?? defaults.maxCompressedBytes,
    maxUncompressedBytes: limits.maxUncompressedBytes ?? defaults.maxUncompressedBytes,
    maxEntries: defaults.maxEntries,
    maxDocuments: limits.maxDocuments ?? defaults.maxDocuments,
    maxDocumentBytes: defaults.maxDocumentBytes,
    maxAssets: limits.maxAssets ?? defaults.maxAssets,
    maxAssetBytes: limits.maxAssetBytes ?? defaults.maxAssetBytes,
    maxTotalAssetBytes: defaults.maxTotalAssetBytes,
    maxArtifacts: defaults.maxArtifacts,
    maxTotalArtifactBytes: defaults.maxTotalArtifactBytes,
    maxManifestBytes: defaults.maxManifestBytes,
    maxBlocksPerDocument: defaults.maxBlocksPerDocument,
  };
}

export interface WebRuntime {
  config: AppConfig;
  fastify: FastifyInstance;
  pool: DbPool;
  logger: Logger;
  application: ReturnType<typeof createApplicationServices>;
  mcp: ReturnType<typeof createMcpServer>;
}

/** Builds the web runtime without listening (unit-testable). */
export async function buildWebRuntime(options: {
  file?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<WebRuntime> {
  const config = loadConfig(options);
  const secrets = loadSecrets(config.secrets, options.env ?? process.env);
  const connectionInfo = buildDbConnectionInfo(config.db, secrets);
  const pool = createDbPool({
    connectionInfo,
    max: config.db.pool.webMax,
    connectionTimeoutMilliseconds: config.db.pool.connectionTimeoutMilliseconds,
    idleTimeoutMilliseconds: config.db.pool.idleTimeoutMilliseconds,
  });
  const logger = createLogger({
    level: config.log.level,
    base: { process: "pcms-web", nodeEnv: config.nodeEnv },
  });
  const requestContext = new AsyncLocalStorage<{ requestId: string }>();

  // API-grade Fastify: fail-secure AjV (unknown write fields rejected) and
  // the M01 baseline flags. The web process serves health + /api/v1.
  // X-Forwarded-* is honored only from the configured proxy networks
  // (PCMS-OPS-T105): behind the production nginx the canonical scheme/host
  // come from the trusted chain, never from an arbitrary client header.
  const fastify = createApiFastify(() => newRequestId(), {
    ...(config.http.trustedProxies.length > 0 ? { trustProxy: config.http.trustedProxies } : {}),
  });

  // API request-rate gate (per-client-IP token bucket over /api/v1/*).
  // Registered BEFORE the counting/authentication hooks so a flood never
  // reaches the DB or the session resolver. There are no /api/v1/health*
  // routes — the health endpoints live outside the prefix and stay
  // unthrottled for probes. `0`/undefined (manual configs) disables the gate
  // entirely; loadConfig defaults 1200/min in production.
  const apiRateLimitPerMinute = config.http.apiRateLimitPerMinute ?? 0;
  if (apiRateLimitPerMinute > 0) {
    // Capacity covers a 10-second burst; steady-state refill is limit/60 per
    // second. Date.now() suffices: bucket math tolerates wall-clock steps.
    const capacity = Math.max(1, Math.ceil(apiRateLimitPerMinute / 6));
    const refillPerSecond = apiRateLimitPerMinute / 60;
    const buckets = new Map<string, { tokens: number; updatedAt: number }>();
    fastify.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/api/v1/")) return;
      const now = Date.now();
      if (buckets.size > 10_000) {
        // Rotation bound: drop fully-refilled (idle) buckets; a flood keeps
        // at most one entry per client IP.
        for (const [ip, bucket] of buckets) {
          if (bucket.tokens >= capacity) buckets.delete(ip);
        }
      }
      const bucket = buckets.get(request.ip) ?? { tokens: capacity, updatedAt: now };
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + (Math.max(0, now - bucket.updatedAt) / 1000) * refillPerSecond,
      );
      bucket.updatedAt = now;
      if (bucket.tokens < 1) {
        buckets.set(request.ip, bucket);
        const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond));
        void reply
          .status(429)
          .header("retry-after", String(retryAfterSeconds))
          .send(
            toErrorEnvelope(
              new ApiError("API_RATE_LIMITED", "API rate limit exceeded, retry later", {
                status: 429,
                retryable: true,
              }),
              request.id,
            ),
          );
        return reply;
      }
      bucket.tokens -= 1;
      buckets.set(request.ip, bucket);
    });
  }

  fastify.addHook("onRequest", async (request) => {
    // enterWith propagates the request id through the request's async chain;
    // incoming X-Request-Id is deliberately not trusted (unvalidated header).
    requestContext.enterWith({ requestId: request.id });
  });
  fastify.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/api/v1") || request.url === "/mcp") return; // logged by their transports
    logger.info("http.request", {
      operation: "http.request",
      request_id: request.id,
      client_ip: request.ip, // trustProxy-aware; no actor is attached at this phase (auth lives in /api/v1 transport)
      method: request.method,
      url: request.url.split("?")[0], // query strings may carry preview tokens
      status_code: reply.statusCode,
      duration_ms: Number(reply.elapsedTime.toFixed(1)),
    });
  });

  // Health endpoints (PCMS-OPS-T008): M01's only required dependency is the
  // database; future dependencies add named checks here.
  await fastify.register(healthRoutes, {
    logger,
    checks: [
      {
        name: "db",
        run: (timeoutMilliseconds) => pool.check(timeoutMilliseconds),
      },
    ],
  });

  // Application layer + REST /api/v1 transport (M09, PCMS-API-T003).
  const previewSecret =
    config.publication?.previewSecretRef === undefined
      ? undefined
      : secrets.get(config.publication.previewSecretRef);
  // TOTP encryption key (M08 spec §67) — M10 wires it so the Admin MFA
  // surface (login completion, enrollment) works over REST (M09 handoff #9).
  const totpEncryptionKey =
    config.auth?.mfa?.totpEncryptionKeySecretRef === undefined
      ? undefined
      : secrets.get(config.auth.mfa.totpEncryptionKeySecretRef);
  const fileContentTypeDefinitions =
    config.content?.typesFile === undefined
      ? undefined
      : loadContentTypeDefinitions(config.content.typesFile);
  // Effective set = typesFile + persisted API schema overrides (additive-only
  // applies via POST /content/schema/apply). Fail-secure like the file: an
  // invalid override fails boot. Resolved here (async) because service
  // composition itself is synchronous.
  // Boot-degraded policy (health contract PCMS-OPS-T008): an unreachable
  // database must not take liveness down — the process starts and readiness
  // reports not_ready. Corrupt override DATA still fails boot (fail-secure
  // inside @pcms/content); only connection-class errors degrade here.
  const contentTypeDefinitions = await effectiveContentTypeDefinitions(
    pool,
    fileContentTypeDefinitions,
  ).catch((cause: unknown) => {
    const code = (cause as { code?: unknown }).code;
    if (typeof code !== "string" || !code.startsWith("E")) throw cause;
    logger.warn("content.overrides.unavailable", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return fileContentTypeDefinitions ?? [];
  });
  // Outbound mail (PCMS-OPS-T110/T130): transport + safe probe. Base surface
  // from deployment config + the secrets channel (`transport: "console"` is
  // the documented no-credential boundary); the Admin-managed SMTP settings
  // (migration 1601) override it per send when enabled. The encryption key
  // for the operator-entered password is optional — without it the Admin
  // cannot store a password (ref-based credentials keep working).
  // One shared encryption key protects ALL Admin-managed runtime secrets:
  // connector instance secrets (1602) and the managed SMTP password (1601).
  const runtimeSecretsKey =
    config.integrations?.runtimeSecretsEncryptionKeySecretRef === undefined
      ? undefined
      : secrets.get(config.integrations.runtimeSecretsEncryptionKeySecretRef);
  const runtimeSecretBox =
    runtimeSecretsKey === undefined ? undefined : createSecretBox(runtimeSecretsKey);
  const mail = applyManagedMailSettings(buildMailSurface(config.mail, secrets), {
    pool,
    ...(runtimeSecretBox === undefined ? {} : { secretBox: runtimeSecretBox }),
    logger,
  });
  // Production update adapters (PCMS-OPS-T114): wired only when the process
  // runs from a release layout that ships an update-manifest.json (dev/test
  // working trees stay fail-closed: apply reports adapters unavailable).
  // The CONFIGURED TARGET is the operator-staged manifest for the NEXT
  // release (incoming/update-manifest.json); the running release's own
  // manifest is the fallback so a no-op/self check stays honest.
  const releaseRoot = resolveCurrentReleaseRoot(import.meta.url);
  // Deployed release identity (M17 §12): read from the running layout, never
  // from the operator cwd; an explicit PCMS_RELEASE_ID still wins.
  const resolvedRelease = resolveReleaseIdentity(fileURLToPath(import.meta.url));
  const releaseId =
    process.env.PCMS_RELEASE_ID ??
    (resolvedRelease.mode === "release" ? resolvedRelease.identity.releaseId : undefined);
  const incomingDir = process.env.PCMS_INCOMING_DIR ?? "/opt/progressive-cms/incoming";
  const updateManifestCandidates = releaseRoot
    ? [join(incomingDir, "update-manifest.json"), join(releaseRoot, "update-manifest.json")]
    : [];
  const updateManifestPath = updateManifestCandidates.find((candidate) => existsSync(candidate));
  const updateManifestDocument =
    updateManifestPath !== undefined
      ? JSON.parse(readFileSync(updateManifestPath, "utf8"))
      : undefined;
  // ADR-0017 R2: the update orchestrator reconciles installed extensions
  // with the shipped artifacts through the same trusted catalog (a second
  // lifecycle INSTANCE is fine — the DB revision/ledger is the authority).
  // PCMS_ADMIN_UI_TEST=1 composes the ui-test entries (Admin UI contract
  // gate fixture) — the e2e harness only; production web always standard.
  // The ui-test variant is loaded DYNAMICALLY so the production import graph
  // never references it (release ships without that module).
  let extensionCatalog = createFirstPartyExtensionCatalog({ pool });
  if (process.env.PCMS_ADMIN_UI_TEST === "1") {
    const uiTest = await import("../../../extensions/catalog.ui-test.generated.js");
    extensionCatalog = uiTest.createFirstPartyExtensionCatalog({ pool });
  }
  const updateOrchestrationPorts =
    updateManifestDocument === undefined
      ? undefined
      : createProductionUpdatePorts({
          currentReleaseRoot: releaseRoot,
          incomingDir,
          currentSymlink: "/opt/progressive-cms/current",
          installStatusFile: "/run/progressive-cms/install.status",
          backupUnit: "progressive-cms-backup.service",
          installUnit: "progressive-cms-install.service",
          backupDir: "/var/backups/progressive-cms",
          healthUrl: `http://127.0.0.1:${config.http.port}/health/ready`,
          pool,
          lifecycle: createExtensionLifecycleService({
            pool,
            clock: systemClock,
            coreVersion: readCmsVersionFromRelease(),
            catalog: extensionCatalog,
            systemCapabilities: createCapabilityRegistry(),
          }),
        });
  if (config.themes?.renderDir)
    await recoverThemeLifecycle({
      pool,
      configuredDir: config.themes.renderDir,
      siteKey: "default",
    });
  const application = createApplicationServices({
    pool,
    clock: systemClock,
    // ADR-0013 §52.1: the trusted catalog is identical in web and worker.
    extensionCatalog,
    // Stock candidate references are signed with the runtime-secrets key
    // material (ADR-0013 §candidate security; never stored in the DB).
    ...(runtimeSecretsKey === undefined ? {} : { mediaCandidateSigningKey: runtimeSecretsKey }),
    ...(contentTypeDefinitions === undefined ? {} : { contentTypeDefinitions }),
    ...(config.seo?.environment === undefined ? {} : { seoEnvironment: config.seo.environment }),
    environmentClassification: config.nodeEnv === "production" ? "production" : "development",
    // Community skills (off by default; the operator opts in via config).
    ...(config.skills?.communityDir === undefined
      ? {}
      : { communitySkillsDir: config.skills.communityDir }),
    ...(config.skills?.communityEnabled === undefined
      ? {}
      : { communitySkillsEnabled: config.skills.communityEnabled }),
    ...(config.registry?.baseUrl === undefined ? {} : { registryBaseUrl: config.registry.baseUrl }),
    registryReportUpdates: config.registry?.reportUpdates === true,
    ...(process.env["PCMS_INCOMING_DIR"] === undefined
      ? {}
      : { registryIncomingDir: process.env["PCMS_INCOMING_DIR"] }),
    ...(releaseId === undefined ? {} : { releaseId }),
    secrets,
    ...(config.themes?.renderDir === undefined ? {} : { themeDir: config.themes.renderDir }),
    mediaPresets: readThemeManifestPresets(config.themes?.renderDir),
    ...(config.media === undefined
      ? {}
      : {
          mediaStorage: new LocalMediaStorage({ root: config.media.storageDir }),
          mediaQuarantine: new LocalMediaStorage({ root: config.media.quarantineDir }),
          mediaLimits: {
            maxUploadBytes: config.media.maxUploadBytes,
            maxVideoUploadBytes: config.media.maxVideoUploadBytes,
            maxAudioUploadBytes: config.media.maxAudioUploadBytes,
            ...(config.media.disabledTypes === undefined
              ? {}
              : { disabledTypes: config.media.disabledTypes }),
            maxImagePixels: config.media.maxImagePixels,
            maxImageDimension: config.media.maxImageDimension,
          },
        }),
    ...(config.pcpub === undefined
      ? {}
      : {
          pcpubBundleLimits: pcpubLimitsFromConfig(config.pcpub),
          pcpubQuarantineDir: config.pcpub.quarantineDir,
        }),
    ...(previewSecret === undefined ? {} : { previewSecret }),
    ...(totpEncryptionKey === undefined ? {} : { totpEncryptionKey }),
    ...(config.auth?.mfa?.policy === undefined ? {} : { mfaPolicy: config.auth.mfa.policy }),
    ...(config.themes?.renderDir === undefined
      ? {}
      : { navigationPlacements: loadThemePlacements(config.themes.renderDir) }),
    ...(mail === undefined ? {} : { mailTransport: mail.transport }),
    ...(mail?.verify === undefined ? {} : { mailVerify: mail.verify }),
    ...(runtimeSecretBox === undefined ? {} : { runtimeSecretBox }),
    ...(updateOrchestrationPorts === undefined ? {} : { updateOrchestrationPorts }),
    ...(updateManifestDocument === undefined ? {} : { updateManifest: updateManifestDocument }),
  });

  // CMS Maintenance Mode (PCMS-OPS-T118): gates everything registered after
  // this point except bypass-privileged actors; health routes registered
  // above stay ungated by construction. Admin/auth/MCP are exempt inside the
  // gate so the mode can always be turned back off.
  registerMaintenanceGate(fastify, {
    application,
    logger,
    cookieSecure: config.http?.cookieSecure ?? config.nodeEnv === "production",
  });

  await fastify.register(
    createApiV1([
      ...makeDiscoveryRoutes(),
      ...makeContentSchemaRoutes(),
      ...makeRoutingRoutes(),
      ...makeSkillsRoutes(),
      ...makeRegistryRoutes(),
      ...makeThemeManageRoutes(),
      ...makeMutationRoutes(),
      ...makeSearchRoutes(),
      ...makeCollectionsRoutes(),
      ...makeAnalyticsRoutes(),
      ...makeSeoIndexNowRoutes(),
      ...makeFormsRoutes(),
      ...makeInteractionsRoutes(),
      ...makeIntegrationsRoutes(),
      ...makePaymentsRoutes(),
      ...makeExtensionsRoutes(),
      ...makeMediaProviderRoutes(),
      ...makePcpubBundleRoutes(),
      ...makeLocalizationRoutes(),
      ...makeMaintenanceRoutes(),
      ...makeAgentRoutes(),
      ...makeMailRoutes(),
      ...makeNotificationRoutes(),
    ]),
    {
      application,
      logger,
      // __Host- cookies demand TLS; plain-HTTP development uses a non-prefixed
      // name (auth package cookie contract). Proxy/TLS hardening is M15.
      cookieSecure: config.http?.cookieSecure ?? config.nodeEnv === "production",
    },
  );

  // Preview transport (PCMS-API-T016/T029): signed URLs over the M07
  // preview state resolver, M07 security headers on every response.
  registerPreviewRoute(fastify, { application });

  // Public site (composition capability): Routing → published revision →
  // theme render; registered after the maintenance gate so anonymous
  // requests keep receiving the branded 503 while it is enabled.
  await registerSiteRoute(fastify, { application });
  registerMediaFilesRoute(fastify, { application });
  // Theme public assets (M17-T007; ADR-0011): the external-RP profile has no
  // in-container nginx, so the application serves /themes/<name>/assets/*.
  registerThemeFilesRoute(fastify, { renderDir: config.themes?.renderDir, application });
  // Public SEO documents (M17 §44/§45): robots.txt + sitemap.xml from the
  // SEO subsystem; origin comes from the primary domain binding.
  registerSeoFilesRoute(fastify, { application });
  // Standard browser alias for the current site's favicon (CORE-FAVICON-01):
  // same Site Identity source as the core head, no theme or Nginx involvement.
  registerFaviconRoute(fastify, { application });

  // Admin Workspace static bundle (PCMS-ADMIN-T001, ADR-0009): pure static
  // SPA under /admin/; missing bundle = warning, API-only deployments fine.
  await registerAdminStatic(fastify, {
    distDir: config.admin?.distDir ?? join(process.cwd(), "apps/admin/dist"),
    logger,
  });

  // MCP transport (PCMS-API-T019): JSON-RPC over POST /mcp, bearer-token
  // auth only; every call resolves its own ActorContext (no trust shortcuts).
  const mcp = createMcpServer({
    operations: bindOperations(application),
    serverInfo: { name: "progressive-cms-mcp", version: "1.0.0" },
    // ADR-0013 §52.3: derived tools from enabled deployed extension
    // operations, recomputed per tools/list (disable ⇒ tool gone).
    dynamicTools: () => buildExtensionMcpTools(application),
  });
  fastify.post("/mcp", { bodyLimit: 1_048_576 }, async (request, reply) => {
    const auth = await authenticateRequest(application, request, {
      cookieSecure: config.http?.cookieSecure ?? config.nodeEnv === "production",
    });
    if (auth === null || auth.via !== "bearer") {
      void reply.status(401).send({ error: { code: "AUTH_UNAUTHENTICATED" } });
      return reply;
    }
    const response = await mcp.handleRequest(request.body, () => ({
      actor: auth.actor,
      transport: "mcp",
      requestId: request.id,
    }));
    if (response === null) {
      void reply.status(204).send();
      return reply;
    }
    void reply.send(response);
    return reply;
  });

  return { config, fastify, pool, logger, application, mcp };
}

export async function startWeb(options: {
  file?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<WebRuntime> {
  const runtime = await buildWebRuntime(options);
  const { config, fastify, pool, logger } = runtime;

  installSignalHandlers({
    shutdownTimeoutMilliseconds: config.http.shutdownTimeoutMilliseconds,
    onSignal: (signal) => logger.info("web.shutdown.begin", { operation: "web.shutdown", signal }),
    shutdown: async () => {
      await fastify.close();
      await pool.end();
      logger.info("web.shutdown.complete", { operation: "web.shutdown" });
    },
  });

  const address = await fastify.listen({ port: config.http.port, host: config.http.host });
  logger.info("web.ready", { operation: "web.boot", address, node: process.version });
  return runtime;
}

// Release installs run through the /opt/progressive-cms/current symlink:
// argv[1] keeps the symlink path while import.meta.url is the real release
// path, so both sides are resolved before comparing (PCMS-OPS-T101).
const isMain =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fileIndex = process.argv.indexOf("--config");
  const fileArg = fileIndex >= 0 ? process.argv[fileIndex + 1] : undefined;
  startWeb(fileArg === undefined ? {} : { file: fileArg }).catch((error) => {
    // Fail-secure: a broken startup (config, secrets, DB) must exit non-zero.
    console.error("[pcms-web] startup failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
