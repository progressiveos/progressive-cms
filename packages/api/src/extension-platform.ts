// Extension Call Context construction (CORE-SHOP-01 P0-a; ADR-0018).
// Single composition point for the platform services every extension
// handler receives: operations, http routes (web), sources. The audit and
// outbox writers are the SAME core writers (auth_security_events /
// publication_outbox), both accepting a tx client so everything inside
// platform.transaction() is one atomic unit.
import { recordSecurityEvent, type SecurityEventType } from "@pcms/auth";
import type { ExtensionCatalog } from "@pcms/extensions/internal";
import {
  ANONYMOUS_PRINCIPAL,
  createExtensionPlatformServices,
  type ExtensionCallContext,
  type ExtensionPlatformServices,
  type ExtensionPrincipal,
  type ExtensionSiteContext,
} from "@pcms/extensions/internal";
import { writeOutboxEvent } from "@pcms/publication";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export interface ExtensionRuntimeFacts {
  readonly extensionId: string;
  readonly config: Record<string, unknown> | null;
}

/** Builds the per-request call context. `principal` is anonymous for
 * public anonymous routes; operations pass the platform actor. */
export async function buildExtensionCallContext(
  app: ApplicationServices,
  ctx: OperationContext | null,
  runtime: ExtensionRuntimeFacts,
  options: {
    readonly anonymous?: boolean;
    /** Validated guest identity (PREPUBLIC §5): public mutations carry the
     * client's stable id as a first-class principal (audit GUEST rows). */
    readonly guestId?: string | null;
    /** Enabled non-default locale selected from the public route prefix. */
    readonly locale?: string;
  } = {},
): Promise<ExtensionCallContext> {
  const principal: ExtensionPrincipal =
    options.anonymous === true || ctx === null
      ? options.guestId != null
        ? { kind: "guest", id: options.guestId, type: "guest" }
        : ANONYMOUS_PRINCIPAL
      : { kind: "actor", id: ctx.actor.id, type: ctx.actor.type };
  // Site context is best-effort: every real transport composes the full
  // app; narrow app doubles (tests) may omit routes/localization entirely.
  const siteFallback: ExtensionSiteContext = {
    key: app.defaultSiteKey,
    defaultLocale: "x-default",
  };
  let site: ExtensionSiteContext = await (async () => {
    try {
      const resolved = await app.routes.ensureSite(app.defaultSiteKey);
      return { key: resolved.key, defaultLocale: resolved.defaultLocale };
    } catch {
      return siteFallback;
    }
  })();
  let locale = options.locale ?? site.defaultLocale;
  try {
    const localization = await app.localization.get();
    if (localization !== null) {
      site = { ...site, defaultLocale: localization.defaultLocale };
      if (options.locale === undefined) locale = localization.defaultLocale;
    }
  } catch {
    // narrow app double without the localization service
  }
  const platform: ExtensionPlatformServices = createExtensionPlatformServices({
    pool: app.pool,
    authorize: async (permission) => {
      if (ctx === null || principal.kind !== "actor") {
        throw new (await import("./errors.js")).ApiError(
          "AUTH_PERMISSION_DENIED",
          `anonymous principals cannot carry "${permission}"`,
          { status: 403 },
        );
      }
      requirePermission(app, ctx, permission);
    },
    actor: principal,
    requestId: ctx?.requestId ?? "req_extension_anonymous",
    extensionId: runtime.extensionId,
    auditWriter: (executor, event) =>
      recordSecurityEvent(executor, null, {
        type: event.type as SecurityEventType,
        actorType:
          principal.kind === "anonymous"
            ? "SYSTEM"
            : principal.kind === "guest"
              ? "GUEST"
              : principal.type === "service_account"
                ? "SERVICE_ACCOUNT"
                : "USER",
        actorId: principal.kind === "anonymous" ? null : principal.id,
        subjectType: event.subjectType ?? "extension",
        subjectId: event.subjectId,
        siteKey: site.key,
        transport: "api",
        ...(event.metadata === undefined
          ? {}
          : { metadata: event.metadata as Record<string, unknown> }),
      }),
    outboxAppender: (executor, event) =>
      writeOutboxEvent(executor, {
        aggregate: "extension",
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
      }),
    jobs: {
      resolveRegistration: extensionJobRegistrationResolver(
        app.extensionCatalog,
        runtime.extensionId,
      ),
      enqueue: async (input) => {
        const request: {
          readonly type: string;
          readonly payload: unknown;
          readonly origin: string;
          readonly idempotencyKey?: string;
          readonly runAt?: Date;
          readonly maxAttempts?: number;
          readonly payloadVersion?: number;
        } = {
          type: input.type,
          payload: input.payload,
          origin: input.origin,
          ...(input.idempotencyKey === null ? {} : { idempotencyKey: input.idempotencyKey }),
          ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
          ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
          ...(input.payloadVersion === null ? {} : { payloadVersion: input.payloadVersion }),
        };
        await app.jobs.enqueue(request);
      },
    },
  });
  return {
    actor: principal,
    requestId: ctx?.requestId ?? "req_extension_anonymous",
    extension: { id: runtime.extensionId, config: runtime.config },
    site,
    locale,
    platform,
  };
}

/** System principal context for CONTRIBUTOR sources (sitemap/search/media
 * usage): no request, no actor — read-only platform calls. */
export function buildExtensionSourceContext(deps: {
  readonly pool: ApplicationServices["pool"];
  readonly site: ExtensionSiteContextLite;
  readonly extensionId: string;
  readonly config: Record<string, unknown> | null;
}): ExtensionCallContext {
  const platform = createExtensionPlatformServices({
    pool: deps.pool,
    authorize: async () => {
      throw new ApiError(
        "AUTH_PERMISSION_DENIED",
        "extension sources run as the system principal and cannot authorize",
        { status: 403 },
      );
    },
    actor: { kind: "actor", id: "system", type: "system" },
    requestId: "req_extension_source",
    extensionId: deps.extensionId,
    auditWriter: (executor, event) =>
      recordSecurityEvent(executor, null, {
        type: event.type as SecurityEventType,
        actorType: "SYSTEM",
        actorId: null,
        subjectType: event.subjectType ?? "extension",
        subjectId: event.subjectId,
        siteKey: deps.site.key,
        transport: "api",
        ...(event.metadata === undefined
          ? {}
          : { metadata: event.metadata as Record<string, unknown> }),
      }),
    outboxAppender: (executor, event) =>
      writeOutboxEvent(executor, {
        aggregate: "extension",
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
      }),
  });
  return {
    actor: { kind: "actor", id: "system", type: "system" },
    requestId: "req_extension_source",
    extension: { id: deps.extensionId, config: deps.config },
    site: deps.site,
    locale: deps.site.defaultLocale,
    platform,
  };
}

export interface ExtensionSiteContextLite {
  readonly key: string;
  readonly defaultLocale: string;
}

/** Resolves a manifest jobs registration of the DEPLOYED artifact into the
 * shared-queue shape (type "<extensionId>/<job_id>" + payload schema stamp).
 * PREPUBLIC §4: a job request for an unknown registration fails closed. */
export function extensionJobRegistrationResolver(
  catalog: ExtensionCatalog | undefined,
  extensionId: string,
): (jobId: string) => { readonly queueType: string; readonly payloadVersion: number } | null {
  return (jobId) => {
    const artifact = catalog?.get(extensionId);
    const registration = artifact?.manifest.registrations.jobs.find(
      (candidate) => candidate.job_id === jobId,
    );
    if (registration === undefined) return null;
    return { queueType: `${extensionId}/${jobId}`, payloadVersion: registration.payload_version };
  };
}
