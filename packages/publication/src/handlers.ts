// Scheduled publish executor (PCMS-PUB-T023): typed job handlers the worker
// composition registers into the generic @pcms/jobs runner. Structural
// contract only — this package never imports @pcms/jobs (owner instruction
// #44).
//
// Flow per spec §30, one transaction per job: verify not cancelled/paused
// (plan item is the cancellation authority — closes the cancel-vs-execution
// race) → verify immutable source and idempotency → verify compile-time
// expected generation (CAS) → execute publication and source route → record result.
// Transient DB failures stay retryable; validation conflicts fail permanent
// and trigger the plan's failure policy (§29).
import type { Clock, DbPool, StableId } from "@pcms/core";
import type { ChangeSetService } from "./changesets.js";
import { PublicationError } from "./errors.js";
import type { PublicationService } from "./publication.js";

export type PublicationJobOutcome = "transient" | "permanent" | "cancelled";

export interface PublicationJobPayload {
  readonly entityType: string;
  readonly entityId: StableId;
  readonly context: string;
  readonly targetRevisionId?: StableId;
  readonly expectedGeneration?: number;
  readonly planId?: StableId;
  readonly planItemId?: StableId;
  readonly changesetItemId?: StableId;
}

export type PublicationJobHandler = (
  payload: PublicationJobPayload,
  context: { readonly job: { readonly id: string }; readonly attempt: number },
) => Promise<PublicationJobOutcome | { outcome: "permanent"; error: unknown } | void>;

const SYSTEM_ACTOR_BASE = "scheduled-job";

export function createPublicationJobHandlers(deps: {
  readonly pool: DbPool;
  readonly clock: Clock;
  readonly publications: PublicationService;
  readonly changesets: ChangeSetService;
  readonly siteKey: string;
}): Record<"publication.publish" | "publication.unpublish", PublicationJobHandler> {
  const { pool, clock, publications } = deps;

  async function applyFailurePolicy(
    tx: Parameters<Parameters<DbPool["withTransaction"]>[0]>[0],
    payload: PublicationJobPayload,
    reason: string,
  ): Promise<void> {
    if (payload.planId === undefined) return;
    const plan = await tx.query<{ failure_policy: string }>(
      `SELECT failure_policy FROM publication_plans WHERE id = $1`,
      [payload.planId],
    );
    const policy = plan.rows[0]?.failure_policy;
    if (policy === undefined || policy === "continue") return;
    const item = await tx.query<{ batch_no: number }>(
      `SELECT batch_no FROM publication_plan_items WHERE id = $1`,
      [payload.planItemId ?? null],
    );
    const batchNo = item.rows[0]?.batch_no;
    if (policy === "pause_batch" && batchNo !== undefined) {
      await tx.query(
        `UPDATE publication_plan_items
         SET state = 'PAUSED', last_error = $3
         WHERE plan_id = $1 AND state = 'SCHEDULED' AND batch_no = $2`,
        [payload.planId, batchNo, reason.slice(0, 500)],
      );
      return;
    }
    await tx.query(
      `UPDATE publication_plan_items
       SET state = 'PAUSED', last_error = $2
       WHERE plan_id = $1 AND state = 'SCHEDULED'`,
      [payload.planId, reason.slice(0, 500)],
    );
    await tx.query(`UPDATE publication_plans SET status = 'PAUSED' WHERE id = $1`, [
      payload.planId,
    ]);
  }

  async function completePlanIfDone(
    tx: Parameters<Parameters<DbPool["withTransaction"]>[0]>[0],
    planId: StableId | undefined,
  ): Promise<void> {
    if (planId === undefined) return;
    await tx.query(
      `UPDATE publication_plans p SET status = 'COMPLETED', completed_at = $2
       WHERE p.id = $1 AND p.status = 'COMPILED'
         AND NOT EXISTS (
           SELECT 1 FROM publication_plan_items i
           WHERE i.plan_id = p.id AND i.state IN ('SCHEDULED', 'PAUSED')
         )`,
      [planId, clock.now()],
    );
  }

  async function runPublishJob(
    payload: PublicationJobPayload,
    jobId: string,
  ): ReturnType<PublicationJobHandler> {
    try {
      return await pool.withTransaction(async (tx) => {
        const planned =
          payload.planId !== undefined ||
          payload.planItemId !== undefined ||
          payload.changesetItemId !== undefined;
        if (planned) {
          const outcome = await deps.changesets.applyScheduledItemWithinTx(tx, payload, {
            actor: { actorClass: "system", actorId: `${SYSTEM_ACTOR_BASE}:${payload.planItemId}` },
            jobId,
            siteKey: deps.siteKey,
          });
          if (outcome) return outcome;
        } else {
          if (!payload.targetRevisionId)
            throw new PublicationError(
              "CHANGESET_ITEM_INVALID",
              "job payload lacks target revision",
            );
          const current = await publications.getPublication(
            tx,
            payload.entityType,
            payload.entityId,
            payload.context,
          );
          if (
            current?.state === "PUBLISHED" &&
            current.currentRevisionId === payload.targetRevisionId
          )
            return;
          await publications.publishWithinTx(tx, {
            entityType: payload.entityType,
            entityId: payload.entityId,
            context: payload.context,
            targetRevisionId: payload.targetRevisionId,
            expectedGeneration: payload.expectedGeneration ?? current?.generation ?? 0,
            actor: { actorClass: "system", actorId: `${SYSTEM_ACTOR_BASE}:manual` },
          });
        }
        if (payload.planItemId)
          await tx.query(
            `UPDATE publication_plan_items SET state = 'PUBLISHED', executed_at = COALESCE(executed_at, $2) WHERE id = $1`,
            [payload.planItemId, clock.now()],
          );
        await completePlanIfDone(tx, payload.planId);
      });
    } catch (error) {
      // Catch outside the transaction: a route failure must roll back pointers and events.
      const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
      if (
        !(error instanceof PublicationError) &&
        !/^(PUBLICATION_|REVISION_|CHANGESET_|PLAN_|ROUTE_|MEDIA_|THEME_)/.test(code)
      )
        return "transient";
      const reason = `${code}: ${error instanceof Error ? error.message : String(error)}`;
      await pool.withTransaction(async (tx) => {
        const failed = await tx.query(
          `UPDATE publication_plan_items SET state = 'FAILED', executed_at = $5, last_error = $6
           WHERE id = $1 AND plan_id = $2 AND changeset_item_id = $3 AND publish_job_id = $4
             AND state = 'SCHEDULED' RETURNING id`,
          [
            payload.planItemId ?? null,
            payload.planId ?? null,
            payload.changesetItemId ?? null,
            jobId,
            clock.now(),
            reason.slice(0, 1500),
          ],
        );
        if (failed.rows.length) {
          await applyFailurePolicy(tx, payload, reason);
          await completePlanIfDone(tx, payload.planId);
        }
      });
      return { outcome: "permanent", error: new PublicationError(code, reason, { cause: error }) };
    }
  }

  return {
    "publication.publish": async (payload, context) => runPublishJob(payload, context.job.id),

    "publication.unpublish": async (payload) =>
      pool.withTransaction(async (tx) => {
        let itemState: string | null = null;
        if (payload.planItemId !== undefined) {
          const locked = await tx.query<{ state: string }>(
            `SELECT state FROM publication_plan_items WHERE id = $1 FOR UPDATE`,
            [payload.planItemId],
          );
          itemState = locked.rows[0]?.state ?? null;
          if (itemState === "CANCELLED" || itemState === "PAUSED") return "cancelled";
          if (itemState === "UNPUBLISHED") return undefined;
        }
        const current = await publications.getPublication(
          tx,
          payload.entityType,
          payload.entityId,
          payload.context,
        );
        if (current === null || current.state === "UNPUBLISHED") {
          if (payload.planItemId !== undefined) {
            await tx.query(
              `UPDATE publication_plan_items SET state = 'UNPUBLISHED', executed_at = $2 WHERE id = $1`,
              [payload.planItemId, clock.now()],
            );
          }
          await completePlanIfDone(tx, payload.planId);
          return undefined;
        }
        try {
          await publications.unpublishWithinTx(tx, {
            entityType: payload.entityType,
            entityId: payload.entityId,
            context: payload.context,
            expectedGeneration: payload.expectedGeneration ?? current.generation,
            actor: {
              actorClass: "system",
              actorId: `${SYSTEM_ACTOR_BASE}:${payload.planItemId ?? "manual"}`,
            },
          });
        } catch (error) {
          const code = error instanceof PublicationError ? error.code : "UNKNOWN";
          const message = error instanceof Error ? error.message : String(error);
          if (code === "PUBLICATION_CONFLICT" || code === "PUBLICATION_NOT_PUBLISHED") {
            if (payload.planItemId !== undefined) {
              await tx.query(
                `UPDATE publication_plan_items SET state = 'FAILED', executed_at = $2, last_error = $3 WHERE id = $1`,
                [payload.planItemId, clock.now(), `${code}: ${message.slice(0, 1500)}`],
              );
            }
            await applyFailurePolicy(tx, payload, `${code}: ${message}`);
            await completePlanIfDone(tx, payload.planId);
            return "permanent";
          }
          return "transient";
        }
        if (payload.planItemId !== undefined) {
          await tx.query(
            `UPDATE publication_plan_items SET state = 'UNPUBLISHED', executed_at = $2 WHERE id = $1`,
            [payload.planItemId, clock.now()],
          );
        }
        await completePlanIfDone(tx, payload.planId);
        return undefined;
      }),
  };
}
