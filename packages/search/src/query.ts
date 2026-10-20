// Safe typed query contract (PCMS-SEARCH-T005; Search spec §10/§15/§17).
//
// The query language is bounded and validated before it ever reaches
// PostgreSQL: NFKC-normalized, length-capped, free of control/markup
// characters; filters/sorts come from closed allowlists; pagination is a
// bounded opaque cursor. No client text is ever interpolated into SQL or a
// tsquery expression — the provider passes the normalized string to
// websearch_to_tsquery (Search spec §10: no raw tsquery injection).
import { stripControlChars } from "./document.js";
import { SearchError } from "./errors.js";

/** Hard input bounds (Search spec §10/§15). */
export const MAX_QUERY_LENGTH = 256;
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;
/** Hard result-window cap: offset + limit may never exceed this. */
export const MAX_RESULT_WINDOW = 500;
export const MAX_FILTER_COUNT = 4;

export const SEARCH_SORT_MODES = ["relevance", "date"] as const;
export type SearchSortMode = (typeof SEARCH_SORT_MODES)[number];

export const SEARCH_FILTER_KEYS = ["content_type", "date_from", "date_to"] as const;
export type SearchFilterKey = (typeof SEARCH_FILTER_KEYS)[number];

const CONTENT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SITE_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const LOCALE_RE = /^[a-z][a-z0-9-]{0,15}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface SearchQueryInput {
  readonly q: string;
  readonly site: string;
  readonly locale: string;
  readonly content_type?: string;
  readonly date_from?: string;
  readonly date_to?: string;
  readonly sort?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ParsedSearchQuery {
  /** NFKC-normalized, whitespace-collapsed, marker-free query text. */
  readonly q: string;
  readonly site: string;
  readonly locale: string;
  readonly sort: SearchSortMode;
  readonly filters: {
    readonly content_type?: string;
    readonly date_from?: string;
    readonly date_to?: string;
  };
  readonly limit: number;
  readonly offset: number;
}

/**
 * Locale → PostgreSQL text-search config (must mirror the SQL function
 * search_locale_config in migration 1100; Search spec §8/§9).
 */
export function localeTextSearchConfig(locale: string): "russian" | "english" | "simple" {
  if (/^ru/i.test(locale)) return "russian";
  if (/^en/i.test(locale)) return "english";
  return "simple";
}

/**
 * Unicode normalization + abuse hardening (Search spec §10): trim, NFKC,
 * strip the snippet marker code points and any remaining control
 * characters, then collapse whitespace.
 */
export function normalizeQueryText(value: string): string {
  const nfkc = value.normalize("NFKC");
  return stripControlChars(nfkc).replace(/\s+/g, " ").trim();
}

function decodeCursor(cursor: string): number {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new SearchError("SEARCH_CURSOR_INVALID", "cursor is not valid base64url");
  }
  if (!/^off:\d+$/.test(decoded)) {
    throw new SearchError("SEARCH_CURSOR_INVALID", "cursor payload is malformed");
  }
  const offset = Number.parseInt(decoded.slice(4), 10);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_RESULT_WINDOW) {
    throw new SearchError("SEARCH_CURSOR_INVALID", "cursor offset out of range");
  }
  return offset;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(`off:${offset}`, "utf8").toString("base64url");
}

/**
 * Parses and validates a search request. Throws SEARCH_QUERY_INVALID /
 * SEARCH_FILTER_INVALID / SEARCH_FILTER_UNSUPPORTED / SEARCH_SORT_UNSUPPORTED /
 * SEARCH_CURSOR_INVALID / SEARCH_WINDOW_EXCEEDED with stable codes; an empty
 * or over-long query never reaches the provider (spec §16: no unbounded
 * dumps through the search endpoint).
 */
export function parseSearchQuery(input: SearchQueryInput): ParsedSearchQuery {
  const q = normalizeQueryText(String(input.q ?? ""));
  if (q === "") {
    throw new SearchError("SEARCH_QUERY_INVALID", "query is empty after normalization");
  }
  if (q.length > MAX_QUERY_LENGTH) {
    throw new SearchError(
      "SEARCH_QUERY_INVALID",
      `query exceeds ${MAX_QUERY_LENGTH} characters after normalization`,
      { details: { length: q.length } },
    );
  }
  if (typeof input.site !== "string" || !SITE_KEY_RE.test(input.site)) {
    throw new SearchError("SEARCH_SCOPE_VIOLATION", "site must be a valid site key");
  }
  if (typeof input.locale !== "string" || !LOCALE_RE.test(input.locale)) {
    throw new SearchError("SEARCH_SCOPE_VIOLATION", "locale must be a BCP47-ish tag");
  }

  const provided = Object.entries(input).filter(
    ([key, value]) =>
      (SEARCH_FILTER_KEYS as readonly string[]).includes(key) && value !== undefined,
  );
  if (provided.length > MAX_FILTER_COUNT) {
    throw new SearchError("SEARCH_FILTER_INVALID", "too many filters");
  }
  const filters: {
    content_type?: string;
    date_from?: string;
    date_to?: string;
  } = {};
  if (input.content_type !== undefined) {
    if (typeof input.content_type !== "string" || !CONTENT_TYPE_RE.test(input.content_type)) {
      throw new SearchError("SEARCH_FILTER_INVALID", "content_type filter is malformed");
    }
    filters.content_type = input.content_type;
  }
  if (input.date_from !== undefined) {
    if (typeof input.date_from !== "string" || !ISO_DATE_RE.test(input.date_from)) {
      throw new SearchError("SEARCH_FILTER_INVALID", "date_from must be an ISO-8601 date");
    }
    filters.date_from = input.date_from;
  }
  if (input.date_to !== undefined) {
    if (typeof input.date_to !== "string" || !ISO_DATE_RE.test(input.date_to)) {
      throw new SearchError("SEARCH_FILTER_INVALID", "date_to must be an ISO-8601 date");
    }
    filters.date_to = input.date_to;
  }
  if (
    filters.date_from !== undefined &&
    filters.date_to !== undefined &&
    Date.parse(filters.date_from) > Date.parse(filters.date_to)
  ) {
    throw new SearchError("SEARCH_FILTER_INVALID", "date_from is after date_to");
  }

  let sort: SearchSortMode = "relevance";
  if (input.sort !== undefined && input.sort !== null && input.sort !== "") {
    if (
      typeof input.sort !== "string" ||
      !(SEARCH_SORT_MODES as readonly string[]).includes(input.sort)
    ) {
      throw new SearchError(
        "SEARCH_SORT_UNSUPPORTED",
        `sort must be one of ${SEARCH_SORT_MODES.join("|")}`,
      );
    }
    sort = input.sort as SearchSortMode;
  }

  let limit = DEFAULT_SEARCH_LIMIT;
  if (input.limit !== undefined && input.limit !== null) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_SEARCH_LIMIT) {
      throw new SearchError(
        "SEARCH_QUERY_INVALID",
        `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
      );
    }
    limit = input.limit;
  }

  const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor);
  if (offset + limit > MAX_RESULT_WINDOW) {
    throw new SearchError(
      "SEARCH_WINDOW_EXCEEDED",
      `result window exceeded: offset ${offset} + limit ${limit} > ${MAX_RESULT_WINDOW}`,
    );
  }

  return { q, site: input.site, locale: input.locale, sort, filters, limit, offset };
}
