// Extension schedule service (D06): periodic trusted extension jobs.
//
// A manifest job registration may declare `interval_seconds`; the Core worker
// re-enqueues that job once per interval window. Execution rides the shared
// M07 queue — no second queue, no scheduler process.
//
// Two distinct guarantees:
//
// 1. EVERY INTERVAL IS ITS OWN RUN. The queue treats an idempotency key as
//    "one active/succeeded job forever", so a single constant key would make
//    the second interval return JOB_ALREADY_COMPLETED and the schedule would
//    silently stop after its first success. The key carries the interval
//    bucket: `extschedule:<ext>/<job>:<floor(now/interval)>`.
// 2. ONE LOGICAL TASK IN FLIGHT, ATOMICALLY. `JobsService.enqueueRecurring`
//    checks for a PENDING/RUNNING run of the same job TYPE (every window, so a
//    run longer than several intervals stays visible) and inserts the new one
//    under a single transaction-scoped advisory lock. Two schedulers on an
//    interval boundary cannot both enqueue, and no window arithmetic can hide
//    a long-running task.
//
// A worker restart resets the in-memory last-run clock; `enqueueRecurring`
// keeps that harmless. No exactly-once guarantee is promised — handlers must
// be idempotent.
//
// Nothing is scheduled for extensions that do not declare a schedule, so a
// CMS without such an extension gets no new background activity.

import type { ExtensionCatalog } from "@pcms/extensions/internal";
import type { JobRecord } from "@pcms/jobs";

export interface ExtensionScheduleServiceDeps {
  readonly jobs: {
    /**
     * Atomic recurring enqueue: checks that no run of this logical task is in
     * flight and inserts the new one under one advisory lock, so a schedule
     * can never be doubled by another worker or by a run that outlives
     * several intervals.
     */
    enqueueRecurring(input: {
      readonly type: string;
      readonly payload: unknown;
      readonly idempotencyKey?: string;
      readonly runAt?: Date;
      readonly maxAttempts?: number;
      readonly origin?: string;
      readonly payloadVersion?: number;
    }): Promise<
      | { readonly outcome: "enqueued"; readonly job: JobRecord }
      | { readonly outcome: "active"; readonly job: JobRecord }
      | { readonly outcome: "already_completed"; readonly job: JobRecord }
      | { readonly outcome: "busy" }
    >;
  };
  /** Trusted deployed artifacts (composition-time). */
  readonly catalog: ExtensionCatalog;
  readonly enabledIds: () => Promise<readonly string[]>;
  readonly clock: { now(): Date };
}

export interface EnqueueDueResult {
  readonly enqueued: number;
  /** Intervals skipped: a run of this logical task is still in flight (any
   * window), this window already ran, or another scheduler held the lock. */
  readonly skipped: number;
}

export function createExtensionScheduleService(deps: ExtensionScheduleServiceDeps) {
  // Last enqueue instant per schedule key (extensionId/jobId), so a 5s poll
  // does not re-evaluate the same window. In-memory by design: a restart
  // re-evaluates once, and enqueueRecurring keeps it idempotent.
  const lastRun = new Map<string, Date>();

  async function enqueueDue(): Promise<EnqueueDueResult> {
    let enqueued = 0;
    let skipped = 0;
    const now = deps.clock.now();
    const enabled = await deps.enabledIds();
    const enabledSet = new Set(enabled);
    for (const artifact of deps.catalog.list()) {
      const manifest = artifact.manifest;
      if (!enabledSet.has(manifest.id)) continue;
      for (const job of manifest.registrations.jobs) {
        const interval = job.interval_seconds;
        if (interval === undefined || interval < 1) continue;
        const scheduleKey = `${manifest.id}/${job.job_id}`;
        const last = lastRun.get(scheduleKey) ?? new Date(0);
        if (now.getTime() - last.getTime() < interval * 1_000) continue;

        const intervalMs = interval * 1_000;
        const bucket = Math.floor(now.getTime() / intervalMs);

        // One call decides and writes atomically: the active-run check spans
        // ALL windows (a long run stays visible) and the insert shares the
        // advisory lock, so two schedulers cannot both enqueue.
        const result = await deps.jobs.enqueueRecurring({
          type: scheduleKey,
          payload: null,
          idempotencyKey: `extschedule:${scheduleKey}:${bucket}`,
          runAt: now,
          maxAttempts: 5,
          origin: `extension-schedule:${scheduleKey}`,
          payloadVersion: job.payload_version,
        });
        lastRun.set(scheduleKey, now);
        if (result.outcome === "enqueued") enqueued += 1;
        else skipped += 1;
      }
    }
    return { enqueued, skipped };
  }

  return { enqueueDue };
}
