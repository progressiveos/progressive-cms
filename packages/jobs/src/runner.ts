// Job runner loop (PCMS-PUB-T018): claim → execute → record, with bounded
// batches and graceful shutdown. The worker composition root (apps/worker)
// instantiates this with a handler registry — this package never imports
// publication or any other subsystem (owner instruction #44).
import { type Clock, newStableId, type StableId } from "@pcms/core";
import type { JobErrorKind, JobHandler, JobsService } from "./store.js";

export interface JobRunnerOptions {
  readonly workerId?: string;
  readonly pollIntervalMilliseconds: number;
  readonly claimBatchMax: number;
  readonly leaseMilliseconds: number;
  /** Runs one tick immediately at start (tests: deterministic first pass). */
  readonly runImmediately?: boolean;
}

export interface JobRunner {
  start(): void;
  /** Stops claiming; waits (bounded by `timeoutMilliseconds`) for in-flight
   * jobs. True when drained in time. */
  stop(timeoutMilliseconds: number): Promise<boolean>;
  readonly inFlight: () => number;
}

export function createJobRunner(
  jobs: JobsService,
  handlers: Readonly<Record<string, JobHandler>>,
  deps: {
    readonly clock: Clock;
    readonly onWorkerError?: (error: unknown) => void;
    readonly onJobDone?: (info: {
      readonly jobId: string;
      readonly type: string;
      readonly outcome:
        | "succeeded"
        | "retried"
        | "dead"
        | "parked"
        | "cancelled"
        | "unknown-handler";
    }) => void;
  },
  options: JobRunnerOptions,
): JobRunner {
  const workerId = options.workerId ?? `worker-${newStableId().slice(0, 8)}`;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = true;
  let inFlightCount = 0;
  /** IDs of claimed jobs whose handler is still running (lease heartbeat set). */
  const inFlightIds = new Set<string>();

  /**
   * Worker-error surface that cannot take the loop down: a throwing
   * `onWorkerError` must never escape into the tick chain (it would kill the
   * poll loop, leaving a "healthy zombie" worker) — fall back to stderr.
   */
  function reportWorkerError(error: unknown): void {
    try {
      deps.onWorkerError?.(error);
    } catch (reportingError) {
      process.stderr.write(`pcms:jobs onWorkerError threw: ${String(reportingError)}\n`);
    }
  }

  async function execute(job: {
    readonly id: StableId;
    readonly type: string;
    readonly payload: unknown;
    readonly attempts: number;
    readonly maxAttempts: number;
  }): Promise<void> {
    inFlightCount += 1;
    inFlightIds.add(job.id as string);
    try {
      const handler = handlers[job.type];
      if (handler === undefined) {
        // Unknown job types are a permanent misconfiguration, never retried.
        await jobs.fail(job.id, "permanent", new Error(`no handler registered for "${job.type}"`));
        deps.onJobDone?.({ jobId: job.id as string, type: job.type, outcome: "unknown-handler" });
        return;
      }
      let outcome: Awaited<ReturnType<JobHandler>>;
      try {
        outcome = await handler(job.payload, { job: job as never, attempt: job.attempts });
      } catch (error) {
        outcome = "transient"; // thrown errors are retryable by contract
        await jobs.fail(job.id, "transient", error);
        deps.onJobDone?.({ jobId: job.id as string, type: job.type, outcome: "retried" });
        return;
      }
      if (
        outcome !== undefined &&
        outcome !== null &&
        typeof outcome === "object" &&
        "outcome" in outcome
      ) {
        const classified = outcome as {
          outcome: "permanent" | "parked";
          error?: unknown;
          delayMilliseconds?: number;
          reason?: string;
        };
        if (classified.outcome === "parked") {
          await jobs.park(job.id, {
            ...(classified.delayMilliseconds === undefined
              ? {}
              : { delayMilliseconds: classified.delayMilliseconds }),
            ...(classified.reason === undefined ? {} : { reason: classified.reason }),
          });
          deps.onJobDone?.({
            jobId: job.id as string,
            type: job.type,
            outcome: "parked",
          });
          return;
        }
        await jobs.fail(job.id, "permanent", classified.error);
        deps.onJobDone?.({ jobId: job.id as string, type: job.type, outcome: "dead" });
        return;
      }
      if (outcome === undefined || outcome === null) {
        try {
          await jobs.complete(job.id);
          deps.onJobDone?.({ jobId: job.id as string, type: job.type, outcome: "succeeded" });
        } catch (error) {
          reportWorkerError(error);
        }
        return;
      }
      await jobs.fail(job.id, outcome, new Error(`handler classified outcome: ${outcome}`));
      deps.onJobDone?.({
        jobId: job.id as string,
        type: job.type,
        outcome:
          outcome === "transient" ? "retried" : outcome === "permanent" ? "dead" : "cancelled",
      });
    } finally {
      inFlightIds.delete(job.id as string);
      inFlightCount -= 1;
    }
  }

  async function tick(): Promise<void> {
    try {
      await jobs.recoverExpiredLeases();
      const batch = await jobs.claim({
        workerId,
        limit: options.claimBatchMax,
        leaseMilliseconds: options.leaseMilliseconds,
      });
      for (const job of batch) {
        // Sequential within the batch: bounded concurrency, no unbounded
        // parallel claim growth; cross-worker parallelism comes from
        // multiple worker processes (spec §63).
        await execute(job);
      }
    } catch (error) {
      reportWorkerError(error);
    }
  }

  function runTick(): void {
    // The catch guards the gap the tick-internal try cannot cover: a throw
    // from `reportWorkerError` inside tick (or any future pre-try code) must
    // still reschedule, or the worker dies as a silent zombie.
    void tick()
      .then(() => schedule())
      .catch((error) => {
        reportWorkerError(error);
        schedule();
      });
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(runTick, options.pollIntervalMilliseconds);
    timer.unref?.();
  }

  /** Extends the claim lease of every in-flight job so long-running work is
   * not reclaimed (and doubled) by `recoverExpiredLeases` mid-execution. */
  function heartbeat(): void {
    if (stopped || inFlightIds.size === 0) return;
    void jobs
      .extendLeases({
        workerId,
        jobIds: [...inFlightIds],
        leaseMilliseconds: options.leaseMilliseconds,
      })
      .catch((error) => reportWorkerError(error));
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      if (heartbeatTimer === null) {
        heartbeatTimer = setInterval(heartbeat, Math.max(1000, options.leaseMilliseconds / 3));
        heartbeatTimer.unref?.();
      }
      if (options.runImmediately) {
        runTick();
      } else {
        schedule();
      }
    },
    async stop(timeoutMilliseconds) {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      const deadline = deps.clock.now().getTime() + timeoutMilliseconds;
      while (inFlightCount > 0 && deps.clock.now().getTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return inFlightCount === 0;
    },
    inFlight: () => inFlightCount,
  };
}
