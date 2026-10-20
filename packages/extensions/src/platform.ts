// Extension Platform Services (CORE-SHOP-01 P0-a; ADR-0018).
//
// The typed primitives Core hands to every extension handler (operations,
// http routes, sources, validators). Core owns ALL implementations; the
// extension only consumes. Design decisions recorded in the ADR:
//
// - Mutations happen ONLY inside `platform.transaction(...)`: the query,
//   audit and outbox.append of one ExtensionTransactionContext share ONE
//   database transaction with explicit commit/rollback semantics (R3).
// - `actor` is a principal, not necessarily an authenticated user: public
//   anonymous routes receive the anonymous principal (R3).
// - The SQL boundary is trust-based, not sandboxed: a trusted package can
//   address any schema it names. Isolation comes from trusted composition,
//   the R3 lifecycle revision, the no-private-imports scans and release
//   review — NOT from the import ban (recorded honestly in the ADR).

import type { DbClient } from "@pcms/core";

/** Principal behind the current call. Public anonymous routes get kind
 * "anonymous" (or "guest" when the client presented a valid guest identity,
 * PREPUBLIC §5); everything authenticated carries the platform actor. */
export interface ExtensionPrincipal {
  readonly kind: "anonymous" | "guest" | "actor";
  readonly id: string;
  readonly type: string;
}

export const ANONYMOUS_PRINCIPAL: ExtensionPrincipal = {
  kind: "anonymous",
  id: "anonymous",
  type: "anonymous",
};

/** Site context of the request (single-site v1: the instance's default site). */
export interface ExtensionSiteContext {
  readonly key: string;
  readonly defaultLocale: string;
}

/** Read-only SQL outside any transaction (pool-level). */
export interface ExtensionDbReader {
  query: <T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
}

/** One explicit database transaction: query + audit + outbox share it. */
export interface ExtensionTransactionContext {
  readonly query: <T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
  /** Security audit row written IN this transaction (actor/requestId filled
   * by Core; commit = the audit is as durable as the business change). */
  readonly audit: (
    action: string,
    subject: { readonly type: string; readonly id: string },
    metadata?: unknown,
  ) => void;
  /** Transactional outbox append (R4): the event becomes visible to
   * consumers only when the surrounding transaction commits. Event types
   * are namespaced "<extensionId>/<Event>" (composition preflights
   * collisions). */
  readonly outbox: {
    readonly append: (eventType: string, payload: unknown) => void;
  };
}

/** Durable background job enqueue (PREPUBLIC §4): jobs ride the shared M07
 * queue; the platform resolves the registration from the DEPLOYED manifest,
 * namespaces the queue type "<extensionId>/<job_id>" and stamps the
 * registration's payload schema version. */
export interface ExtensionJobsPort {
  enqueue(input: {
    /** Local job_id from the manifest registrations.jobs. */
    readonly job: string;
    readonly payload?: unknown;
    /** Stable idempotency key; scoped to this extension automatically. */
    readonly idempotencyKey?: string;
    /** Earliest execution instant (defaults to now). */
    readonly runAt?: Date;
    readonly maxAttempts?: number;
  }): Promise<void>;
}

export interface ExtensionPlatformServices {
  /** Permission check for the CURRENT principal; fails closed (anonymous
   * principals never pass). The permission must be registered (manifest
   * namespace or platform registry) — composition guarantees that. */
  readonly authorize: (permission: string) => Promise<void>;
  /** The only mutation path: everything `run` does joins one transaction. */
  readonly transaction: <R>(run: (tx: ExtensionTransactionContext) => Promise<R>) => Promise<R>;
  /** Read-only pool-level query for handlers and sources. */
  readonly db: ExtensionDbReader;
  /** Durable background jobs on the shared platform queue (PREPUBLIC §4). */
  readonly jobs: ExtensionJobsPort;
}

/** Full call context handed to extension handlers (operations, http routes,
 * sources). Built by the composition layer per request. */
export interface ExtensionCallContext {
  readonly actor: ExtensionPrincipal;
  readonly requestId: string;
  readonly extension: {
    readonly id: string;
    readonly config: Record<string, unknown> | null;
  };
  readonly site: ExtensionSiteContext;
  readonly locale: string;
  readonly platform: ExtensionPlatformServices;
}

/** HTTP handler context. Canonical URLs use configured site bindings only.
 * A missing binding or mount has no absolute public canonical URL. */
export interface ExtensionHttpCallContext extends ExtensionCallContext {
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly body: unknown;
  readonly mount: string;
  readonly canonicalPath: string | null;
  readonly canonicalUrl: string | null;
  readonly guestId: string | null;
  readonly idempotencyKey: string | null;
}

/** Internal factory: Core builds the services over a pool + request facts.
 * Kept in @pcms/extensions so every transport (api routes, web dispatch,
 * worker) constructs IDENTICAL semantics. The audit/outbox writers are
 * injected by the composition layer — they are the SAME writers core uses
 * (auth_security_events via recordSecurityEvent; publication_outbox via
 * writeOutboxEvent), both accepting a DbClient so everything joins the
 * caller's transaction. */
export function createExtensionPlatformServices(input: {
  readonly pool: {
    query: <T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: T[] }>;
    withTransaction: <R>(run: (client: DbClient) => Promise<R>) => Promise<R>;
  };
  readonly authorize: (permission: string) => Promise<void>;
  readonly actor: ExtensionPrincipal;
  readonly requestId: string;
  readonly extensionId: string;
  /** Writes an auth security event on the given executor (tx client). */
  readonly auditWriter: (
    executor: DbClient,
    event: {
      readonly type: string;
      readonly actorType: string;
      readonly actorId: string | null;
      readonly subjectType: string | null;
      readonly subjectId: string | null;
      readonly metadata: unknown;
    },
  ) => Promise<void>;
  /** Appends to the transactional outbox on the given executor (tx client). */
  readonly outboxAppender: (
    executor: DbClient,
    event: { readonly eventType: string; readonly aggregateId: string; readonly payload: unknown },
  ) => Promise<void>;
  /** Job registration resolver + enqueue sink (composition). Absent ⇒
   * platform.jobs fails closed — a transport without the worker queue must
   * not pretend to enqueue. */
  readonly jobs?: {
    readonly resolveRegistration: (
      jobId: string,
    ) => { readonly queueType: string; readonly payloadVersion: number } | null;
    readonly enqueue: (input: {
      readonly type: string;
      readonly payload: unknown;
      readonly idempotencyKey: string | null;
      readonly runAt: Date | undefined;
      readonly maxAttempts: number | undefined;
      readonly origin: string;
      readonly payloadVersion: number | null;
    }) => Promise<void>;
  };
}): ExtensionPlatformServices {
  const reader: ExtensionDbReader = {
    query: (sql, params) => input.pool.query(sql, params),
  };
  return {
    authorize: (permission) => input.authorize(permission),
    async transaction(run) {
      return input.pool.withTransaction(async (client) => {
        // Void hooks stay source-compatible; commit must await every writer,
        // including failures raised before a writer ever reaches PostgreSQL.
        const writes: Promise<PromiseSettledResult<void>>[] = [];
        const track = (write: Promise<void>): void => {
          writes.push(
            write.then(
              () => ({ status: "fulfilled", value: undefined }),
              (reason: unknown) => ({ status: "rejected", reason }),
            ),
          );
        };
        const tx: ExtensionTransactionContext = {
          query: (sql, params) => client.query(sql, params),
          audit: (action, subject, metadata) => {
            // Joins the same transaction: audit is as durable as the change
            // (fail-closed). The redaction contract lives in the writer.
            track(
              input.auditWriter(client, {
                type: action,
                actorType:
                  input.actor.kind === "anonymous"
                    ? "SYSTEM"
                    : input.actor.kind === "guest"
                      ? "GUEST"
                      : input.actor.type.toUpperCase(),
                actorId: input.actor.kind === "anonymous" ? null : input.actor.id,
                subjectType: subject.type,
                subjectId: subject.id,
                metadata: {
                  ...(metadata === undefined ? {} : { data: metadata }),
                  request_id: input.requestId,
                },
              }),
            );
          },
          outbox: {
            append: (eventType, payload) => {
              if (!eventType.startsWith(`${input.extensionId}/`)) {
                throw new Error(
                  `outbox event type "${eventType}" must be namespaced "${input.extensionId}/<Event>"`,
                );
              }
              track(
                input.outboxAppender(client, {
                  eventType,
                  aggregateId: input.extensionId,
                  payload: payload ?? {},
                }),
              );
            },
          },
        };
        const [outcome] = await Promise.allSettled([Promise.resolve().then(() => run(tx))]);
        const results = await Promise.all(writes);
        if (outcome.status === "rejected") throw outcome.reason;
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return outcome.value;
      });
    },
    db: reader,
    jobs: {
      enqueue: async (request) => {
        if (input.jobs === undefined) {
          throw new Error("EXTENSION_JOBS_UNSUPPORTED: this transport has no worker queue");
        }
        const registration = input.jobs.resolveRegistration(request.job);
        if (registration === null) {
          throw new Error(
            `EXTENSION_JOB_UNKNOWN: "${request.job}" is not a registrations.jobs entry of the deployed manifest`,
          );
        }
        await input.jobs.enqueue({
          type: registration.queueType,
          payload: request.payload ?? null,
          idempotencyKey:
            request.idempotencyKey === undefined
              ? null
              : `extjob:${input.extensionId}:${request.idempotencyKey}`,
          runAt: request.runAt,
          maxAttempts: request.maxAttempts,
          origin: `extension:${input.extensionId}`,
          payloadVersion: registration.payloadVersion,
        });
      },
    },
  };
}
