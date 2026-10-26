// Generic JSON-schema props form (PCMS-ADMIN-T006/T007).
// Covers the JSON-schema subset the v1 first-party block props schemas use.
// Special cases: free-form object slots are RichText ASTs (rendered by the
// rich text editor); reference-declared props get StableId pickers; action-
// shaped objects render the typed ActionEditor. The server schema remains
// the validation authority (client feedback comes from validate_block_props).
import { useState } from "react";
import type { BlockPropSchema, BlockReferenceSpec } from "../../../api/blocks.js";
import { Button, Field, Icon, Input, Select, Switch, Textarea } from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { stableId } from "../fields/field-utils.js";
import { EntryPickerDialog, MediaPickerDialog } from "../fields/pickers.js";
import { RichTextEditor } from "../fields/richtext.js";
import { ActionEditor, isActionSchema } from "./ActionEditor.js";

const STABLE_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const RICH_TEXT_STUB = { id: "", type: "object", fields: {} };

interface PathContext {
  readonly references: readonly BlockReferenceSpec[];
  /** Current prop path in reference-spec notation, e.g. "items[].media_id". */
  readonly path: string;
}

function referenceFor(context: PathContext): BlockReferenceSpec | null {
  return context.references.find((reference) => reference.prop === context.path) ?? null;
}

export function JsonPropsForm(props: {
  readonly schema: BlockPropSchema;
  readonly value: Record<string, unknown>;
  readonly onChange: (value: Record<string, unknown>) => void;
  readonly references: readonly BlockReferenceSpec[];
  /** Reference-path prefix for nested rendering, "" at the top level. */
  readonly pathPrefix?: string;
  readonly disabled?: boolean;
}) {
  const properties = props.schema.properties ?? {};
  const required = props.schema.required ?? [];
  const prefix = props.pathPrefix ?? "";
  return (
    <>
      {Object.entries(properties).map(([key, propSchema]) => (
        <PropField
          key={key}
          name={key}
          schema={propSchema}
          required={required.includes(key)}
          value={props.value[key]}
          {...(props.disabled === true ? { disabled: true } : {})}
          context={{ references: props.references, path: `${prefix}${key}` }}
          onChange={(value) => props.onChange({ ...props.value, [key]: value })}
        />
      ))}
    </>
  );
}

function PropField(props: {
  readonly name: string;
  readonly schema: BlockPropSchema;
  readonly required: boolean;
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly context: PathContext;
  readonly onChange: (value: unknown) => void;
}) {
  const schema = props.schema;
  const label = humanize(props.name);

  // Free-form object slots in v1 block props are exactly the RichText ASTs.
  if (schema.type === "object" && schema.properties === undefined) {
    return (
      <Field label={label} required={props.required}>
        <RichTextEditor
          value={props.value}
          onChange={props.onChange}
          {...(props.disabled === true ? { disabled: true } : {})}
          schema={RICH_TEXT_STUB as never}
        />
      </Field>
    );
  }
  if (isActionSchema(schema)) {
    return (
      <Field label={label} required={props.required}>
        <ActionEditor
          value={
            (typeof props.value === "object" && props.value !== null
              ? props.value
              : { type: "none" }) as Record<string, unknown>
          }
          onChange={props.onChange}
          {...(props.disabled === true ? { disabled: true } : {})}
        />
      </Field>
    );
  }
  if (schema.type === "array" && schema.items !== undefined) {
    return (
      <ArrayField
        name={props.name}
        label={label}
        itemSchema={schema.items}
        required={props.required}
        value={Array.isArray(props.value) ? (props.value as unknown[]) : []}
        {...(props.disabled === true ? { disabled: true } : {})}
        context={props.context}
        onChange={props.onChange}
      />
    );
  }
  if (schema.type === "object" && schema.properties !== undefined) {
    return (
      <fieldset className="pcms-fieldset">
        <legend>{label}</legend>
        <JsonPropsForm
          schema={schema}
          value={
            (typeof props.value === "object" && props.value !== null ? props.value : {}) as Record<
              string,
              unknown
            >
          }
          onChange={props.onChange}
          references={props.context.references}
          pathPrefix={`${props.context.path}.`}
          {...(props.disabled === true ? { disabled: true } : {})}
        />
      </fieldset>
    );
  }
  return (
    <ScalarField
      name={props.name}
      schema={schema}
      label={label}
      required={props.required}
      value={props.value}
      {...(props.disabled === true ? { disabled: true } : {})}
      context={props.context}
      onChange={props.onChange}
    />
  );
}

function ScalarField(props: {
  readonly name: string;
  readonly schema: BlockPropSchema;
  readonly label: string;
  readonly required: boolean;
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly context: PathContext;
  readonly onChange: (value: unknown) => void;
}) {
  const schema = props.schema;
  const reference = referenceFor(props.context);

  if (schema.enum !== undefined) {
    return (
      <Field label={props.label} required={props.required}>
        <Select
          value={typeof props.value === "string" ? props.value : ""}
          disabled={props.disabled}
          onChange={(event) =>
            props.onChange(event.target.value === "" ? undefined : event.target.value)
          }
        >
          <option value="">{t("blocks.not_selected")}</option>
          {schema.enum.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (schema.type === "boolean") {
    return (
      <Field label={props.label} required={props.required}>
        <Switch
          checked={props.value === true}
          label={props.value === true ? t("blocks.switch_yes") : t("blocks.switch_no")}
          onChange={props.onChange}
          {...(props.disabled === true ? { disabled: true } : {})}
        />
      </Field>
    );
  }
  if (reference !== null && reference.kind === "media") {
    return (
      <MediaRefField
        label={props.label}
        required={props.required}
        value={props.value}
        {...(props.disabled === true ? { disabled: true } : {})}
        onChange={props.onChange}
      />
    );
  }
  if (schema.pattern === STABLE_ID_PATTERN) {
    // Stable ids without a media reference are entry references.
    return (
      <EntryRefField
        label={props.label}
        required={props.required}
        value={props.value}
        {...(props.disabled === true ? { disabled: true } : {})}
        onChange={props.onChange}
      />
    );
  }
  const isNumber = schema.type === "integer" || schema.type === "number";
  const isLongText =
    schema.type === "string" && schema.maxLength !== undefined && schema.maxLength > 1000;
  return (
    <Field label={props.label} required={props.required}>
      {isLongText ? (
        <Textarea
          value={typeof props.value === "string" ? props.value : ""}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <Input
          type={isNumber ? "number" : "text"}
          inputMode={isNumber ? "numeric" : undefined}
          value={props.value === undefined || props.value === null ? "" : String(props.value)}
          disabled={props.disabled}
          onChange={(event) =>
            props.onChange(
              isNumber
                ? event.target.value === ""
                  ? undefined
                  : Number(event.target.value)
                : event.target.value,
            )
          }
        />
      )}
    </Field>
  );
}

function MediaRefField(props: {
  readonly label: string;
  readonly required: boolean;
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly onChange: (value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = typeof props.value === "string" ? props.value : null;
  return (
    <Field label={props.label} required={props.required}>
      <div className="pcms-ref">
        {id === null ? (
          <span className="pcms-field__hint">{t("blocks.ref_none")}</span>
        ) : (
          <span className="pcms-picker-row__meta">{id}</span>
        )}
        <Button size="sm" disabled={props.disabled} onClick={() => setOpen(true)}>
          {t("blocks.ref_pick")}
        </Button>
        {id === null ? null : (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => props.onChange(undefined)}
          >
            <Icon name="close" label={t("delete")} />
          </Button>
        )}
      </div>
      {open ? (
        <MediaPickerDialog
          open
          onClose={() => setOpen(false)}
          title={props.label}
          onPick={(mediaId) => {
            setOpen(false);
            props.onChange(mediaId);
          }}
        />
      ) : null}
    </Field>
  );
}

function EntryRefField(props: {
  readonly label: string;
  readonly required: boolean;
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly onChange: (value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = typeof props.value === "string" ? props.value : null;
  return (
    <Field label={props.label} required={props.required}>
      <div className="pcms-ref">
        {id === null ? (
          <span className="pcms-field__hint">{t("blocks.ref_none")}</span>
        ) : (
          <span className="pcms-picker-row__meta">{id}</span>
        )}
        <Button size="sm" disabled={props.disabled} onClick={() => setOpen(true)}>
          {t("blocks.ref_pick")}
        </Button>
      </div>
      {open ? (
        <EntryPickerDialog
          open
          onClose={() => setOpen(false)}
          title={props.label}
          onPick={(entryId) => {
            setOpen(false);
            props.onChange(entryId);
          }}
        />
      ) : null}
    </Field>
  );
}

/** Initial value for one row of a scalar-item array (string ids, enums). */
function emptyScalarValue(schema: BlockPropSchema): unknown {
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return undefined;
  return "";
}

function ArrayField(props: {
  readonly name: string;
  readonly label: string;
  readonly itemSchema: BlockPropSchema;
  readonly required: boolean;
  readonly value: readonly unknown[];
  readonly disabled?: boolean;
  readonly context: PathContext;
  readonly onChange: (value: unknown) => void;
}) {
  const rows = props.value;
  const hasId = props.itemSchema.properties?.id !== undefined;
  const nestedPrefix = `${props.context.path}[].`;
  // Arrays of scalars (field ids, content-type keys, entry ids) are rows of
  // ONE control, not objects with properties — an object form would render no
  // input at all for them.
  const scalarItems = props.itemSchema.type !== "object";

  const update = (next: readonly unknown[]) => props.onChange(next);
  return (
    <fieldset className="pcms-fieldset">
      <legend>
        {props.label} ({rows.length})
      </legend>
      <div className="pcms-rows">
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are identified by their id prop when present
          <fieldset key={index} className="pcms-fieldset">
            <legend>{index + 1}</legend>
            {scalarItems ? (
              <ScalarField
                name={`${props.name}_${index}`}
                schema={props.itemSchema}
                label={String(index + 1)}
                required={false}
                value={row}
                {...(props.disabled === true ? { disabled: true } : {})}
                context={{ references: props.context.references, path: `${props.context.path}[]` }}
                onChange={(value) => update(rows.with(index, value))}
              />
            ) : (
              <JsonPropsForm
                schema={props.itemSchema}
                value={(row ?? {}) as Record<string, unknown>}
                onChange={(value) => update(rows.with(index, value as Record<string, unknown>))}
                references={props.context.references}
                pathPrefix={nestedPrefix}
                {...(props.disabled === true ? { disabled: true } : {})}
              />
            )}
            <div className="pcms-row__actions">
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("blocks.array_move_up", { n: index + 1 })}
                disabled={props.disabled || index === 0}
                onClick={() => update(moveItem(rows, index, index - 1))}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("blocks.array_move_down", { n: index + 1 })}
                disabled={props.disabled || index === rows.length - 1}
                onClick={() => update(moveItem(rows, index, index + 1))}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("blocks.array_delete", { n: index + 1 })}
                disabled={props.disabled}
                onClick={() => update(rows.toSpliced(index, 1))}
              >
                <Icon name="close" />
              </Button>
            </div>
          </fieldset>
        ))}
      </div>
      <Button
        size="sm"
        disabled={props.disabled}
        onClick={() =>
          update([
            ...rows,
            scalarItems ? emptyScalarValue(props.itemSchema) : hasId ? { id: stableId() } : {},
          ])
        }
      >
        {t("repeater_add")}
      </Button>
    </fieldset>
  );
}

function moveItem<T>(items: readonly T[], from: number, to: number): readonly T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(Math.max(0, Math.min(to, items.length - 1)), 0, moved);
  return next;
}

function humanize(name: string): string {
  const words = name.split("_").filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) return name;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}
