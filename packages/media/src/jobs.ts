// Bounded media job runner (PCMS-MEDIA-T019; Media spec §21/§22).
//
// Variant/derivative work is async-ready but deliberately does NOT build a
// durable queue — the shared Jobs subsystem (M07) owns that. This runner is
// the bounded in-process executor used by composition roots today:
//   - bounded concurrency (never floods the processor/storage);
//   - retries with backoff for transient processor failures;
//   - key-based coalescing: duplicate submissions share one execution;
//   - idempotent job bodies: re-running a variant generation is safe
//     (upsert semantics proven in PCMS-MEDIA-T010).
export interface MediaJob {
  /** Stable identity — duplicate submissions coalesce onto one execution. */
  readonly key: string;
  readonly run: () => Promise<void>;
  readonly maxAttempts?: number;
}

export interface MediaJobRunnerOptions {
  readonly concurrency?: number;
  readonly baseDelayMilliseconds?: number;
  readonly maxAttempts?: number;
  readonly onRetry?: (key: string, attempt: number, error: unknown) => void;
  readonly onGiveUp?: (key: string, error: unknown) => void;
}

export interface MediaJobRunner {
  /** Submits a job; resolves immediately (never blocks the caller). */
  submit(job: MediaJob): void;
  /** Number of jobs waiting or running. */
  pendingCount(): number;
  /** Resolves when every submitted job has finished (or given up). */
  whenIdle(): Promise<void>;
}

export function createMediaJobRunner(options: MediaJobRunnerOptions = {}): MediaJobRunner {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const baseDelay = Math.max(0, options.baseDelayMilliseconds ?? 50);
  const defaultMaxAttempts = Math.max(1, options.maxAttempts ?? 3);

  const waiting: MediaJob[] = [];
  const inFlight = new Set<string>();
  const queuedKeys = new Set<string>();
  let running = 0;
  let idleNotify: (() => void) | null = null;

  const notifyIfIdle = (): void => {
    if (running === 0 && waiting.length === 0 && idleNotify !== null) {
      const notify = idleNotify;
      idleNotify = null;
      notify();
    }
  };

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const execute = async (job: MediaJob): Promise<void> => {
    const maxAttempts = job.maxAttempts ?? defaultMaxAttempts;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await job.run();
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          options.onGiveUp?.(job.key, error);
          return;
        }
        options.onRetry?.(job.key, attempt, error);
        await delay(baseDelay * 2 ** (attempt - 1));
      }
    }
  };

  const pump = (): void => {
    while (running < concurrency && waiting.length > 0) {
      const job = waiting.shift()!;
      running += 1;
      void execute(job).finally(() => {
        running -= 1;
        inFlight.delete(job.key);
        pump();
        notifyIfIdle();
      });
    }
  };

  return {
    submit(job: MediaJob): void {
      if (queuedKeys.has(job.key) || inFlight.has(job.key)) {
        return; // coalesced: identical work is already queued or running
      }
      queuedKeys.add(job.key);
      const wrapped: MediaJob = {
        ...job,
        run: () => {
          queuedKeys.delete(job.key);
          inFlight.add(job.key);
          return job.run();
        },
      };
      waiting.push(wrapped);
      pump();
    },
    pendingCount(): number {
      return waiting.length + running;
    },
    whenIdle(): Promise<void> {
      if (running === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        idleNotify = resolve;
      });
    },
  };
}
