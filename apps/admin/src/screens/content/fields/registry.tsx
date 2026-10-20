// Schema-driven field renderer registry (PCMS-ADMIN-T002; Admin spec §7/§8).
// The M02 field registry maps onto editor controls by field type. Unknown
// types get a safe generic control — the server validator stays authoritative.
import type { ComponentType } from "react";
import type { BlockDocumentWire } from "../../../api/blocks.js";
import type { FieldSchemaWire } from "../../../api/content.js";
import { BlockDocumentEditor } from "../blocks/BlockDocumentEditor.js";
import {
  DateControl,
  DatetimeControl,
  DecimalControl,
  EnumControl,
  GenericControl,
  IconControl,
  IntegerControl,
  MoneyControl,
  SwitchControl,
  TextControl,
  TextInputControl,
} from "./controls.js";
import { FIELD_TYPES_V1 } from "./registry-constants.js";
import { RepeaterEditor } from "./repeater.js";
import { RichTextEditor } from "./richtext.js";
import {
  ListControl,
  MediaControl,
  MediaListControl,
  ObjectControl,
  RelationControl,
  RelationListControl,
} from "./structured.js";

export interface FieldControlProps {
  readonly schema: FieldSchemaWire;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly disabled?: boolean;
  /** Schema field id this control edits — presentation labels, repeater item names. */
  readonly fieldId?: string;
}

export type FieldControl = ComponentType<FieldControlProps>;

/** Falls back to the safe generic control for unknown editor hints (spec §7). */
export function fieldControlFor(type: string): FieldControl {
  return CONTROLS[type] ?? GenericControl;
}

export { FIELD_TYPES_V1 };

const CONTROLS: Record<string, FieldControl> = {
  string: TextInputControl,
  slug: TextInputControl,
  email: TextInputControl,
  icon: IconControl,
  phone: TextInputControl,
  url: TextInputControl,
  text: TextControl,
  integer: IntegerControl,
  decimal: DecimalControl,
  money: MoneyControl,
  boolean: SwitchControl,
  date: DateControl,
  datetime: DatetimeControl,
  enum: EnumControl,
  media: MediaControl,
  media_list: MediaListControl,
  relation: RelationControl,
  relation_list: RelationListControl,
  object: ObjectControl,
  list: ListControl,
  repeater: RepeaterEditor,
  rich_text: RichTextEditor,
  block_document: BlockDocumentControl,
};

/** FieldControl adapter for the block document editor. */
function BlockDocumentControl(props: FieldControlProps) {
  return (
    <BlockDocumentEditor
      value={(props.value ?? null) as BlockDocumentWire | null}
      onChange={(document) => props.onChange(document)}
      {...(props.disabled === true ? { disabled: true } : {})}
    />
  );
}

export type { FieldSchemaWire };
export { GenericControl };
