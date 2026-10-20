// Full reindex / index versioning (PCMS-SEARCH-T010; Search spec §19/§20).
//
// Shadow-epoch strategy: a rebuild writes into a fresh building epoch while
// the active epoch keeps serving queries; incremental outbox events
// dual-write into both, so changes landing mid-rebuild are never lost; the
// finalize job atomically swaps the active epoch and deletes superseded
// epochs. A partial failure leaves the live index untouched and the run is
// resumable — chunks are idempotent upserts keyed by run + chunk index.
import { randomUUID } from "node:crypto";
import type { DbClient, DbPool } from "@pcms/core";
import { SEARCH_INDEX_VERSION } from "./document.js";
import { SearchError } from "./errors.js";
import type { SearchIndexingService } from "./indexing.js";
import { upsertDocumentIntoEpoch } from "./postgres.js";
import type { SearchDocumentSource } from "./provider.js";

export const SEARCH_REINDEX_CHUNK_JOB_TYPE = "search.reindex-chunk";
export const SEARCH_REINDEX_FINALIZE_JOB_TYPE = "search.reindex-finalize";
export const SEARCH_REINDEX_CHUNK_SIZE = 500;

/** Structural enqueue seam (composition adapts the M07 jobs service). */
export interface ReindexJobsPort {
  enqueue(input: {
    readonly type: string;
    readonly payload: unknown;
    readonly idempotencyKey: string;
    readonly maxAttempts?: number;
  }): Promise<unknown>;
}

export interface ReindexChunkPayload {
  readonly runId: string;
  readonly chunkIndex: number;
  /** Enumeration phase this chunk walks ("entry", "<ext>/<source>", …). */
  readonly phase: string;
  /** Enumeration cursor: continuation of the previous page (null = start). */
  readonly after: string | null;
  readonly limit: number;
}

export interface ReindexFinalizePayload {
  readonly runId: string;
}

export interface ReindexRunStatus {
  readonly run_id: string;
  readonly state: "BUILDING" | "ACTIVE" | "FAILED";
  readonly epoch: number;
  readonly index_version: number;
  readonly total_documents: number;
  readonly chunks_total: number;
  readonly chunks_done: number;
  readonly documents_indexed: number;
  readonly error: string | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
}

export interface SearchReindexService {
  /** Starts (or with resume:true continues) a shadow build. */
  start(options?: { readonly resume?: boolean }): Promise<{
    readonly runId: string;
    readonly epoch: number;
    readonly totalDocuments: number;
    readonly chunksTotal: number;
    readonly resumed: boolean;
  }>;
  /** Executes one chunk against the live derivation source (idempotent). */
  processChunk(payload: ReindexChunkPayload): Promise<void>;
  /** Swaps epochs once every chunk landed; "pending" → retry transiently. */
  finalize(payload: ReindexFinalizePayload): Promise<"done" | "pending">;
  /**
   * Marks a BUILDING run FAILED with diagnostics (a source that kept
   * failing through every chunk retry). The active epoch is untouched —
   * `start({resume:true})` continues the run once the source recovers.
   */
  markFailed(runId: string, error: unknown): Promise<void>;
  /** Latest runs (progress diagnostics, newest first). */
  listRuns(limit?: number): Promise<readonly ReindexRunStatus[]>;
  /** In-process synchronous rebuild (small sites, tests, CLI fallback). */
  runSynchronously(): Promise<void>;
}

interface RunRow extends Record<string, unknown> {
  readonly id: string;
  readonly state: string;
  readonly epoch: number | string;
  readonly index_version: number;
  readonly total_documents: number;
  readonly chunks_total: number;
  readonly documents_indexed: number;
  readonly error: string | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly phases: string[] | null;
}

function toRunStatus(row: RunRow, chunksDone: number): ReindexRunStatus {
  return {
    run_id: row.id,
    state: (row.state as ReindexRunStatus["state"]) ?? "BUILDING",
    epoch: Number(row.epoch),
    index_version: row.index_version,
    total_documents: row.total_documents,
    chunks_total: row.chunks_total,
    chunks_done: chunksDone,
    documents_indexed: row.documents_indexed,
    error: row.error,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

export function createSearchReindexService(deps: {
  readonly pool: DbPool;
  readonly source: SearchDocumentSource;
  readonly jobs?: ReindexJobsPort;
}): SearchReindexService {
  const { pool, source, jobs } = deps;

  async function getRun(executor: DbClient | DbPool, runId: string): Promise<RunRow | null> {
    const { rows } = await executor.query<RunRow>(
      "SELECT * FROM search_reindex_runs WHERE id = $1",
      [runId],
    );
    return rows[0] ?? null;
  }

  async function chunksDone(executor: DbClient | DbPool, runId: string): Promise<number> {
    const { rows } = await executor.query<{ done: string | number }>(
      "SELECT count(*) AS done FROM search_reindex_chunks WHERE run_id = $1",
      [runId],
    );
    return Number(rows[0]?.done ?? 0);
  }

  async function allocateRun(resume: boolean): Promise<{
    run: RunRow;
    resumed: boolean;
  }> {
    // Sizing happens before the allocation transaction: phase counts walk
    // extension sources (their handlers run on the pool, not this tx). Counts
    // are advisory progress metadata — a source that fails counting sizes as
    // 0 and its chunk walk surfaces the real failure (run FAILED) later.
    const phases = await source.listPhases();
    let total = 0;
    for (const phase of phases) {
      total += await source.countPhase(phase).catch(() => 0);
    }
    return pool.withTransaction(async (tx) => {
      const state = await tx.query<{
        active_epoch: number | string;
        building_epoch: number | string | null;
      }>("SELECT active_epoch, building_epoch FROM search_index_state WHERE id = 1 FOR UPDATE");
      const building = state.rows[0]?.building_epoch ?? null;
      if (building !== null) {
        const { rows } = await tx.query<RunRow>(
          "SELECT * FROM search_reindex_runs WHERE epoch = $1",
          [Number(building)],
        );
        const run = rows[0];
        if (run !== undefined && run.state === "BUILDING") {
          if (!resume) {
            throw new SearchError(
              "SEARCH_REINDEX_CONFLICT",
              "a reindex run is already building — pass resume to continue it",
              { details: { run_id: run.id } },
            );
          }
          return { run, resumed: true };
        }
        // Building epoch without a live run: repair by clearing the marker.
        await tx.query(
          "UPDATE search_index_state SET building_epoch = NULL, building_run_id = NULL WHERE id = 1",
        );
      }
      const max = await tx.query<{ next: string | number | null }>(
        `SELECT greatest(
           (SELECT coalesce(max(epoch), 0) FROM search_reindex_runs),
           (SELECT active_epoch FROM search_index_state WHERE id = 1)
         ) + 1 AS next`,
      );
      const chunksTotal = Math.ceil(total / SEARCH_REINDEX_CHUNK_SIZE);
      const runId = randomUUID();
      const epoch = Number(max.rows[0]?.next ?? 1);
      await tx.query(
        `INSERT INTO search_reindex_runs (id, epoch, state, index_version, total_documents, chunks_total, phases)
         VALUES ($1, $2, 'BUILDING', $3, $4, $5, $6)`,
        [runId, epoch, SEARCH_INDEX_VERSION, total, chunksTotal, phases],
      );
      // building_epoch is set before enumeration so every outbox event from
      // here on dual-writes into the shadow epoch (no lost mid-rebuild updates).
      await tx.query(
        "UPDATE search_index_state SET building_epoch = $1, building_run_id = $2 WHERE id = 1",
        [epoch, runId],
      );
      const run = await getRun(tx, runId);
      if (run === null) throw new SearchError("SEARCH_INDEX_UNAVAILABLE", "reindex run vanished");
      return { run, resumed: false };
    });
  }

  /**
   * Seeds (or continues) the chunk chain. Chunks enqueue their successor
   * when they finish — cursors come from live pages, so jobs are chained
   * one deep instead of pre-enumerated. JOB_ALREADY_COMPLETED on a chained
   * enqueue means the successor already exists: the chain has converged.
   */
  const enqueueChunk = async (payload: ReindexChunkPayload): Promise<void> => {
    if (jobs === undefined) return;
    try {
      await jobs.enqueue({
        type: SEARCH_REINDEX_CHUNK_JOB_TYPE,
        payload,
        idempotencyKey: `search-reindex:${payload.runId}:chunk:${payload.chunkIndex}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("JOB_ALREADY_COMPLETED")) throw error;
    }
  };

  const enqueueFinalize = async (runId: string): Promise<void> => {
    if (jobs === undefined) return;
    try {
      await jobs.enqueue({
        type: SEARCH_REINDEX_FINALIZE_JOB_TYPE,
        payload: { runId } satisfies ReindexFinalizePayload,
        idempotencyKey: `search-reindex:${runId}:finalize`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("JOB_ALREADY_COMPLETED")) throw error;
    }
  };

  const service: SearchReindexService = {
    async start(options) {
      const { run, resumed } = await allocateRun(options?.resume === true);
      const phases = run.phases ?? ["entry"];
      if (resumed) {
        // Continue where the last recorded chunk stopped: a completed chunk
        // only proves run completion when it was the FINAL phase's tail —
        // mid-run completions chain into the next phase.
        const last = await pool.query<{
          chunk_index: number;
          phase: string;
          last_entity_id: string | null;
          complete: boolean;
        }>(
          "SELECT chunk_index, phase, last_entity_id, complete FROM search_reindex_chunks WHERE run_id = $1 ORDER BY chunk_index DESC LIMIT 1",
          [run.id],
        );
        const row = last.rows[0];
        const lastPhase = phases[phases.length - 1] ?? "entry";
        if (row !== undefined && row.complete && row.phase === lastPhase) {
          await enqueueFinalize(run.id);
        } else if (row !== undefined && row.complete) {
          const nextPhase = phases[phases.indexOf(row.phase) + 1];
          if (nextPhase === undefined) {
            await enqueueFinalize(run.id);
          } else if (jobs !== undefined) {
            await enqueueChunk({
              runId: run.id,
              chunkIndex: row.chunk_index + 1,
              phase: nextPhase,
              after: null,
              limit: SEARCH_REINDEX_CHUNK_SIZE,
            });
          }
        } else if (jobs !== undefined) {
          await enqueueChunk({
            runId: run.id,
            chunkIndex: (row?.chunk_index ?? -1) + 1,
            phase: row?.phase ?? phases[0] ?? "entry",
            after: row?.last_entity_id ?? null,
            limit: SEARCH_REINDEX_CHUNK_SIZE,
          });
        }
      } else {
        await enqueueChunk({
          runId: run.id,
          chunkIndex: 0,
          phase: phases[0] ?? "entry",
          after: null,
          limit: SEARCH_REINDEX_CHUNK_SIZE,
        });
      }
      return {
        runId: run.id,
        epoch: Number(run.epoch),
        totalDocuments: run.total_documents,
        chunksTotal: run.chunks_total,
        resumed,
      };
    },

    async processChunk(payload) {
      const run = await getRun(pool, payload.runId);
      if (run === null || run.state !== "BUILDING") return; // superseded/finished
      const state = await pool.query<{ building_epoch: number | string | null }>(
        "SELECT building_epoch FROM search_index_state WHERE id = 1",
      );
      const epoch = state.rows[0]?.building_epoch;
      if (epoch === null || Number(epoch) !== Number(run.epoch)) return;
      // Live derivation at execution time: cursor semantics tolerate
      // concurrent publish/unpublish — a mid-rebuild publication also
      // dual-writes through its outbox event, and every write is an
      // idempotent keyed upsert. Documents build through the ONE unified
      // path (entries and extension entities alike); null = not indexable
      // right now, which the finalize purge + outbox removals reconcile.
      const page = await source.listPhaseIds(payload.phase, payload.after, payload.limit);
      if (page.cursor !== null && page.cursor === payload.after && page.ids.length > 0) {
        throw new SearchError(
          "SEARCH_SOURCE_CURSOR_STALLED",
          `source phase "${payload.phase}" repeated cursor without advancing`,
          { details: { run_id: payload.runId, phase: payload.phase } },
        );
      }
      let indexed = 0;
      for (const entityId of page.ids) {
        const document = await source.buildDocument(payload.phase, entityId);
        if (document === null) continue;
        await upsertDocumentIntoEpoch(pool, document, Number(run.epoch));
        indexed += 1;
      }
      const phases = run.phases ?? ["entry"];
      const complete = page.cursor === null;
      const nextPhase = phases[phases.indexOf(payload.phase) + 1];
      await pool.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO search_reindex_chunks (run_id, chunk_index, phase, documents, last_entity_id, complete, done_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (run_id, chunk_index) DO UPDATE SET
             phase = EXCLUDED.phase, documents = EXCLUDED.documents,
             last_entity_id = EXCLUDED.last_entity_id, complete = EXCLUDED.complete, done_at = now()`,
          [payload.runId, payload.chunkIndex, payload.phase, indexed, page.cursor, complete],
        );
        await tx.query(
          "UPDATE search_reindex_runs SET documents_indexed = documents_indexed + $2 WHERE id = $1",
          [payload.runId, indexed],
        );
      });
      if (complete) {
        if (nextPhase === undefined) {
          await enqueueFinalize(payload.runId);
        } else {
          await enqueueChunk({
            runId: payload.runId,
            chunkIndex: payload.chunkIndex + 1,
            phase: nextPhase,
            after: null,
            limit: payload.limit,
          });
        }
      } else {
        await enqueueChunk({
          runId: payload.runId,
          chunkIndex: payload.chunkIndex + 1,
          phase: payload.phase,
          after: page.cursor,
          limit: payload.limit,
        });
      }
    },

    async finalize(payload) {
      const open = await pool.withTransaction(async (tx) => {
        const run = await getRun(tx, payload.runId);
        if (run === null || run.state !== "BUILDING") return false;
        const phases = run.phases ?? ["entry"];
        const lastPhase = phases[phases.length - 1] ?? "entry";
        // Only the final phase's completed tail chunk proves full enumeration;
        // earlier phases complete routinely while the chain keeps running.
        const tail = await tx.query<{ phase: string; complete: boolean }>(
          "SELECT phase, complete FROM search_reindex_chunks WHERE run_id = $1 ORDER BY chunk_index DESC LIMIT 1",
          [payload.runId],
        );
        const tailRow = tail.rows[0];
        if (tailRow === undefined || !tailRow.complete || tailRow.phase !== lastPhase) {
          return true; // pending — transient retry
        }
        const locked = await tx.query<{ state: string }>(
          "SELECT state FROM search_reindex_runs WHERE id = $1 FOR UPDATE",
          [payload.runId],
        );
        if (locked.rows[0]?.state !== "BUILDING") return false;
        await tx.query(
          `UPDATE search_index_state
           SET active_epoch = $1, index_version = $2, building_epoch = NULL,
               building_run_id = NULL, last_reindex_at = now(), updated_at = now()
           WHERE id = 1`,
          [Number(run.epoch), run.index_version],
        );
        // ponytail: an in-flight dual-writer may still land a row in the old
        // epoch after this delete — invisible (queries pin the active epoch),
        // and the next rebuild's finalize deletes it.
        await tx.query("DELETE FROM search_documents WHERE epoch <> $1", [Number(run.epoch)]);
        await tx.query(
          "UPDATE search_reindex_runs SET state = 'ACTIVE', finished_at = now() WHERE id = $1",
          [payload.runId],
        );
        return false;
      });
      if (!open) {
        // Phases that vanished mid-rebuild (extension disabled/uninstalled)
        // must not survive the swap: purge active-epoch documents whose
        // entity_type is no longer an enumeration phase. Live phase list —
        // the run's captured list is deliberately stale by design.
        const phases = await source.listPhases();
        await pool.query(
          "DELETE FROM search_documents WHERE epoch = (SELECT active_epoch FROM search_index_state WHERE id = 1) AND NOT (entity_type = ANY($1::text[]))",
          [phases],
        );
      }
      return open ? "pending" : "done";
    },

    async markFailed(runId, error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      await pool.query(
        "UPDATE search_reindex_runs SET state = 'FAILED', error = $2, finished_at = now() WHERE id = $1 AND state = 'BUILDING'",
        [runId, message],
      );
      // Clear the building marker so incremental dual-writes stop feeding a
      // dead shadow epoch (allocateRun re-allocates a fresh one next start).
      await pool.query(
        "UPDATE search_index_state SET building_epoch = NULL, building_run_id = NULL WHERE id = 1 AND building_run_id = $1",
        [runId],
      );
    },

    async listRuns(limit = 10) {
      const { rows } = await pool.query<RunRow>(
        "SELECT * FROM search_reindex_runs ORDER BY started_at DESC, id DESC LIMIT $1",
        [Math.max(1, Math.min(limit, 100))],
      );
      const out: ReindexRunStatus[] = [];
      for (const row of rows) {
        out.push(toRunStatus(row, await chunksDone(pool, row.id)));
      }
      return out;
    },

    async runSynchronously() {
      const started = await service.start();
      // Walk the same chain the jobs would: pages until a phase exhausts,
      // then the next phase, then finalize swaps the epochs.
      const run = await getRun(pool, started.runId);
      const phases = run?.phases ?? ["entry"];
      const ceiling = started.chunksTotal + phases.length * 2 + 64;
      let phase = phases[0] ?? "entry";
      let after: string | null = null;
      for (let index = 0; index <= ceiling; index += 1) {
        await service.processChunk({
          runId: started.runId,
          chunkIndex: index,
          phase,
          after,
          limit: SEARCH_REINDEX_CHUNK_SIZE,
        });
        const last = await pool.query<{
          phase: string;
          last_entity_id: string | null;
          complete: boolean;
        }>(
          "SELECT phase, last_entity_id, complete FROM search_reindex_chunks WHERE run_id = $1 AND chunk_index = $2",
          [started.runId, index],
        );
        const row = last.rows[0];
        if (row === undefined) break;
        if (row.complete) {
          const next = phases[phases.indexOf(row.phase) + 1];
          if (next === undefined) break;
          phase = next;
          after = null;
        } else {
          phase = row.phase;
          after = row.last_entity_id;
        }
      }
      const finalized = await service.finalize({ runId: started.runId });
      if (finalized !== "done") {
        throw new SearchError("SEARCH_INDEX_UNAVAILABLE", "synchronous reindex did not finalize");
      }
    },
  };

  return service;
}

/**
 * Structural job handlers for the M07 worker (search owns no daemon model).
 * finalize reports "pending" while chunks are still outstanding, which maps
 * to a transient retry; every handler is idempotent by construction.
 */
export function createSearchJobHandlers(deps: {
  readonly reindex: SearchReindexService;
}): Record<
  string,
  (
    payload: unknown,
    context: { readonly job: { readonly maxAttempts?: number }; readonly attempt: number },
  ) => Promise<void | "transient">
> {
  const { reindex } = deps;
  return {
    [SEARCH_REINDEX_CHUNK_JOB_TYPE]: async (payload, context) => {
      const chunk = payload as ReindexChunkPayload;
      try {
        await reindex.processChunk(chunk);
      } catch (error) {
        // Retries are the job layer's backoff; once this attempt is the last
        // one, the run would silently stay BUILDING forever — mark it FAILED
        // so the operator sees the failing source and can resume it later.
        if (context.attempt >= (context.job.maxAttempts ?? 5)) {
          await reindex.markFailed(chunk.runId, error);
        }
        throw error;
      }
    },
    [SEARCH_REINDEX_FINALIZE_JOB_TYPE]: async (payload) => {
      const result = await reindex.finalize(payload as ReindexFinalizePayload);
      if (result === "pending") return "transient";
    },
  };
}

/**
 * Outbox handlers for the M07 consumer: publication events refresh one
 * document; homepage binding changes refresh both affected entries.
 */
export function createSearchOutboxHandlers(deps: {
  readonly indexing: SearchIndexingService;
}): Record<string, (event: unknown) => Promise<void>> {
  const { indexing } = deps;
  const handler = async (event: unknown): Promise<void> => {
    await indexing.applyPublicationEvent(
      event as Parameters<typeof indexing.applyPublicationEvent>[0],
    );
  };
  return {
    EntryPublished: handler,
    EntryUnpublished: handler,
    EntryRolledBack: handler,
    EntryHomeBindingChanged: async (event: unknown): Promise<void> => {
      await indexing.applyHomeBindingChangedEvent(
        event as Parameters<typeof indexing.applyHomeBindingChangedEvent>[0],
      );
    },
  };
}
