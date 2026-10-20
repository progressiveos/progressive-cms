// Durable worker heartbeat (PCMS-OPS-T109; Operations spec §50, task brief §47).
//
// A systemd unit can be "active" while its loop is wedged; the heartbeat is
// the honest operational signal: the worker process updates a singleton row
// on a fixed interval and after outbox activity, and operators (doctor,
// monitoring) read the age of the last successful beat. The table is absent
// on pre-M15 databases — reads report `null` and callers choose the honest
// wording instead of failing.
import { randomUUID } from "node:crypto";
import type { DbPool } from "@pcms/core";

export interface WorkerHeartbeatClock {
  now(): Date;
}

/** How often the worker refreshes its heartbeat. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
/** A heartbeat older than this means the worker loop is not making progress. */
export const WORKER_HEARTBEAT_FRESH_WINDOW_MS = 60_000;

export interface WorkerHeartbeatWriter {
  /** Records one successful loop beat. Never throws on a missing table. */
  beat(): Promise<void>;
  stop(): void;
}

export interface WorkerHeartbeatSnapshot {
  readonly bootId: string;
  readonly startedAt: string;
  readonly lastBeatAt: string;
  readonly loopCount: number;
}

export function createWorkerHeartbeatWriter(
  pool: DbPool,
  clock: WorkerHeartbeatClock,
  options: {
    /** `null` disables the background timer (tests beat manually). */
    readonly intervalMs?: number | null;
  } = {},
): WorkerHeartbeatWriter {
  const bootId = randomUUID();
  const startedAt = clock.now();
  let loopCount = 0;
  let stopped = false;

  const beat = async (): Promise<void> => {
    loopCount += 1;
    const now = clock.now();
    await pool.query(
      `INSERT INTO pcms_worker_heartbeat (id, boot_id, started_at, last_beat_at, loop_count)
       VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET boot_id = EXCLUDED.boot_id,
             started_at = EXCLUDED.started_at,
             last_beat_at = EXCLUDED.last_beat_at,
             loop_count = EXCLUDED.loop_count`,
      [bootId, startedAt, now, loopCount],
    );
  };
  const timer =
    options.intervalMs === null
      ? undefined
      : setInterval(() => {
          if (stopped) return;
          void beat().catch(() => {
            // A failed beat is not fatal: the DB probe logs availability and the
            // stale heartbeat is exactly what doctor must surface.
          });
        }, options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);

  return {
    beat: () => (stopped ? Promise.resolve() : beat().then(() => undefined)),
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
  };
}

/**
 * Reads the current heartbeat. Returns `null` both when no worker ever beat
 * and when the table does not exist yet (pre-M15 database) — use
 * `workerHeartbeatTableExists` when the distinction matters.
 */
export async function readWorkerHeartbeat(pool: DbPool): Promise<WorkerHeartbeatSnapshot | null> {
  if (!(await workerHeartbeatTableExists(pool))) return null;
  const result = await pool.query<{
    boot_id: string;
    started_at: string;
    last_beat_at: string;
    loop_count: string;
  }>(
    "SELECT boot_id, started_at::text AS started_at, last_beat_at::text AS last_beat_at, loop_count::text AS loop_count FROM pcms_worker_heartbeat WHERE id = 1",
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    bootId: row.boot_id,
    startedAt: row.started_at,
    lastBeatAt: row.last_beat_at,
    loopCount: Number(row.loop_count),
  };
}

export async function workerHeartbeatTableExists(pool: DbPool): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('pcms_worker_heartbeat') IS NOT NULL AS exists",
  );
  return result.rows[0]?.exists === true;
}

export function heartbeatAgeMilliseconds(
  snapshot: WorkerHeartbeatSnapshot,
  clock: WorkerHeartbeatClock,
): number {
  return Math.max(0, clock.now().getTime() - new Date(snapshot.lastBeatAt).getTime());
}

export function heartbeatIsFresh(
  snapshot: WorkerHeartbeatSnapshot,
  clock: WorkerHeartbeatClock,
  windowMs = WORKER_HEARTBEAT_FRESH_WINDOW_MS,
): boolean {
  return heartbeatAgeMilliseconds(snapshot, clock) <= windowMs;
}
