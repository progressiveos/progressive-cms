// PCMS-SEARCH-T005 — safe query parsing/limits: normalization, bounds,
// allowlists and cursor validation with frozen error codes (Search spec
// §10/§15/§17). Pure tests — no database, no SQL strings anywhere.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeCursor,
  localeTextSearchConfig,
  MAX_QUERY_LENGTH,
  normalizeQueryText,
  parseSearchQuery,
  SearchError,
} from "@pcms/search";

function throwsCode(run: () => unknown, code: string): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof SearchError && error.code === code,
    `expected ${code}`,
  );
}

const base = { q: "erp внедрение", site: "default", locale: "ru" };

test("normalization: NFKC, whitespace collapse, control/marker stripping", () => {
  // NFKC unfolds the ﬁ ligature; stripped control chars become spaces.
  assert.equal(normalizeQueryText("  ﬁle\u0001name\u0000  test \n q  "), "file name test q");
  const parsed = parseSearchQuery({ ...base, q: "\u0001DROP * ;--" });
  assert.equal(parsed.q, "DROP * ;--");
});

test("empty/oversized queries are rejected with SEARCH_QUERY_INVALID", () => {
  throwsCode(() => parseSearchQuery({ ...base, q: "   " }), "SEARCH_QUERY_INVALID");
  throwsCode(
    () => parseSearchQuery({ ...base, q: "a".repeat(MAX_QUERY_LENGTH + 1) }),
    "SEARCH_QUERY_INVALID",
  );
});

test("site/locale scope violations are rejected with SEARCH_SCOPE_VIOLATION", () => {
  throwsCode(() => parseSearchQuery({ ...base, site: "../other" }), "SEARCH_SCOPE_VIOLATION");
  throwsCode(() => parseSearchQuery({ ...base, locale: "ru' OR 1=1" }), "SEARCH_SCOPE_VIOLATION");
});

test("filters: allowlisted keys only, malformed values rejected", () => {
  const parsed = parseSearchQuery({
    ...base,
    content_type: "news",
    date_from: "2026-01-01",
    date_to: "2026-02-01T10:00:00Z",
  });
  assert.equal(parsed.filters.content_type, "news");
  throwsCode(
    () => parseSearchQuery({ ...base, content_type: "News; DROP" }),
    "SEARCH_FILTER_INVALID",
  );
  throwsCode(() => parseSearchQuery({ ...base, date_from: "yesterday" }), "SEARCH_FILTER_INVALID");
  throwsCode(
    () => parseSearchQuery({ ...base, date_from: "2026-05-01", date_to: "2026-01-01" }),
    "SEARCH_FILTER_INVALID",
  );
});

test("sort must come from the explicit mode list", () => {
  assert.equal(parseSearchQuery({ ...base }).sort, "relevance");
  assert.equal(parseSearchQuery({ ...base, sort: "date" }).sort, "date");
  for (const evil of ["score; DROP", "(select)", "relevance DESC--"]) {
    throwsCode(() => parseSearchQuery({ ...base, sort: evil }), "SEARCH_SORT_UNSUPPORTED");
  }
});

test("limit bounds and cursor window enforcement", () => {
  assert.equal(parseSearchQuery({ ...base }).limit, 20);
  throwsCode(() => parseSearchQuery({ ...base, limit: 0 }), "SEARCH_QUERY_INVALID");
  throwsCode(() => parseSearchQuery({ ...base, limit: 51 }), "SEARCH_QUERY_INVALID");
  const parsed = parseSearchQuery({ ...base, limit: 50, cursor: encodeCursor(450) });
  assert.equal(parsed.offset, 450);
  // 450 + 50 = 500 is the last legal page; one row further is refused.
  throwsCode(
    () => parseSearchQuery({ ...base, limit: 50, cursor: encodeCursor(451) }),
    "SEARCH_WINDOW_EXCEEDED",
  );
});

test("cursors are opaque and validated", () => {
  for (const bad of ["!!!", "off:abc", Buffer.from("drop:1").toString("base64url")]) {
    throwsCode(() => parseSearchQuery({ ...base, cursor: bad }), "SEARCH_CURSOR_INVALID");
  }
});

test("locale→config mapping mirrors the SQL function (RU/EN/simple)", () => {
  assert.equal(localeTextSearchConfig("ru"), "russian");
  assert.equal(localeTextSearchConfig("ru-RU"), "russian");
  assert.equal(localeTextSearchConfig("en"), "english");
  assert.equal(localeTextSearchConfig("en-US"), "english");
  assert.equal(localeTextSearchConfig("default"), "simple");
  assert.equal(localeTextSearchConfig("de"), "simple");
});
