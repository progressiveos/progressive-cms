// Structured field controls (PCMS-ADMIN-T002; Admin spec §8/§9/§28;
// redesign spec §18/§19): object/list/repeater render nested schema-driven
// groups; media/relation controls store StableIds via pickers and identify
// the referenced object with human titles/thumbnails — UUID stays a detail.
import { useEffect, useState } from "react";
import type { FieldSchemaWire } from "../../../api/content.js";
import { Button, Field, Icon, IconButton } from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { emptyFieldValue, fieldLabel } from "./field-utils.js";
import {
  EntryPickerDialog,
  loadEntryTitles,
  loadMediaMeta,
  MediaPickerDialog,
  type MediaSummaryWire,
  ReferenceChip,
} from "./pickers.js";
import type { FieldControlProps } from "./registry.js";
import { fieldControlFor } from "./registry.js";

/* --- object: nested typed group (recursive) --- */

export function ObjectControl(props: FieldControlProps) {
  const fields = props.schema.fields ?? {};
  const values = (
    typeof props.value === "object" && props.value !== null ? props.value : {}
  ) as Record<string, unknown>;
  return (
    <fieldset className="pcms-fieldset" disabled={props.disabled}>
      <ObjectFields
        fields={fields}
        values={values}
        onChange={props.onChange}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      />
    </fieldset>
  );
}

export function ObjectFields(props: {
  readonly fields: Readonly<Record<string, FieldSchemaWire>>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly onChange: (values: Record<string, unknown>) => void;
  readonly disabled?: boolean;
}) {
  return (
    <>
      {Object.entries(props.fields).map(([fieldId, schema]) => (
        <BoundField
          key={fieldId}
          fieldId={fieldId}
          schema={schema}
          value={props.values[fieldId]}
          {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
          onChange={(value) => props.onChange({ ...props.values, [fieldId]: value })}
        />
      ))}
    </>
  );
}

/** One labeled field row: resolves the control from the registry (spec §7).
 * Optional-ness is a compact label-row marker, not a dedicated hint line. */
export function BoundField(props: {
  readonly fieldId: string;
  readonly schema: FieldSchemaWire;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly disabled?: boolean;
}) {
  const Control = fieldControlFor(props.schema.type);
  return (
    <Field
      label={fieldLabel(props.fieldId)}
      required={props.schema.required === true}
      optional={props.schema.required !== true}
    >
      <Control
        schema={props.schema}
        value={props.value}
        onChange={props.onChange}
        fieldId={props.fieldId}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      />
    </Field>
  );
}

/* --- list: single item schema, non-list --- */

export function ListControl(props: FieldControlProps) {
  const itemSchema = props.schema.item;
  const items = Array.isArray(props.value) ? (props.value as unknown[]) : [];
  if (itemSchema === undefined) {
    return <p className="pcms-field__hint">{t("list_item_schema_missing")}</p>;
  }
  const update = (next: readonly unknown[]) => props.onChange(next);
  return (
    <div className="pcms-rows">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the list field contract has no item identity
        <div key={index} className="pcms-row">
          <div className="pcms-row__body">
            <ListRow
              schema={itemSchema}
              value={item}
              {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
              onChange={(value) => update(items.with(index, value))}
            />
          </div>
          <div className="pcms-row__actions">
            <IconButton
              small
              variant="danger"
              icon="delete"
              label={t("list_delete_item")}
              disabled={props.disabled}
              onClick={() => update(items.toSpliced(index, 1))}
            />
          </div>
        </div>
      ))}
      <Button
        size="sm"
        disabled={props.disabled}
        onClick={() => update([...items, emptyFieldValue(itemSchema.type)])}
      >
        {t("list_add_item")}
      </Button>
    </div>
  );
}

function ListRow(props: {
  readonly schema: FieldSchemaWire;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly disabled?: boolean;
}) {
  const Control = fieldControlFor(props.schema.type);
  return (
    <Control
      schema={props.schema}
      value={props.value}
      onChange={props.onChange}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
    />
  );
}

/* --- media / relation: StableId references via pickers --- */

const MEDIA_ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Image field card: thumbnail + filename + dimensions + actions (spec §19).
 * The StableId is not primary content; a broken asset shows an explicit
 * missing state, never a silent empty rectangle.
 * `assetBase` (theme settings only): when set, a non-UUID string value is a
 * bundled theme asset path ("assets/img/…") — previewed from the theme's
 * public assets instead of showing a misleading missing state (0.1.78). */
export function MediaControl(props: FieldControlProps & { readonly assetBase?: string }) {
  const [open, setOpen] = useState(false);
  const id = typeof props.value === "string" && props.value !== "" ? props.value : null;
  const assetPath = id !== null && props.assetBase !== undefined && !MEDIA_ID_LIKE.test(id);
  const fileSrc =
    id === null
      ? null
      : assetPath
        ? `${props.assetBase}/${id.replace(/^\/+/, "")}`
        : `/api/v1/media/${id}/file?preview=thumbnail`;
  const [meta, setMeta] = useState<MediaSummaryWire | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (id === null || assetPath) {
      setMeta(null);
      setMissing(false);
      return undefined;
    }
    let cancelled = false;
    setMissing(false);
    loadMediaMeta(id)
      .then((asset) => {
        if (!cancelled) setMeta(asset);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, assetPath]);

  return (
    <div className="pcms-mediafield">
      {id === null ? (
        <div className="pcms-mediafield__empty">
          <Icon name="image" />
          <span className="pcms-field__hint">{t("media_none")}</span>
        </div>
      ) : (
        <div className="pcms-mediafield__card">
          {missing ? (
            <span
              className="pcms-mediafield__thumb pcms-mediafield__thumb--missing"
              role="img"
              aria-label={t("media_missing")}
            >
              <Icon name="warning" />
            </span>
          ) : (
            <img
              className="pcms-mediafield__thumb"
              src={fileSrc ?? undefined}
              alt={assetPath ? id : (meta?.title ?? meta?.filenameOriginal ?? "")}
              loading="lazy"
              onError={() => setMissing(true)}
            />
          )}
          <div className="pcms-mediafield__meta">
            <span className="pcms-mediafield__name">
              {assetPath ? id : (meta?.title ?? meta?.filenameOriginal ?? id)}
            </span>
            <span className="pcms-field__hint pcms-mediafield__dims">
              {assetPath
                ? t("media_theme_asset")
                : meta === null
                  ? id
                  : [
                      meta.width !== null && meta.height !== null
                        ? `${meta.width}×${meta.height}`
                        : null,
                      meta.mimeType,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
            </span>
          </div>
          <div className="pcms-mediafield__actions">
            <IconButton
              small
              icon="image"
              label={id === null ? t("media_choose") : t("media_replace")}
              disabled={props.disabled}
              onClick={() => setOpen(true)}
            />
            <IconButton
              small
              icon="external"
              label={t("media_open")}
              onClick={() => window.open(fileSrc ?? "", "_blank", "noopener")}
            />
            <IconButton
              small
              variant="danger"
              icon="unlink"
              label={t("media_unlink")}
              disabled={props.disabled}
              onClick={() => props.onChange("")}
            />
          </div>
        </div>
      )}
      {id === null ? (
        <IconButton
          small
          icon="image"
          label={t("media_choose")}
          disabled={props.disabled}
          onClick={() => setOpen(true)}
        />
      ) : null}
      <MediaPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("media_choose_title")}
        onPick={(mediaId) => props.onChange(mediaId)}
      />
    </div>
  );
}

export function MediaListControl(props: FieldControlProps) {
  const [open, setOpen] = useState(false);
  const items = Array.isArray(props.value) ? (props.value as string[]) : [];
  const update = (next: readonly string[]) => props.onChange(next);
  return (
    <div className="pcms-rows">
      {items.map((id, index) => (
        <MediaListRow
          key={id}
          id={id}
          disabled={props.disabled === true}
          onMove={(to) => {
            const next = [...items];
            const [moved] = next.splice(index, 1);
            if (moved !== undefined) next.splice(to, 0, moved);
            update(next);
          }}
          isFirst={index === 0}
          isLast={index === items.length - 1}
          onClear={() => update(items.toSpliced(index, 1))}
        />
      ))}
      <Button size="sm" disabled={props.disabled} onClick={() => setOpen(true)}>
        {t("media_add")}
      </Button>
      <MediaPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("media_add")}
        onPick={(mediaId) => update([...items, mediaId])}
      />
    </div>
  );
}

function MediaListRow(props: {
  readonly id: string;
  readonly disabled: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onMove: (to: number) => void;
  readonly onClear: () => void;
}) {
  const [meta, setMeta] = useState<MediaSummaryWire | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadMediaMeta(props.id)
      .then((asset) => {
        if (!cancelled) setMeta(asset);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.id]);
  return (
    <div className="pcms-row">
      <img
        className="pcms-mediafield__thumb pcms-mediafield__thumb--sm"
        src={`/api/v1/media/${props.id}/file?preview=thumbnail`}
        alt={meta?.title ?? meta?.filenameOriginal ?? ""}
        loading="lazy"
      />
      <ReferenceChip
        label={meta?.title ?? meta?.filenameOriginal ?? props.id}
        onClear={props.onClear}
        disabled={props.disabled}
      />
      <div className="pcms-row__actions">
        <IconButton
          small
          icon="arrowUp"
          label={t("list_move_up")}
          disabled={props.disabled || props.isFirst}
          onClick={() => props.onMove(-1)}
        />
        <IconButton
          small
          icon="arrowDown"
          label={t("list_move_down")}
          disabled={props.disabled || props.isLast}
          onClick={() => props.onMove(1)}
        />
      </div>
    </div>
  );
}

export function RelationControl(props: FieldControlProps) {
  const [open, setOpen] = useState(false);
  const id = typeof props.value === "string" && props.value !== "" ? props.value : null;
  return (
    <div className="pcms-ref">
      {id === null ? (
        <span className="pcms-field__hint">{t("relation_none")}</span>
      ) : (
        <TitledReferenceChip id={id} onClear={() => props.onChange("")} />
      )}
      <Button size="sm" disabled={props.disabled} onClick={() => setOpen(true)}>
        {t("relation_choose")}
      </Button>
      <EntryPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        {...(props.schema.accepts === undefined ? {} : { accepts: props.schema.accepts })}
        title={t("relation_choose_title")}
        onPick={(entryId) => props.onChange(entryId)}
      />
    </div>
  );
}

export function RelationListControl(props: FieldControlProps) {
  const [open, setOpen] = useState(false);
  const items = Array.isArray(props.value) ? (props.value as string[]) : [];
  const update = (next: readonly string[]) => props.onChange(next);
  return (
    <div className="pcms-rows">
      {items.map((id, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: media ids may legitimately repeat in an ordered list
        <div key={`${id}-${index}`} className="pcms-row">
          <TitledReferenceChip id={id} onClear={() => update(items.toSpliced(index, 1))} />
          <div className="pcms-row__actions">
            <IconButton
              small
              icon="arrowUp"
              label={t("list_move_up")}
              disabled={props.disabled || index === 0}
              onClick={() => {
                const next = [...items];
                const [moved] = next.splice(index, 1);
                if (moved !== undefined) next.splice(index - 1, 0, moved);
                update(next);
              }}
            />
            <IconButton
              small
              icon="arrowDown"
              label={t("list_move_down")}
              disabled={props.disabled || index === items.length - 1}
              onClick={() => {
                const next = [...items];
                const [moved] = next.splice(index, 1);
                if (moved !== undefined) next.splice(index + 1, 0, moved);
                update(next);
              }}
            />
          </div>
        </div>
      ))}
      <Button size="sm" disabled={props.disabled} onClick={() => setOpen(true)}>
        {t("relation_add")}
      </Button>
      <EntryPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        {...(props.schema.accepts === undefined ? {} : { accepts: props.schema.accepts })}
        title={t("relation_add")}
        onPick={(entryId) => update([...items, entryId])}
      />
    </div>
  );
}

/** Relation chip that resolves the entry id to its human title; the UUID
 * stays available as the chip tooltip (spec §18.1). */
export function TitledReferenceChip(props: { readonly id: string; readonly onClear?: () => void }) {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadEntryTitles()
      .then((titles) => {
        if (!cancelled) setTitle(titles.get(props.id) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.id]);
  return (
    <ReferenceChip
      label={title ?? t("relation_loading")}
      meta={title === null ? props.id.slice(0, 8) : undefined}
      onClear={props.onClear}
    />
  );
}

/* --- placeholders for dedicated editors (T005/T006) --- */
