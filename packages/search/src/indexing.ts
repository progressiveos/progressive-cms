// Outbox-driven incremental indexing (PCMS-SEARCH-T009; Search spec §18).
//
// Events are treated as invalidation hints, never as content carriers: the
// handler re-derives the document from the *current* publication pointer,
// which makes redelivery idempotent (same resulting index), out-of-order
// events stale-safe (a late generation can never regress the projection)
// and rollback/unpublish symmetric with publish. Publication success never
// depends on this path — failures stay in the outbox retry/dead-letter
// cycle (M07 at-least-once semantics).

import { SearchError } from "./errors.js";
import type { SearchDocumentSource, SearchProvider } from "./provider.js";

/** M07 outbox event as delivered to consumers (structural subset). */
export interface SearchOutboxEvent {
  readonly id: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

export interface SearchIndexEventPayload {
  readonly entityType: string;
  readonly entityId: string;
  readonly context: string;
  readonly generation: number;
}

interface SearchHomeBindingEventPayload {
  readonly previousEntryId: string | null;
  readonly homeEntryId: string | null;
}

function parseHomeBindingEventPayload(payload: unknown): SearchHomeBindingEventPayload {
  if (payload === null || typeof payload !== "object") {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", "home-binding event payload is not an object");
  }
  const record = payload as Record<string, unknown>;
  const previousEntryId = record.previousEntryId;
  const homeEntryId = record.homeEntryId;
  if (
    (previousEntryId !== null && (typeof previousEntryId !== "string" || previousEntryId === "")) ||
    (homeEntryId !== null && (typeof homeEntryId !== "string" || homeEntryId === ""))
  ) {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", "home-binding event has invalid entry IDs");
  }
  if (!("previousEntryId" in record) || !("homeEntryId" in record)) {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", "home-binding event lacks entry IDs");
  }
  return {
    previousEntryId: previousEntryId as string | null,
    homeEntryId: homeEntryId as string | null,
  };
}

export function parseIndexEventPayload(payload: unknown): SearchIndexEventPayload {
  if (payload === null || typeof payload !== "object") {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", "indexing event payload is not an object");
  }
  const record = payload as Record<string, unknown>;
  const entityType = record.entityType;
  const entityId = record.entityId;
  const context = typeof record.context === "string" ? record.context : "default";
  if (
    record.generation === null ||
    record.generation === undefined ||
    !Number.isInteger(Number(record.generation))
  ) {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", "indexing event lacks integer generation");
  }
  const generation = Number(record.generation);
  if (typeof entityType !== "string" || entityType === "") {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", "indexing event lacks entityType");
  }
  if (typeof entityId !== "string" || entityId === "") {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", "indexing event lacks entityId");
  }
  if (!Number.isInteger(generation)) {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", "indexing event lacks integer generation");
  }
  return { entityType, entityId, context, generation };
}

export interface SearchIndexingService {
  /**
   * Re-derives and writes the projection for one entity (or removes it when
   * the entity is no longer publicly indexable) and advances the
   * last-processed-event marker. Throws on infrastructure failure so the
   * outbox retry/dead-letter policy owns recovery.
   */
  applyPublicationEvent(event: SearchOutboxEvent): Promise<void>;
  /** Refreshes both sides of an explicit homepage binding change. */
  applyHomeBindingChangedEvent(event: SearchOutboxEvent): Promise<void>;
}

export function createSearchIndexingService(deps: {
  readonly provider: SearchProvider;
  readonly source: SearchDocumentSource;
  readonly pool: { query: (sql: string, params?: readonly unknown[]) => Promise<unknown> };
  readonly clock: { now(): Date };
}): SearchIndexingService {
  const { provider, source, pool, clock } = deps;

  async function markEvent(eventId: string, error: string | null): Promise<void> {
    await pool.query(
      `UPDATE search_index_state
       SET last_event_id = $1, last_event_at = $2,
           last_error = $3, updated_at = now()
       WHERE id = 1`,
      [eventId, clock.now(), error === null ? null : error.slice(0, 2000)],
    );
  }

  async function refreshDocument(
    entityType: string,
    entityId: string,
    context: string,
  ): Promise<void> {
    const document = await source.buildDocument(entityType, entityId, context);
    if (document === null) await provider.remove(entityType, entityId, context);
    else await provider.index(document);
  }

  return {
    async applyPublicationEvent(event) {
      try {
        const payload = parseIndexEventPayload(event.payload);
        await refreshDocument(payload.entityType, payload.entityId, payload.context);
        await markEvent(event.id, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markEvent(event.id, message).catch(() => undefined);
        throw error;
      }
    },
    async applyHomeBindingChangedEvent(event) {
      try {
        const payload = parseHomeBindingEventPayload(event.payload);
        for (const entityId of new Set([payload.previousEntryId, payload.homeEntryId])) {
          if (entityId !== null) await refreshDocument("entry", entityId, "default");
        }
        await markEvent(event.id, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markEvent(event.id, message).catch(() => undefined);
        throw error;
      }
    },
  };
}
