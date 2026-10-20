// SearchProvider contract (PCMS-SEARCH-T001; Search spec §28).
//
// The public adapter surface: PostgreSQL is the first-party provider; a
// future OpenSearch-style engine implements the same semantic contract
// without touching the Content Model (spec §35.7). The provider is a dumb
// projection store — every document arrives fully derived from
// authoritative CMS data through SearchDocumentSource (composition-built).
import type { DbPool } from "@pcms/core";
import type { SearchDocument } from "./document.js";
import type { ParsedSearchQuery } from "./query.js";

/** Highlighted snippet as semantic text segments (Search spec §13): the
 * provider never emits HTML; presentation marks `match` segments. */
export interface SnippetSegment {
  readonly text: string;
  readonly match: boolean;
}

export interface SearchResultItem {
  readonly entity_id: string;
  readonly entity_type: string;
  readonly content_type: string | null;
  readonly title: string;
  readonly summary: string;
  readonly revision_id: string;
  readonly locale: string;
  readonly modified_at: Date | null;
  readonly path: string | null;
  readonly snippet: {
    readonly source: "body" | "summary" | "title";
    readonly segments: readonly SnippetSegment[];
  } | null;
  /** Rank score rounded to a fixed precision — deterministic for fixtures. */
  readonly score: number;
  readonly published_at: Date | null;
}

export interface SearchQueryResult {
  readonly items: readonly SearchResultItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly next_cursor: string | null;
}

export interface SearchIndexHealth {
  readonly available: boolean;
  readonly index_version: number;
  readonly expected_index_version: number;
  /** True when the stored projection was built by an older extractor/ranker. */
  readonly reindex_required: boolean;
  readonly document_count: number;
  readonly active_epoch: number;
  readonly building_epoch: number | null;
  readonly last_event_at: Date | null;
  readonly last_reindex_at: Date | null;
  readonly last_error: string | null;
}

/** Cursor page of entity ids within one enumeration phase. `cursor` is the
 * opaque continuation token (null = phase exhausted); batched rebuild walks
 * phases to completion, so a cursor must always advance (PREPUBLIC §2). */
export interface SearchSourceIdPage {
  readonly ids: readonly string[];
  readonly cursor: string | null;
}

/**
 * Structural source of derived documents (composition layer implements it
 * over publications/revisions/content/routing/SEO plus every enabled
 * extension search source). Search never reads authoritative stores itself
 * (Search spec §0: derived subsystem).
 *
 * Enumeration is phased, not entry-only: "entry" is the first phase, each
 * enabled extension search source contributes one "<extensionId>/<source_id>"
 * phase — the full rebuild treats Core entries and extension-owned entities
 * through the single Source Contract (PREPUBLIC §2).
 */
export interface SearchDocumentSource {
  /**
   * Current public search document for one entity, re-derived from live
   * state; null when the entity is not publicly indexable right now
   * (unpublished, archived, unrouted, noindex, extension disabled).
   */
  buildDocument(
    entityType: string,
    entityId: string,
    context?: string,
  ): Promise<SearchDocument | null>;
  /**
   * Ordered enumeration phases of the public snapshot, re-derived per call:
   * extension enable/disable affects future phases immediately (a running
   * rebuild finishes gracefully; finalize purges phases that vanished).
   */
  listPhases(): Promise<readonly string[]>;
  /** Deterministic phase size (reindex sizing; allocation-time walk). */
  countPhase(phase: string): Promise<number>;
  /** Cursor page of entity ids within one phase (spec §19 batched rebuild). */
  listPhaseIds(phase: string, after: string | null, limit: number): Promise<SearchSourceIdPage>;
}

export interface SearchProvider {
  /** Idempotent upsert of a derived document into the current epoch(s). */
  index(document: SearchDocument): Promise<void>;
  /** Idempotent removal across all epochs (unpublish/archive/noindex). */
  remove(entityType: string, entityId: string, context?: string): Promise<void>;
  /** Executes a validated, bounded query (site/locale scoped by contract). */
  query(parsed: ParsedSearchQuery, options?: { readonly now?: Date }): Promise<SearchQueryResult>;
  /** Structural seam re-implemented by full-reindex orchestration (spec §28). */
  reindex(): Promise<void>;
  health(): Promise<SearchIndexHealth>;
}

/** Constructor deps shared by concrete providers. */
export interface SearchProviderDeps {
  readonly pool: DbPool;
}
