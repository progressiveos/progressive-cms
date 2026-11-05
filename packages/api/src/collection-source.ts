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
import { FEED_FIELD_PATTERN } from "./feed-options.js";

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
  /**
   * Feed scope (additive): "section" (default — children of sectionEntryId,
   * or the whole site when null), "subtree" (every non-archived descendant,
   * the root excluded; requires sectionEntryId) or "site" (no tree filter).
   */
  readonly scope?: "section" | "subtree" | "site";
  /** Explicit ordering; default published_at DESC + entry_id tie-break. */
  readonly order?: {
    readonly by: "published_at" | "field";
    readonly direction: "asc" | "desc";
    readonly field?: string;
  };
  /** Entry ids removed before counting/paging/facets. */
  readonly excludeEntryIds?: readonly string[];
  /** Restricts the canonical-route join to one site; null keeps the legacy join. */
  readonly siteId?: string | null;
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
 * Pinned-id cards in one statement: entry (locale translation) → published
 * revision → canonical route, mirroring the collection projection so both
 * paths hand the renderer the same row shape. Unknown, translated-away,
 * unpublished or unrouted ids simply do not appear; the returned order is the
 * caller's requested order.
 */
function publishedCardRowsQuery(
  input: {
    readonly context: string;
    readonly entryIds: readonly string[];
    readonly siteId?: string | null;
  },
  trackRequested = false,
): { sql: string; params: readonly unknown[] } {
  const ids = [...new Set(input.entryIds)].filter((id) => STABLE_ID_RE.test(id));
  const routeLocale = input.context === "default" ? "x-default" : input.context;
  const sql = `
    WITH requested AS (
      SELECT t.idx, t.entry_id AS requested_entry_id,
             CASE WHEN $3::text = 'default' THEN t.entry_id ELSE (
               SELECT translation.id FROM entries translation
               WHERE COALESCE(translation.translation_group_id, translation.id) = (
                       SELECT COALESCE(source.translation_group_id, source.id)
                       FROM entries source WHERE source.id = t.entry_id)
                 AND translation.locale = $3 AND translation.archived_at IS NULL
               ORDER BY translation.id LIMIT 1
             ) END AS entry_id
      FROM unnest($1::uuid[]) WITH ORDINALITY AS t(entry_id, idx)
    )
    SELECT ${trackRequested ? "q.idx, q.requested_entry_id::text, " : ""}p.entity_id::text AS entry_id, e.content_type_id AS content_type,
           -- The row contract promises an ISO instant (the collection feed
           -- gets it as JSON text); a raw timestamptz would arrive as a Date.
           to_jsonb(p.published_at) #>> '{}' AS published_at,
           rev.payload->'fields' AS fields, rev.payload->'blocks' AS blocks,
           rt.path AS route_path, rt.locale AS route_locale
    FROM requested q
    JOIN publications p ON p.entity_type = 'entry' AND p.entity_id = q.entry_id
      AND p.state = 'PUBLISHED' AND p.context = $2
    JOIN revisions rev ON rev.id = p.current_revision_id
    JOIN entries e ON e.id = p.entity_id AND e.archived_at IS NULL
    JOIN LATERAL (
      SELECT r.path, r.locale FROM routes r
      WHERE r.target_type = 'entry' AND r.target_id = p.entity_id::text
        AND r.retired_at IS NULL AND r.is_canonical AND r.locale = $4
        AND ($5::uuid IS NULL OR r.site_id = $5::uuid)
      ORDER BY r.path
      LIMIT 1
    ) rt ON true
    ORDER BY q.idx`;
  return { sql, params: [ids, input.context, input.context, routeLocale, input.siteId ?? null] };
}

export async function queryPublishedCardRows(
  deps: CollectionFeedDeps,
  input: {
    readonly context: string;
    readonly entryIds: readonly string[];
    readonly siteId?: string | null;
  },
): Promise<readonly CollectionFeedItemRow[]> {
  if (input.entryIds.length === 0) return [];
  const query = publishedCardRowsQuery(input);
  return (
    await deps.pool.query<CollectionFeedItemRow & Record<string, unknown>>(query.sql, query.params)
  ).rows;
}

/** Whole published rows only: callers must diagnose exclusions, never render a truncated card. */
export async function queryPublishedCardRowsBounded(
  deps: CollectionFeedDeps,
  input: {
    readonly context: string;
    readonly entryIds: readonly string[];
    readonly siteId?: string | null;
  },
): Promise<{
  readonly items: readonly CollectionFeedItemRow[];
  readonly excludedEntryIds: readonly string[];
  readonly resolvedEntryIds: Readonly<Record<string, string>>;
}> {
  const ids = [...new Set(input.entryIds)].filter((id) => STABLE_ID_RE.test(id));
  const requested = ids.slice(0, 1000);
  if (requested.length === 0) return { items: [], excludedEntryIds: [], resolvedEntryIds: {} };
  const query = publishedCardRowsQuery({ ...input, entryIds: requested }, true);
  const result = await deps.pool.query<{
    items: CollectionFeedItemRow[];
    excluded: string[];
    resolved: Record<string, string>;
  }>(
    `WITH candidates AS MATERIALIZED (${query.sql}),
      sizes AS MATERIALIZED (
        SELECT candidates.*, octet_length((to_jsonb(candidates) - 'idx' - 'requested_entry_id')::text)::bigint AS bytes
        FROM candidates
      ), budget AS MATERIALIZED (
        SELECT sizes.*, sum(CASE WHEN bytes <= $6 THEN bytes ELSE 0 END) OVER (ORDER BY idx) AS used
        FROM sizes
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(budget) - 'idx' - 'requested_entry_id' - 'bytes' - 'used' ORDER BY idx)
        FILTER (WHERE bytes <= $6 AND used <= $7), '[]'::jsonb) AS items,
        COALESCE(jsonb_agg(requested_entry_id ORDER BY idx)
        FILTER (WHERE bytes > $6 OR used > $7), '[]'::jsonb) AS excluded,
        COALESCE(jsonb_object_agg(requested_entry_id, entry_id)
        FILTER (WHERE bytes <= $6 AND used <= $7), '{}'::jsonb) AS resolved
      FROM budget`,
    [...query.params, 128 * 1024, 2 * 1024 * 1024],
  );
  return {
    items: result.rows[0]?.items ?? [],
    excludedEntryIds: [...(result.rows[0]?.excluded ?? []), ...ids.slice(1000)],
    resolvedEntryIds: result.rows[0]?.resolved ?? {},
  };
}

/**
 * One deterministic feed page. Default order: published_at DESC with
 * entry_id as the stable tie-breaker; an explicit `order` may switch to an
 * integer content field, both directions using NULLS LAST. Pagination is
 * bounded offset paging (page/page_size — feeds need total + stable pages,
 * not keyset cursors).
 */
function collectionFeedQuery(
  deps: CollectionFeedDeps,
  input: CollectionFeedInput,
  bounded = false,
): { sql: string; params: readonly unknown[] } {
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
  const scope = input.scope ?? "section";
  // An explicit subtree without a root must fail loudly — silently widening
  // to the whole site would publish a different feed than the caller asked for.
  if (scope === "subtree" && input.sectionEntryId === null) {
    throw new ApiError("COLLECTION_SECTION_INVALID", "subtree scope requires a section", {
      status: 400,
    });
  }
  const excluded = input.excludeEntryIds ?? [];
  for (const id of excluded) {
    if (!STABLE_ID_RE.test(id)) {
      throw new ApiError(
        "COLLECTION_EXCLUDE_INVALID",
        "excluded entry ids must be stable entry ids",
        { status: 400 },
      );
    }
  }
  const order = input.order ?? { by: "published_at" as const, direction: "desc" as const };
  if (
    order.by === "field" &&
    (order.field === undefined || !FEED_FIELD_PATTERN.test(order.field))
  ) {
    throw new ApiError("COLLECTION_ORDER_INVALID", "field ordering requires a canonical field id", {
      status: 400,
    });
  }
  // Routes carry the publication locale ('x-default' for the default
  // context — the same mapping publishedCard resolves by).
  const routeLocale = input.context === "default" ? "x-default" : input.context;
  const tagJson = input.tag === null ? null : JSON.stringify([input.tag]);
  const offset = (input.page - 1) * input.pageSize;
  // Tree filter: the recursive CTE walks non-archived descendants by ID
  // (UNION — not UNION ALL — so a historical cycle terminates) and never
  // includes the root itself. An archived node ends its branch because only
  // non-archived children are joined.
  const treeFilter =
    scope === "subtree"
      ? "e.id IN (SELECT id FROM subtree) AND e.id <> $4::uuid"
      : scope === "site"
        ? "TRUE"
        : "($4::uuid IS NULL OR e.parent_entry_id = $4::uuid)";
  const direction = order.direction === "asc" ? "ASC" : "DESC";
  // Field ordering is integer-only: a non-number JSON value, a non-integer
  // number or historical malformed JSON is NULL (NULLS LAST), never a cast
  // error. The direction literal comes from the enum above, never from input.
  // $11 stays in both branches so PostgreSQL can infer its type when the
  // order is by publication (an unused parameter has no type).
  const orderBy =
    order.by === "field"
      ? `CASE WHEN jsonb_typeof(fields->$11::text) = 'number'
               AND fields->>$11::text ~ '^-?[0-9]+$'
              THEN (fields->>$11::text)::numeric END ${direction} NULLS LAST,
         entry_id ASC`
      : `published_at ${direction} NULLS LAST, entry_id ASC, $11::text`;
  // Base: everything the collection could ever return for this context;
  // feed: base under the active tag filter; facets intentionally read BASE so
  // the UI can always offer every tag plus a reset (Theme Contract §43).
  // Filter aggregate inputs by the measured budget; CASE around jsonb_agg alone still allocates.
  const selectedTags = `
    SELECT v.value AS tag, count(*)::int AS count
    FROM base,
         jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(base.fields->$6::text) = 'array'
                THEN base.fields->$6::text ELSE '[]'::jsonb END
         ) AS v
    GROUP BY v.value
    ORDER BY count(*) DESC, v.value ASC
    LIMIT 100`;
  const selectedItems = `
    SELECT * FROM feed
    ORDER BY ${orderBy}
    LIMIT $8 OFFSET $9`;
  const tagJsonObject = "jsonb_build_object('tag', t.tag, 'count', t.count)";
  const itemJsonObject = `jsonb_build_object(
    'entry_id', f.entry_id, 'content_type', f.content_type,
    'published_at', f.published_at, 'fields', f.fields,
    'blocks', f.blocks, 'route_path', f.route_path,
    'route_locale', f.route_locale)`;
  const sql = `
    WITH RECURSIVE subtree AS (
      SELECT child.id FROM entries child
      WHERE $4::uuid IS NOT NULL AND child.parent_entry_id = $4::uuid
        AND child.archived_at IS NULL
      UNION
      SELECT next.id FROM entries next
      JOIN subtree parent ON next.parent_entry_id = parent.id
      WHERE next.archived_at IS NULL
    ),
    base AS (
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
          AND ($12::uuid IS NULL OR r.site_id = $12::uuid)
        ORDER BY r.path
        LIMIT 1
      ) rt ON true
      WHERE p.entity_type = 'entry' AND p.state = 'PUBLISHED' AND p.context = $2
        AND e.content_type_id = ANY($3::text[])
        AND ${treeFilter}
        AND e.id <> ALL($10::uuid[])
    ),
    feed AS (
      SELECT * FROM base
      WHERE $5::text IS NULL OR fields->$6::text @> $7::jsonb
    )${
      bounded
        ? `,
    selected_tags AS MATERIALIZED (${selectedTags}),
    selected_items AS MATERIALIZED (${selectedItems}),
    dependency_budgets AS MATERIALIZED (
      SELECT
        (SELECT COALESCE(sum(octet_length((${tagJsonObject})::text)::bigint), 0)
                  + 2 * count(*) + 2 FROM selected_tags t) AS tags_bytes,
        (SELECT COALESCE(sum(octet_length((${itemJsonObject})::text)::bigint), 0)
                  + 2 * count(*) + 2 FROM selected_items f) AS items_bytes
    )`
        : ""
    }
    SELECT (SELECT count(*) FROM feed)::int AS total,
      COALESCE((
        ${
          bounded
            ? `SELECT CASE WHEN budget.tags_bytes <= $13 THEN (
                 SELECT jsonb_agg(${tagJsonObject} ORDER BY t.count DESC, t.tag ASC)
                 FROM selected_tags t WHERE budget.tags_bytes <= $13
               ) ELSE 'null'::jsonb END FROM dependency_budgets budget`
            : `SELECT jsonb_agg(${tagJsonObject}) FROM (${selectedTags}) t`
        }
      ), '[]'::jsonb) AS tags,
      COALESCE((
        ${
          bounded
            ? `SELECT CASE WHEN budget.items_bytes <= $13 THEN (
                 SELECT jsonb_agg(${itemJsonObject} ORDER BY ${orderBy})
                 FROM selected_items f WHERE budget.items_bytes <= $13
               ) ELSE 'null'::jsonb END FROM dependency_budgets budget`
            : `SELECT jsonb_agg(${itemJsonObject}) FROM (${selectedItems}) f`
        }
      ), '[]'::jsonb) AS items`;

  return {
    sql,
    params: [
      routeLocale,
      input.context,
      [...input.contentTypes],
      input.sectionEntryId,
      input.tag,
      input.tagField,
      tagJson,
      input.pageSize,
      offset,
      excluded,
      order.by === "field" ? (order.field ?? null) : null,
      input.siteId ?? null,
      ...(bounded ? [128 * 1024] : []),
    ],
  };
}

function feedResult(input: CollectionFeedInput, row: FeedRow | undefined): CollectionFeedResult {
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

export async function queryCollectionFeed(
  deps: CollectionFeedDeps,
  input: CollectionFeedInput,
): Promise<CollectionFeedResult> {
  const query = collectionFeedQuery(deps, input);
  const { rows } = await deps.pool.query<FeedRow>(query.sql, query.params);
  return feedResult(input, rows[0]);
}

export type CollectionFeedBatchResult =
  | { readonly result: CollectionFeedResult; readonly reason: null }
  | {
      readonly result: null;
      readonly reason: "collection_dependency_limit" | "collection_dependency_invalid";
    };

/** Batches the existing feed query; incomplete results never masquerade as empty feeds. */
export async function queryCollectionFeedsBatch(
  deps: CollectionFeedDeps,
  inputs: readonly CollectionFeedInput[],
): Promise<readonly CollectionFeedBatchResult[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > 32)
    throw new ApiError("COLLECTION_SOURCE_INVALID", "batch exceeds 32 collection requests", {
      status: 400,
    });
  const params: unknown[] = [];
  const invalid = new Set<number>();
  const statements = inputs.flatMap((input, ord) => {
    try {
      if (
        !Number.isInteger(input.pageSize) ||
        input.pageSize < 1 ||
        input.pageSize > COLLECTION_MAX_PAGE_SIZE ||
        !Number.isInteger(input.page) ||
        input.page < 1 ||
        input.page > 1000
      ) {
        throw new ApiError("COLLECTION_PAGE_INVALID", "invalid bounded collection page", {
          status: 400,
        });
      }
      const query = collectionFeedQuery(deps, input, true);
      const offset = params.length;
      params.push(...query.params);
      return [
        `SELECT ${ord} AS ord, CASE WHEN feed.items = 'null'::jsonb OR feed.tags = 'null'::jsonb THEN NULL ELSE to_jsonb(feed) END AS value FROM (${query.sql.replace(/\$(\d+)/g, (_, index: string) => `$${Number(index) + offset}`)}) feed`,
      ];
    } catch {
      invalid.add(ord);
      return [];
    }
  });
  if (!statements.length)
    return inputs.map(() => ({ result: null, reason: "collection_dependency_invalid" as const }));

  const rowLimit = params.push(128 * 1024);
  const totalLimit = params.push(2 * 1024 * 1024);
  const { rows } = await deps.pool.query<{ ord: number; value: FeedRow | null }>(
    `WITH candidates AS MATERIALIZED (${statements.join(" UNION ALL ")}),
      sizes AS MATERIALIZED (SELECT *, octet_length(value::text)::bigint AS bytes FROM candidates),
      budget AS (SELECT *, sum(CASE WHEN bytes <= $${rowLimit} THEN bytes ELSE 0 END) OVER (ORDER BY ord) AS used FROM sizes)
      SELECT ord, CASE WHEN bytes <= $${rowLimit} AND used <= $${totalLimit} THEN value ELSE NULL END AS value
      FROM budget ORDER BY ord`,
    params,
  );
  return inputs.map((input, index) => {
    if (invalid.has(index))
      return { result: null, reason: "collection_dependency_invalid" as const };
    const row = rows.find((row) => row.ord === index);
    return row?.value == null
      ? { result: null, reason: "collection_dependency_limit" }
      : { result: feedResult(input, row.value), reason: null };
  });
}
