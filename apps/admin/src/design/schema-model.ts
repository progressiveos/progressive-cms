// Schema-driven configuration fields for the Admin (CORE-PAYMENTS-ADMIN-CONFIG-01
// §9): ONE renderer for every config_schema, so a human never types raw JSON
// to configure a provider.
//
// The schema is the single source of types and constraints; UI metadata only
// adds what JSON Schema cannot say — a human label per provider slot, an
// optional hint, and which keys are "advanced". Machine keys are never the
// only label: a missing label falls back to the schema title, then to a
// humanized key, and the Payments map covers every shipped provider slot.
//
// Model (pure, no JSX):
//   fromConfig(schema, stored) → DocState
//   toConfig(schema, state)    → { ok, config } | { ok: false, errors }
// Empty input means "not set" (the adapter default applies) — never 0, never
// NaN, never an empty string that would defeat a schema default.

export interface SchemaProperty {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly items?: SchemaProperty;
  readonly properties?: Readonly<Record<string, SchemaProperty>>;
  readonly required?: readonly string[];
  readonly format?: string;
  readonly additionalProperties?: boolean;
  readonly "x-ui-multiline"?: boolean;
}

export type SchemaObject = Readonly<Record<string, SchemaProperty>>;

export function schemaProperties(schema: Record<string, unknown> | null): SchemaObject {
  if (schema === null) return {};
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return {};
  return properties as SchemaObject;
}

export function requiredKeys(schema: Record<string, unknown> | null): ReadonlySet<string> {
  if (schema === null) return new Set();
  const required = (schema as { required?: unknown }).required;
  return new Set(Array.isArray(required) ? required.filter((key) => typeof key === "string") : []);
}

export function isSecretRefSlot(schema: SchemaProperty | undefined): boolean {
  return schema?.format === "secret-ref";
}

/** One configuration document as the form edits it. */
export interface DocState {
  /** Scalar/boolean/enum fields by key (booleans as "true"/"false"). */
  readonly scalars: Readonly<Record<string, string>>;
  /** String-list fields (CIDR allowlists) by key. */
  readonly lists: Readonly<Record<string, readonly string[]>>;
  /** One level of named object children: parent → { child → text }. */
  readonly nested: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function scalarText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "";
}

export function fromConfig(
  properties: SchemaObject,
  stored: Readonly<Record<string, unknown>>,
): DocState {
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const nested: Record<string, Record<string, string>> = {};
  for (const [key, schema] of Object.entries(properties)) {
    if (isSecretRefSlot(schema)) continue;
    const value = stored[key];
    if (schema.type === "array") {
      // Scalars keep their text form; an integer/number list (allowed_ports is
      // [80,443]) is a supported list, not an unsupported shape (review R9).
      lists[key] = Array.isArray(value)
        ? value
            .map((item) => (typeof item === "number" ? String(item) : item))
            .filter((item): item is string => typeof item === "string")
        : [];
      continue;
    }
    if (schema.type === "object") {
      const source =
        typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
      const children: Record<string, string> = {};
      for (const [childKey, childSchema] of Object.entries(schema.properties ?? {})) {
        children[childKey] = scalarText(source[childKey] ?? childSchema.default);
      }
      nested[key] = children;
      continue;
    }
    scalars[key] = scalarText(value ?? schema.default);
  }
  return { scalars, lists, nested };
}

/**
 * True when this schema shape cannot be edited by the bounded renderer (deep
 * objects, arrays of objects). Callers show a typed notice; `toConfig` keeps
 * the stored value unchanged for such a key.
 */
export function isUnsupportedShape(schema: SchemaProperty): boolean {
  if (schema.type === "array") {
    const itemType = schema.items?.type;
    return itemType !== undefined && !["string", "integer", "number"].includes(itemType);
  }
  if (schema.type === "object") {
    return Object.values(schema.properties ?? {}).some(
      (child) => child.type === "object" || child.type === "array",
    );
  }
  return (
    schema.type !== undefined &&
    !["string", "boolean", "number", "integer"].includes(schema.type) &&
    schema.enum === undefined
  );
}

export interface DocError {
  readonly path: string;
  /** i18n KEY of the message (the Admin never renders a hardcoded string). */
  readonly message: string;
}

export type DocBuild =
  | { readonly ok: true; readonly config: Record<string, unknown> }
  | { readonly ok: false; readonly errors: readonly DocError[] };

const hasText = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

/**
 * Converts the edited document back to a config object with the schema's
 * semantics: blank → omitted, digits or a field error (never NaN/0).
 *
 * Review R9: values the renderer cannot represent (an unsupported nested
 * shape) are carried over from `previous` unchanged instead of being silently
 * dropped — a save must never mangle a stored document it did not understand.
 *
 * `previous` MUST be scoped to the same document the caller delegated to this
 * function (see mergeStructuredConfig): a key absent from `properties` is
 * treated as "outside this scope" and copied verbatim, so passing a whole
 * config that also contains fields the caller edits itself would overwrite
 * those edits.
 */
export function toConfig(
  properties: SchemaObject,
  state: DocState,
  previous?: Readonly<Record<string, unknown>>,
): DocBuild {
  const config: Record<string, unknown> = {};
  const errors: DocError[] = [];
  if (previous !== undefined) {
    for (const [key, value] of Object.entries(previous)) {
      const schema = properties[key];
      if (schema === undefined || isUnsupportedShape(schema)) config[key] = value;
    }
  }
  for (const [key, schema] of Object.entries(properties)) {
    if (isSecretRefSlot(schema) || isUnsupportedShape(schema)) continue;
    const label = key;
    if (schema.type === "array") {
      const itemType = schema.items?.type ?? "string";
      const items = (state.lists[key] ?? [])
        .map((item) => item.trim())
        .filter((item) => item !== "");
      if (items.length === 0) continue;
      if (itemType === "integer" || itemType === "number") {
        // Review R9: the list keeps the schema's element type — too many
        // extensions declare integer arrays (allowed_ports) to lose them.
        const parsed: number[] = [];
        let invalid = false;
        for (const item of items) {
          const numeric = Number(item);
          if (!Number.isFinite(numeric) || (itemType === "integer" && !Number.isInteger(numeric))) {
            errors.push({ path: key, message: "payments.settings_error_list_number" });
            invalid = true;
            break;
          }
          parsed.push(numeric);
        }
        if (!invalid) config[key] = parsed;
        continue;
      }
      config[key] = items;
      continue;
    }
    if (schema.type === "object") {
      const children = state.nested[key] ?? {};
      const built: Record<string, unknown> = {};
      for (const [childKey, childSchema] of Object.entries(schema.properties ?? {})) {
        const text = children[childKey];
        if (!hasText(text)) continue;
        if (childSchema.type === "integer") {
          const parsed = Number(text);
          if (!Number.isInteger(parsed)) {
            errors.push({
              path: `${label}.${childKey}`,
              message: "payments.settings_error_integer",
            });
            continue;
          }
          built[childKey] = parsed;
        } else if (childSchema.type === "number") {
          const parsed = Number(text);
          if (!Number.isFinite(parsed)) {
            errors.push({
              path: `${label}.${childKey}`,
              message: "payments.settings_error_number",
            });
            continue;
          }
          built[childKey] = parsed;
        } else if (childSchema.type === "boolean") {
          built[childKey] = text === "true";
        } else {
          built[childKey] = text;
        }
      }
      if (Object.keys(built).length > 0) config[key] = built;
      continue;
    }
    const raw = state.scalars[key];
    if (schema.type === "boolean") {
      if (raw === "true") config[key] = true;
      else if (raw === "false") config[key] = false;
      // "unset" → omitted: the adapter default decides.
      continue;
    }
    if (!hasText(raw)) continue;
    const text = (raw ?? "").trim();
    if (schema.type === "integer") {
      const parsed = Number(text);
      if (!Number.isInteger(parsed)) {
        errors.push({ path: label, message: "payments.settings_error_integer" });
        continue;
      }
      config[key] = parsed;
      continue;
    }
    if (schema.type === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        errors.push({ path: label, message: "payments.settings_error_number" });
        continue;
      }
      config[key] = parsed;
      continue;
    }
    config[key] = text;
  }
  return errors.length === 0 ? { ok: true, config } : { ok: false, errors };
}

/**
 * Review R9 (second pass): a screen that edits scalars itself and delegates
 * only object/array fields to this model must not let preservation overwrite
 * the scalars it just edited. The stored document is narrowed to the keys
 * this renderer owns, and the caller's explicit edits win.
 */
export function mergeStructuredConfig(
  properties: SchemaObject,
  state: DocState,
  previous: Readonly<Record<string, unknown>> | undefined,
  explicit: Readonly<Record<string, unknown>>,
): DocBuild {
  const scopedPrevious =
    previous === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(previous).filter(([key]) => properties[key] !== undefined),
        );
  const built = toConfig(properties, state, scopedPrevious);
  if (!built.ok) return built;
  // Explicit edits (scalars the caller already parsed) always win.
  return { ok: true, config: { ...built.config, ...explicit } };
}

/** Serializes one value for a human hint (defaults in descriptions). */
export function describeDefault(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
