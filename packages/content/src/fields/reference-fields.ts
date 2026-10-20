// Media/Relation reference field contracts (PCMS-CONT-T007;
// Content spec §21/§22).
//
// Reference fields store stable IDs — never filesystem paths, generated URLs
// or slugs: `media` references a Media Asset ID (exact usage-metadata
// contract arrives with the Media subsystem, M05), `relation` references an
// Entry ID with optional target content-type restriction and mandatory
// referential validation. Shape validation here is pure; existence/type
// checks run against the entries service.
import { type EntryId, isStableId, type StableId } from "../ids/stable-id.js";

export interface ReferenceIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Media/relations reference lists keep their order (Content spec §21/§22). */
export type MediaValue = StableId;
export type MediaListValue = StableId[];
export type RelationValue = EntryId;
export type RelationListValue = EntryId[];

export function validateMediaValue(value: unknown, path: string): ReferenceIssue[] {
  if (isStableId(value)) return [];
  return [
    {
      code: "MEDIA_REF_INVALID",
      path,
      message:
        "media fields reference a Media Asset ID (stable UUIDv7); filesystem paths and URLs are not identities",
    },
  ];
}

export function validateMediaListValue(value: unknown, path: string): ReferenceIssue[] {
  if (!Array.isArray(value)) {
    return [{ code: "TYPE_MISMATCH", path, message: "expected an ordered array of asset IDs" }];
  }
  const issues: ReferenceIssue[] = [];
  value.forEach((item, index) => {
    if (!isStableId(item)) {
      issues.push({
        code: "MEDIA_REF_INVALID",
        path: `${path}/${index}`,
        message: "media_list items must be Media Asset IDs",
      });
    }
  });
  return issues;
}

export function validateRelationValue(value: unknown, path: string): ReferenceIssue[] {
  if (isStableId(value)) return [];
  return [
    {
      code: "RELATION_REF_INVALID",
      path,
      message:
        "relation fields reference an Entry ID (stable UUIDv7); slugs/URLs are not identities",
    },
  ];
}

export function validateRelationListValue(value: unknown, path: string): ReferenceIssue[] {
  if (!Array.isArray(value)) {
    return [{ code: "TYPE_MISMATCH", path, message: "expected an ordered array of Entry IDs" }];
  }
  const issues: ReferenceIssue[] = [];
  value.forEach((item, index) => {
    if (!isStableId(item)) {
      issues.push({
        code: "RELATION_REF_INVALID",
        path: `${path}/${index}`,
        message: "relation_list items must be Entry IDs",
      });
    }
  });
  return issues;
}

/** Minimal read surface the referential check needs (no DB coupling here). */
export interface EntryLookup {
  findEntry(id: EntryId): Promise<{ id: EntryId; contentTypeId: string } | null>;
}

export type RelationTargetIssueCode = "RELATION_TARGET_NOT_FOUND" | "RELATION_TYPE_REJECTED";

/**
 * Referential validation for one relation value (Content spec §22 — mandatory
 * for relations): the target must exist and, when the schema restricts
 * `accepts`, its content type must be allowed.
 */
export async function checkRelationTarget(
  entries: EntryLookup,
  target: unknown,
  accepts: readonly string[] | undefined,
): Promise<ReferenceIssue | null> {
  const found = isStableId(target) ? await entries.findEntry(target as EntryId) : null;
  if (found === null) {
    return {
      code: "RELATION_TARGET_NOT_FOUND",
      path: "",
      message: "relation target entry does not exist",
    };
  }
  if (accepts !== undefined && !accepts.includes(found.contentTypeId)) {
    return {
      code: "RELATION_TYPE_REJECTED",
      path: "",
      message: `relation target content type "${found.contentTypeId}" is not accepted (allows: ${accepts.join(", ")})`,
    };
  }
  return null;
}
