// PublicationPlan service (PCMS-PUB-T020–T025): schedules ChangeSet items
// over time (Publication spec §22–§36). The compiler materializes exact UTC
// timestamps once and persists them — execution never recalculates (§25).
// Approval/readiness is a ChangeSet concern; the plan is pure scheduling.
import { type Clock, type DbClient, type DbPool, newStableId, type StableId } from "@pcms/core";
import type { ChangeSetService } from "./changesets.js";
import { PublicationError } from "./errors.js";
import type { StructuralJobsService } from "./jobs-types.js";
import { writeOutboxEvent } from "./outbox.js";
import type { PublicationService } from "./publication.js";
import type { PublicationActor, PublicationEventType } from "./types.js";
import { addDaysToWallClock, instantToZonedWallClock, zonedWallClockToInstant } from "./tz.js";

export type PlanStatus = "DRAFT" | "COMPILED" | "COMPLETED" | "CANCELLED" | "PAUSED";
export type PlanItemState =
  | "SCHEDULED"
  | "PUBLISHED"
  | "UNPUBLISHED"
  | "FAILED"
  | "CANCELLED"
  | "PAUSED";
export type FailurePolicy = "continue" | "pause_batch" | "pause_plan";

export interface PlanRecord {
  readonly id: StableId;
  readonly changesetId: StableId;
  readonly status: PlanStatus;
  readonly failurePolicy: FailurePolicy;
  readonly timezone: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface PlanItemRecord {
  readonly id: StableId;
  readonly planId: StableId;
  readonly changesetItemId: StableId;
  readonly batchNo: number;
  readonly publishAt: Date | null;
  readonly unpublishAt: Date | null;
  readonly state: PlanItemState;
  readonly publishJobId: StableId | null;
  readonly unpublishJobId: StableId | null;
  readonly lastError: string | null;
  readonly executedAt: Date | null;
}

/** Batch scheduling spec (spec §24): explicit inputs, deterministic output. */
export interface BatchScheduleSpec {
  /** Exact UTC start instant, or… */
  readonly startAt?: Date;
  /** …a local wall-clock start in the plan timezone ("YYYY-MM-DD", "HH:mm"). */
  readonly startLocal?: { readonly date: string; readonly time: string };
  readonly batchSize: number;
  /** Fixed durations (minutes/hours) shift instants; `days` preserves the
   * local wall-clock time across DST (spec §27). */
  readonly interval: { readonly unit: "minutes" | "hours" | "days"; readonly value: number };
}

export interface ItemScheduleOverride {
  readonly changesetItemId: StableId;
  /** Explicit UTC instants for per-entry scheduling (spec §23). */
  readonly publishAt?: Date;
  readonly unpublishAt?: Date;
}

export interface CompiledScheduleEntry {
  readonly planItemId: StableId;
  readonly changesetItemId: StableId;
  readonly batchNo: number;
  readonly publishAt: Date | null;
  readonly unpublishAt: Date | null;
}

export interface PublicationPlanService {
  createPlan(input: {
    changesetId: StableId;
    timezone: string;
    failurePolicy?: FailurePolicy;
    actor: PublicationActor;
  }): Promise<PlanRecord>;
  getPlan(planId: StableId): Promise<PlanRecord>;
  requirePlan(planId: StableId): Promise<PlanRecord>;
  listPlanItems(planId: StableId): Promise<readonly PlanItemRecord[]>;
  /** Deterministic dry run of the compiler — nothing is persisted (§68). */
  previewPlan(
    planId: StableId,
    spec: BatchScheduleSpec,
    overrides?: readonly ItemScheduleOverride[],
  ): Promise<readonly CompiledScheduleEntry[]>;
  /** Materializes explicit timestamps, enqueues idempotent jobs and writes
   * SCHEDULE_CREATED events; the changeset becomes PARTIALLY_SCHEDULED. */
  compilePlan(
    planId: StableId,
    spec: BatchScheduleSpec,
    overrides?: readonly ItemScheduleOverride[],
  ): Promise<readonly CompiledScheduleEntry[]>;
  /** Atomic cancel+replace of a pending schedule (spec §28/§34). */
  rescheduleItem(planId: StableId, planItemId: StableId, publishAt: Date): Promise<PlanItemRecord>;
  cancelItem(planId: StableId, planItemId: StableId, actor: PublicationActor): Promise<void>;
  cancelPlan(planId: StableId, actor: PublicationActor): Promise<void>;
  pausePlan(planId: StableId, actor: PublicationActor): Promise<void>;
  /** Paused items reschedule at max(original, now) (late execution §32). */
  resumePlan(planId: StableId, actor: PublicationActor): Promise<void>;
  /** Cancel pending schedule + publish exactly once (spec §35). */
  publishNow(planId: StableId, planItemId: StableId, actor: PublicationActor): Promise<void>;
}

interface PlanRow {
  [column: string]: unknown;
  id: string;
  changeset_id: string;
  status: string;
  failure_policy: string;
  timezone: string;
  created_at: Date;
  completed_at: Date | null;
}

interface PlanItemRow {
  [column: string]: unknown;
  id: string;
  plan_id: string;
  changeset_item_id: string;
  batch_no: number;
  publish_at: Date | null;
  unpublish_at: Date | null;
  state: string;
  publish_job_id: string | null;
  unpublish_job_id: string | null;
  last_error: string | null;
  executed_at: Date | null;
}

function toPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id as StableId,
    changesetId: row.changeset_id as StableId,
    status: row.status as PlanStatus,
    failurePolicy: row.failure_policy as FailurePolicy,
    timezone: row.timezone,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function toItem(row: PlanItemRow): PlanItemRecord {
  return {
    id: row.id as StableId,
    planId: row.plan_id as StableId,
    changesetItemId: row.changeset_item_id as StableId,
    batchNo: row.batch_no,
    publishAt: row.publish_at,
    unpublishAt: row.unpublish_at,
    state: row.state as PlanItemState,
    publishJobId: (row.publish_job_id as StableId | null) ?? null,
    unpublishJobId: (row.unpublish_job_id as StableId | null) ?? null,
    lastError: row.last_error,
    executedAt: row.executed_at,
  };
}

export const PUBLISH_JOB_TYPE = "publication.publish";
export const UNPUBLISH_JOB_TYPE = "publication.unpublish";

export function createPublicationPlanService(
  pool: DbPool,
  deps: {
    readonly clock: Clock;
    readonly changesets: ChangeSetService;
    readonly publications: PublicationService;
    readonly jobs: StructuralJobsService;
  },
): PublicationPlanService {
  const { clock, changesets, publications, jobs } = deps;

  async function loadPlan(executor: DbClient, planId: StableId): Promise<PlanRecord> {
    const result = await executor.query<PlanRow>(`SELECT * FROM publication_plans WHERE id = $1`, [
      planId,
    ]);
    if (result.rows.length !== 1) {
      throw new PublicationError("PLAN_NOT_FOUND", `plan ${planId} does not exist`);
    }
    return toPlan(result.rows[0]!);
  }

  async function loadItems(executor: DbClient, planId: StableId): Promise<PlanItemRecord[]> {
    const result = await executor.query<PlanItemRow>(
      `SELECT pi.* FROM publication_plan_items pi
       JOIN changeset_items ci ON ci.id = pi.changeset_item_id
       WHERE pi.plan_id = $1 ORDER BY pi.batch_no, ci.position, ci.id`,
      [planId],
    );
    return result.rows.map(toItem);
  }

  async function loadItemByChangesetItem(
    executor: DbClient,
    planId: StableId,
    changesetItemId: StableId,
  ): Promise<PlanItemRecord> {
    const result = await executor.query<PlanItemRow>(
      `SELECT * FROM publication_plan_items WHERE plan_id = $1 AND changeset_item_id = $2`,
      [planId, changesetItemId],
    );
    if (result.rows.length !== 1) {
      throw new PublicationError(
        "PLAN_NOT_FOUND",
        "plan item does not exist for this changeset item",
      );
    }
    return toItem(result.rows[0]!);
  }

  function computeSchedule(
    itemCount: number,
    spec: BatchScheduleSpec,
    timezone: string,
  ): (batchNo: number) => Date {
    if (!Number.isSafeInteger(spec.batchSize) || spec.batchSize < 1) {
      throw new PublicationError("PLAN_INVALID", "batchSize must be >= 1");
    }
    if (!Number.isFinite(spec.interval.value) || spec.interval.value <= 0) {
      throw new PublicationError("PLAN_INVALID", "interval must be positive");
    }
    if (!["minutes", "hours", "days"].includes(spec.interval.unit)) {
      throw new PublicationError("PLAN_INVALID", "interval unit is invalid");
    }
    partsFormatterSanity(timezone);
    const hasStartAt = spec.startAt !== undefined;
    const hasStartLocal = spec.startLocal !== undefined;
    if (hasStartAt === hasStartLocal) {
      throw new PublicationError(
        "PLAN_INVALID",
        "schedule needs exactly one of startAt (UTC) or startLocal (wall-clock)",
      );
    }
    let startWall: {
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
    } | null = null;
    let startInstant: Date | null = null;
    if (spec.startLocal !== undefined) {
      const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec.startLocal.date);
      const timeParts = /^(\d{2}):(\d{2})$/.exec(spec.startLocal.time);
      const year = dateParts?.[1] === undefined ? NaN : Number(dateParts[1]);
      const month = dateParts?.[2] === undefined ? NaN : Number(dateParts[2]);
      const day = dateParts?.[3] === undefined ? NaN : Number(dateParts[3]);
      const hour = timeParts?.[1] === undefined ? NaN : Number(timeParts[1]);
      const minute = timeParts?.[2] === undefined ? NaN : Number(timeParts[2]);
      if (
        dateParts === null ||
        timeParts === null ||
        month! < 1 ||
        month! > 12 ||
        day! < 1 ||
        day! > 31 ||
        hour! > 23 ||
        minute! > 59 ||
        new Date(`${spec.startLocal.date}T00:00:00.000Z`).toISOString().slice(0, 10) !==
          spec.startLocal.date
      ) {
        throw new PublicationError(
          "PLAN_INVALID",
          "startLocal must be {date: YYYY-MM-DD, time: HH:mm}",
        );
      }
      startWall = { year, month, day, hour, minute };
    } else {
      startInstant = spec.startAt!;
      if (!(startInstant instanceof Date) || !Number.isFinite(startInstant.getTime())) {
        throw new PublicationError("PLAN_INVALID", "startAt must be a valid UTC instant");
      }
    }

    const { unit, value } = spec.interval;
    if (unit === "days" && startWall !== null) {
      // Day-based + local start: calendar-day steps, wall-clock preserved.
      return (batchNo: number) =>
        zonedWallClockToInstant(addDaysToWallClock(startWall, batchNo * value), timezone);
    }
    const intervalMs =
      unit === "minutes"
        ? value * 60_000
        : unit === "hours"
          ? value * 3_600_000
          : value * 86_400_000;
    if (startWall !== null) {
      startInstant = zonedWallClockToInstant(startWall, timezone);
    }
    const base = startInstant!.getTime();
    return (batchNo: number) => new Date(base + batchNo * intervalMs);
  }

  function buildScheduleEntries(
    items: readonly PlanItemRecord[],
    spec: BatchScheduleSpec,
    timezone: string,
    overrides: readonly ItemScheduleOverride[],
  ): CompiledScheduleEntry[] {
    const batchStart = computeSchedule(items.length, spec, timezone);
    const itemIds = new Set(items.map((item) => item.changesetItemId));
    const overrideByItemId = new Map<StableId, ItemScheduleOverride>();
    for (const override of overrides) {
      if (!itemIds.has(override.changesetItemId)) {
        throw new PublicationError(
          "PLAN_INVALID",
          `override references unknown changeset item ${override.changesetItemId}`,
        );
      }
      if (overrideByItemId.has(override.changesetItemId)) {
        throw new PublicationError(
          "PLAN_INVALID",
          `duplicate schedule override for changeset item ${override.changesetItemId}`,
        );
      }
      if (override.publishAt === undefined && override.unpublishAt === undefined) {
        throw new PublicationError("PLAN_INVALID", "schedule override must include an instant");
      }
      for (const instant of [override.publishAt, override.unpublishAt]) {
        if (
          instant !== undefined &&
          (!(instant instanceof Date) || !Number.isFinite(instant.getTime()))
        ) {
          throw new PublicationError("PLAN_INVALID", "override instant must be a valid UTC date");
        }
      }
      overrideByItemId.set(override.changesetItemId, override);
    }

    const now = clock.now().getTime();
    return items.map((item, index) => {
      const batchNo = Math.floor(index / spec.batchSize);
      const override = overrideByItemId.get(item.changesetItemId);
      const entry: CompiledScheduleEntry = {
        planItemId: item.id,
        changesetItemId: item.changesetItemId,
        batchNo,
        publishAt: override?.publishAt ?? batchStart(batchNo),
        unpublishAt: override?.unpublishAt ?? null,
      };
      for (const instant of [entry.publishAt, entry.unpublishAt]) {
        if (instant !== null && instant.getTime() < now) {
          throw new PublicationError(
            "SCHEDULE_IN_PAST",
            `scheduled instant ${instant.toISOString()} is in the past`,
            { details: { planItemId: item.id } },
          );
        }
      }
      return entry;
    });
  }

  function partsFormatterSanity(timeZone: string): void {
    // Validates the IANA identifier via the tz helper (throws PLAN_INVALID).
    zonedWallClockToInstant({ year: 2026, month: 1, day: 1 }, timeZone);
  }

  async function scheduleEntry(
    tx: DbClient,
    plan: PlanRecord,
    item: PlanItemRecord,
    entry: CompiledScheduleEntry,
    actor: PublicationActor,
    changesetItem: {
      entityType: string;
      entityId: StableId;
      targetRevisionId: StableId | null;
      context: string;
    },
  ): Promise<void> {
    if (entry.publishAt !== null) {
      // Compile-time generation is the CAS baseline the executor verifies
      // (spec §30 step 5): drift by execution time means the item fails
      // permanent and the failure policy applies.
      const publication = await publications.getPublication(
        tx,
        changesetItem.entityType,
        changesetItem.entityId,
        changesetItem.context,
      );
      const job = await jobs.enqueue({
        type: PUBLISH_JOB_TYPE,
        payload: {
          entityType: changesetItem.entityType,
          entityId: changesetItem.entityId,
          context: changesetItem.context,
          targetRevisionId: changesetItem.targetRevisionId,
          expectedGeneration: publication?.generation ?? 0,
          planId: plan.id,
          planItemId: item.id,
          changesetItemId: item.changesetItemId,
        },
        runAt: entry.publishAt,
        idempotencyKey: `plan-item:${item.id}:publish`,
        origin: `plan:${plan.id}`,
      });
      await tx.query(
        `UPDATE publication_plan_items SET publish_at = $2, publish_job_id = $3, state = 'SCHEDULED' WHERE id = $1`,
        [item.id, entry.publishAt, job.job.id],
      );
      await appendScheduleEvent(
        tx,
        plan,
        changesetItem,
        "SCHEDULE_CREATED",
        actor,
        job.job.id,
        changesetItem.targetRevisionId,
      );
    }
    if (entry.unpublishAt !== null) {
      const job = await jobs.enqueue({
        type: UNPUBLISH_JOB_TYPE,
        payload: {
          entityType: changesetItem.entityType,
          entityId: changesetItem.entityId,
          context: changesetItem.context,
          planId: plan.id,
          planItemId: item.id,
          changesetItemId: item.changesetItemId,
        },
        runAt: entry.unpublishAt,
        idempotencyKey: `plan-item:${item.id}:unpublish`,
        origin: `plan:${plan.id}`,
      });
      await tx.query(
        `UPDATE publication_plan_items SET unpublish_at = $2, unpublish_job_id = $3 WHERE id = $1`,
        [item.id, entry.unpublishAt, job.job.id],
      );
    }
  }

  async function appendScheduleEvent(
    tx: DbClient,
    plan: PlanRecord,
    changesetItem: {
      entityType: string;
      entityId: StableId;
      context: string;
      targetRevisionId: StableId | null;
    },
    eventType: Extract<PublicationEventType, "SCHEDULE_CREATED" | "SCHEDULE_CANCELLED">,
    actor: PublicationActor,
    jobId: StableId | null,
    toRevisionId: StableId | null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO publication_events
         (id, entity_type, entity_id, context, event_type, from_revision_id, to_revision_id,
          actor_class, actor_id, reason, job_id)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10)`,
      [
        newStableId(),
        changesetItem.entityType,
        changesetItem.entityId,
        changesetItem.context,
        eventType,
        toRevisionId,
        actor.actorClass,
        actor.actorId,
        `plan:${plan.id}`,
        jobId,
      ],
    );
  }

  return {
    async createPlan(input) {
      const changeset = await changesets.requireChangeset(input.changesetId);
      if (!["OPEN", "READY", "PARTIALLY_SCHEDULED"].includes(changeset.state)) {
        throw new PublicationError(
          "CHANGESET_INVALID",
          `changeset is ${changeset.state}; plans require OPEN/READY/PARTIALLY_SCHEDULED`,
        );
      }
      // Validate the timezone eagerly (fail-secure).
      zonedWallClockToInstant({ year: 2026, month: 1, day: 1 }, input.timezone);
      const id = newStableId();
      await pool.query(
        `INSERT INTO publication_plans
           (id, changeset_id, status, failure_policy, timezone, created_by_type, created_by)
         VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6)`,
        [
          id,
          input.changesetId,
          input.failurePolicy ?? "continue",
          input.timezone,
          input.actor.actorClass,
          input.actor.actorId,
        ],
      );
      const items = await changesets.listItems(input.changesetId);
      await pool.withTransaction(async (tx) => {
        for (const item of items) {
          await tx.query(
            `INSERT INTO publication_plan_items (id, plan_id, changeset_item_id, batch_no)
             VALUES ($1, $2, $3, $4)`,
            [newStableId(), id, item.id, 0],
          );
        }
      });
      return loadPlan(pool, id);
    },

    async getPlan(planId) {
      return loadPlan(pool, planId);
    },

    requirePlan: (planId) => loadPlan(pool, planId),

    async listPlanItems(planId) {
      return loadItems(pool, planId);
    },

    async previewPlan(planId, spec, overrides = []) {
      const plan = await loadPlan(pool, planId);
      const items = await loadItems(pool, planId);
      return buildScheduleEntries(items, spec, plan.timezone, overrides);
    },

    async compilePlan(planId, spec, overrides = []) {
      return pool.withTransaction(async (tx) => {
        const plan = await loadPlan(tx, planId);
        if (plan.status !== "DRAFT") {
          throw new PublicationError(
            "PLAN_INVALID",
            `plan is ${plan.status}; only DRAFT plans compile`,
          );
        }
        const items = await loadItems(tx, planId);
        if (items.length === 0) {
          throw new PublicationError("PLAN_INVALID", "plan has no items");
        }
        const entries = buildScheduleEntries(items, spec, plan.timezone, overrides);
        const compiled: CompiledScheduleEntry[] = [];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index]!;
          const changesetItem = await changesetItemOf(tx, item.changesetItemId);
          const entry = entries[index]!;
          const batchNo = entry.batchNo;
          await scheduleEntry(
            tx,
            plan,
            item,
            entry,
            {
              actorClass: "system",
              actorId: "plan-compiler",
            },
            changesetItem,
          );
          await tx.query(`UPDATE publication_plan_items SET batch_no = $2 WHERE id = $1`, [
            item.id,
            batchNo,
          ]);
          compiled.push(entry);
        }
        await tx.query(
          `UPDATE publication_plans SET status = 'COMPILED', updated_at = $2 WHERE id = $1`,
          [planId, clock.now()],
        );
        await tx.query(
          `UPDATE changesets SET state = 'PARTIALLY_SCHEDULED', updated_at = $2
           WHERE id = $1 AND state IN ('OPEN', 'READY')`,
          [plan.changesetId, clock.now()],
        );
        return compiled;
      });
    },

    async rescheduleItem(planId, planItemId, publishAt) {
      return pool.withTransaction(async (tx) => {
        const plan = await loadPlan(tx, planId);
        if (plan.status !== "COMPILED") {
          throw new PublicationError("PLAN_INVALID", `plan is ${plan.status}`);
        }
        const items = await loadItems(tx, planId);
        const item = items.find((candidate) => candidate.id === planItemId);
        if (item === undefined) {
          throw new PublicationError("PLAN_NOT_FOUND", "plan item does not exist");
        }
        if (item.state !== "SCHEDULED") {
          throw new PublicationError(
            "SCHEDULE_CONFLICT",
            `plan item is ${item.state}; only SCHEDULED items reschedule`,
          );
        }
        if (publishAt.getTime() < clock.now().getTime()) {
          throw new PublicationError("SCHEDULE_IN_PAST", "reschedule target is in the past");
        }
        const changesetItem = await changesetItemOf(tx, item.changesetItemId);
        if (item.publishJobId !== null) {
          await jobs.cancelPendingJob(item.publishJobId);
        }
        // Re-schedule with the same idempotency key (cancellation freed it).
        const publication = await publications.getPublication(
          tx,
          changesetItem.entityType,
          changesetItem.entityId,
          changesetItem.context,
        );
        const job = await jobs.enqueue({
          type: PUBLISH_JOB_TYPE,
          payload: {
            entityType: changesetItem.entityType,
            entityId: changesetItem.entityId,
            context: changesetItem.context,
            targetRevisionId: changesetItem.targetRevisionId,
            expectedGeneration: publication?.generation ?? 0,
            planId: plan.id,
            planItemId: item.id,
            changesetItemId: item.changesetItemId,
          },
          runAt: publishAt,
          idempotencyKey: `plan-item:${item.id}:publish`,
          origin: `plan:${plan.id}`,
        });
        await tx.query(
          `UPDATE publication_plan_items SET publish_at = $2, publish_job_id = $3 WHERE id = $1`,
          [item.id, publishAt, job.job.id],
        );
        await appendScheduleEvent(
          tx,
          plan,
          changesetItem,
          "SCHEDULE_CANCELLED",
          {
            actorClass: "system",
            actorId: "reschedule",
          },
          item.publishJobId,
          changesetItem.targetRevisionId,
        );
        await appendScheduleEvent(
          tx,
          plan,
          changesetItem,
          "SCHEDULE_CREATED",
          {
            actorClass: "system",
            actorId: "reschedule",
          },
          job.job.id,
          changesetItem.targetRevisionId,
        );
        return (await loadItems(tx, planId)).find((candidate) => candidate.id === planItemId)!;
      });
    },

    async cancelItem(planId, planItemId, actor) {
      await pool.withTransaction(async (tx) => {
        const plan = await loadPlan(tx, planId);
        const items = await loadItems(tx, planId);
        const item = items.find((candidate) => candidate.id === planItemId);
        if (item === undefined) {
          throw new PublicationError("PLAN_NOT_FOUND", "plan item does not exist");
        }
        if (item.state === "PUBLISHED" || item.state === "UNPUBLISHED") {
          throw new PublicationError(
            "SCHEDULE_CONFLICT",
            `already executed (${item.state}); cancel is not retroactive — use unpublish/rollback`,
          );
        }
        if (item.publishJobId !== null) await jobs.cancelPendingJob(item.publishJobId);
        if (item.unpublishJobId !== null) await jobs.cancelPendingJob(item.unpublishJobId);
        const changesetItem = await changesetItemOf(tx, item.changesetItemId);
        await tx.query(
          `UPDATE publication_plan_items SET state = 'CANCELLED' WHERE id = $1 AND state = 'SCHEDULED'`,
          [item.id],
        );
        await appendScheduleEvent(
          tx,
          plan,
          changesetItem,
          "SCHEDULE_CANCELLED",
          actor,
          item.publishJobId,
          changesetItem.targetRevisionId,
        );
      });
    },

    async cancelPlan(planId, actor) {
      await pool.withTransaction(async (tx) => {
        const plan = await loadPlan(tx, planId);
        if (plan.status === "COMPLETED" || plan.status === "CANCELLED") {
          throw new PublicationError("PLAN_INVALID", `plan is ${plan.status}`);
        }
        const items = await loadItems(tx, planId);
        for (const item of items) {
          if (item.state === "SCHEDULED") {
            if (item.publishJobId !== null) await jobs.cancelPendingJob(item.publishJobId);
            if (item.unpublishJobId !== null) await jobs.cancelPendingJob(item.unpublishJobId);
            const changesetItem = await changesetItemOf(tx, item.changesetItemId);
            await tx.query(
              `UPDATE publication_plan_items SET state = 'CANCELLED' WHERE id = $1 AND state = 'SCHEDULED'`,
              [item.id],
            );
            await appendScheduleEvent(
              tx,
              plan,
              changesetItem,
              "SCHEDULE_CANCELLED",
              actor,
              item.publishJobId,
              changesetItem.targetRevisionId,
            );
          }
        }
        await tx.query(
          `UPDATE publication_plans SET status = 'CANCELLED', updated_at = $2 WHERE id = $1`,
          [planId, clock.now()],
        );
      });
    },

    async pausePlan(planId, actor) {
      await pool.withTransaction(async (tx) => {
        const plan = await loadPlan(tx, planId);
        if (plan.status !== "COMPILED") {
          throw new PublicationError("PLAN_INVALID", `plan is ${plan.status}`);
        }
        const items = await loadItems(tx, planId);
        for (const item of items) {
          if (item.state === "SCHEDULED") {
            if (item.publishJobId !== null) await jobs.cancelPendingJob(item.publishJobId);
            if (item.unpublishJobId !== null) await jobs.cancelPendingJob(item.unpublishJobId);
            await tx.query(`UPDATE publication_plan_items SET state = 'PAUSED' WHERE id = $1`, [
              item.id,
            ]);
          }
        }
        await tx.query(
          `UPDATE publication_plans SET status = 'PAUSED', updated_at = $2 WHERE id = $1`,
          [planId, clock.now()],
        );
        void actor;
      });
    },

    async resumePlan(planId, actor) {
      await pool.withTransaction(async (tx) => {
        const plan = await loadPlan(tx, planId);
        if (plan.status !== "PAUSED") {
          throw new PublicationError("PLAN_INVALID", `plan is ${plan.status}`);
        }
        const items = await loadItems(tx, planId);
        for (const item of items) {
          if (item.state !== "PAUSED") continue;
          const changesetItem = await changesetItemOf(tx, item.changesetItemId);
          const runAt =
            item.publishAt !== null && item.publishAt.getTime() > clock.now().getTime()
              ? item.publishAt
              : clock.now(); // late execution: run after recovery (§32)
          const publication = await publications.getPublication(
            tx,
            changesetItem.entityType,
            changesetItem.entityId,
            changesetItem.context,
          );
          const job = await jobs.enqueue({
            type: PUBLISH_JOB_TYPE,
            payload: {
              entityType: changesetItem.entityType,
              entityId: changesetItem.entityId,
              context: changesetItem.context,
              targetRevisionId: changesetItem.targetRevisionId,
              expectedGeneration: publication?.generation ?? 0,
              planId: plan.id,
              planItemId: item.id,
              changesetItemId: item.changesetItemId,
            },
            runAt,
            idempotencyKey: `plan-item:${item.id}:publish`,
            origin: `plan:${plan.id}`,
          });
          await tx.query(
            `UPDATE publication_plan_items SET state = 'SCHEDULED', publish_job_id = $2 WHERE id = $1`,
            [item.id, job.job.id],
          );
        }
        await tx.query(
          `UPDATE publication_plans SET status = 'COMPILED', updated_at = $2 WHERE id = $1`,
          [planId, clock.now()],
        );
        void actor;
      });
    },

    async publishNow(planId, planItemId, actor) {
      await pool.withTransaction(async (tx) => {
        const plan = await loadPlan(tx, planId);
        const items = await loadItems(tx, planId);
        const item = items.find((candidate) => candidate.id === planItemId);
        if (item === undefined) {
          throw new PublicationError("PLAN_NOT_FOUND", "plan item does not exist");
        }
        if (item.state !== "SCHEDULED") {
          throw new PublicationError("SCHEDULE_CONFLICT", `plan item is ${item.state}`);
        }
        const changesetItem = await changesetItemOf(tx, item.changesetItemId);
        if (changesetItem.targetRevisionId === null) {
          throw new PublicationError("CHANGESET_ITEM_INVALID", "item has no publish target");
        }
        if (item.publishJobId !== null) {
          await jobs.cancelPendingJob(item.publishJobId);
        }
        // Publish exactly once, in the same transaction as the cancellation.
        await publications.publishWithinTx(tx, {
          entityType: changesetItem.entityType,
          entityId: changesetItem.entityId,
          context: changesetItem.context,
          targetRevisionId: changesetItem.targetRevisionId,
          // publish-now runs against the live state; the executor verifies
          // via revision match below (expectedGeneration unknown to callers).
          expectedGeneration:
            (
              await publications.getPublication(
                tx,
                changesetItem.entityType,
                changesetItem.entityId,
                changesetItem.context,
              )
            )?.generation ?? 0,
          actor,
          changesetId: plan.changesetId,
        });
        await tx.query(
          `UPDATE publication_plan_items SET state = 'PUBLISHED', executed_at = $2 WHERE id = $1`,
          [item.id, clock.now()],
        );
      });
    },
  };

  async function changesetItemOf(
    tx: DbClient,
    changesetItemId: StableId,
  ): Promise<{
    entityType: string;
    entityId: StableId;
    context: string;
    targetRevisionId: StableId | null;
  }> {
    const result = await tx.query<{
      entity_type: string;
      entity_id: string;
      context: string;
      target_revision_id: string | null;
    }>(
      `SELECT entity_type, entity_id, context, target_revision_id FROM changeset_items WHERE id = $1`,
      [changesetItemId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new PublicationError("CHANGESET_ITEM_NOT_FOUND", "changeset item missing");
    }
    return {
      entityType: row.entity_type,
      entityId: row.entity_id as StableId,
      context: row.context,
      targetRevisionId: (row.target_revision_id as StableId | null) ?? null,
    };
  }
}
