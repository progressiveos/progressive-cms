// RichText AST v2 schema + validator (PCMS-CONT-T009; Content spec §15).
//
// Canonical storage is a semantic JSON AST — never arbitrary HTML (§15/§16).
// There is no "html" node and no attribute escape hatch: inline style/CSS is
// structurally impossible (strict property sets), and link hrefs go through
// a URL scheme allowlist (no javascript:/data:). Parsers and walkers are
// bounded (depth + node limits, Content spec §72 "bounded parsers").
//
// v2 is the ONLY supported document version (owner decision
// CORE-RICHTEXT-V2-ONLY, 2026-10-16): `schema_version: 2` is mandatory on
// every RichText document, including nested ones, and a document without it is
// rejected. Reading historical v1 is a one-off offline conversion concern:
// the converter lives in `tools/migrations/richtext-v1-to-v2/` and is not part
// of this package or of any release artifact.

import type { ReferenceIssue } from "../fields/reference-fields.js";
import { isStableId } from "../ids/stable-id.js";

export type { ReferenceIssue as RichTextIssue };

export const RICHTEXT_MAX_DEPTH = 32;
export const RICHTEXT_MAX_NODES = 10_000;
/** Supported document versions. v2 is the only one; v1 is retired. */
export const RICHTEXT_AST_VERSIONS = [2] as const;

export type RichTextMark = "strong" | "emphasis" | "code";
export const RICHTEXT_MARKS: readonly RichTextMark[] = ["strong", "emphasis", "code"];

export const RICHTEXT_NODE_TYPES = [
  "document",
  "paragraph",
  "heading",
  "bullet_list",
  "ordered_list",
  "list_item",
  "blockquote",
  "image",
  "text",
  "hard_break",
  "link",
  "table",
  "table_row",
  "table_cell",
  "code_block",
  "horizontal_rule",
] as const;

export type RichTextNodeType = (typeof RICHTEXT_NODE_TYPES)[number];

/** Link href policy: safe schemes and site-relative targets only. */
const HREF_ALLOWED_RE = /^(https:\/\/|http:\/\/|mailto:|\/|#)/i;
const HREF_BLOCKED_RE = /(javascript|data|vbscript):/i;

export type RichTextValidationResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: ReferenceIssue[] };

function issue(path: string, code: string, message: string): ReferenceIssue {
  return { path, code, message };
}

interface NodeBudget {
  count: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMarks(marks: unknown, path: string, issues: ReferenceIssue[]): void {
  if (!Array.isArray(marks)) {
    issues.push(issue(path, "RICHTEXT_MARKS_MALFORMED", "marks must be an array"));
    return;
  }
  const seen = new Set<string>();
  for (const [index, mark] of marks.entries()) {
    if (typeof mark !== "string" || !RICHTEXT_MARKS.includes(mark as RichTextMark)) {
      issues.push(
        issue(`${path}/marks/${index}`, "RICHTEXT_MARK_UNKNOWN", `unknown mark "${String(mark)}"`),
      );
      continue;
    }
    if (seen.has(mark)) {
      issues.push(
        issue(`${path}/marks/${index}`, "RICHTEXT_MARK_DUPLICATE", `duplicate mark "${mark}"`),
      );
    }
    seen.add(mark);
  }
}

const BLOCK_ONLY: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "bullet_list",
  "ordered_list",
  "blockquote",
  "image",
  "table",
  "code_block",
  "horizontal_rule",
]);
const INLINE_ONLY: ReadonlySet<string> = new Set(["text", "hard_break", "link"]);

/**
 * Validates one node. `context` is the set of node kinds allowed here:
 * "document" accepts blocks, containers accept their specific children,
 * enforced via allowedTypes below.
 */
function validateNode(
  node: unknown,
  path: string,
  depth: number,
  budget: NodeBudget,
  issues: ReferenceIssue[],
  allowedTypes: ReadonlySet<RichTextNodeType>,
): void {
  if (depth > RICHTEXT_MAX_DEPTH) {
    issues.push(
      issue(
        path,
        "RICHTEXT_TOO_DEEP",
        `AST nesting exceeds the hard limit (${RICHTEXT_MAX_DEPTH})`,
      ),
    );
    return;
  }
  budget.count += 1;
  if (budget.count > RICHTEXT_MAX_NODES) {
    issues.push(
      issue(path, "RICHTEXT_TOO_LARGE", `AST exceeds the node limit (${RICHTEXT_MAX_NODES})`),
    );
    return;
  }
  if (!isPlainObject(node)) {
    issues.push(issue(path, "RICHTEXT_NODE_MALFORMED", "expected a node object"));
    return;
  }
  const type = node.type;
  if (typeof type !== "string" || !RICHTEXT_NODE_TYPES.includes(type as RichTextNodeType)) {
    issues.push(
      issue(`${path}/type`, "RICHTEXT_NODE_UNKNOWN", `unknown node type "${String(type)}"`),
    );
    return;
  }
  if (!allowedTypes.has(type as RichTextNodeType)) {
    issues.push(
      issue(
        `${path}/type`,
        "RICHTEXT_NODE_MISPLACED",
        `node "${type}" is not allowed in this position`,
      ),
    );
    return;
  }
  // No attribute escape hatch: unknown properties are rejected outright, so
  // inline style/CSS/event handlers cannot enter canonical storage (§15).
  const allowedKeys = allowedKeysFor(type as RichTextNodeType);
  for (const key of Object.keys(node)) {
    if (!allowedKeys.includes(key)) {
      issues.push(
        issue(
          `${path}/${key}`,
          "RICHTEXT_PROPERTY_UNKNOWN",
          `property "${key}" is not part of this RichText AST version`,
        ),
      );
    }
  }

  if (type === "text") {
    if (typeof node.text !== "string") {
      issues.push(issue(`${path}/text`, "RICHTEXT_TEXT_REQUIRED", "text node needs a string"));
    } else if (node.text.length === 0) {
      issues.push(issue(`${path}/text`, "RICHTEXT_TEXT_EMPTY", "text nodes must not be empty"));
    }
    if (node.marks !== undefined) validateMarks(node.marks, path, issues);
    return;
  }
  if (type === "hard_break" || type === "horizontal_rule") return;
  if (type === "code_block") {
    if (typeof node.code !== "string")
      issues.push(issue(`${path}/code`, "RICHTEXT_CODE_REQUIRED", "code must be a string"));
    if (
      node.language !== undefined &&
      (typeof node.language !== "string" || !/^[a-zA-Z0-9_+-]{1,50}$/.test(node.language))
    ) {
      issues.push(
        issue(
          `${path}/language`,
          "RICHTEXT_LANGUAGE_INVALID",
          "language must be a bounded identifier",
        ),
      );
    }
    return;
  }
  if (type === "table") {
    const rows = node.content;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 2000) {
      issues.push(
        issue(`${path}/content`, "RICHTEXT_TABLE_DIMENSIONS", "table requires 1–2000 rows"),
      );
    } else {
      const width =
        isPlainObject(rows[0]) && Array.isArray(rows[0].content) ? rows[0].content.length : 0;
      if (width < 1 || width > 50 || width * rows.length > 10_000)
        issues.push(
          issue(
            path,
            "RICHTEXT_TABLE_DIMENSIONS",
            "table requires 1–50 columns and at most 10000 cells",
          ),
        );
      for (const [i, row] of rows.entries()) {
        if (!isPlainObject(row) || !Array.isArray(row.content) || row.content.length !== width)
          issues.push(
            issue(
              `${path}/content/${i}`,
              "RICHTEXT_TABLE_RECTANGULAR",
              "table rows must have equal widths",
            ),
          );
      }
    }
    if (node.caption !== undefined)
      validateContent(node.caption, `${path}/caption`, depth + 1, budget, issues, INLINE_TYPES);
    validateContent(rows, `${path}/content`, depth + 1, budget, issues, new Set(["table_row"]));
    return;
  }
  if (type === "table_row") {
    validateContent(
      node.content,
      `${path}/content`,
      depth + 1,
      budget,
      issues,
      new Set(["table_cell"]),
    );
    return;
  }
  if (type === "table_cell") {
    if (node.header !== undefined && node.header !== "column" && node.header !== "row")
      issues.push(
        issue(`${path}/header`, "RICHTEXT_HEADER_INVALID", "header must be column or row"),
      );
    if (!Array.isArray(node.content) || node.content.length === 0)
      issues.push(issue(`${path}/content`, "RICHTEXT_CELL_EMPTY", "cell requires a paragraph"));
    validateContent(
      node.content,
      `${path}/content`,
      depth + 1,
      budget,
      issues,
      new Set(["paragraph"]),
    );
    let textLength = 0;
    const countText = (value: unknown): void => {
      if (!isPlainObject(value)) return;
      if (typeof value.text === "string") textLength += value.text.length;
      if (Array.isArray(value.content)) value.content.forEach(countText);
    };
    // Count only after bounded validation; never recurse into an invalid subtree.
    if (issues.length === 0 && Array.isArray(node.content)) node.content.forEach(countText);
    if (textLength > 5000)
      issues.push(issue(path, "RICHTEXT_CELL_TOO_LARGE", "cell exceeds 5000 characters"));
    return;
  }
  if (
    type === "ordered_list" &&
    node.start !== undefined &&
    (!Number.isSafeInteger(node.start) || (node.start as number) < 1)
  )
    issues.push(
      issue(
        `${path}/start`,
        "RICHTEXT_LIST_START_INVALID",
        "start must be a positive safe integer",
      ),
    );

  if (type === "heading") {
    const level = node.level;
    if (
      typeof level !== "number" ||
      !Number.isInteger(level) ||
      (level as number) < 1 ||
      (level as number) > 6
    ) {
      issues.push(issue(`${path}/level`, "RICHTEXT_LEVEL_INVALID", "heading level must be 1–6"));
    }
  }

  if (type === "image") {
    // Same scheme policy as links (https/http/site-relative); alt is
    // mandatory (accessibility is a contract, not a nicety). A Media Library
    // insert carries media_id; the legacy URL form carries src. Exactly one.
    const src = node.src;
    if (node.media_id !== undefined) {
      if (!isStableId(node.media_id))
        issues.push(
          issue(`${path}/media_id`, "RICHTEXT_MEDIA_INVALID", "media_id must be a UUIDv7"),
        );
      if (src !== undefined)
        issues.push(
          issue(
            `${path}/src`,
            "RICHTEXT_IMAGE_SOURCE_CONFLICT",
            "image requires exactly one of src or media_id",
          ),
        );
    } else if (typeof src !== "string" || src.length === 0) {
      issues.push(issue(`${path}/src`, "RICHTEXT_SRC_REQUIRED", "image needs a src"));
    } else if (HREF_BLOCKED_RE.test(src) || !HREF_ALLOWED_RE.test(src)) {
      issues.push(
        issue(
          `${path}/src`,
          "RICHTEXT_SRC_REJECTED",
          "src scheme is not allowed (https/site-relative only)",
        ),
      );
    }
    // A deliberate empty alt is allowed in v2 (decorative image), exposed
    // explicitly in the UI; the property itself must still be a string.
    if (typeof node.alt !== "string") {
      issues.push(issue(`${path}/alt`, "RICHTEXT_ALT_REQUIRED", "image needs an alt string"));
    }
    if (node.title !== undefined && typeof node.title !== "string") {
      issues.push(issue(`${path}/title`, "RICHTEXT_TITLE_MALFORMED", "title must be a string"));
    }
    if (node.caption !== undefined)
      validateContent(node.caption, `${path}/caption`, depth + 1, budget, issues, INLINE_TYPES);
    return;
  }

  if (type === "link") {
    const href = node.href;
    if (typeof href !== "string" || href.length === 0) {
      issues.push(issue(`${path}/href`, "RICHTEXT_HREF_REQUIRED", "link needs an href"));
    } else if (HREF_BLOCKED_RE.test(href) || !HREF_ALLOWED_RE.test(href)) {
      issues.push(
        issue(
          `${path}/href`,
          "RICHTEXT_HREF_REJECTED",
          `href scheme is not allowed (http/https/mailto/relative/anchor only)`,
        ),
      );
    }
    validateContent(node.content, `${path}/content`, depth + 1, budget, issues, INLINE_TEXT_BREAK);
    return;
  }

  // Container nodes validate their children by their own kind.
  if (type === "document" || type === "blockquote") {
    validateContent(node.content, `${path}/content`, depth + 1, budget, issues, BLOCK_TYPES);
    return;
  }
  if (type === "bullet_list" || type === "ordered_list") {
    validateContent(node.content, `${path}/content`, depth + 1, budget, issues, LIST_ITEM_ONLY);
    return;
  }
  if (type === "list_item") {
    validateContent(node.content, `${path}/content`, depth + 1, budget, issues, BLOCK_TYPES);
    return;
  }
  // paragraph / heading take inline content.
  validateContent(node.content, `${path}/content`, depth + 1, budget, issues, INLINE_TYPES);
}

const INLINE_TEXT_BREAK: ReadonlySet<RichTextNodeType> = new Set<RichTextNodeType>([
  "text",
  "hard_break",
]);
const LIST_ITEM_ONLY: ReadonlySet<RichTextNodeType> = new Set<RichTextNodeType>(["list_item"]);
const BLOCK_TYPES: ReadonlySet<RichTextNodeType> = new Set([...BLOCK_ONLY] as RichTextNodeType[]);
const INLINE_TYPES: ReadonlySet<RichTextNodeType> = new Set([...INLINE_ONLY] as RichTextNodeType[]);

function allowedKeysFor(type: RichTextNodeType): readonly string[] {
  switch (type) {
    case "document":
      return ["type", "schema_version", "content"];
    case "ordered_list":
      return ["type", "start", "content"];
    case "table":
      return ["type", "caption", "content"];
    case "table_row":
      return ["type", "content"];
    case "table_cell":
      return ["type", "header", "content"];
    case "code_block":
      return ["type", "code", "language"];
    case "horizontal_rule":
      return ["type"];
    case "paragraph":
    case "bullet_list":
    case "list_item":
    case "blockquote":
      return ["type", "content"];
    case "heading":
      return ["type", "level", "content"];
    case "text":
      return ["type", "text", "marks"];
    case "hard_break":
      return ["type"];
    case "image":
      return ["type", "src", "media_id", "alt", "title", "caption"];
    case "link":
      return ["type", "href", "content"];
  }
}

function validateContent(
  content: unknown,
  path: string,
  depth: number,
  budget: NodeBudget,
  issues: ReferenceIssue[],
  allowed: ReadonlySet<RichTextNodeType>,
): void {
  if (!Array.isArray(content)) {
    issues.push(issue(path, "RICHTEXT_CONTENT_MALFORMED", "content must be an array of nodes"));
    return;
  }
  for (const [index, child] of content.entries()) {
    validateNode(child, `${path}/${index}`, depth, budget, issues, allowed);
  }
}

/**
 * Validates a RichText AST value (canonical storage form, Content spec §15).
 * Raw HTML is not representable: strings, unknown nodes, attribute-ish
 * properties and unsafe link schemes are all rejected with stable codes.
 *
 * `schema_version: 2` is mandatory at the document root. Nested documents
 * (declared RichText fields, block props, table cells) go through this same
 * function, so a missing or different version anywhere is rejected.
 */
export function validateRichText(value: unknown): RichTextValidationResult {
  const issues: ReferenceIssue[] = [];
  if (!isPlainObject(value) || value.type !== "document") {
    issues.push(
      issue("", "RICHTEXT_DOCUMENT_REQUIRED", 'rich text must be a {"type":"document"} AST'),
    );
    return { ok: false, issues };
  }
  if (value.schema_version !== 2)
    return {
      ok: false,
      issues: [
        issue(
          "/schema_version",
          value.schema_version === undefined
            ? "RICHTEXT_VERSION_REQUIRED"
            : "RICHTEXT_VERSION_UNSUPPORTED",
          value.schema_version === undefined
            ? 'RichText documents must declare "schema_version": 2'
            : `unsupported RichText document version; only 2 is accepted`,
        ),
      ],
    };
  const budget: NodeBudget = { count: 0 };
  validateNode(value, "", 1, budget, issues, new Set(["document"]));
  if (issues.length === 0 && new TextEncoder().encode(JSON.stringify(value)).length > 1_048_576)
    issues.push(issue("", "RICHTEXT_TOO_LARGE", "document exceeds 1 MiB"));
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}
