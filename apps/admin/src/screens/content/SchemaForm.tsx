// Schema-driven form (PCMS-ADMIN-T002): renders an ObjectFieldSchema as an
// editable form. Unknown content types/fields fail safe at the server; here we
// only shape values. Save semantics (draft/seal) live in the workspace (T003+).
import type { FieldSchemaWire } from "../../api/content.js";
import { ObjectFields } from "./fields/structured.js";

export function SchemaForm(props: {
  readonly fields: Readonly<Record<string, FieldSchemaWire>>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly onChange: (values: Record<string, unknown>) => void;
  /** bodyPolicy block_document: the body panel edits payload.blocks instead. */
  readonly skipBlockDocument?: boolean;
  readonly disabled?: boolean;
}) {
  const fields =
    props.skipBlockDocument === true
      ? Object.fromEntries(
          Object.entries(props.fields).filter(([, schema]) => schema.type !== "block_document"),
        )
      : props.fields;
  return (
    <div className="pcms-form-grid pcms-form-grid--single">
      <ObjectFields
        fields={fields}
        values={props.values}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        onChange={(values) => props.onChange(values)}
      />
    </div>
  );
}
