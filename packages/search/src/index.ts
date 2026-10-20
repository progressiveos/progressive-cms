// @pcms/search — Search bounded context (M11, PCMS-SEARCH-T001).
//
// Derived public/admin search over PostgreSQL full-text search (Search spec
// §7). L1 rules: this package imports @pcms/core only; Content/Publication/
// Routing/SEO facts arrive as plain data through SearchDocumentSource, which
// the composition layer (packages/api context) implements. Deep imports
// ("@pcms/search/src/…") are boundary violations (tests/architecture.test.ts).

export {
  assertIndexableDocument,
  type DocumentIssue,
  MAX_AUX_LENGTH,
  MAX_BODY_LENGTH,
  MAX_STRUCTURED_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeSearchText,
  SEARCH_INDEX_VERSION,
  SEARCH_WEIGHTS,
  type SearchDocument,
  type SearchWeight,
  validateSearchDocument,
} from "./document.js";
export { SEARCH_ERROR_CODES, SearchError, type SearchErrorCode } from "./errors.js";
export {
  blockDocumentToText,
  type ExtractedSearchText,
  extractSearchText,
  richtextImageAltText,
  richtextToPlainText,
  type SearchableFieldContainer,
  type SearchableFieldSchema,
  type SearchExtractionInput,
} from "./extract.js";
export {
  createSearchIndexingService,
  parseIndexEventPayload,
  type SearchIndexEventPayload,
  type SearchIndexingService,
  type SearchOutboxEvent,
} from "./indexing.js";
export { PACKAGE_NAME } from "./package-name.js";
export {
  createPgSearchProvider,
  type PgSearchHealth,
  type PgSearchProviderDeps,
  snippetSegments,
} from "./postgres.js";
export type {
  SearchDocumentSource,
  SearchIndexHealth,
  SearchProvider,
  SearchQueryResult,
  SearchResultItem,
  SearchSourceIdPage,
  SnippetSegment,
} from "./provider.js";
export {
  DEFAULT_SEARCH_LIMIT,
  encodeCursor,
  localeTextSearchConfig,
  MAX_FILTER_COUNT,
  MAX_QUERY_LENGTH,
  MAX_RESULT_WINDOW,
  MAX_SEARCH_LIMIT,
  normalizeQueryText,
  type ParsedSearchQuery,
  parseSearchQuery,
  SEARCH_FILTER_KEYS,
  SEARCH_SORT_MODES,
  type SearchQueryInput,
  type SearchSortMode,
} from "./query.js";
export {
  createSearchJobHandlers,
  createSearchOutboxHandlers,
  createSearchReindexService,
  type ReindexChunkPayload,
  type ReindexFinalizePayload,
  type ReindexJobsPort,
  type ReindexRunStatus,
  SEARCH_REINDEX_CHUNK_JOB_TYPE,
  SEARCH_REINDEX_CHUNK_SIZE,
  SEARCH_REINDEX_FINALIZE_JOB_TYPE,
  type SearchReindexService,
} from "./reindex.js";
