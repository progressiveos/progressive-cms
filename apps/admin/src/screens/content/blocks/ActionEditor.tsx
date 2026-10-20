// Typed action picker (PCMS-ADMIN-T007; Admin spec §13: "Action picker typed,
// not raw URL-only"). Mirrors the v1 ACTION_PROP_SCHEMA union; the server
// schema stays the validation authority.

import { useState } from "react";
import { Field, Input, Select } from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { EntryPickerDialog, MediaPickerDialog } from "../fields/pickers.js";

// [wire type, catalog key] — labels resolve through t() at render time.
const ACTION_TYPES: readonly (readonly [string, string])[] = [
  ["internal_entry", "blocks.action_internal_entry"],
  ["external_url", "blocks.action_external_url"],
  ["anchor", "blocks.action_anchor"],
  ["form", "blocks.action_form"],
  ["phone", "blocks.action_phone"],
  ["email", "blocks.action_email"],
  ["media_download", "blocks.action_media_download"],
  ["none", "blocks.action_none"],
];

export function ActionEditor(props: {
  readonly value: Record<string, unknown>;
  readonly onChange: (value: Record<string, unknown>) => void;
  readonly disabled?: boolean;
}) {
  const [picker, setPicker] = useState<"entry" | "media" | null>(null);
  const type = typeof props.value.type === "string" ? props.value.type : "none";
  const set = (patch: Record<string, unknown>) =>
    props.onChange({ ...props.value, type, ...patch });
  const text = (key: string, label: string, placeholder?: string) => (
    <Field label={label} key={key}>
      <Input
        value={typeof props.value[key] === "string" ? (props.value[key] as string) : ""}
        placeholder={placeholder}
        disabled={props.disabled}
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </Field>
  );

  return (
    <div className="pcms-action">
      <Field label={t("blocks.action_type")}>
        <Select
          value={type}
          disabled={props.disabled}
          onChange={(event) =>
            props.onChange({ ...resetFor(event.target.value), type: event.target.value })
          }
        >
          {ACTION_TYPES.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </Select>
      </Field>
      {type === "internal_entry" ? (
        <div className="pcms-ref">
          <span className="pcms-picker-row__meta">
            {typeof props.value.entry_id === "string"
              ? props.value.entry_id
              : t("blocks.action_entry_none")}
          </span>
          <button type="button" className="pcms-chip__label" onClick={() => setPicker("entry")}>
            {t("blocks.action_pick_entry")}
          </button>
        </div>
      ) : null}
      {type === "external_url" ? text("url", t("blocks.action_url_label")) : null}
      {type === "anchor" ? text("anchor", t("blocks.action_anchor")) : null}
      {type === "form" ? (
        <>
          {text("form_definition_id", t("blocks.action_form_id"))}
          {text(
            "anchor_text",
            t("blocks.action_anchor_text"),
            t("blocks.action_anchor_text_placeholder"),
          )}
        </>
      ) : null}
      {type === "phone"
        ? text("phone", t("blocks.action_phone"), t("blocks.action_phone_placeholder"))
        : null}
      {type === "email" ? text("email", t("blocks.action_email")) : null}
      {type === "media_download" ? (
        <div className="pcms-ref">
          <span className="pcms-picker-row__meta">
            {typeof props.value.media_asset_id === "string"
              ? props.value.media_asset_id
              : t("blocks.action_file_none")}
          </span>
          <button type="button" className="pcms-chip__label" onClick={() => setPicker("media")}>
            {t("blocks.action_pick_file")}
          </button>
        </div>
      ) : null}
      {type === "external_url" ? text("target", t("blocks.action_target_label")) : null}
      {picker === "entry" ? (
        <EntryPickerDialog
          open
          onClose={() => setPicker(null)}
          title={t("blocks.action_entry_dialog")}
          onPick={(entryId) => {
            setPicker(null);
            set({ entry_id: entryId });
          }}
        />
      ) : null}
      {picker === "media" ? (
        <MediaPickerDialog
          open
          onClose={() => setPicker(null)}
          title={t("blocks.action_file_dialog")}
          onPick={(mediaId) => {
            setPicker(null);
            set({ media_asset_id: mediaId });
          }}
        />
      ) : null}
    </div>
  );
}

function resetFor(type: string): Record<string, unknown> {
  switch (type) {
    case "internal_entry":
    case "form":
    case "media_download":
      return {};
    default:
      return {};
  }
}

export function isActionSchema(schema: {
  readonly properties?: Readonly<Record<string, { readonly enum?: readonly string[] }>>;
}): boolean {
  const typeEnum = schema.properties?.type?.enum;
  return (
    Array.isArray(typeEnum) &&
    typeEnum.includes("internal_entry") &&
    typeEnum.includes("external_url")
  );
}
