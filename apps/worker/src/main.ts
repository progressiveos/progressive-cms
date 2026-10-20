// pcms-worker process (PCMS-OPS-T007 / PCMS-PUB-T018) — background
// composition root.
//
// M07: runs the durable job queue runner (claim → execute → record, lease
// recovery on worker death). Typed publication job handlers are registered
// in the composition handler registry (PCMS-PUB-T023); the jobs package
// itself never imports publication. M01 lifecycle contract preserved:
// SIGTERM/SIGINT graceful, bounded shutdown, pool closes, claimed work is
// left in a defined state (lease expiry lets another worker recover it).
import { hkdfSync } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createApplicationServices,
  createExtensionJobHandlers,
  createExtensionScheduleService,
  createMediaGenerationJobHandler,
  processPcpubIngest,
  readCmsVersionFromRelease,
  sweepGenerationRunsOp,
  sweepNotificationsOp,
} from "@pcms/api";
import { createSecretBox, decodeEncryptionKey } from "@pcms/auth";
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
  systemClock,
} from "@pcms/core";
import {
  composeExtensionRegistrations,
  createCapabilityRegistry,
  createExtensionEventConsumer,
  createExtensionLifecycleService,
  type ExtensionEventSubscriptionSpec,
  mergeOutboxHandlers,
} from "@pcms/extensions/internal";
import { createRetentionService } from "@pcms/forms";
import {
  applyManagedMailSettings,
  buildMailSurface,
  INTERACTION_EVENT_TYPES,
  type IntegrationDomainEvent,
} from "@pcms/integrations";
import { createJobRunner, createJobsService, type JobHandler } from "@pcms/jobs";
import { MCP_PROTOCOL_VERSION } from "@pcms/mcp";
import { LocalMediaStorage } from "@pcms/media";
import { createMetricSampler, createWorkerHeartbeatWriter } from "@pcms/operations";
import {
  createOutboxConsumer,
  createOutboxService,
  createPublicationJobHandlers,
  type OutboxConsumer,
} from "@pcms/publication";
import { sweepSealedRevisions } from "@pcms/revisions";
import {
  createPgSearchProvider,
  createSearchIndexingService,
  createSearchJobHandlers,
  createSearchOutboxHandlers,
  createSearchReindexService,
} from "@pcms/search";
import { readThemeManifestPresets } from "@pcms/themes";
import { createFirstPartyExtensionCatalog } from "../../../extensions/catalog.js";
import { loadContentTypeDefinitions } from "./content-types.js";

/** DB probe cadence for availability logging. */
const PROBE_INTERVAL_MILLISECONDS = 10_000;
/** Outbox delivery cadence (M07 at-least-once; search indexing rides it). */
const OUTBOX_INTERVAL_MILLISECONDS = 2_000;
const OUTBOX_BATCH_SIZE = 50;

async function startWorker(options: {
  file?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<void> {
  const config = loadConfig(options);
  const secrets = loadSecrets(config.secrets, options.env ?? process.env);
  const connectionInfo = buildDbConnectionInfo(config.db, secrets);
  const pool = createDbPool({
    connectionInfo,
    max: config.db.pool.workerMax,
    connectionTimeoutMilliseconds: config.db.pool.connectionTimeoutMilliseconds,
    idleTimeoutMilliseconds: config.db.pool.idleTimeoutMilliseconds,
  });
  const logger = createLogger({
    level: config.log.level,
    base: { process: "pcms-worker", nodeEnv: config.nodeEnv },
  });

  // Durable worker heartbeat (PCMS-OPS-T109; Operations spec §50): the
  // singleton row proves the loop is actually progressing — "systemd active"
  // alone is not an operational signal. Beats ride a fixed interval; a failed
  // beat (DB down) is deliberately silent — the stale heartbeat is the
  // failure doctors/monitoring must see.
  const heartbeat = createWorkerHeartbeatWriter(pool, systemClock);
  // System dashboard sampling (owner UX pass 0.1.28): one bounded row per
  // minute — cgroup-aware CPU/memory + queue/outbox depths, 72h retention.
  const metricSampler = createMetricSampler(pool, { clock: systemClock });
  metricSampler.start();

  // Search indexing composition (M11): the worker is the only outbox
  // consumer — publication events re-derive search documents from live
  // authoritative state; failures retry through the outbox lease/backoff
  // cycle and never affect publication outcomes.
  // Effective set = typesFile + persisted API schema overrides (see web
  // boot): both processes must see the identical schema, fail-secure.
  // Boot-degraded policy (health contract PCMS-OPS-T008): an unreachable
  // database must not take liveness down — the process starts and readiness
  // reports not_ready. Corrupt override DATA still fails boot (fail-secure
  // inside @pcms/content); only connection-class errors degrade here.
  const contentTypeDefinitions = await effectiveContentTypeDefinitions(
    pool,
    config.content?.typesFile === undefined
      ? undefined
      : loadContentTypeDefinitions(config.content.typesFile),
  ).catch((cause: unknown) => {
    const code = (cause as { code?: unknown }).code;
    if (typeof code !== "string" || !code.startsWith("E")) throw cause;
    logger.warn("content.overrides.unavailable", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return config.content?.typesFile === undefined
      ? undefined
      : (loadContentTypeDefinitions(config.content.typesFile) ?? []);
  });
  // M14 trusted extension catalog (composition-time only — the DB is not a
  // package manager), built through the shared first-party helper so web and
  // worker always deploy the identical artifact set (ADR-0013 §52.1).
  // PCMS_ADMIN_UI_TEST=1 composes the ui-test entries (ADR-0018 acceptance
  // harness) — worker mirrors the web composition so source pipelines see
  // the same set in both processes.
  let extensionCatalog = createFirstPartyExtensionCatalog({ pool });
  if (process.env.PCMS_ADMIN_UI_TEST === "1") {
    const uiTest = await import("../../../extensions/catalog.ui-test.generated.js");
    extensionCatalog = uiTest.createFirstPartyExtensionCatalog({ pool });
  }
  const extensionSystemCapabilities = createCapabilityRegistry();
  // Runtime secret store key (PCMS-OPS-T131): the worker executes connector
  // deliveries, so it must be able to decrypt Admin-managed secret values.
  const runtimeSecretsKey =
    config.integrations?.runtimeSecretsEncryptionKeySecretRef === undefined
      ? undefined
      : secrets.get(config.integrations.runtimeSecretsEncryptionKeySecretRef);
  // F-37 (key separation): the candidate-signing key is HKDF-derived from the
  // runtime-secrets key instead of reusing it raw — the AES key that decrypts
  // Admin-managed secrets must not be the same key material that is fed into
  // HMAC candidate tokens on every stock/generation request. The derived
  // base64 string is what signStockCandidate/verifyStockCandidate consume.
  const mediaCandidateSigningKey =
    runtimeSecretsKey === undefined
      ? undefined
      : Buffer.from(
          hkdfSync(
            "sha256",
            decodeEncryptionKey(runtimeSecretsKey),
            "pcms-hkdf-v1",
            "pcms:media-candidate-signing",
            32,
          ),
        ).toString("base64");
  // Mail surface (0.1.194): the worker executes integration email-connector
  // deliveries AND notification mail — both route through the same transport
  // resolution as web (config → Admin-managed SMTP override, per call).
  const runtimeSecretBox =
    runtimeSecretsKey === undefined ? undefined : createSecretBox(runtimeSecretsKey);
  const mail = applyManagedMailSettings(buildMailSurface(config.mail, secrets), {
    pool,
    ...(runtimeSecretBox === undefined ? {} : { secretBox: runtimeSecretBox }),
    logger,
  });
  const application = createApplicationServices({
    pool,
    clock: systemClock,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    ...(contentTypeDefinitions === undefined ? {} : { contentTypeDefinitions }),
    ...(config.seo?.environment === undefined ? {} : { seoEnvironment: config.seo.environment }),
    secrets,
    extensionCatalog,
    extensionSystemCapabilities,
    ...(mail === undefined ? {} : { mailTransport: mail.transport }),
    // ADR-0013: signing key for stock candidate references (media ops run
    // here for generation jobs, and the API application surface is shared).
    ...(mediaCandidateSigningKey === undefined ? {} : { mediaCandidateSigningKey }),
    ...(runtimeSecretBox === undefined ? {} : { runtimeSecretBox }),
    // Theme-declared media presets: variant generation for staged media runs
    // HERE (staging_media → generateVariantsAfterAccept) — without the active
    // theme's presets the worker would commit every image with zero
    // derivatives and every theme gallery/hero reference would placeholder.
    mediaPresets: readThemeManifestPresets(config.themes?.renderDir),
    // .pcpub ingest stages media in the worker (ADR-0014 §8; Publication
    // spec §83.5): the same canonical storage volumes the web process uses.
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
  });
  // ADR-0013 §71.7: media generation executes in the worker (durable queue,
  // bounded retries); a failed run is recorded as failed — never blocking.
  const mediaGenerationHandler = createMediaGenerationJobHandler(application);
  const searchIndexing = createSearchIndexingService({
    provider: application.searchProvider,
    source: application.searchSource,
    pool,
    clock: systemClock,
  });
  const outbox = createOutboxService(pool, { clock: systemClock });
  // M13 integrations dispatch (composition-owned): M12/M13/Payments domain
  // events materialize IntegrationDeliveries; the dispatcher NEVER makes
  // network calls here — execution rides the due-delivery loop below so an
  // external outage cannot lose an accepted business event.
  const integrationsHandler = (event: IntegrationDomainEvent) =>
    application.integrations.dispatcher.handleEvent(event);
  const m13Handlers: Record<string, (event: IntegrationDomainEvent) => Promise<void>> = {};
  for (const eventType of INTERACTION_EVENT_TYPES) {
    m13Handlers[eventType] = integrationsHandler;
  }
  m13Handlers["PaymentStatusChanged"] = integrationsHandler;
  // M14 extension event consumption rides the SAME outbox fanout: handler
  // families are merged (never overwritten), so an extension consumer can
  // not steal an event from the search or M13 consumers. Only ENABLED
  // extensions contribute subscriptions; the set refreshes lazily with a
  // cache so boot never requires the extension state tables (pre-M14
  // databases stay bootable — same honest-readiness contract as M01).
  const extensionLifecycle = createExtensionLifecycleService({
    pool,
    clock: systemClock,
    coreVersion: readCmsVersionFromRelease(),
    catalog: extensionCatalog,
    systemCapabilities: extensionSystemCapabilities,
  });
  let extensionEventConsumer = createExtensionEventConsumer({
    pool,
    clock: systemClock,
    subscriptions: [],
  });
  /** Lifecycle revision the current subscription set was built from (R3). */
  let extensionRevision: string | null = null;
  const refreshExtensionSubscriptions = async (): Promise<void> => {
    // Authoritative revision read (ADR-0017 R3): a disable in ANY process
    // (web A, web B, this worker) bumps it and the next dispatched event
    // recomposes BEFORE the consumer runs — fail-closed, no TTL trust.
    let revision: string;
    try {
      revision = await extensionLifecycle.revision();
    } catch {
      return; // pre-M14 database (no extension state tables yet)
    }
    if (revision === extensionRevision) return;
    extensionRevision = revision;
    const enabledExtensionIds = await extensionLifecycle.enabledIds();
    const subscriptions: ExtensionEventSubscriptionSpec[] = [];
    for (const registration of composeExtensionRegistrations(extensionCatalog, enabledExtensionIds)
      .registrations) {
      if (registration.kind !== "event_subscription") continue;
      // Handler resolves from the OWNING artifact (spec §7) — never from one
      // hardcoded module: a second first-party extension must just work, and
      // same-named handlers must not cross-resolve (owner-module defect, 2026-10-10).
      const handler = extensionCatalog.get(registration.extensionId)?.module?.[
        registration.handler
      ];
      if (typeof handler !== "function") continue;
      subscriptions.push({
        extensionId: registration.extensionId,
        subscriptionId: registration.subscriptionId,
        eventType: registration.eventType,
        handler: handler as unknown as ExtensionEventSubscriptionSpec["handler"],
      });
    }
    extensionEventConsumer = createExtensionEventConsumer({
      pool,
      clock: systemClock,
      subscriptions,
    });
  };
  // Every event type ANY deployed artifact could ever subscribe to gets a
  // delegating family entry (manifest data, no DB read): enabling an
  // extension later cannot introduce an unknown type. Types with no core
  // consumer fall through to the outbox fallback, which delegates to the
  // same consumer — a no-op when nothing subscribes, so the event completes.
  const extensionEventFamily: Record<string, (event: unknown) => Promise<void>> = {};
  const potentialTypes = composeExtensionRegistrations(
    extensionCatalog,
    extensionCatalog.list().map((artifact) => artifact.manifest.id),
  ).registrations;
  for (const registration of potentialTypes) {
    if (registration.kind !== "event_subscription") continue;
    if (registration.eventType in extensionEventFamily) continue;
    extensionEventFamily[registration.eventType] = async (event: unknown) => {
      await refreshExtensionSubscriptions();
      await extensionEventConsumer.handle(event as never);
    };
  }
  const composedHandlers = mergeOutboxHandlers([
    createSearchOutboxHandlers({ indexing: searchIndexing }) as never,
    // IndexNow v1 (spec §15): generic publication/routing facts → pending
    // notifications. Gated by settings; a disabled site short-circuits
    // before anything is queued.
    {
      EntryPublished: (event: unknown) =>
        application.indexNow.handlePublicationEvent(event as never),
      EntryUnpublished: (event: unknown) =>
        application.indexNow.handlePublicationEvent(event as never),
      EntryRolledBack: (event: unknown) =>
        application.indexNow.handlePublicationEvent(event as never),
      EntryRouteChanged: (event: unknown) =>
        application.indexNow.handlePublicationEvent(event as never),
    },
    m13Handlers as never,
    extensionEventFamily as never,
  ]);
  const outboxConsumer = createOutboxConsumer(outbox, composedHandlers, {
    // Events without a registered handler are acknowledged as delivered —
    // the outbox must not accumulate. Extension subscriptions on types no
    // core consumer carries ride this fallback (refresh is TTL-bounded; the
    // consumer no-ops when nothing subscribes).
    fallback: async (event: unknown) => {
      // Extension Contract 2.0 (P1-b; ADR-0018): "<extensionId>/EntityChanged"
      // and "<extensionId>/EntityRemoved" outbox events drive extension-owned
      // search documents (build -> index, or null -> remove; the payload
      // carries {entityType, entityId, generation, context?}). Everything
      // else keeps riding the extension subscription fallback.
      const shape = event as { id?: string; eventType?: string; payload?: unknown };
      if (
        typeof shape.eventType === "string" &&
        (shape.eventType.endsWith("/EntityChanged") ||
          shape.eventType.endsWith("/EntityRemoved")) &&
        typeof shape.id === "string"
      ) {
        await searchIndexing.applyPublicationEvent({
          id: shape.id,
          eventType: shape.eventType,
          payload: shape.payload,
          createdAt: new Date(),
        });
        return;
      }
      await refreshExtensionSubscriptions();
      await extensionEventConsumer.handle(event as never);
    },
  });

  const jobs = createJobsService(pool, {
    clock: systemClock,
    ...(config.jobs?.backoffBaseMilliseconds === undefined
      ? {}
      : { backoffBaseMilliseconds: config.jobs.backoffBaseMilliseconds }),
  });
  // PREPUBLIC §4 — Extension Jobs on the SHARED queue (contract in
  // createExtensionJobHandlers): lifecycle + payload-version policy.
  const extensionJobHandlers = createExtensionJobHandlers({
    pool,
    catalog: extensionCatalog,
    enabledIds: () => extensionLifecycle.enabledIds(),
    site: { key: application.defaultSiteKey, defaultLocale: "x-default" },
  });

  // D06 — periodic extension jobs: every poll interval, enqueue every due
  // schedule. `enqueueRecurring` atomically checks for an in-flight run of the
  // same logical task (any window) and inserts the new one under one advisory
  // lock, so neither a long run nor a second worker can double it.
  const scheduleService = createExtensionScheduleService({
    jobs: {
      enqueueRecurring: (input) => jobs.enqueueRecurring(input),
    },
    catalog: extensionCatalog,
    enabledIds: () => extensionLifecycle.enabledIds(),
    clock: systemClock,
  });

  const JOB_HANDLERS: Record<string, JobHandler> = {
    // IndexNow delivery (spec §14/§21): async flush of pending notifications;
    // failures stay bounded in the pending table, never in publication.
    "seo.indexnow.flush": async () => {
      await application.indexNow.deliverPending();
    },
    ...(createSearchJobHandlers({ reindex: application.searchReindex }) as Record<
      string,
      JobHandler
    >),
    // Scheduled publications (owner UX pass 0.1.28): publication plans enqueue
    // publication.publish/unpublish jobs — without these handlers scheduled
    // work sat in the queue forever. Handlers apply through the same
    // PublicationService as manual publishes (CAS + validators included).
    ...(createPublicationJobHandlers({
      pool,
      clock: systemClock,
      publications: application.publications,
      changesets: application.changesets,
      siteKey: application.defaultSiteKey,
    }) as Record<string, JobHandler>),
    // M12 Forms/Quizzes/Leads retention sweep (Forms spec §30/§31): applied
    // daily through the durable queue; the enqueue is idempotent per day.
    // ADR-0013 §71.7: purge unaccepted generation runs (TTL, default 7d).
    "media.generation": async (payload: unknown) => {
      await mediaGenerationHandler(payload as { run_id?: unknown });
    },
    "media.generation-sweep": async () => {
      const removed = await sweepGenerationRunsOp(application);
      if (removed > 0) {
        logger.info("worker.media.generation_sweep", {
          operation: "worker.media.generation",
          runs_removed: removed,
        });
      }
    },
    // .pcpub ingest pipeline (ADR-0014 §8, Publication spec §83): stages run
    // in the worker; resume-from-stage makes retries idempotent.
    "publication_bundle.ingest": async (payload: unknown) => {
      const ingestId = (payload as { ingest_id?: unknown }).ingest_id;
      if (typeof ingestId !== "string") {
        throw new Error("publication_bundle.ingest payload needs ingest_id");
      }
      await processPcpubIngest(application, ingestId);
    },
    // S7 financial safety: durable refund intent execution. The job id is
    // the intent id (idempotency_key) — a retried/duplicated job drives the
    // SAME logical refund; max attempts then leave the intent SUBMITTED for
    // manual reconciliation (never a silent loss).
    "payments.refund.execute": async (payload: unknown) => {
      // The payload carries the intent id; the job's idempotency_key
      // additionally makes duplicated enqueues a no-op at the store level.
      const intentId =
        typeof (payload as { intent_id?: unknown })?.intent_id === "string"
          ? (payload as { intent_id: string }).intent_id
          : "";
      if (intentId === "") return; // malformed enqueue — nothing to drive
      await application.payments.service.executeRefundIntent(intentId);
    },
    "payments.refund.reconcile": async () => {
      const stale = await application.payments.service.reconcileStaleRefundIntents(5);
      if (stale > 0) {
        logger.warn("worker.payments.refund_stale", {
          operation: "worker.payments",
          intents: stale,
        });
      }
      const intents = await application.payments.service.claimDueRefundIntents(25);
      for (const intentId of intents) {
        try {
          await application.payments.service.executeRefundIntent(intentId);
        } catch {
          // executor classified unknown outcomes; job-level retry not needed
          // for REQUESTED rows — the next reconcile sweep re-claims them.
        }
      }
    },
    // S7: inbound replay/recovery (RECEIVED-after-crash, transient FAILED,
    // orphan callbacks whose provider came back). Authenticity re-verified
    // before every apply; capped backoff; attempts cap = dead-letter (visible
    // in Admin diagnostics, never deleted).
    "payments.inbound.recover": async () => {
      const ids = await application.payments.service.claimDueInboundEvents(50, 10);
      for (const eventId of ids) {
        try {
          const outcome = await application.payments.service.recoverInboundEvent(eventId);
          if (!outcome.applied) {
            await application.payments.service.scheduleInboundRetry(eventId, 1);
          }
        } catch {
          await application.payments.service.scheduleInboundRetry(eventId, 3);
        }
      }
    },
    "revisions.retention-sweep": async () => {
      const stats = await sweepSealedRevisions(pool);
      if (stats.deleted > 0) {
        logger.info("worker.revisions.retention_sweep", {
          operation: "worker.revisions.retention",
          entities_scanned: stats.entities_scanned,
          revisions_deleted: stats.deleted,
        });
      }
    },
    // Notifications v1 (owner brief 2026-10-07): sweep sources → queue and
    // deliver immediate/digest mail. Enqueued once per minute (idempotency
    // key below), so "immediate" delivery lands within a minute.
    "notifications.dispatch": async () => {
      const stats = await sweepNotificationsOp({
        pool,
        clock: systemClock,
        ...(mail === undefined ? {} : { mailTransport: mail.transport }),
        origin: await application.primaryOrigin(),
      });
      if (stats.inserted > 0 || stats.immediate_sent > 0 || stats.digests_sent > 0) {
        logger.info("worker.notifications.dispatch", {
          operation: "worker.notifications",
          inserted: stats.inserted,
          immediate_sent: stats.immediate_sent,
          digests_sent: stats.digests_sent,
        });
      }
    },
    "forms.retention-sweep": async () => {
      const stats = await createRetentionService(pool, { clock: systemClock }).sweep();
      logger.info("worker.forms.retention_sweep", {
        operation: "worker.forms.retention",
        forms_anonymized: stats.forms_anonymized,
        forms_deleted: stats.forms_deleted,
        quiz_runs_anonymized: stats.quiz_runs_anonymized,
        quiz_runs_deleted: stats.quiz_runs_deleted,
        leads_anonymized: stats.leads_anonymized,
        leads_deleted: stats.leads_deleted,
        quiz_runs_expired: stats.quiz_runs_expired,
      });
    },
  };
  const runner = createJobRunner(
    jobs,
    {
      ...JOB_HANDLERS,
      ...extensionJobHandlers,
    },
    {
      clock: systemClock,
      onWorkerError: (error) => {
        logger.error("worker.job.error", {
          operation: "worker.jobs",
          error,
        });
      },
      onJobDone: (info) => {
        logger.info("worker.job.done", {
          operation: "worker.jobs",
          job_id: info.jobId,
          job_type: info.type,
          outcome: info.outcome,
        });
      },
    },
    {
      pollIntervalMilliseconds: config.jobs?.pollIntervalMs ?? 5000,
      claimBatchMax: config.jobs?.claimBatchMax ?? 10,
      leaseMilliseconds: config.jobs?.leaseMilliseconds ?? 300000,
      runImmediately: true,
    },
  );

  // D06 schedule sweeps on the same cadence as the job poll loop.
  const enqueueSchedules = async (): Promise<void> => {
    const result = await scheduleService.enqueueDue();
    if (result.enqueued > 0) {
      logger.info("worker.schedules.enqueued", {
        operation: "worker.schedules",
        count: result.enqueued,
      });
    }
  };
  const scheduleTimer = setInterval(() => {
    if (stopped) return;
    void enqueueSchedules().catch((error) => {
      logger.warn("worker.schedules.enqueue_failed", {
        operation: "worker.schedules",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, config.jobs?.pollIntervalMs ?? 5000);
  void enqueueSchedules().catch(() => {});

  let stopped = false;
  let outboxRunning = false;
  let deliveriesRunning = false;
  const outboxTimer = setInterval(() => {
    if (stopped || outboxRunning) return; // no overlapping batches
    outboxRunning = true;
    void outboxConsumer
      .processBatch(OUTBOX_BATCH_SIZE)
      .catch((error: unknown) => {
        logger.warn("worker.outbox.batch_failed", {
          operation: "worker.outbox",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        outboxRunning = false;
      });
    // Execute due IntegrationDeliveries (bounded retry/backoff lives in the
    // delivery tables, independent of the outbox lease cycle).
    if (deliveriesRunning) return;
    deliveriesRunning = true;
    void application.integrations.dispatcher
      .processDue(OUTBOX_BATCH_SIZE)
      .catch((error: unknown) => {
        logger.warn("worker.integrations.batch_failed", {
          operation: "worker.integrations",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        deliveriesRunning = false;
      });
  }, OUTBOX_INTERVAL_MILLISECONDS);

  installSignalHandlers({
    shutdownTimeoutMilliseconds: config.http.shutdownTimeoutMilliseconds,
    onSignal: (signal) =>
      logger.info("worker.shutdown.begin", { operation: "worker.shutdown", signal }),
    shutdown: async () => {
      stopped = true;
      heartbeat.stop();
      metricSampler.stop();
      stopProbes();
      clearInterval(outboxTimer);
      clearInterval(generationSweepTimer);
      clearInterval(notificationsTimer);
      clearInterval(scheduleTimer);
      // Drain one last outbox batch before stopping.
      try {
        await outboxConsumer.processBatch(OUTBOX_BATCH_SIZE);
      } catch {
        // lease expiry lets the next worker recover — best-effort drain
      }
      const drained = await stopJobs(config.http.shutdownTimeoutMilliseconds ?? 0);
      if (!drained) {
        logger.warn("worker.shutdown.jobs_inflight", { operation: "worker.shutdown" });
      }
      await pool.end();
      logger.info("worker.shutdown.complete", { operation: "worker.shutdown" });
    },
  });

  let dbAvailable: boolean | null = null;
  const probe = async (): Promise<void> => {
    if (stopped) return;
    const available = await pool.check(2000);
    if (available !== dbAvailable) {
      dbAvailable = available;
      if (available) logger.info("worker.db.available", { operation: "worker.probe" });
      else logger.warn("worker.db.unavailable", { operation: "worker.probe" });
    }
  };

  const timer = setInterval(() => {
    void probe();
  }, PROBE_INTERVAL_MILLISECONDS);
  const stopProbes = () => {
    clearInterval(timer);
    clearInterval(retentionTimer);
    clearInterval(paymentsSweepTimer);
  };
  const stopJobs = (timeoutMilliseconds = 10_000) => runner.stop(timeoutMilliseconds);

  /** Daily retention-sweep scheduling (M12): idempotency key per UTC day, so
   * retries/overlaps enqueue at most one sweep per day (dormant until M13
   * adds more; the queue owns retries). */
  const RETENTION_ENQUEUE_INTERVAL_MILLISECONDS = 10 * 60_000;
  const enqueueDailyRetentionSweep = async (): Promise<void> => {
    const day = new Date().toISOString().slice(0, 10);
    await jobs.enqueue({
      type: "forms.retention-sweep",
      payload: {},
      idempotencyKey: `forms-retention-sweep:${day}`,
      maxAttempts: 5,
      origin: "worker.forms.retention",
    });
  };
  // S7: every 60s re-enqueue the payments reconcile sweep (idempotent per
  // minute): refund intents REQUESTED → execute; SUBMITTED over attempts →
  // NEEDS_REVIEW; inbound events due for recovery → re-verify + apply.
  const PAYMENTS_SWEEP_INTERVAL_MILLISECONDS = 60_000;
  const enqueuePaymentsSweep = async (): Promise<void> => {
    const minute = new Date().toISOString().slice(0, 16);
    await jobs.enqueue({
      type: "payments.refund.reconcile",
      payload: {},
      idempotencyKey: `payments-reconcile:${minute}`,
      maxAttempts: 1,
      origin: "worker.payments",
    });
    await jobs.enqueue({
      type: "payments.inbound.recover",
      payload: {},
      idempotencyKey: `payments-inbound-recover:${minute}`,
      maxAttempts: 1,
      origin: "worker.payments",
    });
  };
  const paymentsSweepTimer = setInterval(() => {
    if (stopped) return;
    void enqueuePaymentsSweep().catch((error: unknown) => {
      logger.warn("worker.payments.sweep_enqueue_failed", {
        operation: "worker.payments",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, PAYMENTS_SWEEP_INTERVAL_MILLISECONDS);
  void enqueuePaymentsSweep().catch(() => {});
  const retentionTimer = setInterval(() => {
    if (stopped) return;
    void enqueueDailyRetentionSweep().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // F-58: "already succeeded" is the daily idempotency key doing its job —
      // the sweep for this UTC day is already done, so the 10-minute re-enqueue
      // is normal, not a failure worth a warning.
      if (message.includes("already succeeded")) {
        logger.info("worker.forms.retention_already_scheduled", {
          operation: "worker.forms.retention",
        });
        return;
      }
      logger.warn("worker.forms.retention_enqueue_failed", {
        operation: "worker.forms.retention",
        error: message,
      });
    });
  }, RETENTION_ENQUEUE_INTERVAL_MILLISECONDS);
  void enqueueDailyRetentionSweep().catch(() => {});
  const enqueueDailyGenerationSweep = async (): Promise<void> => {
    const day = new Date().toISOString().slice(0, 10);
    await jobs.enqueue({
      type: "media.generation-sweep",
      payload: {},
      idempotencyKey: `media-generation-sweep:${day}`,
      maxAttempts: 5,
      origin: "worker.media.retention",
    });
  };
  const enqueueDailyRevisionsSweep = async (): Promise<void> => {
    const day = new Date().toISOString().slice(0, 10);
    await jobs.enqueue({
      type: "revisions.retention-sweep",
      payload: {},
      idempotencyKey: `revisions-retention-sweep:${day}`,
      maxAttempts: 5,
      origin: "worker.revisions.retention",
    });
  };
  void enqueueDailyGenerationSweep().catch(() => {});
  const generationSweepTimer = setInterval(() => {
    if (stopped) return;
    void enqueueDailyGenerationSweep().catch(() => {});
  }, RETENTION_ENQUEUE_INTERVAL_MILLISECONDS);

  // Notifications dispatch scheduling (0.1.194): idempotency key per UTC
  // minute — at most one dispatch per minute; "already succeeded" on the
  // 60s re-enqueue is the key doing its job, not a failure.
  const enqueueNotificationsDispatch = async (): Promise<void> => {
    const minute = new Date().toISOString().slice(0, 16);
    await jobs.enqueue({
      type: "notifications.dispatch",
      payload: {},
      idempotencyKey: `notifications-dispatch:${minute}`,
      maxAttempts: 3,
      origin: "worker.notifications",
    });
  };
  void enqueueNotificationsDispatch().catch(() => {});
  const notificationsTimer = setInterval(() => {
    if (stopped) return;
    void enqueueNotificationsDispatch().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already succeeded")) return;
      logger.warn("worker.notifications_enqueue_failed", {
        operation: "worker.notifications",
        error: message,
      });
    });
  }, 60_000);

  await probe();
  await heartbeat.beat().catch(() => {});
  runner.start();
  logger.info("worker.ready", {
    operation: "worker.boot",
    probeIntervalMs: PROBE_INTERVAL_MILLISECONDS,
    pollIntervalMs: config.jobs?.pollIntervalMs ?? 5000,
    claimBatchMax: config.jobs?.claimBatchMax ?? 10,
    outboxIntervalMs: OUTBOX_INTERVAL_MILLISECONDS,
  });
}

// Release installs run through the /opt/progressive-cms/current symlink:
// argv[1] keeps the symlink path while import.meta.url is the real release
// path, so both sides are resolved before comparing (PCMS-OPS-T101).
const isMain =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fileIndex = process.argv.indexOf("--config");
  const fileArg = fileIndex >= 0 ? process.argv[fileIndex + 1] : undefined;
  startWorker(fileArg === undefined ? {} : { file: fileArg }).catch((error) => {
    console.error("[pcms-worker] startup failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
