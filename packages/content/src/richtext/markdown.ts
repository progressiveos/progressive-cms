import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { ContentError } from "../errors.js";
import { type RichTextValidationResult, validateRichText } from "./ast.js";

const MAX_MARKDOWN_LENGTH = 1_000_000;
export interface RichTextNode {
  type: string;
  [key: string]: unknown;
}
export function containsRawHtml(text: string): boolean {
  return /<[a-zA-Z/!]/.test(text);
}

function unrepresentable(path: string, reason: string): never {
  throw new ContentError("MARKDOWN_UNREPRESENTABLE", reason, {
    details: [
      {
        path,
        reason,
        canonical_export: "Export the canonical RichText AST through REST/MCP instead.",
      },
    ],
  });
}

export function markdownToRichText(markdown: string): RichTextValidationResult {
  if (markdown.length > MAX_MARKDOWN_LENGTH)
    throw new ContentError("MARKDOWN_TOO_LARGE", `markdown exceeds ${MAX_MARKDOWN_LENGTH} chars`);
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  let nodes = 0;
  const convert = (
    node: RootContent | Root,
    path: string,
    marks: string[] = [],
    depth = 0,
  ): RichTextNode[] => {
    if (++nodes > 10_000 || depth > 32)
      throw new ContentError("MARKDOWN_TOO_LARGE", "Markdown tree exceeds document limits", {
        details: [{ path }],
      });
    const children = (): RichTextNode[] =>
      "children" in node
        ? node.children.flatMap((child, i) =>
            convert(child as RootContent, `${path}/children/${i}`, marks, depth + 1),
          )
        : [];
    switch (node.type) {
      case "root":
        return [{ type: "document", schema_version: 2, content: children() }];
      case "text":
        return node.value === ""
          ? []
          : [
              {
                type: "text",
                text: node.value.replaceAll("\n", " "),
                ...(marks.length ? { marks } : {}),
              },
            ];
      case "inlineCode":
        return [{ type: "text", text: node.value, marks: [...marks, "code"] }];
      case "strong":
      case "emphasis":
        return node.children.flatMap((child, i) =>
          convert(child, `${path}/children/${i}`, [...marks, node.type], depth + 1),
        );
      case "break":
        return [{ type: "hard_break" }];
      case "link":
        if (node.title !== null && node.title !== undefined)
          unrepresentable(path, "Link titles are not supported by the canonical contract");
        return [{ type: "link", href: node.url, content: children() }];
      case "image":
        return [
          {
            type: "image",
            src: node.url,
            alt: node.alt ?? "",
            ...(node.title ? { title: node.title } : {}),
          },
        ];
      case "paragraph": {
        const content = children();
        // Images are document blocks; split mixed Markdown paragraphs in sequence.
        const output: RichTextNode[] = [];
        let inline: RichTextNode[] = [];
        for (const child of content) {
          if (child.type === "image") {
            if (inline.length) output.push({ type: "paragraph", content: inline });
            inline = [];
            output.push(child);
          } else inline.push(child);
        }
        if (inline.length || output.length === 0)
          output.push({ type: "paragraph", content: inline });
        return output;
      }
      case "heading":
        return [{ type: "heading", level: node.depth, content: children() }];
      case "blockquote":
        return [{ type: "blockquote", content: children() }];
      case "list":
        return [
          {
            type: node.ordered ? "ordered_list" : "bullet_list",
            ...(node.ordered && node.start !== null && node.start !== 1
              ? { start: node.start }
              : {}),
            content: children(),
          },
        ];
      case "listItem":
        if (node.checked !== null && node.checked !== undefined)
          unrepresentable(path, "Task-list state is not supported");
        return [{ type: "list_item", content: children() }];
      case "code":
        if (node.meta) unrepresentable(path, "Code fence metadata is not supported");
        return [
          { type: "code_block", code: node.value, ...(node.lang ? { language: node.lang } : {}) },
        ];
      case "thematicBreak":
        return [{ type: "horizontal_rule" }];
      case "table": {
        if (node.align?.some((align) => align !== null))
          unrepresentable(path, "Table alignment is not part of the semantic document contract");
        const width = node.children[0]?.children.length ?? 0;
        const content = node.children.map((row, i) => {
          // mdast retains extra cells; inspect before normalization/serialization.
          if (row.children.length > width)
            unrepresentable(
              `${path}/children/${i}`,
              "Table row has more cells than the declared header; conversion would lose data",
            );
          return {
            type: "table_row",
            content: Array.from({ length: width }, (_, j) => ({
              type: "table_cell",
              ...(i === 0 ? { header: "column" } : {}),
              content: [
                {
                  type: "paragraph",
                  content: row.children[j]
                    ? convert(row.children[j], `${path}/children/${i}/children/${j}`, [], depth + 1)
                    : [],
                },
              ],
            })),
          };
        });
        return [{ type: "table", content }];
      }
      case "tableRow":
      case "tableCell":
        return children();
      case "html":
        throw new ContentError(
          "RICHTEXT_HTML_REJECTED",
          "Raw HTML is forbidden in Markdown import",
          { details: [{ path }] },
        );
      default:
        return unrepresentable(path, `Markdown node ${node.type} is not supported`);
    }
  };
  try {
    return validateRichText(convert(root, "")[0]);
  } catch (error) {
    if (!(error instanceof ContentError)) throw error;
    return {
      ok: false,
      issues: [
        {
          path: (error.details[0] as { path?: string } | undefined)?.path ?? "",
          code: error.code,
          message: error.message,
        },
      ],
    };
  }
}

export function richTextToMarkdown(document: unknown): string {
  const validation = validateRichText(document);
  if (!validation.ok)
    throw new ContentError("RICHTEXT_INVALID", "Export requires a valid canonical document", {
      details: validation.issues,
    });
  const convert = (node: RichTextNode, path: string): Record<string, unknown> => {
    const children = () =>
      ((node.content ?? []) as RichTextNode[]).map((child, i) =>
        convert(child, `${path}/content/${i}`),
      );
    switch (node.type) {
      case "document":
        return { type: "root", children: children() };
      case "paragraph":
      case "blockquote":
        return { type: node.type, children: children() };
      case "heading":
        return { type: "heading", depth: node.level, children: children() };
      case "hard_break":
        return { type: "break" };
      case "text": {
        const marks = (node.marks ?? []) as string[];
        if (marks.includes("code") && marks.length > 1)
          unrepresentable(
            `${path}/marks`,
            "GFM cannot combine code with emphasis/strong marks losslessly",
          );
        let text: Record<string, unknown> = {
          type: marks.includes("code") ? "inlineCode" : "text",
          value: node.text,
        };
        for (const mark of marks) if (mark !== "code") text = { type: mark, children: [text] };
        return text;
      }
      case "link":
        return { type: "link", url: node.href, children: children() };
      case "image":
        if (node.media_id !== undefined)
          unrepresentable(`${path}/media_id`, "GFM cannot preserve MediaAsset identity");
        if (node.caption !== undefined)
          unrepresentable(`${path}/caption`, "GFM cannot preserve image captions");
        return {
          type: "paragraph",
          children: [{ type: "image", url: node.src, alt: node.alt, title: node.title ?? null }],
        };
      case "bullet_list":
      case "ordered_list":
        return {
          type: "list",
          ordered: node.type === "ordered_list",
          start: node.start ?? 1,
          spread: false,
          children: children(),
        };
      case "list_item":
        return { type: "listItem", spread: false, children: children() };
      case "code_block":
        return { type: "code", value: node.code, lang: node.language ?? null };
      case "horizontal_rule":
        return { type: "thematicBreak" };
      case "table": {
        if (node.caption !== undefined)
          unrepresentable(`${path}/caption`, "GFM cannot preserve table captions");
        const rows = node.content as RichTextNode[];
        return {
          type: "table",
          children: rows.map((row, i) => ({
            type: "tableRow",
            children: (row.content as RichTextNode[]).map((cell, j) => {
              const cellPath = `${path}/content/${i}/content/${j}`;
              if ((i === 0 && cell.header !== "column") || (i > 0 && cell.header !== undefined))
                unrepresentable(
                  `${cellPath}/header`,
                  "GFM requires exactly one column-header row and no other header cells",
                );
              const paragraphs = cell.content as RichTextNode[];
              if (paragraphs.length !== 1)
                unrepresentable(`${cellPath}/content`, "GFM cells support exactly one paragraph");
              if (
                (paragraphs[0]!.content as RichTextNode[]).some(
                  (child) =>
                    child.type === "hard_break" ||
                    (child.type === "text" && String(child.text).includes("\n")),
                )
              )
                unrepresentable(
                  `${cellPath}/content`,
                  "GFM cannot preserve line breaks inside cells",
                );
              return {
                type: "tableCell",
                children: (paragraphs[0]!.content as RichTextNode[]).map((child, k) =>
                  convert(child, `${cellPath}/content/0/content/${k}`),
                ),
              };
            }),
          })),
        };
      }
      default:
        return unrepresentable(path, `Node ${node.type} is not representable in GFM`);
    }
  };
  let markdown: string;
  try {
    markdown = toMarkdown(convert(document as RichTextNode, "") as unknown as Root, {
      extensions: [gfmToMarkdown()],
      bullet: "-",
      emphasis: "*",
      strong: "*",
      fences: true,
    }).trimEnd();
  } catch (error) {
    if (error instanceof ContentError) throw error;
    return unrepresentable("", error instanceof Error ? error.message : "GFM serialization failed");
  }
  const roundTrip = markdownToRichText(markdown);
  if (
    !roundTrip.ok ||
    JSON.stringify(semanticDocument(roundTrip.value)) !== JSON.stringify(semanticDocument(document))
  )
    unrepresentable("/content", "GFM cannot preserve this document structure or text exactly");
  return markdown;
}

function semanticDocument(value: unknown): unknown {
  if (Array.isArray(value)) {
    const output: Record<string, unknown>[] = [];
    for (const item of value) {
      const node = semanticDocument(item) as Record<string, unknown>;
      const previous = output.at(-1);
      if (
        node.type === "text" &&
        previous?.type === "text" &&
        JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])
      )
        previous.text = String(previous.text) + String(node.text);
      else if (node.type === "link" && previous?.type === "link" && node.href === previous.href)
        previous.content = semanticDocument([
          ...(previous.content as unknown[]),
          ...(node.content as unknown[]),
        ]);
      else output.push(node);
    }
    return output;
  }
  if (value === null || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node).sort(([a], [b]) => a.localeCompare(b))) {
    if (
      key === "schema_version" ||
      (key === "start" && item === 1) ||
      (key === "marks" && Array.isArray(item) && item.length === 0)
    )
      continue;
    result[key] =
      key === "marks" && Array.isArray(item)
        ? [...item].sort()
        : Array.isArray(item)
          ? semanticDocument(item)
          : item;
  }
  return result;
}
