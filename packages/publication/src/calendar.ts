// Publication calendar application services (PCMS-PUB-T027, spec §37/§68).
// Range-bounded, paginated, deterministic; actions delegate to the plan
// service. No Admin UI here (M10) and no transport (M09).
import type { Clock, DbPool, StableId } from "@pcms/core";
import { PublicationError } from "./errors.js";
import type { PlanItemRecord, PlanRecord, PublicationPlanService } from "./plans.js";
import type { PublicationActor } from "./types.js";

export const MAX_CALENDAR_RANGE_DAYS = 366;
export const MAX_CALENDAR_PAGE_SIZE = 500;

export interface CalendarEntry {
  readonly planId: StableId;
  readonly planItemId: StableId;
  readonly changesetId: StableId;
  /** Release grouping (spec §37). */
  readonly changesetTitle: string;
  readonly entityType: string;
  readonly entityId: StableId;
  readonly context: string;
  /** "scheduled-publish" | "scheduled-unpublish" | "failed" | "cancelled" | "paused" */
  readonly kind: string;
  readonly instant: Date | null;
  readonly state: string;
  readonly lastError: string | null;
}

export interface PublicationCalendarService {
  /** Deterministic (instant, planItemId) ordering; both bounds optional but
   * the span is capped (MAX_CALENDAR_RANGE_DAYS) and pages bounded. */
  listCalendar(input: {
    readonly from?: Date;
    readonly to?: Date;
    readonly limit?: number;
    readonly offset?: number;
    readonly includeCancelled?: boolean;
  }): Promise<readonly CalendarEntry[]>;
  rescheduleItem(input: { planId: StableId; planItemId: StableId; publishAt: Date }): Promise<void>;
  cancelScheduledItem(input: {
    planId: StableId;
    planItemId: StableId;
    actor: PublicationActor;
  }): Promise<void>;
  publishNow(input: {
    planId: StableId;
    planItemId: StableId;
    actor: PublicationActor;
  }): Promise<void>;
  inspect(input: { planId: StableId; planItemId?: StableId }): Promise<{
    readonly plan: PlanRecord;
    readonly items: readonly PlanItemRecord[];
  }>;
}

interface CalendarRow {
  [column: string]: unknown;
  plan_id: string;
  plan_item_id: string;
  changeset_id: string;
  changeset_title: string;
  entity_type: string;
  entity_id: string;
  context: string;
  instant: Date | null;
  publish_at: Date | null;
  item_state: string;
  last_error: string | null;
}

function toEntry(row: CalendarRow): CalendarEntry {
  const state = row.item_state as string;
  let kind: string;
  if (state === "FAILED") kind = "failed";
  else if (state === "CANCELLED") kind = "cancelled";
  else if (state === "PAUSED") kind = "paused";
  else if (row.instant !== null && row.instant.getTime() === row.publish_at?.getTime()) {
    kind = "scheduled-publish";
  } else kind = "scheduled-unpublish";
  return {
    planId: row.plan_id as StableId,
    planItemId: row.plan_item_id as StableId,
    changesetId: row.changeset_id as StableId,
    changesetTitle: row.changeset_title,
    entityType: row.entity_type,
    entityId: row.entity_id as StableId,
    context: row.context,
    kind,
    instant: row.instant,
    state,
    lastError: row.last_error,
  };
}

export function createPublicationCalendarService(
  pool: DbPool,
  deps: {
    readonly clock: Clock;
    readonly plans: PublicationPlanService;
  },
): PublicationCalendarService {
  return {
    async listCalendar(input) {
      const now = deps.clock.now();
      const half = Math.floor((MAX_CALENDAR_RANGE_DAYS / 2) * 86_400_000);
      const from = input.from ?? new Date(now.getTime() - half);
      const to = input.to ?? new Date(now.getTime() + half);
      if (to.getTime() - from.getTime() > MAX_CALENDAR_RANGE_DAYS * 86_400_000) {
        throw new PublicationError(
          "PLAN_INVALID",
          `calendar range exceeds ${MAX_CALENDAR_RANGE_DAYS} days`,
        );
      }
      const limit = Math.min(input.limit ?? 100, MAX_CALENDAR_PAGE_SIZE);
      const offset = Math.max(input.offset ?? 0, 0);
      const result = await pool.query<CalendarRow>(
        `SELECT i.plan_id, i.id AS plan_item_id, p.changeset_id, c.title AS changeset_title,
                ci.entity_type, ci.entity_id, ci.context,
                COALESCE(i.publish_at, i.unpublish_at) AS instant,
                i.publish_at,
                i.state AS item_state, i.last_error
         FROM publication_plan_items i
         JOIN publication_plans p ON p.id = i.plan_id
         JOIN changesets c ON c.id = p.changeset_id
         JOIN changeset_items ci ON ci.id = i.changeset_item_id
         WHERE p.status IN ('COMPILED', 'PAUSED')
           AND COALESCE(i.publish_at, i.unpublish_at) IS NOT NULL
           AND COALESCE(i.publish_at, i.unpublish_at) BETWEEN $1 AND $2
           AND (i.state IN ('SCHEDULED', 'FAILED', 'PAUSED') OR ($3::boolean AND i.state = 'CANCELLED'))
         ORDER BY instant, plan_item_id
         LIMIT $4 OFFSET $5`,
        [from, to, input.includeCancelled ?? false, limit, offset],
      );
      return result.rows.map(toEntry);
    },

    async rescheduleItem({ planId, planItemId, publishAt }) {
      await deps.plans.rescheduleItem(planId, planItemId, publishAt);
    },

    async cancelScheduledItem({ planId, planItemId, actor }) {
      await deps.plans.cancelItem(planId, planItemId, actor);
    },

    async publishNow({ planId, planItemId, actor }) {
      await deps.plans.publishNow(planId, planItemId, actor);
    },

    async inspect({ planId, planItemId }) {
      const plan = await deps.plans.getPlan(planId);
      const items = await deps.plans.listPlanItems(planId);
      return {
        plan,
        items:
          planItemId === undefined ? [...items] : items.filter((item) => item.id === planItemId),
      };
    },
  };
}
