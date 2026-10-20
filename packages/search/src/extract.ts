// Semantic content text extractor (PCMS-SEARCH-T002; Search spec §5/§6).
//
// Pure structural walks over the *versioned wire contracts* (RichText AST
// v1, BlockDocument v1, content field payloads) — @pcms/search is L1 and
// imports no other subsystem; the composition layer feeds it plain JSON.
// Extraction follows semantic content, not payload bytes: presentation
// metadata, code, formulas, coordinates and internal ids are never indexed.
import {
  MAX_AUX_LENGTH,
  MAX_BODY_LENGTH,
  MAX_STRUCTURED_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeSearchText,
  type SearchWeight,
} from "./document.js";

/** Minimal structural mirror of the M02 field-schema hints we consume. */
export interface SearchableFieldSchema {
  readonly type: string;
  readonly required?: boolean;
  readonly searchable?: boolean;
  /** M11 addition (Search spec §5); absent in pre-M11 schemas. */
  readonly search_weight?: SearchWeight;
  /** Structural list item schema (list<T>, M02 §24). */
  readonly item?: SearchableFieldSchema;
}

export interface SearchableFieldContainer {
  readonly fields: Readonly<Record<string, SearchableFieldSchema>>;
}

/** Structural input for one entry's extraction (composition-built). */
export interface SearchExtractionInput {
  /** Entry field values keyed by field id. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Content-type field schema (hint source), e.g. LoadedContentType.fieldSchema. */
  readonly fieldSchema: SearchableFieldContainer;
  /** Body policy of the content type. */
  readonly bodyPolicy: "none" | "rich_text" | "block_document";
  /** Entry-level BlockDocument payload (bodyPolicy "block_document"). */
  readonly blocks?: unknown;
}

export interface ExtractedSearchText {
  readonly title: string;
  readonly summary: string;
  readonly structuredText: string;
  readonly bodyText: string;
  readonly auxText: string;
}

// Scalar field types whose values are meaningless as free text (Search
// spec §6: no blind payload indexing). Everything numeric/monetary/temporal
// is filtered; identifiers (slug/url) demoted to aux only when hinted.
const NON_TEXT_FIELD_TYPES: ReadonlySet<string> = new Set([
  "media",
  "media_list",
  "relation",
  "relation_list",
  "money",
  "decimal",
  "integer",
  "date",
  "datetime",
  "boolean",
  "block_document",
]);

const AUX_FIELD_TYPES: ReadonlySet<string> = new Set(["slug", "url"]);

/** Default weight per field id when the schema declares none (spec §5). */
const SEMANTIC_DEFAULT_WEIGHT: Readonly<Record<string, SearchWeight>> = {
  title: "A",
  h1: "A",
  menu_title: "D",
  slug_hint: "D",
  intro: "B",
  teaser: "B",
  body: "C",
};

function weightOf(fieldId: string, schema: SearchableFieldSchema): SearchWeight {
  if (schema.search_weight !== undefined) return schema.search_weight;
  return SEMANTIC_DEFAULT_WEIGHT[fieldId] ?? "C";
}

/**
 * RichText AST v1 → plain semantic text (presentation/markup stripped).
 * Structural walk only: `text` leaves carry content, `content` carries
 * children; bounds mirror the AST contract (depth 32, nodes 10_000).
 */
export function richtextToPlainText(value: unknown, depth = 0): string {
  if (value === null || typeof value !== "object" || depth > 32) return "";
  const parts: string[] = [];
  let visited = 0;
  const walk = (node: unknown, level: number): void => {
    if (node === null || typeof node !== "object" || level > 32 || visited > 10_000) return;
    visited += 1;
    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") {
      parts.push(record.text);
      return;
    }
    if (record.type === "code_block") return;
    if (Array.isArray(record.caption)) for (const child of record.caption) walk(child, level + 1);
    const content = record.content;
    if (Array.isArray(content)) {
      for (const child of content) walk(child, level + 1);
      return;
    }
    // Leaf nodes without text/content (hard_break, anchors) contribute nothing.
  };
  const record = value as Record<string, unknown>;
  if (Array.isArray(record)) {
    for (const child of record) walk(child, depth);
  } else {
    walk(value, depth);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Image alternatives supplement searchable text without leaking asset IDs. */
export function richtextImageAltText(value: unknown): string {
  const parts: string[] = [];
  let visited = 0;
  const walk = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== "object" || depth > 32 || visited >= 10_000) return;
    visited += 1;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.type === "code_block") return;
    if (record.type === "image" && typeof record.alt === "string" && record.alt.trim())
      parts.push(record.alt.trim());
    if (Array.isArray(record.content)) walk(record.content, depth + 1);
  };
  walk(value, 0);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

interface BlockParts {
  body: string[];
  aux: string[];
}

/**
 * BlockDocument v1 → weighted text parts. Walks the first-party block
 * contract structurally (type + props keys): FAQ questions/answers and
 * timeline/document titles are body-grade (spec §6); CTA/markers/alt text
 * are aux-grade; code/calculator/map payloads are not indexed at all.
 */
export function blockDocumentToText(value: unknown): { body: string; aux: string } {
  const parts: BlockParts = { body: [], aux: [] };
  let visited = 0;
  const pushBody = (text: string | undefined | null): void => {
    if (typeof text === "string" && text.trim() !== "") parts.body.push(text.trim());
  };
  const pushAux = (text: string | undefined | null): void => {
    if (typeof text === "string" && text.trim() !== "") parts.aux.push(text.trim());
  };
  const textProp = (props: Record<string, unknown>, key: string): string =>
    richtextToPlainText(props[key]);

  const walkItems = (
    items: unknown,
    visit: (item: Record<string, unknown>) => void,
    bound = 200,
  ): void => {
    if (!Array.isArray(items)) return;
    for (const item of items.slice(0, bound)) {
      if (item !== null && typeof item === "object") visit(item as Record<string, unknown>);
    }
  };

  const walkBlock = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== "object" || depth > 16 || visited > 500) return;
    visited += 1;
    const block = node as Record<string, unknown>;
    const props = (block.props ?? {}) as Record<string, unknown>;
    switch (block.type) {
      case "text":
        pushBody(textProp(props, "rich_text"));
        break;
      case "heading":
        pushBody(typeof props.text === "string" ? props.text : null);
        break;
      case "quote":
        pushBody(textProp(props, "rich_text"));
        pushAux(typeof props.author === "string" ? props.author : null);
        pushAux(typeof props.source === "string" ? props.source : null);
        break;
      case "callout":
        pushBody(typeof props.title === "string" ? props.title : null);
        pushBody(textProp(props, "body"));
        break;
      case "list":
        walkItems(props.items, (item) => {
          pushBody(typeof item.title === "string" ? item.title : null);
          pushBody(richtextToPlainText(item.text));
        });
        break;
      case "table":
        pushBody(typeof props.caption === "string" ? props.caption : null);
        walkItems(
          props.rows,
          (row) => {
            if (Array.isArray(row)) {
              for (const cell of row.slice(0, 50)) {
                if (typeof cell === "string") pushBody(cell);
                else pushBody(richtextToPlainText(cell));
              }
            }
          },
          2000,
        );
        break;
      case "faq":
        walkItems(props.items, (item) => {
          pushBody(typeof item.question === "string" ? item.question : null);
          pushBody(richtextToPlainText(item.answer));
        });
        break;
      case "cta":
        pushAux(typeof props.title === "string" ? props.title : null);
        pushAux(richtextToPlainText(props.text));
        break;
      case "gallery":
        pushAux(typeof props.caption === "string" ? props.caption : null);
        walkItems(
          props.items,
          (item) => {
            pushAux(typeof item.alt_override === "string" ? item.alt_override : null);
            pushAux(typeof item.caption === "string" ? item.caption : null);
          },
          100,
        );
        break;
      case "video":
        pushAux(typeof props.title === "string" ? props.title : null);
        pushAux(typeof props.caption === "string" ? props.caption : null);
        break;
      case "map":
        walkItems(props.markers, (item) => {
          pushAux(typeof item.title === "string" ? item.title : null);
        });
        break;
      case "timeline":
        pushBody(typeof props.title === "string" ? props.title : null);
        walkItems(props.items, (item) => {
          pushBody(typeof item.date_text === "string" ? item.date_text : null);
          pushBody(typeof item.title === "string" ? item.title : null);
          pushBody(richtextToPlainText(item.text));
        });
        break;
      case "documents":
        pushBody(typeof props.title === "string" ? props.title : null);
        walkItems(props.items, (item) => {
          pushBody(typeof item.display_title === "string" ? item.display_title : null);
          pushBody(typeof item.description === "string" ? item.description : null);
        });
        break;
      case "related_content":
        pushAux(typeof props.title === "string" ? props.title : null);
        break;
      case "image":
        pushAux(typeof props.alt_override === "string" ? props.alt_override : null);
        pushAux(typeof props.caption === "string" ? props.caption : null);
        break;
      case "code":
        // Spec §6: never index code payloads; caption/filename are aux at most.
        pushAux(typeof props.caption === "string" ? props.caption : null);
        break;
      case "calculator":
      default:
        // calculator formula/map coordinates/unknown extension blocks: no
        // text extraction — unknown namespaces preserve payload untouched
        // elsewhere and stay out of the public corpus by default.
        break;
    }
    if (Array.isArray(block.children)) {
      for (const child of block.children) walkBlock(child, depth + 1);
    }
  };

  const document = value as Record<string, unknown> | null;
  if (document !== null && typeof document === "object" && Array.isArray(document.blocks)) {
    for (const block of document.blocks) walkBlock(block, 0);
  }
  return { body: parts.body.join("\n"), aux: parts.aux.join("\n") };
}

function scalarFieldText(fieldId: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (Array.isArray(value)) {
    // list<string>/tags: joined tokens are exactly the "names/product codes"
    // aux corpus of spec §9.
    const words = value
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .slice(0, 100);
    return words.length === 0 ? null : words.join(" ");
  }
  if (typeof value === "object") return null;
  if (typeof value === "number" || typeof value === "boolean") return null;
  return null;
}

/**
 * Builds the weighted text parts of a search document from an entry payload
 * (Search spec §5/§6). Only fields with `searchable: true` (or the semantic
 // defaults for the M02 semantic ids) contribute; security/private extension
 * data in the payload is never touched.
 */
export function extractSearchText(input: SearchExtractionInput): ExtractedSearchText {
  const titles: string[] = [];
  const summaries: string[] = [];
  const structured: string[] = [];
  const body: string[] = [];
  const aux: string[] = [];

  const visitField = (
    fieldId: string,
    schema: SearchableFieldSchema | undefined,
    value: unknown,
    depth: number,
  ): void => {
    if (depth > 16 || schema === undefined || value === null || value === undefined) return;
    const weight = weightOf(fieldId, schema);
    const searchable = schema.searchable === true;
    const semanticKnown = fieldId in SEMANTIC_DEFAULT_WEIGHT;

    if (schema.type === "object" || schema.type === "repeater") {
      // Nested groups recurse over hinted child fields only.
      const childSchemas = childFieldsOf(schema);
      if (childSchemas === null) return;
      const rows = schema.type === "repeater" ? (Array.isArray(value) ? value : []) : [value];
      for (const row of rows.slice(0, 100)) {
        if (row === null || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        for (const [childId, childSchema] of Object.entries(childSchemas)) {
          visitField(`${fieldId}.${childId}`, childSchema, record[childId], depth + 1);
        }
      }
      return;
    }
    if (schema.type === "list") {
      const item = itemOf(schema);
      if (item !== null && Array.isArray(value)) {
        for (const element of value.slice(0, 100)) {
          if (item.type === "rich_text" || item.type === "block_document") {
            // Structured list items recurse with full weight semantics.
            visitField(fieldId, item, element, depth + 1);
          } else {
            // list<string>/tags are enumeration tokens — exactly the
            // names/product-codes aux corpus of spec §9, no hint needed.
            const text = scalarFieldText(fieldId, element);
            if (text !== null) aux.push(text);
          }
        }
      }
      return;
    }

    if (schema.type === "rich_text" || schema.type === "block_document") {
      const text =
        schema.type === "rich_text" ? richtextToPlainText(value) : blockDocumentToText(value).body;
      if (schema.type === "rich_text") {
        const alt = richtextImageAltText(value);
        if (alt !== "") aux.push(alt);
      }
      if (text === "") return;
      if (fieldId === "body" || weight === "C") body.push(text);
      else if (weight === "A") titles.push(text);
      else if (weight === "D") aux.push(text);
      else structured.push(text);
      return;
    }

    if (NON_TEXT_FIELD_TYPES.has(schema.type)) return;
    if (!searchable && !semanticKnown) return;

    const text = scalarFieldText(fieldId, value);
    if (text === null) return;
    const effectiveWeight = weight;
    if (AUX_FIELD_TYPES.has(schema.type) && !searchable) return; // slug/url are not user queries' corpus by default
    if (effectiveWeight === "A" && fieldId !== "body") titles.push(text);
    else if (effectiveWeight === "B") {
      if (fieldId === "intro" || fieldId === "teaser") summaries.push(text);
      else structured.push(text);
    } else if (effectiveWeight === "D") aux.push(text);
    else structured.push(text);
  };

  for (const [fieldId, schema] of Object.entries(input.fieldSchema.fields)) {
    visitField(fieldId, schema, input.fields[fieldId], 0);
  }

  if (input.bodyPolicy === "block_document") {
    const parts = blockDocumentToText(input.blocks ?? null);
    if (parts.body !== "") body.push(parts.body);
    if (parts.aux !== "") aux.push(parts.aux);
  }

  return {
    title: normalizeSearchText(titles.join(" ").replace(/\s+/g, " ").trim(), MAX_TITLE_LENGTH),
    summary: normalizeSearchText(
      summaries
        .join("\n")
        .replace(/[ \t]+/g, " ")
        .trim(),
      MAX_SUMMARY_LENGTH,
    ),
    structuredText: normalizeSearchText(structured.join("\n"), MAX_STRUCTURED_LENGTH),
    bodyText: normalizeSearchText(body.join("\n"), MAX_BODY_LENGTH),
    auxText: normalizeSearchText(aux.join("\n"), MAX_AUX_LENGTH),
  };
}

/** Structural child-field extraction for object/repeater schemas (M02 §23/§25). */
function childFieldsOf(
  schema: SearchableFieldSchema,
): Readonly<Record<string, SearchableFieldSchema>> | null {
  const record = schema as unknown as {
    fields?: Readonly<Record<string, SearchableFieldSchema>>;
    item?: { fields?: Readonly<Record<string, SearchableFieldSchema>> };
  };
  if (record.fields !== undefined) return record.fields;
  if (record.item?.fields !== undefined) return record.item.fields;
  return null;
}

/** Structural item-schema extraction for list schemas (M02 §24). */
function itemOf(schema: SearchableFieldSchema): SearchableFieldSchema | null {
  const record = schema as unknown as { item?: SearchableFieldSchema };
  return record.item ?? null;
}
