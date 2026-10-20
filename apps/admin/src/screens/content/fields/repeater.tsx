// Repeater editor (PCMS-ADMIN-T004; Admin spec §9; redesign spec §17):
// add / edit / duplicate / remove / drag reorder (with keyboard alternatives)
// / collapse rows. Rows are named by the field's presentation entity label
// (e.g. "Advantage 1", not "Row 1"); Stable item ids are preserved across
// reorders and hidden from the editor.

import type { DragEvent } from "react";
import { useState } from "react";
import { Button, Icon, IconButton } from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { repeaterItemLabel, stableId } from "./field-utils.js";
import type { FieldControlProps, FieldSchemaWire } from "./registry.js";
import {
  duplicateRepeaterItem,
  moveRepeaterItem,
  type RepeaterItem,
  withItemIds,
} from "./repeater-utils.js";
import { ObjectFields } from "./structured.js";

export function RepeaterEditor(props: FieldControlProps) {
  const rows = withItemIds(Array.isArray(props.value) ? (props.value as RepeaterItem[]) : []);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const itemFields = props.schema.item?.fields ?? {};
  const minItems = props.schema.minItems ?? 0;
  const maxItems = props.schema.maxItems;
  const disabled = props.disabled === true;
  const itemLabel = repeaterItemLabel(props.fieldId ?? "") ?? t("repeater_add");

  const update = (next: readonly RepeaterItem[]) => props.onChange(next);
  const keyOf = (row: RepeaterItem, index: number): string =>
    typeof row.itemId === "string" ? row.itemId : `row-${index}`;

  const reorder = (from: number, to: number) => update(moveRepeaterItem(rows, from, to));

  const onDrop = (event: DragEvent, to: number) => {
    event.preventDefault();
    if (dragFrom !== null) reorder(dragFrom, to);
    setDragFrom(null);
  };

  return (
    <div className="pcms-rows" data-testid="repeater">
      {rows.map((row, index) => {
        const id = keyOf(row, index);
        const isCollapsed = collapsed.has(id);
        return (
          <fieldset
            key={id}
            className="pcms-fieldset pcms-repeater-row"
            draggable={!disabled}
            onDragStart={() => setDragFrom(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, index)}
            aria-label={`${itemLabel} ${index + 1}`}
          >
            <legend>
              <span className="pcms-repeater-row__grip" aria-hidden="true">
                <Icon name="grip" />
              </span>
              {itemLabel} {index + 1}
            </legend>
            {isCollapsed ? null : (
              <div className="pcms-repeater-row__fields">
                <ObjectFields
                  fields={itemFields}
                  values={row}
                  onChange={(values) => update(rows.with(index, values as RepeaterItem))}
                />
              </div>
            )}
            <div className="pcms-row__actions">
              <IconButton
                small
                icon={isCollapsed ? "expand" : "collapse"}
                label={isCollapsed ? t("repeater_expand") : t("repeater_collapse")}
                aria-expanded={!isCollapsed}
                disabled={disabled}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              />
              <IconButton
                small
                icon="arrowUp"
                label={t("repeater_move_up", { n: index + 1 })}
                disabled={disabled || index === 0}
                onClick={() => reorder(index, index - 1)}
              />
              <IconButton
                small
                icon="arrowDown"
                label={t("repeater_move_down", { n: index + 1 })}
                disabled={disabled || index === rows.length - 1}
                onClick={() => reorder(index, index + 1)}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  update([
                    ...rows.slice(0, index + 1),
                    duplicateRepeaterItem(row),
                    ...rows.slice(index + 1),
                  ])
                }
              >
                {t("duplicate")}
              </Button>
              <IconButton
                small
                variant="danger"
                icon="delete"
                label={t("repeater_delete")}
                disabled={disabled || rows.length <= minItems}
                onClick={() => update(rows.toSpliced(index, 1))}
              />
            </div>
          </fieldset>
        );
      })}
      <div className="pcms-actions-row">
        <Button
          size="sm"
          disabled={disabled || (maxItems !== undefined && rows.length >= maxItems)}
          onClick={() => update([...rows, { itemId: stableId() }])}
        >
          {t("repeater_add")} {itemLabel.toLowerCase()}
        </Button>
        <span className="pcms-field__hint">
          {t("repeater_count")}: {rows.length}
          {maxItems === undefined ? "" : ` / ${maxItems}`}
        </span>
      </div>
    </div>
  );
}

export type { FieldControlProps, FieldSchemaWire };
