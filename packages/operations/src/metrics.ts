// Lightweight runtime metrics sampling (owner productization pass 0.1.28).
// The worker appends one bounded sample per minute: cgroup-v2 CPU/memory when
// available (container-native — never a privileged host call), process RSS as
// fallback, plus queue/outbox depths. Retention is bounded (default 72h) —
// this is a recent operational window for the Admin System dashboard, not a
// monitoring platform.
import { readFile } from "node:fs/promises";
import type { Clock, DbPool } from "@pcms/core";

/** One-shot runtime resource reading for status surfaces (web process). */
export async function readRuntimeResourceSample(): Promise<{
  uptime_seconds: number;
  memory_used_bytes: number;
  memory_limit_bytes: number | null;
}> {
  const cgroupMemory = await readMemoryCgroup();
  return {
    uptime_seconds: Math.round(process.uptime()),
    memory_used_bytes: cgroupMemory?.used ?? process.memoryUsage().rss,
    memory_limit_bytes: cgroupMemory?.limit ?? null,
  };
}

export interface MetricSampler {
  start(): void;
  stop(): void;
  /** Runs one sample immediately — used by tests. */
  sampleOnce(): Promise<void>;
}

interface CpuStat {
  readonly usage_usec: number;
}

async function readCpuStat(): Promise<CpuStat | null> {
  try {
    const text = await readFile("/sys/fs/cgroup/cpu.stat", "utf8");
    const match = /^usage_usec (\d+)$/m.exec(text);
    return match === null ? null : { usage_usec: Number(match[1]) };
  } catch {
    return null;
  }
}

async function readMemoryCgroup(): Promise<{ used: number; limit: number | null } | null> {
  try {
    const used = Number((await readFile("/sys/fs/cgroup/memory.current", "utf8")).trim());
    const rawMax = (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim();
    return { used, limit: rawMax === "max" ? null : Number(rawMax) };
  } catch {
    return null;
  }
}

export function createMetricSampler(
  pool: DbPool,
  options: {
    readonly clock: Clock;
    readonly intervalMilliseconds?: number;
    readonly retentionHours?: number;
  },
): MetricSampler {
  const interval = options.intervalMilliseconds ?? 60_000;
  const retentionHours = options.retentionHours ?? 72;
  let previousCpu: CpuStat | null = null;
  let previousAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const sample = async (): Promise<void> => {
    const now = options.clock.now();
    const cpu = await readCpuStat();
    let cpuPercent: number | null = null;
    if (cpu !== null && previousCpu !== null && now.getTime() > previousAt) {
      const deltaUsec = cpu.usage_usec - previousCpu.usage_usec;
      const wallUsec = (now.getTime() - previousAt) * 1000;
      cpuPercent = Math.max(0, Math.min(100, (deltaUsec / wallUsec) * 100));
    }
    previousCpu = cpu;
    previousAt = now.getTime();

    const cgroupMemory = await readMemoryCgroup();
    const memoryUsed = cgroupMemory?.used ?? process.memoryUsage().rss;
    const memoryLimit = cgroupMemory?.limit ?? null;

    try {
      await pool.query(
        `INSERT INTO pcms_metric_samples
           (ts, cpu_percent, memory_used_bytes, memory_limit_bytes, queue_pending, queue_dead, outbox_pending)
         SELECT $1, $2, $3, $4,
           (SELECT count(*) FROM jobs WHERE state IN ('RUNNING', 'PENDING')),
           (SELECT count(*) FROM jobs WHERE state = 'DEAD'),
           (SELECT count(*) FROM publication_outbox WHERE state = 'PENDING')`,
        [now, cpuPercent, memoryUsed, memoryLimit],
      );
      // Bounded retention: prune anything older than the window.
      await pool.query(`DELETE FROM pcms_metric_samples WHERE ts < $1`, [
        new Date(now.getTime() - retentionHours * 3_600_000),
      ]);
    } catch {
      // Metrics are best-effort: a missing table (not yet migrated) or a
      // transient DB hiccup must never take the worker down.
    }
  };

  return {
    start() {
      if (timer !== null) return;
      void sample();
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void sample().finally(() => {
          running = false;
        });
      }, interval);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    sampleOnce: sample,
  };
}
