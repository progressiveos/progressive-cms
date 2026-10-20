// Machine discovery (PCMS-PUB-T028, spec §68/§70): JSON-serializable
// ChangeSet and publication-plan/calendar operations with deterministic
// descriptors. Discovery only — no REST/MCP/CLI transport (M09), no Admin
// UI (M10). Revision discovery lives in @pcms/revisions.
import type { StableId } from "@pcms/core";
import type { CalendarEntry, PublicationCalendarService } from "./calendar.js";
import type { ChangeSetService, PreflightReport } from "./changesets.js";
import type { PublicationPlanService } from "./plans.js";
import type { PublicationActor } from "./types.js";

export interface DiscoveryOperation {
  readonly name: string;
  /** Permission key from the M08 registry (structural string). */
  readonly permission: string;
  readonly input: readonly string[];
  readonly output: readonly string[];
}

export interface DiscoveryDescriptor {
  readonly family: string;
  readonly description: string;
  readonly operations: readonly DiscoveryOperation[];
}

function record(value: unknown, omit: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (omit.includes(key)) continue;
    out[key] = member instanceof Date ? member.toISOString() : member !== undefined ? member : null;
  }
  return out;
}

export interface ChangeSetDiscovery {
  describe(): DiscoveryDescriptor;
  create_changeset(input: {
    title: string;
    actor: PublicationActor;
  }): Promise<Record<string, unknown>>;
  add_item(input: {
    changesetId: StableId;
    item: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  remove_item(input: { changesetId: StableId; itemId: StableId }): Promise<Record<string, unknown>>;
  validate_changeset(input: { changesetId: StableId }): Promise<PreflightReport>;
  preview_changeset(input: { changesetId: StableId }): Promise<Record<string, unknown>>;
  apply_changeset(input: {
    changesetId: StableId;
    actor: PublicationActor;
  }): Promise<Record<string, unknown>>;
  cancel_changeset(input: {
    changesetId: StableId;
    actor: PublicationActor;
    reason?: string;
  }): Promise<Record<string, unknown>>;
}

export interface PublicationPlanDiscovery {
  describe(): DiscoveryDescriptor;
  list_publication_calendar(
    input: Parameters<PublicationCalendarService["listCalendar"]>[0],
  ): Promise<readonly CalendarEntry[]>;
  create_publication_plan(input: {
    changesetId: StableId;
    timezone: string;
    failurePolicy?: "continue" | "pause_batch" | "pause_plan";
    actor: PublicationActor;
  }): Promise<Record<string, unknown>>;
  preview_plan(input: {
    planId: StableId;
    spec: Parameters<PublicationPlanService["previewPlan"]>[1];
  }): Promise<readonly Record<string, unknown>[]>;
  apply_plan(input: {
    planId: StableId;
    spec: Parameters<PublicationPlanService["compilePlan"]>[1];
    overrides?: Parameters<PublicationPlanService["compilePlan"]>[2];
  }): Promise<readonly Record<string, unknown>[]>;
  reschedule_item(input: {
    planId: StableId;
    planItemId: StableId;
    publishAt: Date;
  }): Promise<Record<string, unknown>>;
  cancel_scheduled_item(input: {
    planId: StableId;
    planItemId: StableId;
    actor: PublicationActor;
  }): Promise<Record<string, unknown>>;
  publish_now(input: {
    planId: StableId;
    planItemId: StableId;
    actor: PublicationActor;
  }): Promise<Record<string, unknown>>;
}

export function createChangeSetsDiscovery(changesets: ChangeSetService): ChangeSetDiscovery {
  const descriptor: DiscoveryDescriptor = {
    family: "changesets",
    description:
      "ChangeSet (Release) authoring, validation and atomic apply (Publication spec §70)",
    operations: [
      {
        name: "create_changeset",
        permission: "publication.plan",
        input: ["title", "actor"],
        output: ["ChangeSetRecord"],
      },
      {
        name: "add_item",
        permission: "publication.plan",
        input: ["changesetId", "item"],
        output: ["ChangeSetItemRecord"],
      },
      {
        name: "remove_item",
        permission: "publication.plan",
        input: ["changesetId", "itemId"],
        output: ["void"],
      },
      {
        name: "validate_changeset",
        permission: "publication.read",
        input: ["changesetId"],
        output: ["PreflightReport"],
      },
      {
        name: "preview_changeset",
        permission: "publication.read",
        input: ["changesetId"],
        output: ["items[]"],
      },
      {
        name: "apply_changeset",
        permission: "publication.publish",
        input: ["changesetId", "actor"],
        output: ["ChangeSetItemRecord[]"],
      },
      {
        name: "cancel_changeset",
        permission: "publication.plan",
        input: ["changesetId", "actor"],
        output: ["ChangeSetRecord"],
      },
    ],
  };
  return {
    describe: () => descriptor,
    async create_changeset(input) {
      return record(await changesets.createChangeset(input));
    },
    async add_item(input) {
      return record(await changesets.addItem(input.changesetId, input.item as never));
    },
    async remove_item(input) {
      await changesets.removeItem(input.changesetId, input.itemId);
      return { removed: input.itemId };
    },
    async validate_changeset(input) {
      return changesets.preflight(input.changesetId);
    },
    async preview_changeset(input) {
      const items = await changesets.listItems(input.changesetId);
      return { changesetId: input.changesetId, items: items.map((item) => record(item)) };
    },
    async apply_changeset(input) {
      const applied = await changesets.apply(input.changesetId, { actor: input.actor });
      return { changesetId: input.changesetId, applied: applied.map((item) => record(item)) };
    },
    async cancel_changeset(input) {
      return record(await changesets.cancel(input.changesetId, input.actor, input.reason));
    },
  };
}

export function createPublicationPlansDiscovery(deps: {
  readonly plans: PublicationPlanService;
  readonly calendar: PublicationCalendarService;
}): PublicationPlanDiscovery {
  const { plans, calendar } = deps;
  const descriptor: DiscoveryDescriptor = {
    family: "publication-plans",
    description: "Publication calendar, plans and scheduling actions (Publication spec §68)",
    operations: [
      {
        name: "list_publication_calendar",
        permission: "publication.read",
        input: ["from?", "to?", "limit?", "offset?"],
        output: ["CalendarEntry[]"],
      },
      {
        name: "create_publication_plan",
        permission: "publication.plan",
        input: ["changesetId", "timezone", "failurePolicy?", "actor"],
        output: ["PlanRecord"],
      },
      {
        name: "preview_plan",
        permission: "publication.read",
        input: ["planId", "spec"],
        output: ["CompiledScheduleEntry[]"],
      },
      {
        name: "apply_plan",
        permission: "publication.schedule",
        input: ["planId", "spec", "overrides?"],
        output: ["CompiledScheduleEntry[]"],
      },
      {
        name: "reschedule_item",
        permission: "publication.schedule",
        input: ["planId", "planItemId", "publishAt"],
        output: ["PlanItemRecord"],
      },
      {
        name: "cancel_scheduled_item",
        permission: "publication.schedule",
        input: ["planId", "planItemId", "actor"],
        output: ["void"],
      },
      {
        name: "publish_now",
        permission: "publication.publish",
        input: ["planId", "planItemId", "actor"],
        output: ["void"],
      },
    ],
  };
  return {
    describe: () => descriptor,
    list_publication_calendar: (input) => calendar.listCalendar(input),
    async create_publication_plan(input) {
      return record(await plans.createPlan(input));
    },
    async preview_plan(input) {
      return (await plans.previewPlan(input.planId, input.spec)).map((entry) => record(entry));
    },
    async apply_plan(input) {
      return (await plans.compilePlan(input.planId, input.spec, input.overrides)).map((entry) =>
        record(entry),
      );
    },
    async reschedule_item(input) {
      return record(await plans.rescheduleItem(input.planId, input.planItemId, input.publishAt));
    },
    async cancel_scheduled_item(input) {
      await plans.cancelItem(input.planId, input.planItemId, input.actor);
      return { cancelled: input.planItemId };
    },
    async publish_now(input) {
      await plans.publishNow(input.planId, input.planItemId, input.actor);
      return { published: input.planItemId };
    },
  };
}
