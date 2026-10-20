// BlockDocument editor framework (PCMS-ADMIN-T006; Admin spec §10/§11).
// Registry-driven: the block palette and every props form come from
// /discovery/blocks — adding a block type needs no Admin code change.
// add / insert before-after / edit / duplicate / move / delete / collapse,
// semantic validation feedback via validate_block_props.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type BlockDocumentWire,
  type BlockNodeWire,
  type BlockSchemaWire,
  type BlockTypeSummary,
  getBlockSchema,
  listBlockTypes,
  validateBlock,
} from "../../../api/blocks.js";
import { Dialog } from "../../../design/dialog.js";
import { Badge, Button, Field, Icon } from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { stableId } from "../fields/field-utils.js";
import { JsonPropsForm } from "./JsonPropsForm.js";
import { summaryOf } from "./summary.js";

function humanize(name: string): string {
  const words = name.split("_").filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) return name;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

// Block type id → catalog key; labels resolve through t() at render time.
const BLOCK_TITLE_KEYS: Readonly<Record<string, string>> = {
  text: "blocks.block_text",
  heading: "blocks.block_heading",
  image: "blocks.block_image",
  gallery: "blocks.block_gallery",
  quote: "blocks.block_quote",
  callout: "blocks.block_callout",
  list: "blocks.block_list",
  table: "blocks.block_table",
  code: "blocks.block_code",
  faq: "blocks.block_faq",
  cta: "blocks.block_cta",
  video: "blocks.block_video",
  video_gallery: "blocks.block_video_gallery",
  audio: "blocks.block_audio",
  calculator: "blocks.block_calculator",
  map: "blocks.block_map",
  timeline: "blocks.block_timeline",
  documents: "blocks.block_documents",
  related_content: "blocks.block_related_content",
};

function blockTitle(typeId: string): string {
  const key = BLOCK_TITLE_KEYS[typeId];
  return key === undefined ? humanize(typeId) : t(key);
}

export function BlockDocumentEditor(props: {
  readonly value: BlockDocumentWire | null;
  readonly onChange: (value: BlockDocumentWire) => void;
  readonly disabled?: boolean;
}) {
  const [types, setTypes] = useState<readonly BlockTypeSummary[] | null>(null);
  const [schemas, setSchemas] = useState<Readonly<Record<string, BlockSchemaWire>>>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [paletteFor, setPaletteFor] = useState<number | "end" | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [computed, setComputed] = useState<
    readonly { readonly label: string; readonly value: string }[]
  >([]);

  const disabled = props.disabled === true;
  const doc = props.value ?? { schema_version: 1, blocks: [] as readonly BlockNodeWire[] };
  const blocks = doc.blocks;

  useEffect(() => {
    void listBlockTypes().then((result) => setTypes(result.items));
  }, []);

  const schemaOf = useCallback(
    (typeId: string): BlockSchemaWire | null => {
      const cached = schemas[typeId];
      if (cached !== undefined) return cached;
      void getBlockSchema(typeId).then((schema) => {
        setSchemas((current) => ({ ...current, [typeId]: schema }));
      });
      return null;
    },
    [schemas],
  );

  const update = (next: readonly BlockNodeWire[]) =>
    props.onChange({ schema_version: 1, blocks: next });

  const runValidation = async (block: BlockNodeWire) => {
    const result = await validateBlock(block.type, block.props);
    setIssues((current) => ({
      ...current,
      [block.id]: result.issues.map((issue) => `${issue.path}: ${issue.message}`),
    }));
    if (result.computed !== undefined) setComputed(result.computed);
  };

  const blockActions = (index: number) => (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("blocks.insert_after", { n: index + 1 })}
        disabled={disabled}
        onClick={() => setPaletteFor(index + 1)}
      >
        {t("blocks.insert_after_short")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("blocks.move_block_up", { n: index + 1 })}
        disabled={disabled || index === 0}
        onClick={() => update(moveBlock(blocks, index, index - 1))}
      >
        ↑
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("blocks.move_block_down", { n: index + 1 })}
        disabled={disabled || index === blocks.length - 1}
        onClick={() => update(moveBlock(blocks, index, index + 1))}
      >
        ↓
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => {
          const target = blocks[index];
          if (target === undefined) return;
          update([
            ...blocks.slice(0, index + 1),
            duplicateBlock(target),
            ...blocks.slice(index + 1),
          ]);
        }}
      >
        {t("duplicate")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => update(blocks.toSpliced(index, 1))}
      >
        <Icon name="close" label={t("delete")} />
      </Button>
    </>
  );

  const sortedTypes = useMemo(() => (types ?? []).map((item) => item.typeId).sort(), [types]);

  return (
    <div className="pcms-rows" data-testid="block-document">
      {blocks.map((block, index) => {
        const schema = schemaOf(block.type);
        const isCollapsed = collapsed.has(block.id);
        const blockIssues = issues[block.id];
        return (
          <fieldset key={block.id} className="pcms-fieldset pcms-block-card">
            <legend>
              {blockTitle(block.type)}
              <span className="pcms-picker-row__meta"> · {summaryOf(block)}</span>
            </legend>
            <div className="pcms-row__actions pcms-block-card__actions">{blockActions(index)}</div>
            {isCollapsed ? null : (
              <div className="pcms-block-card__body">
                {schema === null ? (
                  <Badge>{t("blocks.schema_loading")}</Badge>
                ) : (
                  <>
                    {schema.allowedVariants.length > 0 ? (
                      <Field label={t("blocks.variant")}>
                        <select
                          className="pcms-select"
                          value={block.variant ?? ""}
                          disabled={disabled}
                          onChange={(event) =>
                            update(
                              blocks.with(index, {
                                ...block,
                                variant: event.target.value === "" ? null : event.target.value,
                              }),
                            )
                          }
                        >
                          <option value="">—</option>
                          {schema.allowedVariants.map((variant) => (
                            <option key={variant} value={variant}>
                              {variant}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ) : null}
                    <JsonPropsForm
                      schema={schema.propsSchema}
                      value={block.props}
                      references={schema.references}
                      disabled={disabled}
                      onChange={(nextProps) =>
                        update(blocks.with(index, { ...block, props: nextProps }))
                      }
                    />
                    <div className="pcms-actions-row">
                      <Button
                        size="sm"
                        disabled={disabled}
                        onClick={() => void runValidation(block)}
                      >
                        {t("blocks.validate_block")}
                      </Button>
                      {blockIssues === undefined ? null : blockIssues.length === 0 ? (
                        <Badge tone="success">{t("blocks.block_valid")}</Badge>
                      ) : (
                        <div className="pcms-field__error" role="alert">
                          {blockIssues.map((message) => (
                            <div key={message}>{message}</div>
                          ))}
                        </div>
                      )}
                      {computed.map((entry) => (
                        <Badge key={entry.label} tone="accent">
                          {entry.label}: {entry.value}
                        </Badge>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="pcms-actions-row">
        <Button size="sm" disabled={disabled} onClick={() => setPaletteFor("end")}>
          {t("blocks.add_block")}
        </Button>
        {blocks.length === 0 ? (
          <span className="pcms-field__hint">{t("blocks.no_blocks")}</span>
        ) : null}
      </div>
      {paletteFor === null ? null : (
        <BlockPalette
          types={sortedTypes}
          onPick={(typeId) => {
            const at = paletteFor === "end" ? blocks.length : paletteFor;
            setPaletteFor(null);
            insertBlock(typeId, at);
          }}
          onClose={() => setPaletteFor(null)}
        />
      )}
    </div>
  );

  function insertBlock(typeId: string, at: number) {
    const block: BlockNodeWire = {
      id: stableId(),
      type: typeId,
      schema_version: 1,
      variant: null,
      props: {},
      children: [],
    };
    update([...blocks.slice(0, at), block, ...blocks.slice(at)]);
  }
}

function BlockPalette(props: {
  readonly types: readonly string[];
  readonly onPick: (typeId: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open onClose={props.onClose} title={t("blocks.palette_title")} wide>
      <div className="pcms-block-palette">
        {props.types.map((typeId) => (
          <button
            key={typeId}
            type="button"
            className="pcms-picker-row"
            onClick={() => props.onPick(typeId)}
          >
            <span className="pcms-picker-row__title">{blockTitle(typeId)}</span>
            <span className="pcms-picker-row__meta">{typeId}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function moveBlock(
  blocks: readonly BlockNodeWire[],
  from: number,
  to: number,
): readonly BlockNodeWire[] {
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return blocks;
  next.splice(Math.max(0, Math.min(to, blocks.length - 1)), 0, moved);
  return next;
}

function duplicateBlock(block: BlockNodeWire): BlockNodeWire {
  return { ...block, id: stableId() };
}
