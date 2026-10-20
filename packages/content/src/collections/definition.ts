// CollectionDefinition DSL + operator whitelist (PCMS-CONT-T020;
// Content spec §55/§57/§58/§59).
//
// A Collection is a declarative request against the published/preview content
// graph. The DSL allows only explicitly supported fields and operators —
// there is no arbitrary SQL and no arbitrary expressions (§55/§57). Field
// hints (`filterable`/`sortable`) gate usage (§59); `limit` has a hard
// maximum (§58).

import type { LoadedContentType } from "../content-types/content-type.js";
import { ContentError } from "../errors.js";
import { isStableId, type StableId } from "../ids/stable-id.js";

export const FILTER_OPS = ["eq", "neq", "in", "contains", "gte", "lte", "exists"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export type SortDirection = "asc" | "desc";

/** Hard maximum preventing accidental query explosion (Content spec §58). */
export const MAX_COLLECTION_LIMIT = 100;

/** Declarative context value references (Content spec §57) — no expressions. */
export const CONTEXT_REFS = [
  "current_locale",
  "current_entry.id",
  "current_entry.content_type",
] as const;
export type ContextRef = (typeof CONTEXT_REFS)[number];

export interface FilterCondition {
  readonly field: string;
  readonly op: FilterOp;
  /** Literal value — mutually exclusive with `context`. */
  readonly value?: string | number | boolean | readonly (string | number)[];
  /** Context reference value — mutually exclusive with `value`. */
  readonly context?: ContextRef;
}

export interface SortSpec {
  readonly field: string;
  readonly direction: SortDirection;
}

export type CollectionMode = "automatic" | "manual" | "hybrid";

export interface CollectionDefinition {
  readonly source: { readonly contentTypes: readonly string[] };
  readonly mode: CollectionMode;
  /** manual/hybrid: ordered explicit Entry IDs. */
  readonly pinnedIds?: readonly StableId[];
  readonly filters?: readonly FilterCondition[];
  readonly sort?: readonly SortSpec[];
  /** automatic/hybrid fill bound (§58). */
  readonly limit?: number;
}

const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

function fieldSchemaOf(schema: LoadedContentType, field: string) {
  return schema.fieldSchema.fields[field];
}

/** Validates a collection definition against the ContentType schemas (§55). */
export function validateCollectionDefinition(
  definition: CollectionDefinition,
  schemas: ReadonlyMap<string, LoadedContentType>,
): LoadedContentType[] {
  if (definition.source.contentTypes.length === 0) {
    throw new ContentError("COLLECTION_SOURCE_EMPTY", "collection needs at least one content type");
  }
  const resolved: LoadedContentType[] = [];
  for (const key of definition.source.contentTypes) {
    const schema = schemas.get(key);
    if (schema === undefined) {
      throw new ContentError(
        "COLLECTION_SOURCE_UNKNOWN",
        `content type "${key}" is not registered`,
      );
    }
    resolved.push(schema);
  }
  const primary = resolved[0];
  if (primary === undefined) {
    throw new ContentError("COLLECTION_SOURCE_EMPTY", "collection needs at least one content type");
  }

  for (const filter of definition.filters ?? []) {
    if (!FILTER_OPS.includes(filter.op)) {
      throw new ContentError(
        "COLLECTION_OP_NOT_ALLOWED",
        `operator "${String(filter.op)}" is not in the whitelist`,
      );
    }
    if (!FIELD_NAME_RE.test(filter.field)) {
      throw new ContentError("COLLECTION_FIELD_INVALID", `invalid field name "${filter.field}"`);
    }
    const fieldSchema = fieldSchemaOf(primary, filter.field);
    if (fieldSchema === undefined) {
      throw new ContentError(
        "COLLECTION_FIELD_UNKNOWN",
        `field "${filter.field}" does not exist on "${primary.key}"`,
      );
    }
    // §59: filterable hint gates filter usage.
    if ((fieldSchema as { filterable?: boolean }).filterable !== true) {
      throw new ContentError(
        "COLLECTION_FIELD_NOT_FILTERABLE",
        `field "${filter.field}" is not declared filterable`,
      );
    }
    if (filter.op === "contains") {
      const type = fieldSchema.type;
      if (type !== "string" && type !== "text" && type !== "slug") {
        throw new ContentError(
          "COLLECTION_OP_UNSUPPORTED",
          `contains is only supported for string/text fields, not "${String(type)}"`,
        );
      }
    }
    if (filter.op === "exists") {
      if (filter.value !== undefined || filter.context !== undefined) {
        throw new ContentError("COLLECTION_CONDITION_INVALID", "exists takes no value");
      }
    } else if (filter.value === undefined && filter.context === undefined) {
      throw new ContentError(
        "COLLECTION_CONDITION_INVALID",
        "condition needs a value or context ref",
      );
    } else if (filter.value !== undefined && filter.context !== undefined) {
      throw new ContentError(
        "COLLECTION_CONDITION_INVALID",
        "condition must use either value or context, not both",
      );
    }
    if (filter.context !== undefined && !CONTEXT_REFS.includes(filter.context)) {
      throw new ContentError(
        "COLLECTION_CONTEXT_UNKNOWN",
        `context ref "${String(filter.context)}" is not in the whitelist`,
      );
    }
  }

  for (const sort of definition.sort ?? []) {
    if (!FIELD_NAME_RE.test(sort.field)) {
      throw new ContentError("COLLECTION_FIELD_INVALID", `invalid field name "${sort.field}"`);
    }
    const fieldSchema = fieldSchemaOf(primary, sort.field);
    if (fieldSchema === undefined) {
      throw new ContentError("COLLECTION_FIELD_UNKNOWN", `field "${sort.field}" does not exist`);
    }
    if ((fieldSchema as { sortable?: boolean }).sortable !== true) {
      throw new ContentError(
        "COLLECTION_FIELD_NOT_SORTABLE",
        `field "${sort.field}" is not declared sortable`,
      );
    }
    if (sort.direction !== "asc" && sort.direction !== "desc") {
      throw new ContentError("COLLECTION_DIRECTION_INVALID", "direction must be asc or desc");
    }
  }

  if (definition.limit !== undefined) {
    if (
      !Number.isInteger(definition.limit) ||
      definition.limit < 1 ||
      definition.limit > MAX_COLLECTION_LIMIT
    ) {
      throw new ContentError(
        "COLLECTION_LIMIT_INVALID",
        `limit must be an integer in 1..${MAX_COLLECTION_LIMIT}`,
      );
    }
  }

  if (definition.mode === "manual" || definition.mode === "hybrid") {
    const pinned = definition.pinnedIds ?? [];
    if (definition.mode === "manual" && pinned.length === 0) {
      throw new ContentError("COLLECTION_PINNED_REQUIRED", "manual collection needs pinnedIds");
    }
    if (new Set(pinned).size !== pinned.length) {
      throw new ContentError("COLLECTION_PINNED_DUPLICATE", "pinnedIds contains duplicates");
    }
    for (const id of pinned) {
      if (!isStableId(id)) {
        throw new ContentError("COLLECTION_PINNED_INVALID", "pinnedIds must be stable Entry IDs");
      }
    }
  }
  return resolved;
}
