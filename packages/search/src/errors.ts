// Stable search-domain error codes (Search spec §29/§31; append-only like
// every other subsystem registry — codes are contract, messages are not).
export class SearchError extends Error {
  /** Machine-stable error code, e.g. "SEARCH_QUERY_INVALID". */
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    options?: {
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "SearchError";
    this.code = code;
    this.details = options?.details;
  }
}

export const SEARCH_ERROR_CODES = [
  "SEARCH_QUERY_INVALID",
  "SEARCH_FILTER_INVALID",
  "SEARCH_FILTER_UNSUPPORTED",
  "SEARCH_SORT_UNSUPPORTED",
  "SEARCH_CURSOR_INVALID",
  "SEARCH_WINDOW_EXCEEDED",
  "SEARCH_SCOPE_VIOLATION",
  "SEARCH_INDEX_UNAVAILABLE",
  "SEARCH_REINDEX_CONFLICT",
  "SEARCH_DOCUMENT_INVALID",
  "SEARCH_ENTITY_NOT_FOUND",
  "SEARCH_RATE_LIMITED",
] as const;

export type SearchErrorCode = (typeof SEARCH_ERROR_CODES)[number];
