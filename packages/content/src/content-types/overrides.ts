// Content type schema overrides + additive-change analysis (2026-09-29,
// "schemas via API": the content_schema.propose/apply permissions existed
// without a mechanism — the only path was editing /etc content-types.json on
// the deployment). The typesFile stays the base; API applies persist additive
// overrides (wholesale per key@version) that web AND worker overlay at boot.
//
// Additive-only policy: brand-new types and new OPTIONAL fields on existing
// types. Anything that could make an existing payload invalid (field removed,
// field type changed, field became required, bodyPolicy changed, version
// semantics) is a violation, reported with a stable code — never applied.

import type { DbPool } from "@pcms/core";
import { ContentError } from "../errors.js";
import type { ContentTypeDefinition, LoadedContentType } from "./content-type.js";

/**
 * Accepts both definition shapes that exist in the wild: the deployment
 * typesFile holds a bare array, while tooling/fixtures use the
 * `{ contentTypes: [...] }` wrapper. One parser so files stop bouncing
 * between formats (2026-09-29 site-developer report, item 2a).
 */
export function parseDefinitionsInput(input: unknown): ContentTypeDefinition[] {
  if (Array.isArray(input)) return input as ContentTypeDefinition[];
  if (
    typeof input === "object" &&
    input !== null &&
    Array.isArray((input as { contentTypes?: unknown }).contentTypes)
  ) {
    return (input as { contentTypes: ContentTypeDefinition[] }).contentTypes;
  }
  throw new ContentError(
    "SCHEMA_INVALID",
    'definitions must be an array or {"contentTypes": [...]}',
  );
}

export interface ContentTypeDiff {
  /** key@version entirely new against the current set. */
  readonly added_types: readonly string[];
  /** key@version → field ids added on an existing type (all optional). */
  readonly added_fields: Readonly<Record<string, readonly string[]>>;
  /** Cosmetic-only edits (title/description/template hint). */
  readonly changed_meta: readonly string[];
  /** Non-additive edits — each one blocks apply with its reason. */
  readonly violations: readonly { code: string; message: string }[];
}

/**
 * Classifies proposed definitions against the currently effective set.
 * Both sides are normalized (LoadedContentType), so field comparison runs on
 * the registered shape, not on raw JSON.
 */
export function diffContentTypeDefinitions(
  current: readonly LoadedContentType[],
  proposed: readonly LoadedContentType[],
): ContentTypeDiff {
  const currentByKey = new Map(
    current.map((loaded) => [`${loaded.key}@${loaded.version}`, loaded]),
  );
  const addedTypes: string[] = [];
  const addedFields: Record<string, string[]> = {};
  const changedMeta: string[] = [];
  const violations: { code: string; message: string }[] = [];

  for (const next of proposed) {
    const mapKey = `${next.key}@${next.version}`;
    const before = currentByKey.get(mapKey);
    if (before === undefined) {
      addedTypes.push(mapKey);
      continue;
    }
    for (const [fieldId, field] of Object.entries(next.fieldSchema.fields)) {
      if (fieldId in before.fieldSchema.fields) continue;
      if (field.required === true) {
        violations.push({
          code: "SCHEMA_CHANGE_NOT_ADDITIVE",
          message: `${mapKey}: field "${fieldId}" is new but required — new fields must be optional`,
        });
        continue;
      }
      const bucket = addedFields[mapKey] ?? [];
      bucket.push(fieldId);
      addedFields[mapKey] = bucket;
    }
    for (const fieldId of Object.keys(before.fieldSchema.fields)) {
      if (!(fieldId in next.fieldSchema.fields)) {
        violations.push({
          code: "SCHEMA_CHANGE_NOT_ADDITIVE",
          message: `${mapKey}: field "${fieldId}" is removed — removals are out of scope for apply`,
        });
      }
    }
    for (const [fieldId, field] of Object.entries(next.fieldSchema.fields)) {
      const was = before.fieldSchema.fields[fieldId];
      if (was === undefined) continue;
      if (was.type !== field.type) {
        violations.push({
          code: "SCHEMA_CHANGE_NOT_ADDITIVE",
          message: `${mapKey}: field "${fieldId}" type changed ${was.type} → ${field.type}`,
        });
      }
      if (was.required === true && field.required !== true) {
        violations.push({
          code: "SCHEMA_CHANGE_NOT_ADDITIVE",
          message: `${mapKey}: field "${fieldId}" dropped its required flag`,
        });
      }
    }
    if (before.bodyPolicy !== next.bodyPolicy) {
      violations.push({
        code: "SCHEMA_CHANGE_NOT_ADDITIVE",
        message: `${mapKey}: bodyPolicy changed ${before.bodyPolicy} → ${next.bodyPolicy}`,
      });
    }
    if (before.title !== next.title || before.description !== next.description) {
      changedMeta.push(mapKey);
    }
  }
  return {
    added_types: addedTypes,
    added_fields: addedFields,
    changed_meta: changedMeta,
    violations,
  };
}

/**
 * Boot-time overlay: override rows replace/append wholesale per key@version.
 * Validation happens at apply time; here an override that fails registration
 * fails startup exactly like an invalid typesFile (fail-secure, no partial
 * schema).
 */
export function mergeContentTypeDefinitions(
  base: readonly ContentTypeDefinition[],
  overrides: readonly ContentTypeDefinition[],
): ContentTypeDefinition[] {
  const byKeyVersion = new Map(
    base.map((definition) => [`${definition.key}@${definition.version}`, definition]),
  );
  for (const override of overrides) {
    byKeyVersion.set(`${override.key}@${override.version}`, override);
  }
  return [...byKeyVersion.values()];
}

interface OverrideRow extends Record<string, unknown> {
  readonly content_type_id: string;
  readonly version: number;
  readonly definition: unknown;
}

/**
 * Boot-time effective set for web AND worker: typesFile base overlaid with
 * persisted API overrides. A missing overrides table (pre-migration
 * deployment) means "no overrides", not a failure; a corrupt override fails
 * registration downstream exactly like an invalid typesFile (fail-secure).
 */
export async function loadContentTypeOverrides(pool: DbPool): Promise<ContentTypeDefinition[]> {
  let rows: OverrideRow[];
  try {
    const result = await pool.query<OverrideRow>(
      "SELECT content_type_id, version, definition FROM pcms_content_type_overrides ORDER BY content_type_id, version",
    );
    rows = result.rows;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }
  return rows.map((row) => ({
    ...(row.definition as ContentTypeDefinition),
    key: row.content_type_id,
    version: row.version,
  }));
}

export async function effectiveContentTypeDefinitions(
  pool: DbPool,
  fileDefinitions: readonly ContentTypeDefinition[] | undefined,
): Promise<ContentTypeDefinition[]> {
  const overrides = await loadContentTypeOverrides(pool);
  if (overrides.length === 0) return [...(fileDefinitions ?? [])];
  return mergeContentTypeDefinitions(fileDefinitions ?? [], overrides);
}
