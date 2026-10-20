// Pagination conventions (PCMS-API-T006; spec §13).
// Keyset cursors over (id DESC): UUIDv7 ids are time-ordered, so the cursor
// never skips or repeats under concurrent inserts (owner instruction #27).
// Every list endpoint is bounded — no unbounded collections.
import { ApiError } from "../errors.js";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Cursors are opaque, but never anything but base64url (encodeCursor). */
const CURSOR_CHARS = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_CHARS = 512;

/** Part separator inside a multi-key cursor (ASCII unit separator 0x1F). */
const CURSOR_SEPARATOR = "";

/**
 * Shared cursor shape gate (audit F-49): a cursor outside the strict
 * base64url alphabet decodes through silent character-dropping, which has
 * produced NaN offsets and 500s. Malformed cursors are a client error.
 */
function assertCursorShape(cursor: string): void {
  if (cursor.length > MAX_CURSOR_CHARS || !CURSOR_CHARS.test(cursor)) {
    throw new ApiError("API_REQUEST_INVALID", "cursor is not valid", { status: 400 });
  }
}

export interface PageRequest {
  readonly limit: number;
  readonly cursor: string | null;
}

export function parsePageRequest(query: Record<string, unknown>): PageRequest {
  const rawLimit = query.limit;
  let limit = DEFAULT_PAGE_LIMIT;
  if (typeof rawLimit === "string" && rawLimit.length > 0) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
      throw new ApiError(
        "API_REQUEST_INVALID",
        `limit must be an integer in [1, ${MAX_PAGE_LIMIT}]`,
        {
          status: 400,
        },
      );
    }
    limit = parsed;
  }
  const rawCursor = query.cursor;
  let cursor: string | null = null;
  if (typeof rawCursor === "string" && rawCursor.length > 0) {
    assertCursorShape(rawCursor);
    cursor = rawCursor;
  }
  return { limit, cursor };
}

/** Opaque, tamper-evident-enough cursor: base64url of the sort key. */
export function encodeCursor(...parts: readonly (string | number)[]): string {
  return Buffer.from(parts.map((part) => String(part)).join(CURSOR_SEPARATOR), "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string, expectedParts: number): (string | number)[] {
  assertCursorShape(cursor);
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const parts = raw.split(CURSOR_SEPARATOR);
  if (parts.length !== expectedParts) {
    throw new ApiError("API_REQUEST_INVALID", "cursor is not valid", { status: 400 });
  }
  return parts.map((part) => (/^-?\d+$/.test(part) ? Number(part) : part));
}

/**
 * Strict numeric offset cursor (audit F-49): shape-checked base64url, decoded
 * to a digits-only string, evaluated as a safe non-negative integer. Anything
 * else is a 400 — never a NaN that would reach SQL OFFSET and turn a malformed
 * cursor into an internal error. Numeric-cursor lists adopt this over raw
 * `Number(Buffer.from(...))` decoding.
 */
export function decodeOffsetCursor(cursor: string): number {
  assertCursorShape(cursor);
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^\d+$/.test(raw)) {
    throw new ApiError("API_REQUEST_INVALID", "cursor is not valid", { status: 400 });
  }
  const offset = Number(raw);
  if (offset >= Number.MAX_SAFE_INTEGER) {
    throw new ApiError("API_REQUEST_INVALID", "cursor is not valid", { status: 400 });
  }
  return offset;
}

export interface PageResult<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

/**
 * Assembles a page from items fetched with `limit + 1`. The extra item only
 * signals has_more and is trimmed.
 */
export function pageOf<T>(
  fetched: readonly T[],
  limit: number,
  cursorOf: (item: T) => (string | number)[],
): PageResult<T> {
  const hasMore = fetched.length > limit;
  const items = hasMore ? fetched.slice(0, limit) : fetched;
  const last = items.at(-1);
  return {
    items,
    next_cursor: hasMore && last !== undefined ? encodeCursor(...cursorOf(last)) : null,
    has_more: hasMore,
  };
}
