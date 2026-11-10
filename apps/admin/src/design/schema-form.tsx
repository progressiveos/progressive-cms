// Schema-driven field controls (CORE-PAYMENTS-ADMIN-CONFIG-01 §9.4): a
// bounded renderer for string/boolean/number/integer/enum, one-level named
// objects, editable string lists (CIDR), multi-line PEM and password inputs.
// An unsupported shape produces an explicit "interface update required"
// notice instead of raw JSON.
import { Button, Field, Input, Select, Switch, Textarea } from "./ui.js";
import { t } from "../i18n/index.js";
import {
  describeDefault,
  type DocError,
  type DocState,
  isSecretRefSlot,
  isUnsupportedShape,
  type SchemaProperty,
} from "./schema-model.js";
export { isUnsupportedShape } from "./schema-model.js";

export interface FieldMeta {
  /** Human label — never the bare machine key when a label exists. */
  readonly label: string;
  readonly hint?: string;
}

export interface SchemaFieldProps {
  readonly propertyKey: string;
  readonly schema: SchemaProperty;
  readonly meta: FieldMeta;
  readonly state: DocState;
  readonly onChange: (next: DocState) => void;
  readonly error?: DocError | undefined;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly labelPrefix?: string;
}

function hintText(schema: SchemaProperty, meta: FieldMeta): string | undefined {
  const parts: string[] = [];
  if (meta.hint !== undefined) parts.push(meta.hint);
  if (schema.description !== undefined && schema.description !== meta.hint) {
    parts.push(schema.description);
  }
  const fallback = describeDefault(schema.default);
  if (fallback !== null) {
    parts.push(t("extensions.settings_hint_default", { value: fallback }));
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function withScalar(state: DocState, key: string, value: string): DocState {
  return { ...state, scalars: { ...state.scalars, [key]: value } };
}

export function SchemaField(props: SchemaFieldProps) {
  const { propertyKey: key, schema, state, meta, disabled } = props;
  const error = props.error;
  const hint = hintText(schema, meta);
  const hintProps = hint === undefined ? {} : { hint };
  const errorProps = error === undefined ? {} : { error: t(error.message) };
  const common = { ...hintProps, ...errorProps };
  const label =
    props.labelPrefix === undefined ? meta.label : `${props.labelPrefix} · ${meta.label}`;

  if (isUnsupportedShape(schema)) {
    return (
      <Field label={label} {...common}>
        <p className="pcms-field__hint">{t("payments.settings_unsupported_field")}</p>
      </Field>
    );
  }
  if (schema.type === "boolean") {
    const raw = state.scalars[key];
    const checked = raw === undefined ? schema.default === true : raw === "true";
    return (
      <Field label={label} {...common}>
        <Switch
          label={label}
          checked={checked}
          {...(disabled === undefined ? {} : { disabled })}
          onChange={(next) => props.onChange(withScalar(state, key, next ? "true" : "false"))}
        />
      </Field>
    );
  }
  if (schema.enum !== undefined) {
    return (
      <Field label={label} {...common}>
        <Select
          value={state.scalars[key] ?? ""}
          disabled={disabled}
          onChange={(event) => props.onChange(withScalar(state, key, event.target.value))}
        >
          <option value="">{t("payments.settings_use_default")}</option>
          {schema.enum.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (schema.type === "array") {
    // One entry per line: a CIDR/host allowlist is edited as a list, never as
    // JSON. Blank lines and surrounding spaces are ignored on save.
    const items = state.lists[key] ?? [];
    return (
      <Field label={label} {...common}>
        <Textarea
          rows={Math.min(Math.max(items.length + 1, 3), 12)}
          spellCheck={false}
          style={{ fontFamily: "monospace" }}
          placeholder={t("payments.settings_list_item")}
          value={items.join("\n")}
          {...(disabled === undefined ? {} : { disabled })}
          onChange={(event) =>
            props.onChange({
              ...state,
              lists: { ...state.lists, [key]: event.target.value.split("\n") },
            })
          }
        />
      </Field>
    );
  }
  if (schema.type === "object") {
    const children = state.nested[key] ?? {};
    const update = (childKey: string, value: string) => {
      props.onChange({
        ...state,
        nested: { ...state.nested, [key]: { ...children, [childKey]: value } },
      });
    };
    return (
      <Field label={label} {...common}>
        <div style={{ display: "grid", gap: 8 }}>
          {Object.entries(schema.properties ?? {}).map(([childKey, childSchema]) => (
            <Field key={childKey} label={childSchema.title ?? humanizeKey(childKey)}>
              <Input
                value={children[childKey] ?? ""}
                disabled={disabled}
                type={
                  childSchema.type === "number" || childSchema.type === "integer"
                    ? "number"
                    : "text"
                }
                onChange={(event) => update(childKey, event.target.value)}
              />
            </Field>
          ))}
        </div>
      </Field>
    );
  }
  const multiline =
    schema["x-ui-multiline"] === true || schema.format === "pem" || schema.format === "multiline";
  if (multiline) {
    return (
      <Field label={label} {...common}>
        <Textarea
          rows={6}
          spellCheck={false}
          style={{ fontFamily: "monospace" }}
          value={state.scalars[key] ?? ""}
          disabled={disabled}
          onChange={(event) => props.onChange(withScalar(state, key, event.target.value))}
        />
      </Field>
    );
  }
  const numeric = schema.type === "number" || schema.type === "integer";
  return (
    <Field label={label} {...common}>
      <Input
        type={numeric ? "number" : "text"}
        inputMode={numeric ? "decimal" : undefined}
        style={numeric ? { maxWidth: 200 } : undefined}
        value={state.scalars[key] ?? ""}
        disabled={disabled}
        onChange={(event) => props.onChange(withScalar(state, key, event.target.value))}
      />
    </Field>
  );
}

export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Splits schema keys into the visible block and the collapsed "advanced"
 * block declared by UI metadata. */
export function splitByAdvanced(
  properties: Readonly<Record<string, SchemaProperty>>,
  advanced: readonly string[],
): { readonly primary: readonly string[]; readonly advanced: readonly string[] } {
  const keys = Object.keys(properties).filter((key) => !isSecretRefSlot(properties[key]));
  const advancedSet = new Set(advanced);
  return {
    primary: keys.filter((key) => !advancedSet.has(key)),
    advanced: keys.filter((key) => advancedSet.has(key)),
  };
}
