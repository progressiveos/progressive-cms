// Public collection feed source (Theme Contract §43; Content spec §54–§59).
//
// A named collection is DECLARED by the active theme manifest
// (`theme.json` → `collections`); this module is its only read path: one
// bounded SQL page over the public projection inputs, following the
// search-source composition precedent (publications × revisions × entries ×
// routes). Published current revisions only — drafts, archived, unrouted and
// foreign-locale entries cannot enter a feed by construction. Read-only: no
// derivative is generated and no state changes.
//
// Section semantics: a collection resolves the CHILDREN of the page it is
// rendered for ("self" — the Content Tree section), so themes never carry
// site entry ids. The REST surface passes the section explicitly.

import { ApiError } from "./errors.js";

/** Hard page-size maximum — one page never exceeds the DSL feed bound. */
export const COLLECTION_MAX_PAGE_SIZE = 100;
export const COLLECTION_DEFAULT_PAGE_SIZE = 12;

const STABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TAG_RE = /^[^%_\\]{1,64}$/;

/** One published feed row: everything a card needs, nothing else. */
export interface CollectionFeedItemRow {
  readonly entry_id: string;
  readonly content_type: string;
  /** ISO instant of the current publication. */
  readonly published_at: string;
  readonly fields: Record<string, unknown>;
  readonly blocks: unknown;
  readonly route_path: string;
  readonly route_locale: string;
}

export interface CollectionTagFacet {
  readonly tag: string;
  readonly count: number;
}

export interface CollectionFeedInput {
  /** Publication context = locale axis ("default" sentinel or BCP-47). */
  readonly context: string;
  readonly contentTypes: readonly string[];
  /** Section entry id (children of it); null = no tree filter. */
  readonly sectionEntryId: string | null;
  readonly tagField: string;
  readonly tag: string | null;
  readonly page: number;
  readonly pageSize: number;
}

export interface CollectionFeedResult {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  /** Tag counts over the WHOLE collection (ignores the active tag filter). */
  readonly tags: readonly CollectionTagFacet[];
  readonly items: readonly CollectionFeedItemRow[];
}

export interface CollectionFeedDeps {
  readonly pool: {
    query<Row extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: Row[] }>;
  };
  /** Registered content types — a manifest typo must fail loudly (§43). */
  readonly isKnownContentType: (key: string) => boolean;
}

interface FeedRow extends Record<string, unknown> {
  readonly total: number;
  readonly tags: CollectionTagFacet[];
  readonly items: CollectionFeedItemRow[];
}

/**
 * Strict REST param parsing: malformed page/page_size/tag are client errors,
 * never a NaN that would reach SQL (audit F-49 posture).
 */
export function parseCollectionFeedQuery(
  query: Record<string, unknown>,
  defaults: {
    pageSize: number;
  },
): { page: number; pageSize: number; tag: string | null } {
  let page = 1;
  if (query.page !== undefined) {
    const parsedPage = typeof query.page === "string" ? Number(query.page) : Number.NaN;
    if (
      typeof query.page !== "string" ||
      !/^\d+$/.test(query.page) ||
      query.page === "0" ||
      !Number.isSafeInteger(parsedPage)
    ) {
      throw new ApiError("COLLECTION_PAGE_INVALID", "page must be a positive integer", {
        status: 400,
      });
    }
    page = parsedPage;
  }
  let pageSize = defaults.pageSize;
  if (query.page_size !== undefined) {
    if (
      typeof query.page_size !== "string" ||
      !/^\d+$/.test(query.page_size) ||
      Number(query.page_size) < 1 ||
      Number(query.page_size) > COLLECTION_MAX_PAGE_SIZE
    ) {
      throw new ApiError(
        "COLLECTION_PAGE_INVALID",
        `page_size must be an integer in [1, ${COLLECTION_MAX_PAGE_SIZE}]`,
        { status: 400 },
      );
    }
    pageSize = Number(query.page_size);
  }
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    throw new ApiError("COLLECTION_PAGE_INVALID", "page offset is out of range", { status: 400 });
  }
  let tag: string | null = null;
  if (query.tag !== undefined) {
    if (typeof query.tag !== "string" || !TAG_RE.test(query.tag)) {
      throw new ApiError("COLLECTION_TAG_INVALID", "tag must be 1..64 characters", {
        status: 400,
      });
    }
    tag = query.tag;
  }
  return { page, pageSize, tag };
}

/**
 * One deterministic feed page. Order: published_at DESC with entry_id as the
 * stable tie-breaker; pagination is bounded offset paging (page/page_size —
 * feeds need total + stable pages, not keyset cursors).
 */
export async function queryCollectionFeed(
  deps: CollectionFeedDeps,
  input: CollectionFeedInput,
): Promise<CollectionFeedResult> {
  for (const key of input.contentTypes) {
    if (!deps.isKnownContentType(key)) {
      throw new ApiError(
        "COLLECTION_SOURCE_INVALID",
        `collection content type "${key}" is not registered on this server`,
        { status: 409 },
      );
    }
  }
  if (input.sectionEntryId !== null && !STABLE_ID_RE.test(input.sectionEntryId)) {
    throw new ApiError("COLLECTION_SECTION_INVALID", "section must be a stable entry id", {
      status: 400,
    });
  }
  // Routes carry the publication locale ('x-default' for the default
  // context — the same mapping publishedCard resolves by).
  const routeLocale = input.context === "default" ? "x-default" : input.context;
  const tagJson = input.tag === null ? null : JSON.stringify([input.tag]);
  const offset = (input.page - 1) * input.pageSize;
  // Base: everything the collection could ever return for this context;
  // feed: base under the active tag filter; facets intentionally read BASE so
  // the UI can always offer every tag plus a reset (Theme Contract §43).
  const sql = `
    WITH base AS (
      SELECT p.entity_id::text AS entry_id, e.content_type_id AS content_type,
             p.published_at, rev.payload->'fields' AS fields, rev.payload->'blocks' AS blocks,
             rt.path AS route_path, rt.locale AS route_locale
      FROM publications p
      JOIN revisions rev ON rev.id = p.current_revision_id
      JOIN entries e ON e.id = p.entity_id AND e.archived_at IS NULL
      JOIN LATERAL (
        SELECT r.path, r.locale FROM routes r
        WHERE r.target_type = 'entry' AND r.target_id = p.entity_id::text
          AND r.retired_at IS NULL AND r.is_canonical AND r.locale = $1
        ORDER BY r.path
        LIMIT 1
      ) rt ON true
      WHERE p.entity_type = 'entry' AND p.state = 'PUBLISHED' AND p.context = $2
        AND e.content_type_id = ANY($3::text[])
        AND ($4::uuid IS NULL OR e.parent_entry_id = $4::uuid)
    ),
    feed AS (
      SELECT * FROM base
      WHERE $5::text IS NULL OR fields->$6::text @> $7::jsonb
    )
    SELECT (SELECT count(*) FROM feed)::int AS total,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('tag', t.tag, 'count', t.count))
        FROM (
          SELECT v.value AS tag, count(*)::int AS count
          FROM base,
               jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(base.fields->$6::text) = 'array'
                      THEN base.fields->$6::text ELSE '[]'::jsonb END
               ) AS v
          GROUP BY v.value
          ORDER BY count(*) DESC, v.value ASC
          LIMIT 100
        ) t
      ), '[]'::jsonb) AS tags,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'entry_id', f.entry_id, 'content_type', f.content_type,
                 'published_at', f.published_at, 'fields', f.fields,
                 'blocks', f.blocks, 'route_path', f.route_path,
                 'route_locale', f.route_locale))
        FROM (
          SELECT * FROM feed
          ORDER BY published_at DESC, entry_id ASC
          LIMIT $8 OFFSET $9
        ) f
      ), '[]'::jsonb) AS items`;
  const { rows } = await deps.pool.query<FeedRow>(sql, [
    routeLocale,
    input.context,
    [...input.contentTypes],
    input.sectionEntryId,
    input.tag,
    input.tagField,
    tagJson,
    input.pageSize,
    offset,
  ]);
  const row = rows[0];
  if (row === undefined) {
    return {
      total: 0,
      page: input.page,
      pageSize: input.pageSize,
      pageCount: 1,
      tags: [],
      items: [],
    };
  }
  const total = row.total;
  return {
    total,
    page: input.page,
    pageSize: input.pageSize,
    pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
    tags: row.tags ?? [],
    items: row.items ?? [],
  };
}
