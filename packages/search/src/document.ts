// Derived search document model (PCMS-SEARCH-T001; Search spec §3/§5).
//
// The index is a projection of published state (spec §0): every document is
// rebuildable from authoritative CMS data and keyed by stable entity
// identity — never by slug or URL. Text columns feed the weighted tsvector
// (generated in SQL, migration 1100): title=A, summary+structured=B,
// body=C; aux_text feeds a language-independent `simple` vector for product
// codes/names/mixed tokens (spec §9) at weight D semantics.
import { SearchError } from "./errors.js";

/**
 * Version of the extraction + ranking schema (Search spec §20). Bump on any
 * material extractor/ranking change — doctor reports a stored/index_version
 * mismatch as "reindex required".
 */
export const SEARCH_INDEX_VERSION = 2;

/** Field weighting classes (Search spec §5). */
export const SEARCH_WEIGHTS = ["A", "B", "C", "D"] as const;
export type SearchWeight = (typeof SEARCH_WEIGHTS)[number];

// Extraction output bounds — the searchable corpus is semantic text, not a
// payload dump (Search spec §6/§10); oversized inputs are truncated, never
// rejected, so indexing can never fail on content size.
export const MAX_TITLE_LENGTH = 500;
export const MAX_SUMMARY_LENGTH = 2000;
export const MAX_STRUCTURED_LENGTH = 16_000;
export const MAX_BODY_LENGTH = 65_536;
export const MAX_AUX_LENGTH = 8000;

export interface SearchDocument {
  /** Versioned entity type of the indexed aggregate, e.g. "entry". */
  readonly entity_type: string;
  /** Stable entity identity (URLs change, ids never do). */
  readonly entity_id: string;
  /** Publication context of the pointer this document was derived from. */
  readonly context: string;
  /** Owning site (site isolation: every query is scoped, spec §29). */
  readonly site_id: string;
  /** Content locale used to pick the text-search config (spec §8/§9). */
  readonly locale: string;
  readonly content_type: string | null;
  /** Public revision identity this projection was built from. */
  readonly revision_id: string;
  /** Publication generation — stale-event guard for out-of-order writes. */
  readonly generation: number;
  readonly title: string;
  readonly summary: string;
  readonly structured_text: string;
  readonly body_text: string;
  readonly aux_text: string;
  /** Current canonical route path (Routing composition, never slug-built). */
  readonly route: string | null;
  /** Core-composed mount-relative canonical path for an extension projection.
   * Normal Entry documents leave this absent. */
  readonly extension_path?: string;
  readonly published_at: Date | null;
  readonly modified_at: Date | null;
}

/**
 * Replaces control characters (including the chr(1)/chr(2) snippet markers
 * reserved by the PostgreSQL provider) with spaces — stored text must never
 * be able to forge marker splitting. Character-scan on purpose: regex
 * literals with control chars trip the security lint on purpose.
 */
export function stripControlChars(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : character;
  }
  return out;
}

/** Strip marker/control characters, then bound length. */
export function normalizeSearchText(value: string, maxLength: number): string {
  const cleaned = stripControlChars(value);
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

export interface DocumentIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * Structural validation of a derived document (machine operation
 * `validate_search_document`, Search spec §31). Checks invariants the index
 * relies on; does not re-derive content.
 */
export function validateSearchDocument(document: SearchDocument): readonly DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  const push = (code: string, message: string) => issues.push({ code, message });
  if (document.entity_type !== document.entity_type.trim() || document.entity_type === "") {
    push("SEARCH_DOCUMENT_INVALID", "entity_type must be a non-empty trimmed string");
  }
  if (typeof document.entity_id !== "string" || document.entity_id === "") {
    push("SEARCH_DOCUMENT_INVALID", "entity_id must be a non-empty string");
  }
  if (typeof document.site_id !== "string" || document.site_id === "") {
    push("SEARCH_DOCUMENT_INVALID", "site_id must be a non-empty string");
  }
  if (typeof document.locale !== "string" || document.locale === "") {
    push("SEARCH_DOCUMENT_INVALID", "locale must be a non-empty string");
  }
  if (typeof document.revision_id !== "string" || document.revision_id === "") {
    push("SEARCH_DOCUMENT_INVALID", "revision_id must be a non-empty string");
  }
  if (!Number.isInteger(document.generation) || document.generation < 0) {
    push("SEARCH_DOCUMENT_INVALID", "generation must be a non-negative integer");
  }
  if (document.title === "") {
    push("SEARCH_DOCUMENT_TITLE_EMPTY", "document has no title — extraction found no title field");
  }
  if (
    document.title === "" &&
    document.summary === "" &&
    document.body_text === "" &&
    document.aux_text === ""
  ) {
    push("SEARCH_DOCUMENT_EMPTY", "document carries no searchable text at all");
  }
  return issues;
}

/** Throws SEARCH_DOCUMENT_INVALID when a document violates index invariants. */
export function assertIndexableDocument(document: SearchDocument): void {
  const issues = validateSearchDocument(document);
  const blocking = issues.filter((issue) => issue.code !== "SEARCH_DOCUMENT_TITLE_EMPTY");
  if (blocking.length > 0) {
    throw new SearchError("SEARCH_DOCUMENT_INVALID", blocking[0]?.message ?? "invalid document", {
      details: { issues: blocking.map((issue) => issue.code) },
    });
  }
}
