// ChangeSet domain, preflight and atomic apply (PCMS-PUB-T013/T014/T015).
// Immediate apply moves every item's public pointer — plus coordinated route
// operations through the injected RouteOperationsPort — inside ONE database
// transaction: internally consistent or none (Publication spec §18).
import { type Clock, type DbClient, type DbPool, newStableId, type StableId } from "@pcms/core";
import { PublicationError } from "./errors.js";
import type { PublicationJobPayload } from "./handlers.js";
import { writeOutboxEvent } from "./outbox.js";
import type { RevisionReaderPort, SealedRevisionRef } from "./ports.js";
import type { PublicationService } from "./publication.js";
import type { PublicationActor, PublicationEventType } from "./types.js";
import {
  type PublicationCandidate,
  type PublicationValidator,
  type RouteOperation,
  runPublicationValidators,
} from "./validators.js";

export type ChangeSetState =
  | "OPEN"
  | "READY"
  | "APPLIED"
  | "PARTIALLY_SCHEDULED"
  | "CANCELLED"
  | "FAILED";

export interface ChangeSetRecord {
  readonly id: StableId;
  readonly title: string;
  readonly state: ChangeSetState;
  readonly createdByType: PublicationActor["actorClass"];
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly appliedAt: Date | null;
}

export interface AddItemInput {
  readonly entityType: string;
  readonly entityId: StableId;
  readonly context?: string;
  readonly intent: "PUBLISH" | "UNPUBLISH";
  /** Required for PUBLISH; must be SEALED (checked at preflight/apply). */
  readonly targetRevisionId?: StableId;
  /** CAS baseline captured when the item is authored (spec §21). */
  readonly expectedGeneration: number;
  readonly routeOperation?: RouteOperation;
}

export interface ChangeSetItemRecord {
  readonly id: StableId;
  readonly changesetId: StableId;
  readonly entityType: string;
  readonly entityId: StableId;
  readonly context: string;
  readonly intent: "PUBLISH" | "UNPUBLISH";
  readonly targetRevisionId: StableId | null;
  readonly expectedGeneration: number;
  readonly routeOperation: RouteOperation;
  readonly position: number;
  readonly createdAt: Date;
}

export interface PreflightIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly itemId: StableId | null;
  readonly validator?: string;
}

export interface PreflightReport {
  readonly changesetId: StableId;
  readonly ok: boolean;
  readonly issues: readonly PreflightIssue[];
  /** Live generations observed at preflight time — the staleness fingerprint
   * callers may re-verify just before apply (spec §21). */
  readonly observedGenerations: readonly {
    readonly itemId: StableId;
    readonly entityType: string;
    readonly entityId: StableId;
    readonly context: string;
    readonly generation: number;
  }[];
}

export interface RouteOperationsPort {
  /** Preflight validation running the exact activatability rules apply
   * enforces (R17-style report: preflight accepted an entry route for "/"
   * that apply rejected). Throws the routing error on invalid input. */
  validateActivatable?(input: {
    readonly siteId: string;
    readonly path: string;
    readonly locale?: string;
    readonly domainBindingId?: string;
    readonly targetType: "entry" | "system";
    readonly targetId: string;
  }): Promise<void>;
  /** Composition adapters over @pcms/routing `*WithinTx` seams. */
  activateWithinTx(
    executor: DbClient,
    operation: Extract<RouteOperation, { kind: "set" }> & {
      readonly entityId: StableId;
    },
  ): Promise<void>;
  retireWithinTx(
    executor: DbClient,
    input: {
      readonly entityType: string;
      readonly entityId: StableId;
    },
  ): Promise<void>;
}

export interface ChangeSetService {
  createChangeset(input: { title: string; actor: PublicationActor }): Promise<ChangeSetRecord>;
  getChangeset(changesetId: StableId): Promise<ChangeSetRecord>;
  requireChangeset(changesetId: StableId): Promise<ChangeSetRecord>;
  listChangesets(options?: {
    readonly limit?: number;
    readonly offset?: number;
    readonly state?: ChangeSetState;
  }): Promise<readonly ChangeSetRecord[]>;
  /** Transaction-scoped creation (PCMS-API-T017): the bundle composes the
   * changeset with drafts and public pointers on one transaction. */
  createChangesetWithinTx(
    executor: DbClient | DbPool,
    input: { readonly title: string; readonly actor: PublicationActor },
  ): Promise<ChangeSetRecord>;
  addItem(changesetId: StableId, input: AddItemInput): Promise<ChangeSetItemRecord>;
  /** Transaction-scoped add (PCMS-API-T017): identical admission rules. */
  addItemWithinTx(
    tx: DbClient,
    changesetId: StableId,
    input: AddItemInput,
  ): Promise<ChangeSetItemRecord>;
  removeItem(changesetId: StableId, itemId: StableId): Promise<void>;
  listItems(changesetId: StableId): Promise<readonly ChangeSetItemRecord[]>;
  /** Preflight: validates the combined candidate state and reports live
   * generations; ok=true moves the ChangeSet to READY (spec §20/§21). */
  preflight(changesetId: StableId): Promise<PreflightReport>;
  /** Immediate atomic apply: every pointer/route operation in one
   * transaction, else nothing changes (spec §18). */
  apply(
    changesetId: StableId,
    input: { readonly actor: PublicationActor; readonly expectedStates?: ChangeSetState[] },
  ): Promise<readonly ChangeSetItemRecord[]>;
  /** Transaction-scoped apply (PCMS-API-T017): identical semantics on a
   * caller-owned transaction so the Publication Bundle can move drafts, the
   * changeset and the public pointers in ONE commit (Publication spec §18). */
  applyWithinTx(
    tx: DbClient,
    changesetId: StableId,
    input: { readonly actor: PublicationActor; readonly expectedStates?: ChangeSetState[] },
  ): Promise<readonly ChangeSetItemRecord[]>;
  applyScheduledItemWithinTx(
    tx: DbClient,
    payload: PublicationJobPayload,
    input: { actor: PublicationActor; jobId: string; siteKey: string },
  ): Promise<"cancelled" | void>;
  cancel(changesetId: StableId, actor: PublicationActor, reason?: string): Promise<ChangeSetRecord>;
}

interface ChangesetRow {
  [column: string]: unknown;
  id: string;
  title: string;
  state: string;
  created_by_type: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
}

interface ItemRow {
  [column: string]: unknown;
  id: string;
  changeset_id: string;
  entity_type: string;
  entity_id: string;
  context: string;
  intent: string;
  target_revision_id: string | null;
  expected_generation: number;
  route_operation: unknown;
  position: number;
  created_at: Date;
}

function toChangeset(row: ChangesetRow): ChangeSetRecord {
  return {
    id: row.id as StableId,
    title: row.title,
    state: row.state as ChangeSetState,
    createdByType: row.created_by_type as PublicationActor["actorClass"],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
  };
}

function toRouteOperation(raw: unknown): RouteOperation {
  if (raw === null || raw === undefined) return { kind: "none" };
  return raw as RouteOperation;
}

function toItem(row: ItemRow): ChangeSetItemRecord {
  return {
    id: row.id as StableId,
    changesetId: row.changeset_id as StableId,
    entityType: row.entity_type,
    entityId: row.entity_id as StableId,
    context: row.context,
    intent: row.intent as "PUBLISH" | "UNPUBLISH",
    targetRevisionId: (row.target_revision_id as StableId | null) ?? null,
    expectedGeneration: row.expected_generation,
    routeOperation: toRouteOperation(row.route_operation),
    position: row.position,
    createdAt: row.created_at,
  };
}

const MAX_CHANGESET_ITEMS = 200;

export function createChangeSetService(
  pool: DbPool,
  deps: {
    readonly clock: Clock;
    readonly revisions: RevisionReaderPort;
    readonly publications: PublicationService;
    readonly validators?: readonly PublicationValidator[];
    readonly routes?: RouteOperationsPort;
  },
): ChangeSetService {
  const { clock, revisions, publications } = deps;
  const validators = deps.validators ?? [];

  async function applyItemWithinTx(
    tx: DbClient,
    item: ChangeSetItemRecord,
    actor: PublicationActor,
    expectedGeneration: number,
  ): Promise<void> {
    const op = item.routeOperation;
    if (item.intent === "PUBLISH") {
      await publications.publishWithinTx(tx, {
        entityType: item.entityType,
        entityId: item.entityId,
        context: item.context,
        targetRevisionId: item.targetRevisionId!,
        expectedGeneration,
        actor,
        changesetId: item.changesetId,
      });
    } else {
      await publications.unpublishWithinTx(tx, {
        entityType: item.entityType,
        entityId: item.entityId,
        context: item.context,
        expectedGeneration,
        actor,
        changesetId: item.changesetId,
      });
    }
    if (deps.routes !== undefined) {
      if (op.kind === "set") {
        await deps.routes.activateWithinTx(tx, { ...op, entityId: item.entityId });
      } else if (op.kind === "retire") {
        await deps.routes.retireWithinTx(tx, {
          entityType: item.entityType,
          entityId: item.entityId,
        });
      }
    }
  }

  async function loadChangeset(executor: DbClient, id: StableId): Promise<ChangeSetRecord> {
    const result = await executor.query<ChangesetRow>(`SELECT * FROM changesets WHERE id = $1`, [
      id,
    ]);
    if (result.rows.length !== 1) {
      throw new PublicationError("CHANGESET_NOT_FOUND", `changeset ${id} does not exist`, {
        details: { changesetId: id },
      });
    }
    return toChangeset(result.rows[0]!);
  }

  async function loadItems(executor: DbClient, id: StableId): Promise<ChangeSetItemRecord[]> {
    const result = await executor.query<ItemRow>(
      `SELECT * FROM changeset_items WHERE changeset_id = $1 ORDER BY position, id`,
      [id],
    );
    return result.rows.map(toItem);
  }

  /** Builds candidates + sealed-revision map for validation. */
  async function buildCandidates(
    executor: DbClient,
    items: readonly ChangeSetItemRecord[],
  ): Promise<{
    candidates: PublicationCandidate[];
    revisions: Map<string, SealedRevisionRef>;
    issues: PreflightIssue[];
  }> {
    const candidates: PublicationCandidate[] = [];
    const sealed = new Map<string, SealedRevisionRef>();
    const issues: PreflightIssue[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.intent === "PUBLISH") {
        if (item.targetRevisionId === null) {
          issues.push({
            code: "CHANGESET_ITEM_INVALID",
            severity: "error",
            message: "PUBLISH item requires a target revision",
            itemId: item.id,
          });
          continue;
        }
        const ref = await revisions.getSealedRevision(
          executor,
          item.entityType,
          item.entityId,
          item.targetRevisionId,
        );
        if (ref === null) {
          issues.push({
            code: "REVISION_NOT_SEALED",
            severity: "error",
            message: `target revision ${item.targetRevisionId} is missing, not sealed, or belongs to another entity`,
            itemId: item.id,
          });
          continue;
        }
        sealed.set(item.id, ref);
        candidates.push({
          entityType: item.entityType,
          entityId: item.entityId,
          context: item.context,
          intent: "PUBLISH",
          targetRevision: ref,
          routeOperation: item.routeOperation,
        });
      } else {
        candidates.push({
          entityType: item.entityType,
          entityId: item.entityId,
          context: item.context,
          intent: "UNPUBLISH",
          targetRevision: null,
          routeOperation: item.routeOperation,
        });
      }
    }
    return { candidates, revisions: sealed, issues };
  }

  return {
    async createChangeset(input) {
      return this.createChangesetWithinTx(pool, input);
    },

    /** Transaction-scoped creation (PCMS-API-T017): the bundle composes the
     * changeset with drafts and public pointers on one transaction. */
    async createChangesetWithinTx(
      executor: DbClient | DbPool,
      input: { readonly title: string; readonly actor: PublicationActor },
    ): Promise<ChangeSetRecord> {
      const id = newStableId();
      const now = clock.now();
      await executor.query(
        `INSERT INTO changesets (id, title, state, created_by_type, created_by, created_at, updated_at)
         VALUES ($1, $2, 'OPEN', $3, $4, $5, $5)`,
        [id, input.title, input.actor.actorClass, input.actor.actorId, now],
      );
      return loadChangeset(executor, id);
    },

    async getChangeset(changesetId) {
      return loadChangeset(pool, changesetId);
    },

    async requireChangeset(changesetId) {
      return loadChangeset(pool, changesetId);
    },

    async listChangesets(options) {
      const limit = Math.min(options?.limit ?? 100, 1000);
      const offset = Math.max(options?.offset ?? 0, 0);
      const result = await pool.query<ChangesetRow>(
        `SELECT * FROM changesets WHERE ($3::text IS NULL OR state = $3)
         ORDER BY created_at, id
         LIMIT $1 OFFSET $2`,
        [limit, offset, options?.state ?? null],
      );
      return result.rows.map(toChangeset);
    },

    async addItem(changesetId, input) {
      return pool.withTransaction(async (tx) => this.addItemWithinTx(tx, changesetId, input));
    },

    /** Transaction-scoped add (PCMS-API-T017): identical admission rules. */
    async addItemWithinTx(tx, changesetId, input) {
      {
        const changeset = await loadChangeset(tx, changesetId);
        if (changeset.state !== "OPEN") {
          throw new PublicationError(
            "CHANGESET_INVALID",
            `changeset is ${changeset.state}; items can only be added while OPEN`,
          );
        }
        const existing = await loadItems(tx, changesetId);
        if (existing.length >= MAX_CHANGESET_ITEMS) {
          throw new PublicationError(
            "CHANGESET_INVALID",
            `changeset exceeds the ${MAX_CHANGESET_ITEMS}-item bound`,
          );
        }
        if (input.intent === "PUBLISH" && input.targetRevisionId === undefined) {
          throw new PublicationError(
            "CHANGESET_ITEM_INVALID",
            "PUBLISH items require a target revision",
          );
        }
        const duplicate = existing.find(
          (item) =>
            item.entityType === input.entityType &&
            item.entityId === input.entityId &&
            item.context === (input.context ?? "default"),
        );
        if (duplicate !== undefined) {
          throw new PublicationError(
            "CHANGESET_ITEM_DUPLICATE",
            `entity ${input.entityType}/${input.entityId} is already in this changeset`,
          );
        }
        const id = newStableId();
        const position = existing.length;
        await tx.query(
          `INSERT INTO changeset_items
             (id, changeset_id, entity_type, entity_id, context, intent,
              target_revision_id, expected_generation, route_operation, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            changesetId,
            input.entityType,
            input.entityId,
            input.context ?? "default",
            input.intent,
            input.targetRevisionId ?? null,
            input.expectedGeneration,
            input.routeOperation === undefined ? null : JSON.stringify(input.routeOperation),
            position,
          ],
        );
        await tx.query(`UPDATE changesets SET updated_at = $2 WHERE id = $1`, [
          changesetId,
          clock.now(),
        ]);
        const items = await loadItems(tx, changesetId);
        return items.find((item) => item.id === id)!;
      }
    },

    async removeItem(changesetId, itemId) {
      return pool.withTransaction(async (tx) => {
        const changeset = await loadChangeset(tx, changesetId);
        if (changeset.state !== "OPEN") {
          throw new PublicationError(
            "CHANGESET_INVALID",
            `changeset is ${changeset.state}; items can only be removed while OPEN`,
          );
        }
        const result = await tx.query<{ id: string }>(
          `DELETE FROM changeset_items WHERE id = $1 AND changeset_id = $2 RETURNING id`,
          [itemId, changesetId],
        );
        if (result.rows.length !== 1) {
          throw new PublicationError(
            "CHANGESET_ITEM_NOT_FOUND",
            `item ${itemId} is not in this changeset`,
          );
        }
      });
    },

    async listItems(changesetId) {
      return loadItems(pool, changesetId);
    },

    async preflight(changesetId) {
      return pool.withTransaction(async (tx) => {
        const changeset = await loadChangeset(tx, changesetId);
        if (changeset.state !== "OPEN" && changeset.state !== "READY") {
          throw new PublicationError(
            "CHANGESET_INVALID",
            `changeset is ${changeset.state}; only OPEN/READY changesets can be validated`,
          );
        }
        const items = await loadItems(tx, changesetId);
        if (items.length === 0) {
          throw new PublicationError("CHANGESET_EMPTY", "changeset has no items");
        }

        const { candidates, issues: candidateIssues } = await buildCandidates(tx, items);

        // Staleness fingerprint: live generation vs authored expectation.
        const observedGenerations: {
          readonly itemId: StableId;
          readonly entityType: string;
          readonly entityId: StableId;
          readonly context: string;
          readonly generation: number;
        }[] = [];
        const staleIssues: PreflightIssue[] = [];
        for (const item of items) {
          const publication = await publications.getPublication(
            tx,
            item.entityType,
            item.entityId,
            item.context,
          );
          const live = publication?.generation ?? 0;
          observedGenerations.push({
            itemId: item.id,
            entityType: item.entityType,
            entityId: item.entityId,
            context: item.context,
            generation: live,
          });
          if (live !== item.expectedGeneration) {
            staleIssues.push({
              code: "CHANGESET_STALE",
              severity: "error",
              message: `public generation moved since authoring (expected ${item.expectedGeneration}, live ${live})`,
              itemId: item.id,
            });
          }
        }

        const validatorIssues = await runPublicationValidators(validators, candidates, {
          clock,
          executor: tx,
        });
        // Route operations meet the same rules apply will enforce (drift-free:
        // the port delegates to the routing service itself).
        const routeIssues: PreflightIssue[] = [];
        for (const item of items) {
          const op = item.routeOperation;
          if (op.kind !== "set" || deps.routes?.validateActivatable === undefined) continue;
          try {
            await deps.routes.validateActivatable({
              siteId: op.siteId,
              path: op.path,
              ...(op.locale === undefined ? {} : { locale: op.locale }),
              ...(op.domainBindingId === undefined ? {} : { domainBindingId: op.domainBindingId }),
              targetType: item.entityType === "entry" ? "entry" : "system",
              targetId: item.entityId,
            });
          } catch (error) {
            routeIssues.push({
              code: (error as { code?: string }).code ?? "ROUTE_PATH_INVALID",
              severity: "error",
              message: (error as Error).message,
              itemId: item.id,
            });
          }
        }
        const allIssues: PreflightIssue[] = [
          ...candidateIssues,
          ...staleIssues,
          ...routeIssues,
          ...validatorIssues.map((issue) => ({
            code: issue.code,
            severity: issue.severity,
            message: issue.message,
            itemId: items[issue.candidateIndex]?.id ?? null,
            validator: issue.validator,
          })),
        ];
        const ok = !allIssues.some((issue) => issue.severity === "error");
        if (ok && changeset.state === "OPEN") {
          await tx.query(`UPDATE changesets SET state = 'READY', updated_at = $2 WHERE id = $1`, [
            changesetId,
            clock.now(),
          ]);
        }
        return {
          changesetId,
          ok,
          issues: allIssues.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
          observedGenerations,
        };
      });
    },

    async apply(changesetId, input) {
      return pool.withTransaction(async (tx) => this.applyWithinTx(tx, changesetId, input));
    },

    async applyScheduledItemWithinTx(tx, payload, input) {
      const invalid = () =>
        new PublicationError(
          "CHANGESET_ITEM_INVALID",
          "scheduled job does not match its immutable ChangeSet item",
        );
      if (
        !payload.planId ||
        !payload.planItemId ||
        !payload.changesetItemId ||
        !Number.isInteger(payload.expectedGeneration) ||
        payload.expectedGeneration! < 0
      )
        throw invalid();
      const result = await tx.query<
        ItemRow & {
          plan_id: string;
          source_id: string;
          plan_changeset_id: string;
          publish_job_id: string;
          state: string;
        }
      >(
        `SELECT ci.*, pi.plan_id, pi.changeset_item_id AS source_id, pi.publish_job_id, pi.state,
                p.changeset_id AS plan_changeset_id
         FROM publication_plan_items pi JOIN publication_plans p ON p.id = pi.plan_id
         JOIN changeset_items ci ON ci.id = pi.changeset_item_id
         WHERE pi.id = $1 FOR UPDATE OF pi`,
        [payload.planItemId],
      );
      const row = result.rows[0];
      if (
        !row ||
        row.plan_id !== payload.planId ||
        row.source_id !== payload.changesetItemId ||
        row.plan_changeset_id !== row.changeset_id ||
        row.publish_job_id !== input.jobId ||
        row.entity_type !== payload.entityType ||
        row.entity_id !== payload.entityId ||
        row.context !== payload.context ||
        row.target_revision_id !== payload.targetRevisionId ||
        row.intent !== "PUBLISH"
      )
        throw invalid();
      const item = toItem(row);
      if (item.routeOperation.kind === "set") {
        const site = await tx.query<{ key: string }>(`SELECT key FROM sites WHERE id = $1`, [
          item.routeOperation.siteId,
        ]);
        if (site.rows[0]?.key !== input.siteKey) throw invalid();
      }
      if (row.state === "CANCELLED" || row.state === "PAUSED") return "cancelled";
      if (row.state === "PUBLISHED") return;
      if (row.state !== "SCHEDULED") throw invalid();
      if (item.routeOperation.kind !== "none" && !deps.routes) throw invalid();
      const { candidates, issues } = await buildCandidates(tx, [item]);
      const validation = await runPublicationValidators(validators, candidates, {
        clock,
        executor: tx,
      });
      const issue = [...issues, ...validation].find((issue) => issue.severity === "error");
      if (issue) throw new PublicationError(issue.code, issue.message);
      await applyItemWithinTx(tx, item, input.actor, payload.expectedGeneration!);
    },

    async applyWithinTx(tx, changesetId, input) {
      {
        // Lock the changeset row first: concurrent applies serialize here and
        // the loser sees APPLIED.
        const changeset = await loadChangeset(tx, changesetId);
        const allowed = input.expectedStates ?? (["READY"] as ChangeSetState[]);
        if (!allowed.includes(changeset.state)) {
          throw new PublicationError(
            "CHANGESET_INVALID",
            `changeset is ${changeset.state}; apply requires ${allowed.join("/")}`,
            { details: { state: changeset.state } },
          );
        }
        const items = await loadItems(tx, changesetId);

        // Re-check staleness right inside the apply transaction (spec §21).
        for (const item of items) {
          const publication = await publications.getPublication(
            tx,
            item.entityType,
            item.entityId,
            item.context,
          );
          const live = publication?.generation ?? 0;
          if (live !== item.expectedGeneration) {
            throw new PublicationError(
              "CHANGESET_STALE",
              `public state moved after preflight (item ${item.entityType}/${item.entityId}: expected ${item.expectedGeneration}, live ${live})`,
              { details: { itemId: item.id } },
            );
          }
        }

        // Combined-state validation at commit time.
        const { candidates } = await buildCandidates(tx, items);
        const validatorIssues = await runPublicationValidators(validators, candidates, {
          clock,
          executor: tx,
        });
        if (validatorIssues.some((issue) => issue.severity === "error")) {
          throw new PublicationError("CHANGESET_INVALID", "combined candidate state is invalid", {
            details: { issues: validatorIssues },
          });
        }

        // Apply every item on this transaction: internally consistent or none.
        const applied: ChangeSetItemRecord[] = [];
        for (const item of items) {
          await applyItemWithinTx(tx, item, input.actor, item.expectedGeneration);
          applied.push(item);
        }

        const now = clock.now();
        await tx.query(
          `UPDATE changesets SET state = 'APPLIED', applied_at = $2, updated_at = $2 WHERE id = $1`,
          [changesetId, now],
        );
        await writeOutboxEvent(tx, {
          aggregate: "changeset",
          aggregateId: changesetId,
          eventType: "ChangeSetApplied",
          payload: {
            changesetId,
            itemCount: applied.length,
            actor: { actorClass: input.actor.actorClass, actorId: input.actor.actorId },
          },
        });
        return applied;
      }
    },

    async cancel(changesetId, actor, reason) {
      return pool.withTransaction(async (tx) => {
        const changeset = await loadChangeset(tx, changesetId);
        if (changeset.state === "APPLIED") {
          throw new PublicationError(
            "CHANGESET_INVALID",
            "applied changesets cannot be cancelled; use unpublish/rollback",
          );
        }
        if (changeset.state === "CANCELLED") return changeset;
        await tx.query(`UPDATE changesets SET state = 'CANCELLED', updated_at = $2 WHERE id = $1`, [
          changesetId,
          clock.now(),
        ]);
        await writeOutboxEvent(tx, {
          aggregate: "changeset",
          aggregateId: changesetId,
          eventType: "ChangeSetCancelled",
          payload: {
            changesetId,
            reason: reason ?? null,
            actor: { actorClass: actor.actorClass, actorId: actor.actorId },
          },
        });
        return loadChangeset(tx, changesetId);
      });
    },
  };
}
