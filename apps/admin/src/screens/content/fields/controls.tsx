// Scalar field controls (PCMS-ADMIN-T002; Admin spec §8).
// Each control renders inside a <Field> and binds a wire-shaped value.

import type { ChangeEvent } from "react";
import { useEffect, useId, useState } from "react";
import { apiGet } from "../../../api/client.js";
import type { FieldSchemaWire } from "../../../api/content.js";
import { Field, Input, Select, Switch, Textarea } from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { fromDatetimeWire, integerIssues, moneyIssues, toDatetimeWire } from "./field-utils.js";
import type { FieldControlProps } from "./registry.js";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const INPUT_TYPES: Readonly<Record<string, string>> = {
  email: "email",
  phone: "tel",
  url: "url",
};

export function TextInputControl(props: FieldControlProps) {
  return (
    <Input
      type={INPUT_TYPES[props.schema.type] ?? "text"}
      value={asString(props.value)}
      disabled={props.disabled}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
    />
  );
}

export function TextControl(props: FieldControlProps) {
  return (
    <Textarea
      value={asString(props.value)}
      disabled={props.disabled}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value)}
    />
  );
}

export function IntegerControl(props: FieldControlProps) {
  const bounds: { min?: number; max?: number } = {};
  if (typeof props.schema.min === "number") bounds.min = props.schema.min;
  if (typeof props.schema.max === "number") bounds.max = props.schema.max;
  const issues = integerIssues(props.value, bounds);
  return (
    <>
      <Input
        inputMode="numeric"
        value={asString(props.value)}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
      />
      {issues.length === 0 ? null : <div className="pcms-field__error">{issues.join(". ")}</div>}
    </>
  );
}

export function DecimalControl(props: FieldControlProps) {
  const raw = asString(props.value);
  const malformed = raw !== "" && !/^-?(0|[1-9]\d{0,17})(\.\d{1,6})?$/.test(raw);
  return (
    <>
      <Input
        inputMode="decimal"
        placeholder={t("blocks.decimal_placeholder")}
        value={raw}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
      />
      {malformed ? <div className="pcms-field__error">{t("blocks.decimal_invalid")}</div> : null}
    </>
  );
}

export function MoneyControl(props: FieldControlProps) {
  const money = (typeof props.value === "object" && props.value !== null ? props.value : {}) as {
    amount?: unknown;
    currency?: unknown;
  };
  const issues = moneyIssues(props.value);
  const update = (patch: { amount?: string; currency?: string }) => {
    props.onChange({
      amount: patch.amount ?? (typeof money.amount === "string" ? money.amount : ""),
      currency: patch.currency ?? (typeof money.currency === "string" ? money.currency : ""),
    });
  };
  return (
    <div className="pcms-money">
      <Input
        inputMode="decimal"
        placeholder="125000.00"
        aria-label={t("blocks.money_amount")}
        value={typeof money.amount === "string" ? money.amount : ""}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => update({ amount: event.target.value })}
      />
      <Input
        placeholder="RUB"
        aria-label={t("blocks.money_currency")}
        maxLength={3}
        value={typeof money.currency === "string" ? money.currency : ""}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          update({ currency: event.target.value.toUpperCase() })
        }
      />
      {issues.length === 0 ? null : <div className="pcms-field__error">{issues.join(". ")}</div>}
    </div>
  );
}

export function SwitchControl(props: FieldControlProps) {
  return (
    <Switch
      checked={props.value === true}
      label={props.value === true ? t("blocks.switch_yes") : t("blocks.switch_no")}
      onChange={props.onChange}
      {...(props.disabled === true ? { disabled: true } : {})}
    />
  );
}

export function DateControl(props: FieldControlProps) {
  return (
    <Input
      type="date"
      value={asString(props.value)}
      disabled={props.disabled}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
    />
  );
}

export function DatetimeControl(props: FieldControlProps) {
  const raw = asString(props.value);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Input
        type="datetime-local"
        value={raw === "" ? "" : fromDatetimeWire(raw)}
        disabled={props.disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          if (event.target.value === "") {
            props.onChange("");
            setError(null);
            return;
          }
          const wire = toDatetimeWire(event.target.value);
          if (wire === null) {
            setError(t("blocks.datetime_parse_error"));
            return;
          }
          setError(null);
          props.onChange(wire);
        }}
      />
      {error === null ? null : <div className="pcms-field__error">{error}</div>}
    </>
  );
}

export function EnumControl(props: FieldControlProps) {
  const values = props.schema.values ?? [];
  const current = asString(props.value);
  return (
    <Select
      value={current}
      disabled={props.disabled}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value)}
    >
      <option value="">{t("blocks.not_selected")}</option>
      {values.map((value: string) => (
        <option key={value} value={value}>
          {value}
        </option>
      ))}
    </Select>
  );
}

/**
 * Icon field (Font Awesome class string, e.g. "fa-solid fa-shield-halved").
 * A free input (sites may use glyphs outside the shipped catalog) with a
 * datalist fed by GET /discovery/content/icons — a typo used to degrade
 * silently to a fallback glyph, the list makes the valid values visible.
 */
let iconCatalogPromise: Promise<readonly string[]> | null = null;
function iconCatalog(): Promise<readonly string[]> {
  iconCatalogPromise ??= apiGet<{ items: readonly string[] }>("/discovery/content/icons")
    .then((result) => result.items)
    .catch(() => [] as readonly string[]);
  return iconCatalogPromise;
}

export function IconControl(props: FieldControlProps) {
  const [catalog, setCatalog] = useState<readonly string[]>([]);
  useEffect(() => {
    let alive = true;
    void iconCatalog().then((items) => {
      if (alive) setCatalog(items);
    });
    return () => {
      alive = false;
    };
  }, []);
  const listId = useId();
  const current = asString(props.value);
  return (
    <>
      <Input
        value={current}
        disabled={props.disabled}
        list={listId}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
      />
      <datalist id={listId}>
        {catalog.map((icon) => (
          <option key={icon} value={icon} />
        ))}
      </datalist>
    </>
  );
}

/** Safe fallback for unknown editor hints (Admin spec §7). */
export function GenericControl(props: FieldControlProps & { readonly hint?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  void props.hint;
  void draft;
  return (
    <Input
      value={asString(props.value)}
      disabled={props.disabled}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
    />
  );
}

export type { FieldSchemaWire };
