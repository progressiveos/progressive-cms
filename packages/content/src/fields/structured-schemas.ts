// Object/List/Repeater structured field schemas (PCMS-CONT-T006;
// Content spec §23/§24/§25/§26).
//
// `object` replaces MIGX-style typed nested groups (§23), `list<T>` holds
// ordered simple/structured values (§24), `repeater` is the ordered typed-row
// workhorse where every item carries a stable item ID for diff/reorder (§25).
// Limits are mandatory in spirit: even when a schema declares no max, the
// global hard safety limit applies — unbounded payloads are rejected (§26).
// Validation issues carry JSON-pointer-style paths so transports can point at
// the exact offending location.

import { ContentError } from "../errors.js";
import { isStableId } from "../ids/stable-id.js";
import { validateRichText } from "../richtext/ast.js";
import { createFieldRegistry, type FieldRegistry, type FieldTypeName } from "./field-registry.js";
import {
  validateMediaListValue,
  validateMediaValue,
  validateRelationListValue,
  validateRelationValue,
} from "./reference-fields.js";
import {
  dateIssues,
  datetimeIssues,
  decimalIssues,
  enumIssues,
  integerIssues,
  moneyIssues,
} from "./scalar-serialization.js";

const ENUM_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** Font Awesome class value: style class + exactly one icon name class. */
const ICON_VALUE_RE =
  /^fa-(?:solid|regular|brands|light|thin|duotone) fa-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** String-family field types (Content spec §14/§20): Unicode string values. */
const STRING_FIELD_TYPES: ReadonlySet<string> = new Set([
  "string",
  "text",
  "slug",
  "url",
  "email",
  "phone",
]);

/** Reserved key carrying the stable Repeater item identity (Content spec §25). */
export const REPEATER_ITEM_ID_KEY = "itemId";

/** Search weight classes surfaced to the M11 derived search index (Search spec §5). */
export const SEARCH_WEIGHT_CLASSES = ["A", "B", "C", "D"] as const;
export type SearchWeightClass = (typeof SEARCH_WEIGHT_CLASSES)[number];

/** Global hard safety limit for repeater item counts (Content spec §26). */
export const MAX_REPEATER_ITEMS = 1000;
/** Hard bound for schema nesting depth (object/list/repeater recursion). */
export const MAX_SCHEMA_DEPTH = 16;

export interface ScalarFieldSchema {
  readonly id: string;
  readonly type: FieldTypeName;
  /** Required fields must carry a non-null value (Content spec §12). */
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;
}

export interface ObjectFieldSchema {
  readonly id: string;
  readonly type: "object";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;

  /** Explicit typed nested fields (Content spec §23 — object schema is always explicit). */
  readonly fields: Record<string, FieldSchema>;
}

export interface ListFieldSchema {
  readonly id: string;
  readonly type: "list";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;

  readonly item: FieldSchema;
}

export interface RepeaterFieldSchema {
  readonly id: string;
  readonly type: "repeater";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;

  /** Typed row shape; each validated row carries a stable `itemId`. */
  readonly item: { readonly fields: Record<string, FieldSchema> };
  readonly minItems?: number;
  readonly maxItems?: number;
  /** Item field whose values must be unique across rows (Content spec §26). */
  readonly uniqueBy?: string;
}

/** Relation field restricted to target content types (Content spec §22). */
export interface RelationFieldSchema {
  readonly id: string;
  readonly type: "relation";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;

  /** Allowed target content type keys; undefined = any Entry. */
  readonly accepts?: readonly string[];
}

export interface RelationListFieldSchema {
  readonly id: string;
  readonly type: "relation_list";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;

  readonly accepts?: readonly string[];
}

/** Money value shape is fixed by Content spec §18. */
export interface MoneyFieldSchema {
  readonly id: string;
  readonly type: "money";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;
}

/** Decimal with exact-string constraints (Content spec §17). */
export interface DecimalFieldSchema {
  readonly id: string;
  readonly type: "decimal";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;

  readonly min?: string;
  readonly max?: string;
  /** Total significant digits (1–38). */
  readonly precision?: number;
  /** Fractional digits (0–6, ≤ precision). */
  readonly scale?: number;
}

export interface IntegerFieldSchema {
  readonly id: string;
  readonly type: "integer";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;

  readonly min?: number;
  readonly max?: number;
}

/** Enum over stable machine keys (Content spec §20). */
export interface EnumFieldSchema {
  readonly id: string;
  readonly type: "enum";
  readonly required?: boolean;
  /** Index-strategy hints (Content spec §59). */
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly searchable?: boolean;
  /** Search weight class (M11, Search spec §5): A title / B intro / C body / D aux. */
  readonly search_weight?: SearchWeightClass;

  readonly values: readonly string[];
}

export type FieldSchema =
  | ScalarFieldSchema
  | ObjectFieldSchema
  | ListFieldSchema
  | RepeaterFieldSchema
  | RelationFieldSchema
  | RelationListFieldSchema
  | MoneyFieldSchema
  | DecimalFieldSchema
  | IntegerFieldSchema
  | EnumFieldSchema;

export interface StructuredIssue {
  /** Stable machine code, e.g. "REQUIRED_MISSING". */
  readonly code: string;
  /** JSON-pointer-style path to the offending location (without leading "#"). */
  readonly path: string;
  readonly message: string;
}

export type StructuredValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: StructuredIssue[] };

const FIELD_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

// Scalar `type` is a broad FieldTypeName union that overlaps the structural
// names, so discriminant narrowing alone cannot separate the variants —
// the structural property is part of each guard.
function isObjectSchema(schema: FieldSchema): schema is ObjectFieldSchema {
  return schema.type === "object" && "fields" in schema;
}
function isListSchema(schema: FieldSchema): schema is ListFieldSchema {
  return schema.type === "list" && "item" in schema;
}
function isRepeaterSchema(schema: FieldSchema): schema is RepeaterFieldSchema {
  return schema.type === "repeater" && "item" in schema;
}

function assertFieldId(id: string, context: string): void {
  if (!FIELD_ID_RE.test(id)) {
    throw new ContentError(
      "FIELD_ID_INVALID",
      `${context}: field id "${id}" must be lowercase snake_case (≤64 chars)`,
    );
  }
}

function assertRegistered(registry: FieldRegistry, type: string): void {
  if (!registry.hasFieldType(type)) {
    throw new ContentError(
      "FIELD_TYPE_UNREGISTERED",
      `field type "${type}" is not registered in the Field Registry`,
    );
  }
}

const CONTENT_TYPE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Validates the `accepts` restriction of relation fields (Content spec §22). */
function normalizeAccepts(
  accepts: readonly string[] | undefined,
  context: string,
): readonly string[] | undefined {
  if (accepts === undefined) return undefined;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new ContentError(
      "SCHEMA_INVALID",
      `${context}: accepts must be a non-empty array of content type keys`,
    );
  }
  for (const key of accepts) {
    if (!CONTENT_TYPE_KEY_RE.test(key)) {
      throw new ContentError(
        "SCHEMA_INVALID",
        `${context}: accepts contains an invalid content type key "${key}"`,
      );
    }
  }
  if (new Set(accepts).size !== accepts.length) {
    throw new ContentError("SCHEMA_INVALID", `${context}: accepts contains duplicate keys`);
  }
  return [...accepts];
}

function countDepth(schema: FieldSchema, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new ContentError(
      "SCHEMA_TOO_DEEP",
      `structured schema nesting exceeds the hard depth limit (${MAX_SCHEMA_DEPTH})`,
    );
  }
  if (isObjectSchema(schema)) {
    for (const child of Object.values(schema.fields)) countDepth(child, depth + 1);
  } else if (isListSchema(schema)) {
    countDepth(schema.item, depth + 1);
  } else if (isRepeaterSchema(schema)) {
    for (const child of Object.values(schema.item.fields)) countDepth(child, depth + 1);
  }
}

function defineSchema(schema: FieldSchema, registry: FieldRegistry): FieldSchema {
  assertFieldId(schema.id, `field "${schema.id}"`);
  assertRegistered(registry, schema.type);
  if (
    schema.search_weight !== undefined &&
    !(SEARCH_WEIGHT_CLASSES as readonly string[]).includes(schema.search_weight)
  ) {
    throw new ContentError(
      "SCHEMA_INVALID",
      `field "${schema.id}": search_weight must be one of ${SEARCH_WEIGHT_CLASSES.join("|")}`,
    );
  }
  countDepth(schema, 1);
  if (isObjectSchema(schema)) {
    const fields = validateFields(schema.fields, registry, `object "${schema.id}"`);
    return { ...schema, fields };
  }
  if (isListSchema(schema)) {
    if (schema.item.type === "list") {
      throw new ContentError(
        "LIST_ITEM_NESTING",
        `list "${schema.id}": list items must be simple/structured values — use repeater for rows`,
      );
    }
    return { id: schema.id, type: "list", item: defineSchema(schema.item, registry) };
  }
  if (isRepeaterSchema(schema)) {
    const fields = validateFields(schema.item.fields, registry, `repeater "${schema.id}"`);
    const { minItems, maxItems, uniqueBy } = schema;
    if (minItems !== undefined && (!Number.isInteger(minItems) || minItems < 0)) {
      throw new ContentError("SCHEMA_INVALID", `repeater "${schema.id}": invalid minItems`);
    }
    if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 1)) {
      throw new ContentError("SCHEMA_INVALID", `repeater "${schema.id}": invalid maxItems`);
    }
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      throw new ContentError("SCHEMA_INVALID", `repeater "${schema.id}": minItems > maxItems`);
    }
    if (maxItems !== undefined && maxItems > MAX_REPEATER_ITEMS) {
      throw new ContentError(
        "SCHEMA_INVALID",
        `repeater "${schema.id}": maxItems exceeds the global limit (${MAX_REPEATER_ITEMS})`,
      );
    }
    if (uniqueBy !== undefined && !(uniqueBy in fields)) {
      throw new ContentError(
        "SCHEMA_INVALID",
        `repeater "${schema.id}": uniqueBy "${uniqueBy}" is not an item field`,
      );
    }
    return {
      id: schema.id,
      type: "repeater",
      item: { fields },
      ...(minItems === undefined ? {} : { minItems }),
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(uniqueBy === undefined ? {} : { uniqueBy }),
    };
  }
  if (schema.type === "relation" || schema.type === "relation_list") {
    const accepts = normalizeAccepts(
      (schema as { accepts?: readonly string[] }).accepts,
      `${schema.type} "${schema.id}"`,
    );
    return accepts === undefined ? { ...schema } : ({ ...schema, accepts } as FieldSchema);
  }
  if (schema.type === "enum") {
    const { values } = schema as EnumFieldSchema;
    if (!Array.isArray(values) || values.length === 0) {
      throw new ContentError(
        "SCHEMA_INVALID",
        `enum "${schema.id}" requires a non-empty values list`,
      );
    }
    for (const key of values) {
      if (!ENUM_KEY_RE.test(key)) {
        throw new ContentError(
          "SCHEMA_INVALID",
          `enum "${schema.id}": "${key}" is not a stable machine key`,
        );
      }
    }
    if (new Set(values).size !== values.length) {
      throw new ContentError("SCHEMA_INVALID", `enum "${schema.id}" contains duplicate keys`);
    }
    return { ...schema };
  }
  if (schema.type === "decimal") {
    const decimal = schema as DecimalFieldSchema;
    const num = (value: string | undefined): number | null =>
      value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : NaN;
    if (
      decimal.precision !== undefined &&
      (!Number.isInteger(decimal.precision) || decimal.precision < 1 || decimal.precision > 38)
    ) {
      throw new ContentError("SCHEMA_INVALID", `decimal "${schema.id}": precision must be 1–38`);
    }
    if (
      decimal.scale !== undefined &&
      (!Number.isInteger(decimal.scale) ||
        decimal.scale < 0 ||
        decimal.scale > 6 ||
        (decimal.precision !== undefined && decimal.scale > decimal.precision))
    ) {
      throw new ContentError(
        "SCHEMA_INVALID",
        `decimal "${schema.id}": scale must be 0–6 and ≤ precision`,
      );
    }
    for (const bound of ["min", "max"] as const) {
      const value = decimal[bound];
      if (value === undefined) continue;
      if (num(value) === null || Number.isNaN(num(value))) {
        throw new ContentError(
          "SCHEMA_INVALID",
          `decimal "${schema.id}": ${bound} must be a decimal string`,
        );
      }
    }
    if (
      decimal.min !== undefined &&
      decimal.max !== undefined &&
      num(decimal.min) !== null &&
      num(decimal.max) !== null &&
      (num(decimal.min) as number) > (num(decimal.max) as number)
    ) {
      throw new ContentError("SCHEMA_INVALID", `decimal "${schema.id}": min > max`);
    }
    return { ...schema };
  }
  if (schema.type === "integer") {
    const integer = schema as IntegerFieldSchema;
    for (const bound of ["min", "max"] as const) {
      const value = integer[bound];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value)) {
        throw new ContentError(
          "SCHEMA_INVALID",
          `integer "${schema.id}": ${bound} must be a safe integer`,
        );
      }
    }
    if (integer.min !== undefined && integer.max !== undefined && integer.min > integer.max) {
      throw new ContentError("SCHEMA_INVALID", `integer "${schema.id}": min > max`);
    }
    return { ...schema };
  }
  return schema;
}

function validateFields(
  fields: Record<string, FieldSchema>,
  registry: FieldRegistry,
  context: string,
): Record<string, FieldSchema> {
  const defined: Record<string, FieldSchema> = {};
  for (const [key, schema] of Object.entries(fields)) {
    // The reserved item-id key is rejected before any shape check so callers
    // get the precise diagnostic, independent of its spelling validity.
    if (key === REPEATER_ITEM_ID_KEY) {
      throw new ContentError(
        "FIELD_ID_RESERVED",
        `${context}: "${REPEATER_ITEM_ID_KEY}" is reserved for the stable item id`,
      );
    }
    assertFieldId(key, context);
    defined[key] = defineSchema({ ...schema, id: key }, registry);
  }
  return defined;
}

/** Defines + validates an object field schema (Content spec §23). */
export function defineObjectSchema(
  fields: Record<string, FieldSchema>,
  registry: FieldRegistry = createFieldRegistry(),
): ObjectFieldSchema {
  const normalized = validateFields(fields, registry, "object");
  const schema: ObjectFieldSchema = { id: "object", type: "object", fields: normalized };
  countDepth(schema, 1);
  return schema;
}

/** Defines + validates a list field schema (Content spec §24). */
export function defineListSchema(
  item: FieldSchema,
  registry: FieldRegistry = createFieldRegistry(),
): ListFieldSchema {
  return defineSchema({ id: "list", type: "list", item }, registry) as ListFieldSchema;
}

/** Defines + validates a repeater field schema (Content spec §25/§26). */
export function defineRepeaterSchema(
  itemFields: Record<string, FieldSchema>,
  options: { minItems?: number; maxItems?: number; uniqueBy?: string } = {},
  registry: FieldRegistry = createFieldRegistry(),
): RepeaterFieldSchema {
  return defineSchema(
    {
      id: "repeater",
      type: "repeater",
      item: { fields: itemFields },
      ...options,
    },
    registry,
  ) as RepeaterFieldSchema;
}

/** Defines + validates a relation field schema (Content spec §22). */
export function defineRelationSchema(
  options: { required?: boolean; accepts?: readonly string[] } = {},
  registry: FieldRegistry = createFieldRegistry(),
): RelationFieldSchema {
  const schema: RelationFieldSchema = {
    id: "relation",
    type: "relation",
    ...(options.required === undefined ? {} : { required: options.required }),
    ...(options.accepts === undefined ? {} : { accepts: options.accepts }),
  };
  return defineSchema(schema, registry) as RelationFieldSchema;
}

/** Defines + validates an ordered relation_list field schema (Content spec §22). */
export function defineRelationListSchema(
  options: { required?: boolean; accepts?: readonly string[] } = {},
  registry: FieldRegistry = createFieldRegistry(),
): RelationListFieldSchema {
  const schema: RelationListFieldSchema = {
    id: "relation_list",
    type: "relation_list",
    ...(options.required === undefined ? {} : { required: options.required }),
    ...(options.accepts === undefined ? {} : { accepts: options.accepts }),
  };
  return defineSchema(schema, registry) as RelationListFieldSchema;
}

/** Defines a money field schema (Content spec §18). */
export function defineMoneySchema(
  options: { required?: boolean } = {},
  registry: FieldRegistry = createFieldRegistry(),
): MoneyFieldSchema {
  return defineSchema(
    {
      id: "money",
      type: "money",
      ...(options.required === undefined ? {} : { required: options.required }),
    },
    registry,
  ) as MoneyFieldSchema;
}

/** Defines a decimal field schema with exact-string constraints (§17). */
export function defineDecimalSchema(
  options: {
    required?: boolean;
    min?: string;
    max?: string;
    precision?: number;
    scale?: number;
  } = {},
  registry: FieldRegistry = createFieldRegistry(),
): DecimalFieldSchema {
  return defineSchema(
    {
      id: "decimal",
      type: "decimal",
      ...(options.required === undefined ? {} : { required: options.required }),
      ...(options.min === undefined ? {} : { min: options.min }),
      ...(options.max === undefined ? {} : { max: options.max }),
      ...(options.precision === undefined ? {} : { precision: options.precision }),
      ...(options.scale === undefined ? {} : { scale: options.scale }),
    },
    registry,
  ) as DecimalFieldSchema;
}

/** Defines an integer field schema with safe-integer bounds (§17). */
export function defineIntegerSchema(
  options: { required?: boolean; min?: number; max?: number } = {},
  registry: FieldRegistry = createFieldRegistry(),
): IntegerFieldSchema {
  return defineSchema(
    {
      id: "integer",
      type: "integer",
      ...(options.required === undefined ? {} : { required: options.required }),
      ...(options.min === undefined ? {} : { min: options.min }),
      ...(options.max === undefined ? {} : { max: options.max }),
    },
    registry,
  ) as IntegerFieldSchema;
}

/** Defines an enum field schema over stable machine keys (§20). */
export function defineEnumSchema(
  values: readonly string[],
  options: { required?: boolean } = {},
  registry: FieldRegistry = createFieldRegistry(),
): EnumFieldSchema {
  return defineSchema(
    {
      id: "enum",
      type: "enum",
      values,
      ...(options.required === undefined ? {} : { required: options.required }),
    },
    registry,
  ) as EnumFieldSchema;
}

/** Defines a date field schema (Content spec §19). */
export function defineDateSchema(
  options: { required?: boolean } = {},
  registry: FieldRegistry = createFieldRegistry(),
): ScalarFieldSchema {
  return defineSchema(
    {
      id: "date",
      type: "date",
      ...(options.required === undefined ? {} : { required: options.required }),
    },
    registry,
  ) as ScalarFieldSchema;
}

/** Defines a datetime field schema (Content spec §19). */
export function defineDatetimeSchema(
  options: { required?: boolean } = {},
  registry: FieldRegistry = createFieldRegistry(),
): ScalarFieldSchema {
  return defineSchema(
    {
      id: "datetime",
      type: "datetime",
      ...(options.required === undefined ? {} : { required: options.required }),
    },
    registry,
  ) as ScalarFieldSchema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSchemaValue(
  schema: FieldSchema,
  value: unknown,
  path: string,
  issues: StructuredIssue[],
  required: boolean,
): void {
  if (value === undefined || value === null) {
    if (required) {
      issues.push({ code: "REQUIRED_MISSING", path, message: "field is required" });
    }
    return;
  }
  if (isObjectSchema(schema)) {
    if (!isPlainObject(value)) {
      issues.push({ code: "TYPE_MISMATCH", path, message: "expected an object" });
      return;
    }
    for (const [key, child] of Object.entries(schema.fields)) {
      validateSchemaValue(child, value[key], `${path}/${key}`, issues, child.required === true);
    }
    for (const key of Object.keys(value)) {
      if (!(key in schema.fields)) {
        issues.push({
          code: "UNKNOWN_FIELD",
          path: `${path}/${key}`,
          message: `unknown field "${key}"`,
        });
      }
    }
    return;
  }
  if (isListSchema(schema)) {
    if (!Array.isArray(value)) {
      issues.push({ code: "TYPE_MISMATCH", path, message: "expected an array" });
      return;
    }
    value.forEach((item, index) => {
      validateSchemaValue(schema.item, item, `${path}/${index}`, issues, true);
    });
    return;
  }
  if (isRepeaterSchema(schema)) {
    if (!Array.isArray(value)) {
      issues.push({ code: "TYPE_MISMATCH", path, message: "expected an array of items" });
      return;
    }
    if (value.length > MAX_REPEATER_ITEMS) {
      issues.push({
        code: "REPEATER_ITEM_LIMIT",
        path,
        message: `repeater exceeds the global item limit (${MAX_REPEATER_ITEMS})`,
      });
      return;
    }
    const { minItems, maxItems, uniqueBy } = schema;
    if (minItems !== undefined && value.length < minItems) {
      issues.push({
        code: "REPEATER_MIN_ITEMS",
        path,
        message: `repeater requires at least ${minItems} items`,
      });
    }
    if (maxItems !== undefined && value.length > maxItems) {
      issues.push({
        code: "REPEATER_MAX_ITEMS",
        path,
        message: `repeater allows at most ${maxItems} items`,
      });
    }
    value.forEach((item, index) => {
      const itemPath = `${path}/${index}`;
      if (!isPlainObject(item)) {
        issues.push({ code: "TYPE_MISMATCH", path: itemPath, message: "expected an item object" });
        return;
      }
      const itemId = item[REPEATER_ITEM_ID_KEY];
      if (!isStableId(itemId)) {
        issues.push({
          code: "REPEATER_ITEM_ID_REQUIRED",
          path: `${itemPath}/${REPEATER_ITEM_ID_KEY}`,
          message:
            "every repeater item needs a stable itemId — must be a UUIDv7 (slugs and counters are not identities)",
        });
      }
      for (const [key, child] of Object.entries(schema.item.fields)) {
        validateSchemaValue(
          child,
          item[key],
          `${itemPath}/${key}`,
          issues,
          child.required === true,
        );
      }
      for (const key of Object.keys(item)) {
        if (key !== REPEATER_ITEM_ID_KEY && !(key in schema.item.fields)) {
          issues.push({
            code: "UNKNOWN_FIELD",
            path: `${itemPath}/${key}`,
            message: `unknown field "${key}"`,
          });
        }
      }
    });
    if (uniqueBy !== undefined) {
      const seen = new Set<unknown>();
      value.forEach((item, index) => {
        if (!isPlainObject(item)) return;
        const key = item[uniqueBy];
        if (key === undefined || key === null) return;
        if (seen.has(key)) {
          issues.push({
            code: "REPEATER_DUPLICATE_UNIQUE_BY",
            path: `${path}/${index}/${uniqueBy}`,
            message: `duplicate value for uniqueBy "${uniqueBy}"`,
          });
        }
        seen.add(key);
      });
    }
    return;
  }
  if (schema.type === "media") {
    issues.push(...validateMediaValue(value, path));
    return;
  }
  if (schema.type === "media_list") {
    issues.push(...validateMediaListValue(value, path));
    return;
  }
  if (schema.type === "relation") {
    issues.push(...validateRelationValue(value, path));
    return;
  }
  if (schema.type === "relation_list") {
    issues.push(...validateRelationListValue(value, path));
    return;
  }
  if (schema.type === "rich_text") {
    const richtext = validateRichText(value);
    if (!richtext.ok) {
      issues.push(
        ...richtext.issues.map((issue) => ({
          code: issue.code,
          path: `${path}${issue.path}`,
          message: issue.message,
        })),
      );
    }
    return;
  }
  if (STRING_FIELD_TYPES.has(schema.type)) {
    // Content spec §14: string/text and the constrained string family are
    // Unicode strings; type safety is enforced here, per-value formats
    // (slug/url/email/phone patterns) are schema/security-layer concerns.
    if (typeof value !== "string") {
      issues.push({
        code: "TYPE_MISMATCH",
        path,
        message: `expected a string for type "${schema.type}"`,
      });
    }
    return;
  }
  if (schema.type === "icon") {
    // Icon values are Font Awesome class strings ("fa-solid fa-name"): a
    // typo used to degrade silently to a fallback glyph, so the format is
    // validated at the schema layer (2026-09-29 site-developer report).
    // Membership in the shipped catalog is discoverable via
    // GET /discovery/content/icons but not enforced — sites may use their
    // own FA subsets.
    if (typeof value !== "string" || !ICON_VALUE_RE.test(value)) {
      issues.push({
        code: "FIELD_VALUE_INVALID",
        path,
        message: 'expected a Font Awesome class string like "fa-solid fa-shield-halved"',
      });
    }
    return;
  }
  if (schema.type === "money") {
    issues.push(...moneyIssues(value, path));
    return;
  }
  if (schema.type === "date") {
    issues.push(...dateIssues(value, path));
    return;
  }
  if (schema.type === "datetime") {
    issues.push(...datetimeIssues(value, path));
    return;
  }
  if (schema.type === "enum") {
    issues.push(...enumIssues(value, path, (schema as EnumFieldSchema).values));
    return;
  }
  if (schema.type === "decimal") {
    const decimal = schema as DecimalFieldSchema;
    issues.push(
      ...decimalIssues(value, path, {
        ...(decimal.min === undefined ? {} : { min: decimal.min }),
        ...(decimal.max === undefined ? {} : { max: decimal.max }),
        ...(decimal.precision === undefined ? {} : { precision: decimal.precision }),
        ...(decimal.scale === undefined ? {} : { scale: decimal.scale }),
      }),
    );
    return;
  }
  if (schema.type === "integer") {
    const integer = schema as IntegerFieldSchema;
    issues.push(
      ...integerIssues(value, path, {
        ...(integer.min === undefined ? {} : { min: integer.min }),
        ...(integer.max === undefined ? {} : { max: integer.max }),
      }),
    );
    return;
  }
  // Remaining scalar leaves (string/text/…) get their exact checks with their
  // own tasks; the structural shape check is all this layer asserts.
}

/**
 * Validates a structured value against its schema (Content spec §23–§26).
 * Round-trip safe: an accepted value is returned unchanged, and every issue
 * carries a stable code plus a JSON-pointer-style path.
 */
export function validateStructuredValue(
  schema: FieldSchema,
  value: unknown,
): StructuredValidationResult {
  const issues: StructuredIssue[] = [];
  validateSchemaValue(schema, value, "", issues, schema.required === true);
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}
