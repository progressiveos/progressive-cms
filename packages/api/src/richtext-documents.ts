import type { BlockRegistry } from "@pcms/blocks";
import { ContentError, type FieldSchema, type LoadedContentType } from "@pcms/content";
import type { RevisionIssue, RevisionState } from "@pcms/revisions";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blockNodes(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!record(value)) return null;
  if (Array.isArray(value.blocks)) return value.blocks;
  if (Array.isArray(value.content)) return value.content;
  return null;
}

/** New rich_text revisions cannot seal BlockDocument content that Themes never render. */
export function validateRichTextBlockPolicy(
  bodyPolicy: string,
  blocks: unknown,
  revisionState: RevisionState | undefined,
): RevisionIssue[] {
  if (revisionState !== "WORKING") return [];
  if (bodyPolicy === "rich_text") {
    const nodes = blockNodes(blocks);
    if (blocks === null || blocks === undefined || (nodes !== null && nodes.length === 0))
      return [];
    return [
      {
        code: "RICH_TEXT_BLOCKS_NOT_RENDERED",
        path: "/blocks",
        message:
          "This Content Type uses bodyPolicy rich_text; BlockDocument content is not rendered. Import supported content into the RichText body before sealing.",
        severity: "error",
      },
    ];
  }
  if (bodyPolicy !== "block_document") return [];

  const issues: RevisionIssue[] = [];
  const visit = (nodes: unknown[], path: string): void => {
    nodes.forEach((value, index) => {
      if (!record(value)) return;
      const nodePath = `${path}/${index}`;
      if (value.type === "table" && Number(value.schema_version ?? value.schemaVersion) === 1) {
        const props = value.props;
        const rows = record(props) && Array.isArray(props.rows) ? props.rows : [];
        rows.forEach((row, rowIndex) => {
          if (!Array.isArray(row)) return;
          row.forEach((cell, columnIndex) => {
            const path = `${nodePath}/props/rows/${rowIndex}/${columnIndex}`;
            if (
              record(cell) &&
              (cell.type !== "document" ||
                !Array.isArray(cell.content) ||
                cell.content.some((node) => !record(node) || node.type !== "paragraph"))
            ) {
              issues.push({
                code: "TABLE_RICH_TEXT_CELL_INVALID",
                path,
                message: "Object table cells must contain a RichText document with paragraphs",
                severity: "error",
              });
            }
          });
        });
      }
      visit(Array.isArray(value.children) ? value.children : [], `${nodePath}/children`);
    });
  };
  const nodes = blockNodes(blocks);
  if (nodes !== null) visit(nodes, "/blocks");
  return issues;
}

/** Walk only declared document locations; unrelated JSON fields remain untouched. */
export function mapEntryRichText(
  payload: unknown,
  type: LoadedContentType,
  blocks: BlockRegistry,
  transform: (document: unknown, path: string) => unknown,
): unknown {
  const result = structuredClone(payload);
  if (!record(result)) return result;
  let visited = 0;
  const guard = (depth: number) => {
    if (++visited > 10_000 || depth > 32)
      throw new ContentError("RICHTEXT_TOO_LARGE", "Document location walk exceeds limits");
  };
  const fieldValue = (value: unknown, field: FieldSchema, path: string, depth: number): unknown => {
    guard(depth);
    if (value === undefined || value === null || value === "") return value;
    if (field.type === "rich_text") return transform(value, path);
    if (field.type === "object" && "fields" in field && record(value))
      return fields(value, field.fields, path, depth + 1);
    if (field.type === "list" && "item" in field && "type" in field.item && Array.isArray(value))
      return value.map((item, i) =>
        fieldValue(item, field.item as FieldSchema, `${path}/${i}`, depth + 1),
      );
    if (
      field.type === "repeater" &&
      "item" in field &&
      "fields" in field.item &&
      Array.isArray(value)
    )
      return value.map((item, i) =>
        record(item)
          ? fields(
              item,
              (field.item as { fields: Record<string, FieldSchema> }).fields,
              `${path}/${i}`,
              depth + 1,
            )
          : item,
      );
    return value;
  };
  const fields = (
    value: Record<string, unknown>,
    schema: Record<string, FieldSchema>,
    path: string,
    depth: number,
  ): Record<string, unknown> => {
    for (const [key, field] of Object.entries(schema))
      if (key in value)
        value[key] = fieldValue(
          value[key],
          field,
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          depth,
        );
    return value;
  };
  const declaredProp = (value: unknown, segments: string[], path: string): unknown => {
    if (segments.length === 0)
      return value === undefined || value === null ? value : transform(value, path);
    if (!record(value)) return value;
    const [segment, ...rest] = segments;
    if (segment === undefined) return value;
    const array = segment.endsWith("[]");
    const key = array ? segment.slice(0, -2) : segment;
    if (array && Array.isArray(value[key]))
      value[key] = value[key].map((item: unknown, i: number) =>
        declaredProp(item, rest, `${path}/${key}/${i}`),
      );
    else if (!array && key in value) value[key] = declaredProp(value[key], rest, `${path}/${key}`);
    return value;
  };
  const namedProp = (value: unknown, key: string, path: string, depth: number): unknown => {
    guard(depth);
    if (Array.isArray(value))
      return value.map((item, i) => namedProp(item, key, `${path}/${i}`, depth + 1));
    if (!record(value)) return value;
    for (const [name, child] of Object.entries(value)) {
      if (name === key && child !== null && child !== undefined)
        value[name] = transform(child, `${path}/${name}`);
      else value[name] = namedProp(child, key, `${path}/${name}`, depth + 1);
    }
    return value;
  };
  const blockTree = (nodes: unknown, path: string, depth: number): void => {
    if (!Array.isArray(nodes)) return;
    for (const [i, node] of nodes.entries()) {
      guard(depth);
      if (!record(node)) continue;
      const descriptor =
        typeof node.type === "string"
          ? blocks.getBlockType(node.type, Number(node.schema_version ?? node.schemaVersion))
          : null;
      for (const prop of descriptor?.richTextProps ?? [])
        node.props = prop.includes(".")
          ? declaredProp(node.props, prop.split("."), `${path}/${i}/props`)
          : namedProp(node.props, prop, `${path}/${i}/props`, depth + 1);
      // table@1 also permits restricted RichText cell documents.
      if (node.type === "table" && record(node.props) && Array.isArray(node.props.rows))
        node.props.rows = node.props.rows.map((row: unknown, r: number) =>
          Array.isArray(row)
            ? row.map((cell: unknown, c: number) =>
                record(cell) && cell.type === "document"
                  ? transform(cell, `${path}/${i}/props/rows/${r}/${c}`)
                  : cell,
              )
            : row,
        );
      blockTree(node.children, `${path}/${i}/children`, depth + 1);
    }
  };
  if (record(result.fields)) fields(result.fields, type.fieldSchema.fields, "/fields", 0);
  if (type.bodyPolicy === "rich_text" && result.body !== undefined)
    result.body = transform(result.body, "/body");
  const nodes = record(result.blocks)
    ? (result.blocks.blocks ?? result.blocks.content)
    : result.blocks;
  blockTree(nodes, "/blocks", 0);
  return result;
}
