// PostgreSQL tsvector/GIN search provider (PCMS-SEARCH-T003; Search spec
// §7–§17). Plain SQL via the core pool (ADR-0002 style): weighted generated
// tsvector per locale config, GIN indexes, websearch_to_tsquery parsing,
// bounded offset-window pagination and marker-based semantic snippets.
//
// Ranking (spec §11/§12): ts_rank_cd over the weighted vector + exact-title
// boost + a modest deterministic recency term, tie-broken by
// (published_at DESC, entity_id ASC) — never by natural table order.
import type { DbClient, DbPool } from "@pcms/core";
import { SEARCH_INDEX_VERSION, type SearchDocument } from "./document.js";
import { SearchError } from "./errors.js";
import type { SearchProvider, SearchResultItem, SnippetSegment } from "./provider.js";
import { encodeCursor, localeTextSearchConfig } from "./query.js";

interface StateRow extends Record<string, unknown> {
  readonly index_version: number;
  readonly active_epoch: number | string;
  readonly building_epoch: number | string | null;
  readonly last_event_at: Date | null;
  readonly last_reindex_at: Date | null;
  readonly last_error: string | null;
}

const UPSERT_SQL = `
  INSERT INTO search_documents (
    entity_type, entity_id, context, site_id, locale, content_type,
    revision_id, generation, epoch, title, summary, structured_text,
    body_text, aux_text, route, published_at, modified_at, extension_path, indexed_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9,
    $10, $11, $12, $13, $14, $15, $16, $17, $18, now()
  )
  ON CONFLICT (epoch, entity_type, entity_id, context) DO UPDATE SET
    site_id = EXCLUDED.site_id,
    locale = EXCLUDED.locale,
    content_type = EXCLUDED.content_type,
    revision_id = EXCLUDED.revision_id,
    generation = EXCLUDED.generation,
    title = EXCLUDED.title,
    summary = EXCLUDED.summary,
    structured_text = EXCLUDED.structured_text,
    body_text = EXCLUDED.body_text,
    aux_text = EXCLUDED.aux_text,
    route = EXCLUDED.route,
    extension_path = EXCLUDED.extension_path,
    published_at = EXCLUDED.published_at,
    modified_at = EXCLUDED.modified_at,
    indexed_at = now()
  WHERE search_documents.generation <= EXCLUDED.generation`;

/**
 * Idempotent epoch upsert with the stale-event guard: a late write derived
 * from an older publication generation never overwrites a newer projection
 * (Search spec §18 + M07 at-least-once delivery).
 */
export async function upsertDocumentIntoEpoch(
  executor: DbClient | DbPool,
  document: SearchDocument,
  epoch: number,
): Promise<void> {
  await executor.query(UPSERT_SQL, [
    document.entity_type,
    document.entity_id,
    document.context,
    document.site_id,
    document.locale,
    document.content_type,
    document.revision_id,
    document.generation,
    epoch,
    document.title,
    document.summary,
    document.structured_text,
    document.body_text,
    document.aux_text,
    document.route,
    document.published_at,
    document.modified_at,
    document.extension_path ?? null,
  ]);
}

interface DocumentRow extends Record<string, unknown> {
  readonly entity_id: string;
  readonly entity_type: string;
  readonly content_type: string | null;
  readonly title: string;
  readonly summary: string;
  readonly revision_id: string;
  readonly locale: string;
  readonly modified_at: Date | null;
  readonly path: string | null;
  readonly score: string | number;
  readonly published_at: Date | null;
  readonly headline: string | null;
  readonly snippet_source: string;
  readonly total: string | number;
}

const SNIPPET_MAX_CHARS = 1000;

export interface PgSearchProviderDeps {
  readonly pool: DbPool;
  readonly clock?: { now(): Date };
  /** Full-rebuild delegate (spec §28 reindex()) — composition wires the
   * reindex service here; a provider without one is query/index-only. */
  readonly reindex?: () => Promise<void>;
  /** Composition-owned live visibility gate for extension projections only. */
  readonly extensionRoutes?: (locale: string) => Promise<
    readonly {
      readonly entityType: string;
      readonly routePrefix: string;
      readonly routePattern: string;
      readonly priority: number;
      readonly publicPage: boolean;
    }[]
  >;
}

export function createPgSearchProvider(deps: PgSearchProviderDeps): SearchProvider {
  const { pool } = deps;

  async function readState(executor: DbPool | DbClient): Promise<StateRow | null> {
    const { rows } = await executor.query<StateRow>(
      "SELECT index_version, active_epoch, building_epoch, last_event_at, last_reindex_at, last_error FROM search_index_state WHERE id = 1",
    );
    return rows[0] ?? null;
  }

  async function targetEpochs(): Promise<{ active: number; building: number | null }> {
    const state = await readState(pool);
    if (state === null) {
      throw new SearchError("SEARCH_INDEX_UNAVAILABLE", "search index state is not initialized");
    }
    return {
      active: Number(state.active_epoch),
      building: state.building_epoch === null ? null : Number(state.building_epoch),
    };
  }

  const provider: SearchProvider = {
    async index(document) {
      const epochs = await targetEpochs();
      const targets = epochs.building === null ? [epochs.active] : [epochs.active, epochs.building];
      await pool.withTransaction(async (tx) => {
        for (const epoch of targets) {
          await upsertDocumentIntoEpoch(tx, document, epoch);
        }
      });
    },

    async remove(entityType, entityId, context = "default") {
      await pool.query(
        "DELETE FROM search_documents WHERE entity_type = $1 AND entity_id = $2 AND context = $3",
        [entityType, entityId, context],
      );
    },

    async query(parsed, options) {
      const state = await readState(pool);
      if (state === null) {
        throw new SearchError("SEARCH_INDEX_UNAVAILABLE", "search index state is not initialized");
      }
      const activeEpoch = Number(state.active_epoch);
      const config = localeTextSearchConfig(parsed.locale);
      const now = options?.now ?? new Date();
      const params: unknown[] = [activeEpoch, config, parsed.q];
      let filterSql = "";
      let pathSql = "d.route";
      if (deps.extensionRoutes !== undefined) {
        params.push(JSON.stringify(await deps.extensionRoutes(parsed.locale)));
        filterSql += ` AND (strpos(d.entity_type, '/') = 0 OR COALESCE((
          SELECT scope."publicPage" FROM jsonb_to_recordset($${params.length}::jsonb)
            AS scope("entityType" text, "routePattern" text, priority int, "publicPage" boolean)
          WHERE scope."entityType" = d.entity_type AND d.extension_path ~ scope."routePattern"
          ORDER BY scope.priority LIMIT 1), false))`;
        pathSql = `CASE WHEN strpos(d.entity_type, '/') = 0 THEN d.route ELSE (
          SELECT scope."routePrefix" || ltrim(d.extension_path, '/')
          FROM jsonb_to_recordset($${params.length}::jsonb) AS scope("entityType" text, "routePrefix" text, "routePattern" text)
          WHERE scope."entityType" = d.entity_type LIMIT 1) END`;
      }
      if (parsed.filters.content_type !== undefined) {
        params.push(parsed.filters.content_type);
        filterSql += ` AND d.content_type = $${params.length}`;
      }
      if (parsed.filters.date_from !== undefined) {
        params.push(new Date(parsed.filters.date_from));
        filterSql += ` AND d.published_at >= $${params.length}::timestamptz`;
      }
      if (parsed.filters.date_to !== undefined) {
        // Date-only bounds are inclusive of the whole day.
        const raw = parsed.filters.date_to;
        const bound = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
        params.push(new Date(bound));
        filterSql += ` AND d.published_at <= $${params.length}::timestamptz`;
      }
      params.push(parsed.site, parsed.locale);
      const siteParam = params.length - 1;
      const localeParam = params.length;
      params.push(now);
      const nowParam = params.length;
      params.push(parsed.limit, parsed.offset);
      const limitParam = params.length - 1;
      const offsetParam = params.length;

      const rankExpr = `(
        ts_rank_cd(d.search_vector, websearch_to_tsquery($2::regconfig, $3))
        + 0.1 * ts_rank_cd(d.aux_vector, plainto_tsquery('simple'::regconfig, $3))
        + CASE WHEN lower(d.title) = lower($3) THEN 1.0 ELSE 0.0 END
        + CASE WHEN d.published_at IS NULL THEN 0.0 ELSE
            0.1 * greatest(0.0, 1.0 - extract(epoch FROM ($${nowParam}::timestamptz - d.published_at)) / 31557600.0)
          END
      )`;
      const headlineExpr = `ts_headline(
        $2::regconfig,
        CASE WHEN d.body_text <> '' THEN d.body_text
             WHEN d.summary <> '' THEN d.summary
             ELSE d.title END,
        websearch_to_tsquery($2::regconfig, $3),
        'StartSel=' || chr(1) || ',StopSel=' || chr(2) ||
        ',MaxFragments=2,MaxWords=24,MinWords=12,FragmentDelimiter= …'
      )`;
      const snippetSource = `CASE WHEN d.body_text <> '' THEN 'body'
        WHEN d.summary <> '' THEN 'summary' ELSE 'title' END`;
      const orderSql =
        parsed.sort === "date"
          ? "ORDER BY m.published_at DESC NULLS LAST, m.entity_id ASC"
          : "ORDER BY m.score DESC, m.published_at DESC NULLS LAST, m.entity_id ASC";

      // Rank/count narrow rows first. Headline extraction and wide text reads
      // happen only for the bounded page, never for every matching document.
      const sql = `
        WITH matched AS (
          SELECT d.entity_id, d.entity_type, d.context, d.content_type,
                 ${pathSql} AS path, d.published_at,
                 ${rankExpr} AS score
          FROM search_documents d
          WHERE d.epoch = $1
            AND d.site_id = $${siteParam}
            AND d.locale = $${localeParam}
            AND (
              d.search_vector @@ websearch_to_tsquery($2::regconfig, $3)
              OR d.aux_vector @@ plainto_tsquery('simple'::regconfig, $3)
            )${filterSql}
        ), page AS MATERIALIZED (
          SELECT m.*, count(*) OVER () AS total
          FROM matched m
          ${orderSql}
          LIMIT $${limitParam} OFFSET $${offsetParam}
        )
        SELECT m.*, d.title, d.summary, d.revision_id, d.locale, d.modified_at,
               ${headlineExpr} AS headline, ${snippetSource} AS snippet_source
        FROM page m
        JOIN search_documents d ON d.epoch = $1
          AND d.entity_type = m.entity_type AND d.entity_id = m.entity_id
          AND d.context = m.context
        ${orderSql}`;

      const { rows } = await pool.query<DocumentRow>(sql, params);
      const total = rows.length === 0 ? 0 : Number(rows[0]?.total ?? 0);
      const nextOffset = parsed.offset + rows.length;
      const items: SearchResultItem[] = rows.map((row) => ({
        entity_id: row.entity_id,
        entity_type: row.entity_type,
        content_type: row.content_type,
        title: row.title,
        summary: row.summary,
        revision_id: row.revision_id,
        locale: row.locale,
        modified_at: row.modified_at,
        path: row.path,
        snippet: snippetSegments(row.headline, row.snippet_source),
        score: Number(row.score),
        published_at: row.published_at,
      }));
      return {
        items,
        total,
        limit: parsed.limit,
        offset: parsed.offset,
        // A next page exists whenever the window did not cover all matches;
        // a request beyond MAX_RESULT_WINDOW fails loudly (bounded window).
        next_cursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      };
    },

    async reindex() {
      if (deps.reindex === undefined) {
        throw new SearchError(
          "SEARCH_INDEX_UNAVAILABLE",
          "this provider was not wired with a reindex service",
        );
      }
      await deps.reindex();
    },

    async health() {
      const state = await readState(pool);
      if (state === null) {
        throw new SearchError("SEARCH_INDEX_UNAVAILABLE", "search index state is not initialized");
      }
      const { rows } = await pool.query<{ document_count: string | number; trgm: boolean }>(
        `SELECT
           (SELECT count(*) FROM search_documents d WHERE d.epoch = $1) AS document_count,
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trgm`,
        [Number(state.active_epoch)],
      );
      const version = Number(state.index_version);
      return {
        available: true,
        index_version: version,
        expected_index_version: SEARCH_INDEX_VERSION,
        reindex_required: version !== SEARCH_INDEX_VERSION,
        document_count: Number(rows[0]?.document_count ?? 0),
        active_epoch: Number(state.active_epoch),
        building_epoch: state.building_epoch === null ? null : Number(state.building_epoch),
        last_event_at: state.last_event_at,
        last_reindex_at: state.last_reindex_at,
        last_error: state.last_error,
        // pg_trgm capability fact (PCMS-SEARCH-T013) — presence only.
        trigram_available: rows[0]?.trgm === true,
      };
    },
  };

  return provider;
}

/** Splits a chr(1)/chr(2)-marked headline into safe semantic segments. */
export function snippetSegments(
  headline: string | null,
  source: string,
): SearchResultItem["snippet"] {
  if (typeof headline !== "string" || headline === "") return null;
  const MARK_START = String.fromCharCode(1);
  const MARK_STOP = String.fromCharCode(2);
  const segments: SnippetSegment[] = [];
  let match = false;
  let used = 0;
  let buffer = "";
  const flush = (): void => {
    if (buffer === "" || used >= SNIPPET_MAX_CHARS) {
      buffer = "";
      return;
    }
    const text = buffer.slice(0, SNIPPET_MAX_CHARS - used);
    used += text.length;
    segments.push({ text, match });
    buffer = "";
  };
  for (const character of headline) {
    if (character === MARK_START) {
      flush();
      match = true;
    } else if (character === MARK_STOP) {
      flush();
      match = false;
    } else {
      buffer += character;
    }
  }
  flush();
  if (segments.length === 0 || !segments.some((segment) => segment.match)) return null;
  return {
    source: source === "summary" || source === "title" ? source : "body",
    segments,
  };
}

/** SearchIndexHealth augmented with the trigram capability fact. */
export interface PgSearchHealth extends Awaited<ReturnType<SearchProvider["health"]>> {
  readonly trigram_available: boolean;
}
