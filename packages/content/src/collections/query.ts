// Collection query compiler (PCMS-CONT-T020; Content spec §55/§58).
//
// Compiles a validated CollectionDefinition into fully parameterized SQL over
// the canonical published-content source binding. Field names and table names
// NEVER get interpolated as values: field names are bound as parameters to a
// jsonb extraction and identifiers are validated against ^[a-z_][a-z0-9_]*$.
// The source binding itself is composition-root configuration, not user
// input — the published payload view plugs in with publication (M07).
import { ContentError } from "../errors.js";
import { type FilterCondition, MAX_COLLECTION_LIMIT } from "./definition.js";

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

export interface CollectionSourceBinding {
  /** Canonical payload projection table/view, e.g. "published_content". */
  readonly payloadTable: string;
  /** Column holding the fields jsonb. Defaults to "fields". */
  readonly fieldsColumn?: string;
  /** Column holding the entry id. Defaults to "entry_id". */
  readonly entryIdColumn?: string;
  /** Column holding the content type key. Defaults to "content_type". */
  readonly contentTypeColumn?: string;
}

export interface CompiledCollectionQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function assertIdentifier(name: string, label: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new ContentError(
      "COLLECTION_SOURCE_INVALID",
      `${label} "${name}" is not a valid identifier`,
    );
  }
  return name;
}

/** Escapes LIKE/ILIKE metacharacters so a `contains` value matches
 * literally — `%`, `_` and `\` in user input must not widen the filter. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function compileAutomaticCollection(
  options: {
    contentTypes: readonly string[];
    filters?: readonly FilterCondition[];
    sort?: readonly { field: string; direction: "asc" | "desc" }[];
    limit?: number;
    /**
     * Fields whose values must compare numerically (integer/decimal/money per
     * the schema); jsonb text extraction would compare lexicographically.
     */
    numericFields?: readonly string[];
  },
  source: CollectionSourceBinding,
): CompiledCollectionQuery {
  const numeric = new Set(options.numericFields ?? []);
  const table = assertIdentifier(source.payloadTable, "payloadTable");
  const fieldsColumn = assertIdentifier(source.fieldsColumn ?? "fields", "fieldsColumn");
  const entryIdColumn = assertIdentifier(source.entryIdColumn ?? "entry_id", "entryIdColumn");
  const contentTypeColumn = assertIdentifier(
    source.contentTypeColumn ?? "content_type",
    "contentTypeColumn",
  );

  const params: unknown[] = [];
  const bind = (value: unknown, cast?: string): string => {
    params.push(value);
    return cast === undefined ? `$${params.length}` : `$${params.length}::${cast}`;
  };

  const where: string[] = [];
  where.push(`e.${contentTypeColumn} = ANY(${bind(options.contentTypes, "text[]")})`);
  where.push("e.archived_at IS NULL");

  for (const filter of options.filters ?? []) {
    // Field name is a bound parameter for the jsonb extraction — the DSL
    // whitelist has already validated it against the schema (§55).
    const fieldParam = bind(filter.field, "text");
    const rawRef = `e.${fieldsColumn}->>${fieldParam}`;
    const fieldRef = numeric.has(filter.field) ? `(${rawRef})::numeric` : rawRef;
    if (filter.op === "exists") {
      where.push(`(${fieldRef}) IS NOT NULL`);
      continue;
    }
    // Explicit casts give PostgreSQL full type information for every bound
    // parameter; jsonb text extraction compares as text unless numeric.
    const valueCast = numeric.has(filter.field) ? "numeric" : "text";
    if (filter.op === "in") {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      const placeholders = values.map((value) => bind(value, valueCast)).join(", ");
      where.push(`${fieldRef} IN (${placeholders})`);
      continue;
    }
    // One bound parameter per filter; `contains` escapes the LIKE
    // metacharacters and binds as text (the escape needs a string), other
    // ops keep the field cast.
    const valueParam = bind(
      filter.op === "contains" ? escapeLikePattern(String(filter.value)) : filter.value,
      filter.op === "contains" ? "text" : valueCast,
    );
    switch (filter.op) {
      case "eq":
        where.push(`${fieldRef} = ${valueParam}`);
        break;
      case "neq":
        where.push(`(${fieldRef} <> ${valueParam} OR ${fieldRef} IS NULL)`);
        break;
      case "contains":
        where.push(`${fieldRef} ILIKE '%' || ${valueParam} || '%' ESCAPE '\\'`);
        break;
      case "gte":
        where.push(`${fieldRef} >= ${valueParam}`);
        break;
      case "lte":
        where.push(`${fieldRef} <= ${valueParam}`);
        break;
    }
  }

  let orderBy = "";
  const parts: string[] = [];
  for (const sort of options.sort ?? []) {
    const fieldParam = bind(sort.field, "text");
    const fieldRef = numeric.has(sort.field)
      ? `(e.${fieldsColumn}->>${fieldParam})::numeric`
      : `e.${fieldsColumn}->>${fieldParam}`;
    parts.push(`${fieldRef} ${sort.direction === "desc" ? "DESC" : "ASC"}`);
  }
  // Stable tiebreaker so result order is deterministic.
  parts.push(`e.${entryIdColumn} ASC`);
  orderBy = ` ORDER BY ${parts.join(", ")}`;

  const limit = options.limit ?? MAX_COLLECTION_LIMIT;
  const sql = `SELECT e.${entryIdColumn} AS entry_id FROM ${table} e WHERE ${where.join(" AND ")}${orderBy} LIMIT ${bind(limit, "int")}`;
  return { sql, params };
}
