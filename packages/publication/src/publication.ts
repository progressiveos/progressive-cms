// Publication pointer service (PCMS-PUB-T005–T008). One logical DB
// transaction per operation (spec §10):
//   lock publication row → validate expected generation (CAS) → require
//   SEALED target → run publication validators → apply internal public state
//   → write PublicationEvent → write Outbox event → commit.
// Any failure leaves no changed pointer, no orphan event, no orphan outbox
// row — guaranteed by transaction atomicity.
import { type Clock, type DbClient, type DbPool, newStableId, type StableId } from "@pcms/core";
import { PublicationError } from "./errors.js";
import { writeOutboxEvent } from "./outbox.js";
import type { RevisionReaderPort, SealedRevisionRef } from "./ports.js";
import type {
  PublicationActor,
  PublicationEventRecord,
  PublicationEventType,
  PublicationRecord,
} from "./types.js";
import {
  type PublicationCandidate,
  type PublicationValidator,
  runPublicationValidators,
} from "./validators.js";

interface PublicationRow {
  [column: string]: unknown;
  entity_type: string;
  entity_id: string;
  context: string;
  state: string;
  current_revision_id: string | null;
  current_payload_hash: string | null;
  generation: number;
  first_published_at: Date | null;
  published_at: Date | null;
  modified_at: Date | null;
  unpublished_at: Date | null;
  updated_at: Date;
}

interface EventRow {
  [column: string]: unknown;
  id: string;
  entity_type: string;
  entity_id: string;
  context: string;
  event_type: string;
  from_revision_id: string | null;
  to_revision_id: string | null;
  actor_class: string;
  actor_id: string;
  reason: string | null;
  changeset_id: string | null;
  job_id: string | null;
  request_id: string | null;
  created_at: Date;
}

function toRecord(row: PublicationRow): PublicationRecord {
  return {
    entityType: row.entity_type,
    entityId: row.entity_id as StableId,
    context: row.context,
    state: row.state as PublicationRecord["state"],
    currentRevisionId: (row.current_revision_id as StableId | null) ?? null,
    currentPayloadHash: row.current_payload_hash,
    generation: row.generation,
    firstPublishedAt: row.first_published_at,
    publishedAt: row.published_at,
    modifiedAt: row.modified_at,
    unpublishedAt: row.unpublished_at,
    updatedAt: row.updated_at,
  };
}

const PUBLICATION_COLUMNS = `entity_type, entity_id, context, state, current_revision_id,
  current_payload_hash, generation, first_published_at, published_at, modified_at,
  unpublished_at, updated_at`;

/** Batch equivalent of getPublishedRevision's visibility checks, for navigation. */
export async function publishedEntryIds(
  executor: DbClient,
  ids: readonly string[],
  context: string,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const result = await executor.query<{ entity_id: string }>(
      `SELECT p.entity_id FROM publications p
       JOIN revisions r ON r.id = p.current_revision_id
         AND r.entity_type = p.entity_type AND r.entity_id = p.entity_id
       WHERE p.entity_type = 'entry' AND p.context = $2 AND p.state = 'PUBLISHED'
         AND p.entity_id = ANY($1::uuid[]) AND r.state = 'SEALED' AND r.payload_hash IS NOT NULL`,
      [ids.slice(offset, offset + 500), context],
    );
    for (const row of result.rows) found.add(row.entity_id);
  }
  return found;
}

export interface PublicationOperationInput {
  readonly entityType: string;
  readonly entityId: StableId;
  readonly context?: string;
  readonly targetRevisionId: StableId;
  /** CAS baseline (spec §11): operation applies only if the pointer still
   * sits at this generation; otherwise PUBLICATION_CONFLICT. */
  readonly expectedGeneration: number;
  readonly actor: PublicationActor;
  readonly reason?: string;
  readonly changesetId?: StableId;
  readonly jobId?: StableId;
  /** Internal format migration only; never accepted by ordinary Publish transports. */
  readonly preservePublicationDates?: boolean;
}

export interface UnpublishInput {
  readonly entityType: string;
  readonly entityId: StableId;
  readonly context?: string;
  readonly expectedGeneration: number;
  readonly actor: PublicationActor;
  readonly reason?: string;
  readonly changesetId?: StableId;
}

export interface PublicationOperationResult {
  readonly publication: PublicationRecord;
  readonly event: PublicationEventRecord;
  /** The sealed snapshot now backing the pointer (unpublish: the state it
   * was removed from). */
  readonly revision: SealedRevisionRef | null;
}

export interface PublicationService {
  publish(input: PublicationOperationInput): Promise<PublicationOperationResult>;
  /** Rollback: point the pointer at any previous SEALED revision. Creates a
   * ROLLBACK event; never deletes or mutates newer revisions (spec §13). */
  rollback(input: PublicationOperationInput): Promise<PublicationOperationResult>;
  /** Unpublish: clears public visibility, preserves revisions + history
   * (spec §12). Routing outcome (404/redirect) is delegated to Routing. */
  unpublish(input: UnpublishInput): Promise<PublicationOperationResult>;
  /** Transaction-scoped variants (T015 additive seam): identical semantics
   * on a caller-owned executor so a ChangeSet apply moves every item's
   * pointer inside ONE transaction (Publication spec §18). */
  publishWithinTx(
    tx: DbClient,
    input: PublicationOperationInput,
  ): Promise<PublicationOperationResult>;
  rollbackWithinTx(
    tx: DbClient,
    input: PublicationOperationInput,
  ): Promise<PublicationOperationResult>;
  unpublishWithinTx(tx: DbClient, input: UnpublishInput): Promise<PublicationOperationResult>;
  getPublication(
    executor: DbClient,
    entityType: string,
    entityId: StableId,
    context?: string,
  ): Promise<PublicationRecord | null>;
  requirePublication(
    executor: DbClient,
    entityType: string,
    entityId: StableId,
    context?: string,
  ): Promise<PublicationRecord>;
  /** Deterministic bounded listing of public state for composition. */
  listPublished(
    executor: DbClient,
    entityType: string,
    options?: { readonly context?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly PublicationRecord[]>;
  listPublicationEvents(
    executor: DbClient,
    entityType: string,
    entityId: StableId,
    options?: { readonly context?: string; readonly limit?: number; readonly offset?: number },
  ): Promise<readonly PublicationEventRecord[]>;
  /** Published payload read for render/SEO composition (M07 seam). */
  getPublishedRevision(
    executor: DbClient,
    entityType: string,
    entityId: StableId,
    context?: string,
  ): Promise<SealedRevisionRef | null>;
}

/** Spec §57 event names, per entity type, deterministically derived. */
export function publishedEventTypeFor(
  entityType: string,
  suffix: "Published" | "Unpublished" | "RolledBack",
): string {
  const cap = entityType.charAt(0).toUpperCase() + entityType.slice(1);
  return `${cap}${suffix}`;
}

export function createPublicationService(
  pool: DbPool,
  deps: {
    readonly clock: Clock;
    readonly revisions: RevisionReaderPort;
    /** Registered cross-subsystem gates (T010); wired at composition. */
    readonly validators?: readonly PublicationValidator[];
  },
): PublicationService {
  const { clock, revisions } = deps;
  const validators = deps.validators ?? [];

  async function lockPublication(
    tx: DbClient,
    entityType: string,
    entityId: StableId,
    context: string,
  ): Promise<PublicationRecord> {
    await tx.query(
      `INSERT INTO publications (entity_type, entity_id, context, state, generation, updated_at)
       VALUES ($1, $2, $3, 'UNPUBLISHED', 0, $4)
       ON CONFLICT (entity_type, entity_id, context) DO NOTHING`,
      [entityType, entityId, context, clock.now()],
    );
    const locked = await tx.query<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS} FROM publications
       WHERE entity_type = $1 AND entity_id = $2 AND context = $3
       FOR UPDATE`,
      [entityType, entityId, context],
    );
    return toRecord(locked.rows[0]!);
  }

  async function requireSealedTarget(
    tx: DbClient,
    input: PublicationOperationInput,
    context: string,
  ): Promise<SealedRevisionRef> {
    const revision = await revisions.getSealedRevision(
      tx,
      input.entityType,
      input.entityId,
      input.targetRevisionId,
    );
    if (revision === null) {
      throw new PublicationError(
        "REVISION_NOT_SEALED",
        `target revision ${input.targetRevisionId} is missing, not sealed, or belongs to another entity`,
        { details: { revisionId: input.targetRevisionId, entityType: input.entityType } },
      );
    }
    return revision;
  }

  async function appendEvent(
    tx: DbClient,
    input: {
      entityType: string;
      entityId: StableId;
      context: string;
      eventType: PublicationEventType;
      fromRevisionId: StableId | null;
      toRevisionId: StableId | null;
      actor: PublicationActor;
      changesetId: StableId | null;
      jobId: StableId | null;
    },
  ): Promise<PublicationEventRecord> {
    const id = newStableId();
    await tx.query(
      `INSERT INTO publication_events
         (id, entity_type, entity_id, context, event_type, from_revision_id, to_revision_id,
          actor_class, actor_id, reason, changeset_id, job_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        input.entityType,
        input.entityId,
        input.context,
        input.eventType,
        input.fromRevisionId,
        input.toRevisionId,
        input.actor.actorClass,
        input.actor.actorId,
        input.actor.reason ?? null,
        input.changesetId ?? null,
        input.jobId ?? null,
        input.actor.requestId ?? null,
      ],
    );
    return {
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      context: input.context,
      eventType: input.eventType,
      fromRevisionId: input.fromRevisionId,
      toRevisionId: input.toRevisionId,
      actorClass: input.actor.actorClass,
      actorId: input.actor.actorId,
      reason: input.actor.reason ?? null,
      changesetId: input.changesetId ?? null,
      jobId: input.jobId ?? null,
      requestId: input.actor.requestId ?? null,
      createdAt: clock.now(),
    };
  }

  /** Shared publish/rollback core on a caller-owned executor (spec §10
   * pointer semantics); `pointAt` wraps it in its own transaction and the
   * `*WithinTx` variants let ChangeSet apply compose many items into ONE
   * transaction (Publication spec §18). */
  async function pointAtOn(
    tx: DbClient,
    input: PublicationOperationInput,
    kind: "publish" | "rollback",
  ): Promise<PublicationOperationResult> {
    const context = input.context ?? "default";
    {
      const publication = await lockPublication(tx, input.entityType, input.entityId, context);
      if (publication.generation !== input.expectedGeneration) {
        throw new PublicationError(
          "PUBLICATION_CONFLICT",
          `expected generation ${input.expectedGeneration}, current is ${publication.generation}`,
          {
            details: {
              expected: input.expectedGeneration,
              current: publication.generation,
              entityType: input.entityType,
              entityId: input.entityId,
              context,
            },
          },
        );
      }

      if (input.preservePublicationDates && publication.state !== "PUBLISHED")
        throw new PublicationError(
          "PUBLICATION_MIGRATION_STATE_INVALID",
          "Format migration requires an existing published pointer",
        );
      const revision = await requireSealedTarget(tx, input, context);

      const candidate: PublicationCandidate = {
        entityType: input.entityType,
        entityId: input.entityId,
        context,
        intent: "PUBLISH",
        targetRevision: revision,
        routeOperation: { kind: "none" },
      };
      const issues = await runPublicationValidators(validators, [candidate], {
        clock,
        executor: tx,
      });
      if (issues.some((issue) => issue.severity === "error")) {
        throw new PublicationError(
          "PUBLICATION_VALIDATION_FAILED",
          "publication validators rejected the candidate state",
          { details: { issues } },
        );
      }

      const now = clock.now();
      const isFirst = publication.firstPublishedAt === null;
      const eventType: PublicationEventType =
        kind === "rollback" ? "ROLLBACK" : isFirst ? "PUBLISH_FIRST" : "PUBLISH_UPDATE";

      const updated = await tx.query<PublicationRow>(
        `UPDATE publications
         SET state = 'PUBLISHED',
             current_revision_id = $4,
             current_payload_hash = $5,
             generation = generation + 1,
             first_published_at = CASE WHEN $8 THEN first_published_at ELSE COALESCE(first_published_at, $2) END,
             published_at = CASE WHEN $8 THEN published_at ELSE $2 END,
             modified_at = CASE
               WHEN $8 OR current_payload_hash IS NOT DISTINCT FROM $5 THEN modified_at
               ELSE $2 END,
             unpublished_at = NULL,
             updated_at = $2
         WHERE entity_type = $1 AND entity_id = $6 AND context = $3
           AND generation = $7
         RETURNING ${PUBLICATION_COLUMNS}`,
        [
          input.entityType,
          now,
          context,
          input.targetRevisionId,
          revision.payloadHash,
          input.entityId,
          input.expectedGeneration,
          input.preservePublicationDates === true,
        ],
      );
      if (updated.rows.length !== 1) {
        throw new PublicationError("PUBLICATION_CONFLICT", "pointer moved concurrently");
      }

      const event = await appendEvent(tx, {
        entityType: input.entityType,
        entityId: input.entityId,
        context,
        eventType,
        fromRevisionId: publication.currentRevisionId,
        toRevisionId: input.targetRevisionId,
        actor:
          input.actor.reason === undefined && input.reason !== undefined
            ? { ...input.actor, reason: input.reason }
            : input.actor,
        changesetId: input.changesetId ?? null,
        jobId: input.jobId ?? null,
      });
      await writeOutboxEvent(tx, {
        aggregate: "publication",
        aggregateId: `${input.entityType}:${input.entityId}:${context}`,
        eventType: publishedEventTypeFor(
          input.entityType,
          kind === "rollback" ? "RolledBack" : "Published",
        ),
        payload: {
          entityType: input.entityType,
          entityId: input.entityId,
          context,
          revisionId: input.targetRevisionId,
          generation: publication.generation + 1,
          eventType,
          changesetId: input.changesetId ?? null,
          jobId: input.jobId ?? null,
          actor: { actorClass: input.actor.actorClass, actorId: input.actor.actorId },
        },
      });

      return { publication: toRecord(updated.rows[0]!), event, revision };
    }
  }

  /** Unpublish core on a caller-owned executor (spec §12). */
  async function unpublishOn(
    tx: DbClient,
    input: UnpublishInput,
  ): Promise<PublicationOperationResult> {
    const context = input.context ?? "default";
    const publication = await lockPublication(tx, input.entityType, input.entityId, context);
    if (publication.generation !== input.expectedGeneration) {
      throw new PublicationError(
        "PUBLICATION_CONFLICT",
        `expected generation ${input.expectedGeneration}, current is ${publication.generation}`,
        {
          details: {
            expected: input.expectedGeneration,
            current: publication.generation,
            entityType: input.entityType,
            entityId: input.entityId,
            context,
          },
        },
      );
    }
    if (publication.state !== "PUBLISHED") {
      throw new PublicationError(
        "PUBLICATION_NOT_PUBLISHED",
        `entity ${input.entityType}/${input.entityId} is not currently published`,
      );
    }
    const now = clock.now();
    const updated = await tx.query<PublicationRow>(
      `UPDATE publications
       SET state = 'UNPUBLISHED', generation = generation + 1, unpublished_at = $2,
           updated_at = $2
       WHERE entity_type = $1 AND entity_id = $4 AND context = $3 AND generation = $5
       RETURNING ${PUBLICATION_COLUMNS}`,
      [input.entityType, now, context, input.entityId, input.expectedGeneration],
    );
    if (updated.rows.length !== 1) {
      throw new PublicationError("PUBLICATION_CONFLICT", "pointer moved concurrently");
    }
    const event = await appendEvent(tx, {
      entityType: input.entityType,
      entityId: input.entityId,
      context,
      eventType: "UNPUBLISH",
      fromRevisionId: publication.currentRevisionId,
      toRevisionId: null,
      actor:
        input.actor.reason === undefined && input.reason !== undefined
          ? { ...input.actor, reason: input.reason }
          : input.actor,
      changesetId: input.changesetId ?? null,
      jobId: null,
    });
    await writeOutboxEvent(tx, {
      aggregate: "publication",
      aggregateId: `${input.entityType}:${input.entityId}:${context}`,
      eventType: publishedEventTypeFor(input.entityType, "Unpublished"),
      payload: {
        entityType: input.entityType,
        entityId: input.entityId,
        context,
        fromRevisionId: publication.currentRevisionId,
        generation: publication.generation + 1,
        changesetId: input.changesetId ?? null,
        actor: { actorClass: input.actor.actorClass, actorId: input.actor.actorId },
      },
    });
    return { publication: toRecord(updated.rows[0]!), event, revision: null };
  }

  return {
    publish: (input) => pool.withTransaction((tx) => pointAtOn(tx, input, "publish")),
    rollback: (input) => pool.withTransaction((tx) => pointAtOn(tx, input, "rollback")),
    publishWithinTx: (tx, input) => pointAtOn(tx, input, "publish"),
    rollbackWithinTx: (tx, input) => pointAtOn(tx, input, "rollback"),

    async unpublish(input) {
      const context = input.context ?? "default";
      return pool.withTransaction(async (tx) => unpublishOn(tx, input));
    },
    unpublishWithinTx: (tx, input) => unpublishOn(tx, input),

    async getPublication(executor, entityType, entityId, context = "default") {
      const result = await executor.query<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS} FROM publications
         WHERE entity_type = $1 AND entity_id = $2 AND context = $3`,
        [entityType, entityId, context],
      );
      return result.rows.length === 1 ? toRecord(result.rows[0]!) : null;
    },

    async requirePublication(executor, entityType, entityId, context = "default") {
      const record = await this.getPublication(executor, entityType, entityId, context);
      if (record === null) {
        throw new PublicationError(
          "PUBLICATION_NOT_FOUND",
          `no publication state for ${entityType}/${entityId}/${context}`,
        );
      }
      return record;
    },

    async listPublished(executor, entityType, options) {
      const limit = Math.min(options?.limit ?? 100, 10_000);
      const offset = Math.max(options?.offset ?? 0, 0);
      const context = options?.context;
      const result = await executor.query<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS} FROM publications
         WHERE entity_type = $1 AND state = 'PUBLISHED' AND ($3::text IS NULL OR context = $3)
         ORDER BY entity_id
         LIMIT $2 OFFSET $4`,
        [entityType, limit, context, offset],
      );
      return result.rows.map(toRecord);
    },

    async listPublicationEvents(executor, entityType, entityId, options) {
      const limit = Math.min(options?.limit ?? 100, 1000);
      const offset = Math.max(options?.offset ?? 0, 0);
      const context = options?.context;
      const result = await executor.query<EventRow>(
        `SELECT id, entity_type, entity_id, context, event_type, from_revision_id,
                to_revision_id, actor_class, actor_id, reason, changeset_id, job_id,
                request_id, created_at
         FROM publication_events
         WHERE entity_type = $1 AND entity_id = $2 AND ($3::text IS NULL OR context = $3)
         ORDER BY created_at, id
         LIMIT $4 OFFSET $5`,
        [entityType, entityId, context, limit, offset],
      );
      return result.rows.map((row) => ({
        id: row.id as StableId,
        entityType: row.entity_type,
        entityId: row.entity_id as StableId,
        context: row.context,
        eventType: row.event_type as PublicationEventType,
        fromRevisionId: (row.from_revision_id as StableId | null) ?? null,
        toRevisionId: (row.to_revision_id as StableId | null) ?? null,
        actorClass: row.actor_class as PublicationActor["actorClass"],
        actorId: row.actor_id,
        reason: row.reason,
        changesetId: (row.changeset_id as StableId | null) ?? null,
        jobId: (row.job_id as StableId | null) ?? null,
        requestId: row.request_id,
        createdAt: row.created_at,
      }));
    },

    async getPublishedRevision(executor, entityType, entityId, context = "default") {
      const publication = await this.getPublication(executor, entityType, entityId, context);
      if (publication === null || publication.state !== "PUBLISHED") return null;
      if (publication.currentRevisionId === null) return null;
      return revisions.getSealedRevision(
        executor,
        entityType,
        entityId,
        publication.currentRevisionId,
      );
    },
  };
}
