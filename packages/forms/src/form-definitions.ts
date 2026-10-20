// FormDefinition domain (PCMS-FORM-T002; Forms spec §4–§8, §24).
//
// A definition is a stable identity (id + key) carrying immutable schema
// versions. Submissions pin `form_definition_id` + `form_schema_version`, so
// a definition may evolve without rewriting history. Field identity is the
// machine `key`; labels/help/placeholder are presentational and may change
// between versions (spec §6). Server-side validation of *values* against a
// field set lives in fields.ts (T003); this module validates definition
// documents themselves — fail-secure, bounded, allowlist-only.
import type { DbPool } from "@pcms/core";
import { newStableId } from "@pcms/core";
import { FormsError } from "./errors.js";
import {
  asRecord,
  assertMachineKey,
  assertOptionValue,
  boundedInt,
  boundedText,
  oneOf,
  optionalText,
  parseRetentionPolicy,
  rejectUnknownKeys,
} from "./validate.js";

export const FORM_FIELD_TYPES_V1 = [
  "text",
  "textarea",
  "email",
  "phone",
  "number",
  "select",
  "radio",
  "checkbox",
  "checkbox_group",
  "hidden_controlled",
  "consent",
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES_V1)[number];

/** Builder-facing capability matrix (owner UX pass 0.1.28): which optional
 * field properties are meaningful per type. The Admin form builder drives its
 * controls from this descriptor list instead of hardcoding the type corpus —
 * the allowlist above stays the single source of truth. */
const FORM_FIELD_PROPERTY_KEYS_V1 = [
  "required",
  "help",
  "placeholder",
  "min_length",
  "max_length",
  "pattern",
  "min",
  "max",
  "options",
  "expected_value",
  "consent",
] as const;

export type FormFieldPropertyKey = (typeof FORM_FIELD_PROPERTY_KEYS_V1)[number];

export interface FormFieldTypeDescriptor {
  readonly type: FormFieldType;
  readonly supports: readonly FormFieldPropertyKey[];
}

const TEXT_FAMILY: readonly FormFieldPropertyKey[] = [
  "required",
  "help",
  "placeholder",
  "min_length",
  "max_length",
  "pattern",
];

export const FORM_FIELD_TYPE_INFO_V1: readonly FormFieldTypeDescriptor[] = [
  { type: "text", supports: TEXT_FAMILY },
  { type: "textarea", supports: TEXT_FAMILY },
  { type: "email", supports: TEXT_FAMILY },
  { type: "phone", supports: TEXT_FAMILY },
  {
    type: "number",
    supports: ["required", "help", "placeholder", "min", "max"],
  },
  {
    type: "select",
    supports: ["required", "help", "placeholder", "options"],
  },
  { type: "radio", supports: ["required", "help", "options"] },
  { type: "checkbox", supports: ["required", "help"] },
  { type: "checkbox_group", supports: ["required", "help", "options"] },
  { type: "hidden_controlled", supports: ["help", "expected_value"] },
  {
    type: "consent",
    supports: ["required", "help", "consent"],
  },
];

export interface FormFieldOption {
  readonly value: string;
  readonly label: string;
}

/** One v1 form field (Forms spec §5/§8). Only `key`/`type` are identity; the
 * rest is per-version presentation + server-authoritative validation rules. */
export interface FormFieldDefinition {
  readonly key: string;
  readonly type: FormFieldType;
  readonly label: string;
  readonly required?: boolean;
  readonly help?: string;
  readonly placeholder?: string;
  /** text/textarea/email/phone bounds. */
  readonly min_length?: number;
  readonly max_length?: number;
  /** text-family safe pattern (server-side re-check; see fields.ts). */
  readonly pattern?: string;
  /** number bounds. */
  readonly min?: number;
  readonly max?: number;
  /** select/radio/checkbox_group allowlist (enum). */
  readonly options?: readonly FormFieldOption[];
  /** hidden_controlled: value must equal this to pass server validation. */
  readonly expected_value?: string;
  /** consent: stable consent identity + what was accepted (spec §21). */
  readonly consent_key?: string;
  readonly consent_text?: string;
  readonly policy_reference?: string;
}

export interface FormSuccessBehavior {
  readonly type: "message" | "redirect_internal" | "redirect_external_trusted";
  readonly message?: string;
  readonly path?: string;
  readonly url?: string;
}

/** Lightweight lead creation on accepted interactions (spec §18/§19). */
export interface FormLeadPolicy {
  readonly create_lead?: boolean;
  readonly classification?: string;
  readonly name_from?: string;
  readonly email_from?: string;
  readonly phone_from?: string;
  readonly summary_from?: string;
}

export interface FormSpamPolicy {
  /** Honeypot input name; must not collide with a real field key. */
  readonly honeypot_field?: string;
}

/** Retention policy applied by the T017 sweep (spec §30/§31). */
export interface FormRetentionPolicy {
  readonly mode: "retain" | "anonymize" | "delete";
  readonly after_days?: number;
}

export interface FormDefinitionSettings {
  readonly success_behavior?: FormSuccessBehavior;
  readonly lead_policy?: FormLeadPolicy;
  readonly spam_policy?: FormSpamPolicy;
  readonly retention?: FormRetentionPolicy;
}

/** Flattened current view of a definition (identity + current version). */
export interface FormDefinition {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly schema_version: number;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly fields: readonly FormFieldDefinition[];
  readonly settings: FormDefinitionSettings;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface FormDefinitionVersionRecord {
  readonly definition_id: string;
  readonly schema_version: number;
  readonly fields: readonly FormFieldDefinition[];
  readonly settings: FormDefinitionSettings;
  readonly created_at: string;
}

const MAX_FIELDS = 100;

/**
 * Fields carrying `pattern` must cap their values at or below this length:
 * the server runs the author-supplied regex against public input, and longer
 * subjects make catastrophic backtracking a real ReDoS vector (F-43). The
 * runtime validator (fields.ts) enforces the same bound as a safety net.
 */
export const FORM_PATTERN_MAX_SUBJECT_LENGTH = 2000;

/** JSON round-trip discipline: never materialize `undefined` own-properties
 * (they would come back as absent keys after a DB round-trip). */
function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

const FIELD_KEY_SET = new Set<string>([
  "key",
  "type",
  "label",
  "required",
  "help",
  "placeholder",
  "min_length",
  "max_length",
  "pattern",
  "min",
  "max",
  "options",
  "expected_value",
  "consent_key",
  "consent_text",
  "policy_reference",
]);

export function validateFieldDefinition(value: unknown): FormFieldDefinition {
  const raw = asRecord(value, "FORM_DEFINITION_INVALID", "form field");
  rejectUnknownKeys(raw, [...FIELD_KEY_SET], "FORM_DEFINITION_INVALID", "form field");
  const key = assertMachineKey(raw.key, "FORM_DEFINITION_INVALID", "field key");
  const type = oneOf(
    raw.type,
    FORM_FIELD_TYPES_V1,
    "FORM_FIELD_UNSUPPORTED",
    `field "${key}" type`,
  );
  const label = boundedText(raw.label, "FORM_DEFINITION_INVALID", `field "${key}" label`, 300);
  const field: {
    -readonly [K in keyof FormFieldDefinition]?: FormFieldDefinition[K];
  } = { key, type, label };
  if (raw.required !== undefined) {
    if (typeof raw.required !== "boolean") {
      throw new FormsError("FORM_DEFINITION_INVALID", `field "${key}" required must be boolean`);
    }
    field.required = raw.required;
  }
  assignDefined(
    field,
    "help",
    optionalText(raw.help, "FORM_DEFINITION_INVALID", `field "${key}" help`, 500),
  );
  assignDefined(
    field,
    "placeholder",
    optionalText(raw.placeholder, "FORM_DEFINITION_INVALID", `field "${key}" placeholder`, 200),
  );
  if (raw.min_length !== undefined) {
    field.min_length = boundedInt(
      raw.min_length,
      "FORM_DEFINITION_INVALID",
      `field "${key}" min_length`,
      0,
      100_000,
    );
  }
  if (raw.max_length !== undefined) {
    field.max_length = boundedInt(
      raw.max_length,
      "FORM_DEFINITION_INVALID",
      `field "${key}" max_length`,
      1,
      100_000,
    );
  }
  if (
    field.min_length !== undefined &&
    field.max_length !== undefined &&
    field.min_length > field.max_length
  ) {
    throw new FormsError("FORM_DEFINITION_INVALID", `field "${key}" min_length exceeds max_length`);
  }
  if (raw.pattern !== undefined) {
    // Safe pattern: bounded length, no flags, must compile; catastrophic
    // regex hardening stays with the bounded subject lengths (ponytail:
    // ReDoS-resistant by input capping, not by regex analysis).
    const pattern = boundedText(
      raw.pattern,
      "FORM_DEFINITION_INVALID",
      `field "${key}" pattern`,
      200,
    );
    try {
      new RegExp(pattern);
    } catch {
      throw new FormsError("FORM_DEFINITION_INVALID", `field "${key}" pattern does not compile`);
    }
    // ReDoS bound (F-43): a pattern-bearing field must declare a max_length
    // that keeps regex subjects short; absent max_length means the runtime
    // default cap (5000) — too permissive to compile a pattern against.
    if (field.max_length === undefined || field.max_length > FORM_PATTERN_MAX_SUBJECT_LENGTH) {
      throw new FormsError(
        "FORM_DEFINITION_INVALID",
        `field "${key}" with a pattern must declare max_length <= ${FORM_PATTERN_MAX_SUBJECT_LENGTH}`,
      );
    }
    field.pattern = pattern;
  }
  if (raw.min !== undefined) {
    field.min = boundedInt(raw.min, "FORM_DEFINITION_INVALID", `field "${key}" min`, -1e12, 1e12);
  }
  if (raw.max !== undefined) {
    field.max = boundedInt(raw.max, "FORM_DEFINITION_INVALID", `field "${key}" max`, -1e12, 1e12);
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    throw new FormsError("FORM_DEFINITION_INVALID", `field "${key}" min exceeds max`);
  }
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > 500) {
      throw new FormsError(
        "FORM_DEFINITION_INVALID",
        `field "${key}" options must be 1..500 entries`,
      );
    }
    const seen = new Set<string>();
    field.options = raw.options.map((option) => {
      const record = asRecord(option, "FORM_DEFINITION_INVALID", `field "${key}" option`);
      rejectUnknownKeys(
        record,
        ["value", "label"],
        "FORM_DEFINITION_INVALID",
        `field "${key}" option`,
      );
      const optionValue = assertOptionValue(
        record.value,
        "FORM_DEFINITION_INVALID",
        `field "${key}" option value`,
      );
      if (seen.has(optionValue)) {
        throw new FormsError(
          "FORM_DEFINITION_INVALID",
          `field "${key}" has duplicate option "${optionValue}"`,
        );
      }
      seen.add(optionValue);
      return {
        value: optionValue,
        label: boundedText(
          record.label,
          "FORM_DEFINITION_INVALID",
          `field "${key}" option label`,
          300,
        ),
      };
    });
  }
  if (raw.expected_value !== undefined) {
    field.expected_value = boundedText(
      raw.expected_value,
      "FORM_DEFINITION_INVALID",
      `field "${key}" expected_value`,
      200,
    );
  }
  if (type === "consent") {
    field.consent_key = assertMachineKey(
      raw.consent_key,
      "FORM_DEFINITION_INVALID",
      `field "${key}" consent_key`,
    );
    assignDefined(
      field,
      "consent_text",
      optionalText(
        raw.consent_text,
        "FORM_DEFINITION_INVALID",
        `field "${key}" consent_text`,
        2000,
      ),
    );
    assignDefined(
      field,
      "policy_reference",
      optionalText(
        raw.policy_reference,
        "FORM_DEFINITION_INVALID",
        `field "${key}" policy_reference`,
        500,
      ),
    );
    if (!field.consent_text && !field.policy_reference) {
      throw new FormsError(
        "FORM_DEFINITION_INVALID",
        `field "${key}" consent requires consent_text or policy_reference`,
      );
    }
  }
  return field as FormFieldDefinition;
}

function validateFields(value: unknown): FormFieldDefinition[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FIELDS) {
    throw new FormsError("FORM_DEFINITION_INVALID", `fields must be 1..${MAX_FIELDS} entries`);
  }
  const seen = new Set<string>();
  const fields = value.map((entry) => {
    const field = validateFieldDefinition(entry);
    if (seen.has(field.key)) {
      throw new FormsError("FORM_DEFINITION_INVALID", `duplicate field key "${field.key}"`);
    }
    seen.add(field.key);
    return field;
  });
  return fields;
}

export function validateSettings(
  value: unknown,
  fields: readonly FormFieldDefinition[],
): FormDefinitionSettings {
  const settings: { -readonly [K in keyof FormDefinitionSettings]?: FormDefinitionSettings[K] } =
    {};
  if (value === undefined || value === null) return settings;
  const raw = asRecord(value, "FORM_DEFINITION_INVALID", "settings");
  rejectUnknownKeys(
    raw,
    ["success_behavior", "lead_policy", "spam_policy", "retention"],
    "FORM_DEFINITION_INVALID",
    "settings",
  );
  if (raw.success_behavior !== undefined) {
    const sb = asRecord(
      raw.success_behavior,
      "FORM_DEFINITION_INVALID",
      "settings.success_behavior",
    );
    rejectUnknownKeys(
      sb,
      ["type", "message", "path", "url"],
      "FORM_DEFINITION_INVALID",
      "settings.success_behavior",
    );
    const type = oneOf(
      sb.type,
      ["message", "redirect_internal", "redirect_external_trusted"] as const,
      "FORM_DEFINITION_INVALID",
      "settings.success_behavior.type",
    );
    const behavior: { -readonly [K in keyof FormSuccessBehavior]?: FormSuccessBehavior[K] } = {
      type,
    };
    assignDefined(
      behavior,
      "message",
      optionalText(sb.message, "FORM_DEFINITION_INVALID", "success_behavior.message", 1000),
    );
    if (type === "redirect_internal") {
      behavior.path = boundedText(sb.path, "FORM_DEFINITION_INVALID", "success_behavior.path", 500);
      if (!behavior.path.startsWith("/")) {
        throw new FormsError(
          "FORM_DEFINITION_INVALID",
          "success_behavior.path must be site-relative",
        );
      }
    }
    if (type === "redirect_external_trusted") {
      // Safe allow policy: definition authors pin the exact trusted https URL
      // at authoring time; the public surface never accepts redirect targets.
      const url = boundedText(sb.url, "FORM_DEFINITION_INVALID", "success_behavior.url", 500);
      if (!/^https:\/\/[^\s]+$/.test(url)) {
        throw new FormsError(
          "FORM_DEFINITION_INVALID",
          "success_behavior.url must be an https URL",
        );
      }
      behavior.url = url;
    }
    settings.success_behavior = behavior as FormSuccessBehavior;
  }
  if (raw.lead_policy !== undefined) {
    const lp = asRecord(raw.lead_policy, "FORM_DEFINITION_INVALID", "settings.lead_policy");
    rejectUnknownKeys(
      lp,
      ["create_lead", "classification", "name_from", "email_from", "phone_from", "summary_from"],
      "FORM_DEFINITION_INVALID",
      "settings.lead_policy",
    );
    const policy: { -readonly [K in keyof FormLeadPolicy]?: FormLeadPolicy[K] } = {};
    if (lp.create_lead !== undefined) {
      if (typeof lp.create_lead !== "boolean") {
        throw new FormsError("FORM_DEFINITION_INVALID", "lead_policy.create_lead must be boolean");
      }
      policy.create_lead = lp.create_lead;
    }
    assignDefined(
      policy,
      "classification",
      optionalText(lp.classification, "FORM_DEFINITION_INVALID", "lead_policy.classification", 100),
    );
    for (const mapping of ["name_from", "email_from", "phone_from", "summary_from"] as const) {
      const source = optionalText(
        lp[mapping],
        "FORM_DEFINITION_INVALID",
        `lead_policy.${mapping}`,
        64,
      );
      if (source !== undefined && !fields.some((field) => field.key === source)) {
        throw new FormsError(
          "FORM_DEFINITION_INVALID",
          `lead_policy.${mapping} references unknown field "${source}"`,
        );
      }
      if (source !== undefined) policy[mapping] = source;
    }
    settings.lead_policy = policy as FormLeadPolicy;
  }
  if (raw.spam_policy !== undefined) {
    const sp = asRecord(raw.spam_policy, "FORM_DEFINITION_INVALID", "settings.spam_policy");
    rejectUnknownKeys(sp, ["honeypot_field"], "FORM_DEFINITION_INVALID", "settings.spam_policy");
    const policy: { -readonly [K in keyof FormSpamPolicy]?: FormSpamPolicy[K] } = {};
    const honeypot = optionalText(
      sp.honeypot_field,
      "FORM_DEFINITION_INVALID",
      "spam_policy.honeypot_field",
      64,
    );
    if (honeypot !== undefined) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(honeypot)) {
        throw new FormsError(
          "FORM_DEFINITION_INVALID",
          "spam_policy.honeypot_field must be a machine key",
        );
      }
      if (fields.some((field) => field.key === honeypot)) {
        throw new FormsError(
          "FORM_DEFINITION_INVALID",
          "spam_policy.honeypot_field must not collide with a field",
        );
      }
      policy.honeypot_field = honeypot;
    }
    settings.spam_policy = policy as FormSpamPolicy;
  }
  if (raw.retention !== undefined) {
    settings.retention = parseRetentionPolicy<FormRetentionPolicy>(
      raw.retention,
      "FORM_DEFINITION_INVALID",
    );
  }
  return settings;
}

interface DefinitionRow {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly current_schema_version: number;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface VersionRow {
  readonly [column: string]: unknown;
  readonly definition_id: string;
  readonly schema_version: number;
  readonly fields: unknown;
  readonly settings: unknown;
  readonly created_at: Date;
}

export interface CreateFormDefinitionInput {
  readonly key: string;
  readonly title: string;
  readonly fields: unknown;
  readonly settings?: unknown;
}

export interface AddFormDefinitionVersionInput {
  /** Definition id (stable identity; versions never change it). */
  readonly form_definition_id: string;
  readonly title?: string;
  readonly fields: unknown;
  readonly settings?: unknown;
}

export interface FormDefinitionService {
  createDefinition(input: CreateFormDefinitionInput): Promise<FormDefinition>;
  /** Adds the next immutable schema_version (current+1). */
  addVersion(input: AddFormDefinitionVersionInput): Promise<FormDefinition>;
  listDefinitions(options?: {
    readonly status?: "ACTIVE" | "ARCHIVED";
  }): Promise<readonly FormDefinition[]>;
  getDefinition(form_definition_id: string): Promise<FormDefinition>;
  getVersion(
    form_definition_id: string,
    schema_version: number,
  ): Promise<FormDefinitionVersionRecord>;
  getDefinitionByKey(key: string): Promise<FormDefinition>;
  setArchived(form_definition_id: string, archived: boolean): Promise<FormDefinition>;
}

function definitionFromRows(definition: DefinitionRow, version: VersionRow): FormDefinition {
  return {
    id: definition.id,
    key: definition.key,
    title: definition.title,
    schema_version: version.schema_version,
    status: definition.status as "ACTIVE" | "ARCHIVED",
    fields: version.fields as readonly FormFieldDefinition[],
    settings: version.settings as FormDefinitionSettings,
    created_at: definition.created_at.toISOString(),
    updated_at: definition.updated_at.toISOString(),
  };
}

const DEFINITION_JOIN_SQL = `
  SELECT d.id, d.key, d.title, d.current_schema_version, d.status, d.created_at, d.updated_at,
         v.schema_version, v.fields, v.settings, v.created_at AS version_created_at
  FROM forms_form_definitions d
  JOIN forms_form_definition_versions v
    ON v.definition_id = d.id AND v.schema_version = d.current_schema_version`;

function rowToDefinition(row: Readonly<Record<string, unknown>>): FormDefinition {
  return definitionFromRows(row as unknown as DefinitionRow, {
    definition_id: row.id as string,
    schema_version: row.schema_version as number,
    fields: row.fields,
    settings: row.settings,
    created_at: row.version_created_at as Date,
  });
}

export function createFormDefinitionService(pool: DbPool): FormDefinitionService {
  async function loadDefinition(id: string): Promise<FormDefinition> {
    const result = await pool.query(`${DEFINITION_JOIN_SQL} WHERE d.id = $1`, [id]);
    if (result.rows.length !== 1) {
      throw new FormsError("FORM_DEFINITION_NOT_FOUND", `form definition ${id} not found`);
    }
    return rowToDefinition(result.rows[0]!);
  }

  return {
    async createDefinition(input) {
      const key = assertMachineKey(input.key, "FORM_DEFINITION_INVALID", "definition key");
      const title = boundedText(input.title, "FORM_DEFINITION_INVALID", "title", 300);
      const fields = validateFields(input.fields);
      const settings = validateSettings(input.settings, fields);
      const id = newStableId();
      return pool.withTransaction(async (tx) => {
        const inserted = await tx.query<DefinitionRow>(
          `INSERT INTO forms_form_definitions (id, key, title) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO NOTHING
           RETURNING id, key, title, current_schema_version, status, created_at, updated_at`,
          [id, key, title],
        );
        if (inserted.rows.length !== 1) {
          throw new FormsError("FORM_KEY_TAKEN", `form definition key "${key}" already exists`);
        }
        await tx.query(
          `INSERT INTO forms_form_definition_versions (definition_id, schema_version, fields, settings)
           VALUES ($1, 1, $2, $3)`,
          [id, JSON.stringify(fields), JSON.stringify(settings)],
        );
        return definitionFromRows(inserted.rows[0]!, {
          definition_id: id,
          schema_version: 1,
          fields,
          settings,
          created_at: inserted.rows[0]!.created_at,
        });
      });
    },

    async addVersion(input) {
      const title =
        input.title === undefined
          ? undefined
          : boundedText(input.title, "FORM_DEFINITION_INVALID", "title", 300);
      const fields = validateFields(input.fields);
      const settings = validateSettings(input.settings, fields);
      return pool.withTransaction(async (tx) => {
        const current = await tx.query<DefinitionRow>(
          `SELECT id, key, title, current_schema_version, status, created_at, updated_at
           FROM forms_form_definitions WHERE id = $1 FOR UPDATE`,
          [input.form_definition_id],
        );
        if (current.rows.length !== 1) {
          throw new FormsError(
            "FORM_DEFINITION_NOT_FOUND",
            `form definition ${input.form_definition_id} not found`,
          );
        }
        const row = current.rows[0]!;
        const nextVersion = row.current_schema_version + 1;
        const updated = await tx.query<DefinitionRow>(
          `UPDATE forms_form_definitions
           SET current_schema_version = $2, updated_at = now(),
               title = COALESCE($3, title)
           WHERE id = $1
           RETURNING id, key, title, current_schema_version, status, created_at, updated_at`,
          [row.id, nextVersion, title ?? null],
        );
        await tx.query(
          `INSERT INTO forms_form_definition_versions (definition_id, schema_version, fields, settings)
           VALUES ($1, $2, $3, $4)`,
          [row.id, nextVersion, JSON.stringify(fields), JSON.stringify(settings)],
        );
        return definitionFromRows(updated.rows[0]!, {
          definition_id: row.id,
          schema_version: nextVersion,
          fields,
          settings,
          created_at: new Date(),
        });
      });
    },

    async listDefinitions(options) {
      const filter = options?.status ?? undefined;
      const result =
        filter === undefined
          ? await pool.query(`${DEFINITION_JOIN_SQL} ORDER BY d.created_at DESC, d.id LIMIT 500`)
          : await pool.query(
              `${DEFINITION_JOIN_SQL} WHERE d.status = $1 ORDER BY d.created_at DESC, d.id LIMIT 500`,
              [filter],
            );
      return result.rows.map(rowToDefinition);
    },

    async getDefinition(form_definition_id) {
      return loadDefinition(form_definition_id);
    },

    async getVersion(form_definition_id, schema_version) {
      const result = await pool.query<VersionRow>(
        `SELECT definition_id, schema_version, fields, settings, created_at
         FROM forms_form_definition_versions WHERE definition_id = $1 AND schema_version = $2`,
        [form_definition_id, schema_version],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row) {
        throw new FormsError(
          "FORM_DEFINITION_NOT_FOUND",
          `form definition ${form_definition_id} version ${schema_version} not found`,
        );
      }
      return {
        definition_id: row.definition_id,
        schema_version: row.schema_version,
        fields: row.fields as readonly FormFieldDefinition[],
        settings: row.settings as FormDefinitionSettings,
        created_at: row.created_at.toISOString(),
      };
    },

    async getDefinitionByKey(key) {
      const result = await pool.query(`${DEFINITION_JOIN_SQL} WHERE d.key = $1`, [key]);
      if (result.rows.length !== 1) {
        throw new FormsError("FORM_DEFINITION_NOT_FOUND", `form definition "${key}" not found`);
      }
      return rowToDefinition(result.rows[0]!);
    },

    async setArchived(form_definition_id, archived) {
      const result = await pool.query<DefinitionRow>(
        `UPDATE forms_form_definitions SET status = $2, updated_at = now() WHERE id = $1
         RETURNING id, key, title, current_schema_version, status, created_at, updated_at`,
        [form_definition_id, archived ? "ARCHIVED" : "ACTIVE"],
      );
      if (result.rows.length !== 1) {
        throw new FormsError(
          "FORM_DEFINITION_NOT_FOUND",
          `form definition ${form_definition_id} not found`,
        );
      }
      return loadDefinition(form_definition_id);
    },
  };
}
