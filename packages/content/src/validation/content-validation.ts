// Draft vs publish-level content validation core (PCMS-CONT-T012;
// Content spec §61/§65/§66).
//
// Two validation levels (§65):
//   draft  — schema/type safety, payload limits, parseability; a draft may be
//            incomplete, so missing required fields are tolerated;
//   publish — additionally enforces required fields and resolves references
//            (relations against the entries lookup; media availability through
//            an injected Media checker, fully wired when Media lands in M05).
// Every issue carries a stable machine code + JSON-pointer path (§66);
// warnings are kept separate from errors.
import type { LoadedContentType } from "../content-types/content-type.js";
import { EXTENSIONS_KEY, extensionIssues } from "../extensions/extension-data.js";
import {
  checkRelationTarget,
  type EntryLookup,
  type ReferenceIssue,
} from "../fields/reference-fields.js";
import type { FieldSchema } from "../fields/structured-schemas.js";
import { validateStructuredValue } from "../fields/structured-schemas.js";
import { isStableId, type StableId } from "../ids/stable-id.js";

export type ValidationLevel = "draft" | "publish";
export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  /** Stable machine code, e.g. "FIELD_REQUIRED" (Content spec §66). */
  readonly code: string;
  /** JSON-pointer path into the revision fields, e.g. "/fields/hero_image". */
  readonly path: string;
  readonly message: string;
  readonly severity: ValidationSeverity;
  /** Producing layer; cross-subsystem validators add their own sources. */
  readonly source: "content-schema";
}

export interface ContentValidationResult {
  readonly level: ValidationLevel;
  readonly ok: boolean;
  readonly errors: ValidationIssue[];
  readonly warnings: ValidationIssue[];
}

export interface ContentValidatorOptions {
  /** Entries lookup for publish-level referential validation (§61). */
  readonly entries?: EntryLookup;
  /**
   * Media availability check for publish validation (§65); when omitted,
   * media existence is not checked (Media subsystem lands in M05).
   */
  readonly checkMediaAsset?: (assetId: StableId) => Promise<boolean>;
}

function toIssue(reference: ReferenceIssue, code?: string): ValidationIssue {
  return {
    code: code ?? reference.code,
    path: `/fields${reference.path}`,
    message: reference.message,
    severity: "error",
    source: "content-schema",
  };
}

/** Deep clone of a schema with all `required` flags removed (draft leniency). */
function stripRequired(schema: FieldSchema): FieldSchema {
  const clone = { ...schema } as { required?: boolean };
  delete clone.required;
  if ("fields" in clone && typeof clone.fields === "object" && clone.fields !== null) {
    const fields = clone.fields as Record<string, FieldSchema>;
    const stripped: Record<string, FieldSchema> = {};
    for (const [key, child] of Object.entries(fields)) stripped[key] = stripRequired(child);
    clone.fields = stripped;
  }
  if ("item" in clone && typeof clone.item === "object" && clone.item !== null) {
    const item = clone.item as { fields?: Record<string, FieldSchema> } & Record<string, unknown>;
    if (item.fields !== undefined) {
      const stripped: Record<string, FieldSchema> = {};
      for (const [key, child] of Object.entries(item.fields)) stripped[key] = stripRequired(child);
      clone.item = { ...item, fields: stripped };
    } else if ("type" in item) {
      clone.item = stripRequired(item as unknown as FieldSchema);
    }
  }
  return clone as FieldSchema;
}

interface ReferenceHit {
  schema: FieldSchema;
  value: unknown;
  path: string;
}

/** Collects reference-typed values with their paths for publish checks. */
function collectReferenceHits(
  schema: FieldSchema,
  value: unknown,
  path: string,
  hits: ReferenceHit[],
): void {
  if (value === undefined || value === null) return;
  if (
    schema.type === "relation" ||
    schema.type === "relation_list" ||
    schema.type === "media" ||
    schema.type === "media_list"
  ) {
    hits.push({ schema, value, path });
    return;
  }
  if ("fields" in schema && typeof schema.fields === "object" && schema.fields !== null) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(schema.fields)) {
      collectReferenceHits(child, record[key], `${path}/${key}`, hits);
    }
    return;
  }
  if ("item" in schema && typeof schema.item === "object" && schema.item !== null) {
    if (!Array.isArray(value)) return;
    const item = schema.item as { fields?: Record<string, FieldSchema> } & FieldSchema;
    if (item.fields !== undefined) {
      value.forEach((entry, index) => {
        if (typeof entry !== "object" || entry === null) return;
        const record = entry as Record<string, unknown>;
        for (const [key, child] of Object.entries(item.fields ?? {})) {
          collectReferenceHits(child, record[key], `${path}/${index}/${key}`, hits);
        }
      });
    } else {
      value.forEach((entry, index) => {
        collectReferenceHits(item as unknown as FieldSchema, entry, `${path}/${index}`, hits);
      });
    }
  }
}

export function validateContentPayload(
  contentType: LoadedContentType,
  fields: unknown,
  level: ValidationLevel,
  _options: ContentValidatorOptions = {},
): ContentValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Level 1 (both levels): schema/type safety, limits, parseability. Draft
  // strips `required` — an incomplete draft is valid by definition (§65).
  const schema =
    level === "draft"
      ? ({ id: contentType.key, type: "object", fields: contentType.fieldSchema.fields } as const)
      : contentType.fieldSchema;
  const effectiveSchema = level === "draft" ? stripRequired(schema as FieldSchema) : schema;
  // The root `extensions` envelope is validated separately (§68) and never
  // leaks into the typed-field structural pass as an unknown field.
  const hasEnvelope =
    typeof fields === "object" &&
    fields !== null &&
    !Array.isArray(fields) &&
    EXTENSIONS_KEY in (fields as Record<string, unknown>);
  let fieldPayload = fields;
  if (hasEnvelope) {
    const { [EXTENSIONS_KEY]: _extensions, ...rest } = fields as Record<string, unknown>;
    void _extensions;
    fieldPayload = rest;
  }
  const structural = validateStructuredValue(effectiveSchema, fieldPayload);
  if (!structural.ok) {
    for (const issue of structural.issues) {
      // Content spec §66 names the missing-required publish error FIELD_REQUIRED.
      errors.push(
        toIssue(
          issue,
          level === "publish" && issue.code === "REQUIRED_MISSING" ? "FIELD_REQUIRED" : undefined,
        ),
      );
    }
  }
  if (hasEnvelope) {
    for (const issue of extensionIssues(fields)) {
      errors.push({
        code: issue.code,
        path: `/fields${issue.path}`,
        message: issue.message,
        severity: "error",
        source: "content-schema",
      });
    }
  }

  return {
    level,
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Async publish-level completion of {@link validateContentPayload}: resolves
 * relation targets and media availability. The sync core handles structure;
 * referential resolution needs injected lookups and therefore awaits.
 */
export async function validateContentPayloadAsync(
  contentType: LoadedContentType,
  fields: unknown,
  level: ValidationLevel,
  options: ContentValidatorOptions = {},
): Promise<ContentValidationResult> {
  const result = validateContentPayload(contentType, fields, level, options);
  if (level !== "publish") return result;

  const errors: ValidationIssue[] = [...result.errors];
  const hits: ReferenceHit[] = [];
  collectReferenceHits(contentType.fieldSchema, fields, "", hits);

  for (const hit of hits) {
    const path = `/fields${hit.path}`;
    if (hit.schema.type === "relation" || hit.schema.type === "relation_list") {
      const isList = hit.schema.type === "relation_list";
      const targets = isList ? (Array.isArray(hit.value) ? hit.value : []) : [hit.value];
      const accepts = (hit.schema as { accepts?: readonly string[] }).accepts;
      if (options.entries === undefined) continue; // no lookup injected → structural-only run
      for (const [index, target] of targets.entries()) {
        if (!isStableId(target)) continue; // malformed shape already an error
        const violation = await checkRelationTarget(options.entries, target, accepts);
        if (violation !== null) {
          errors.push(toIssue({ ...violation, path: isList ? `${hit.path}/${index}` : hit.path }));
        }
      }
    }
    if (
      (hit.schema.type === "media" || hit.schema.type === "media_list") &&
      options.checkMediaAsset !== undefined
    ) {
      const assets =
        hit.schema.type === "media" ? [hit.value] : Array.isArray(hit.value) ? hit.value : [];
      for (const [index, asset] of assets.entries()) {
        if (!isStableId(asset)) continue;
        const available = await options.checkMediaAsset(asset as StableId);
        if (!available) {
          errors.push({
            code: "MEDIA_NOT_FOUND",
            path: `${path}${hit.schema.type === "media_list" ? `/${index}` : ""}`,
            message: "media asset does not exist or is not available",
            severity: "error",
            source: "content-schema",
          });
        }
      }
    }
  }
  return {
    level,
    ok: errors.length === 0,
    errors,
    warnings: result.warnings,
  };
}
