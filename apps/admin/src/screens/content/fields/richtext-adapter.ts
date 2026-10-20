import type { JSONContent } from "@tiptap/core";

type Node = { type: string; [key: string]: unknown };
const names: Record<string, string> = {
  document: "doc",
  bullet_list: "bulletList",
  ordered_list: "orderedList",
  list_item: "listItem",
  hard_break: "hardBreak",
  code_block: "codeBlock",
  horizontal_rule: "horizontalRule",
  table_row: "tableRow",
  table_cell: "tableCell",
};
const reverse = Object.fromEntries(Object.entries(names).map(([a, b]) => [b, a]));
const markNames: Record<string, string> = { strong: "bold", emphasis: "italic", code: "code" };
const reverseMarks = Object.fromEntries(Object.entries(markNames).map(([a, b]) => [b, a]));

/** Editor-private JSON is never the persisted CMS contract. */
export function richTextToEditor(value: unknown): JSONContent {
  if (value === undefined || value === null || value === "")
    return { type: "doc", content: [{ type: "paragraph" }] };
  // v2 is the only readable version (CORE-RICHTEXT-V2-ONLY). A stored v1
  // document is a migration concern, not something the editor silently opens:
  // opening it would let a mere save "convert" content the operator never saw
  // converted, and would hide the migration from the site owner.
  if (typeof value !== "object" || (value as { schema_version?: unknown }).schema_version !== 2)
    throw new Error(
      "This document is not RichText v2 (schema_version: 2); convert it with the site migration first",
    );
  const convert = (
    node: Node,
    inherited: NonNullable<JSONContent["marks"]> = [],
    depth = 0,
  ): JSONContent[] => {
    if (depth > 32 || !node || typeof node.type !== "string")
      throw new Error("Invalid RichText document");
    if (node.type === "link")
      return ((node.content ?? []) as Node[]).flatMap((child) =>
        convert(child, [...inherited, { type: "link", attrs: { href: node.href } }], depth + 1),
      );
    const children = () =>
      ((node.content ?? []) as Node[]).flatMap((child) => convert(child, inherited, depth + 1));
    if (node.type === "text")
      return [
        {
          type: "text",
          text: String(node.text),
          marks: [
            ...inherited,
            ...((node.marks ?? []) as string[]).map((type) => ({ type: markNames[type] ?? type })),
          ],
        },
      ];
    if (node.type === "image")
      return [
        {
          type: "image",
          attrs: {
            src: node.src ?? null,
            mediaId: node.media_id ?? null,
            alt: node.alt,
            title: node.title ?? null,
            caption: node.caption ?? null,
          },
        },
      ];
    if (node.type === "code_block")
      return [
        {
          type: "codeBlock",
          attrs: { language: node.language ?? null },
          content: node.code === "" ? [] : [{ type: "text", text: String(node.code) }],
        },
      ];
    if (node.type === "table_cell")
      return [
        {
          type: node.header ? "tableHeader" : "tableCell",
          attrs: { header: node.header ?? null, colspan: 1, rowspan: 1, colwidth: null },
          content: children(),
        },
      ];
    const attrs =
      node.type === "heading"
        ? { level: node.level }
        : node.type === "ordered_list"
          ? { start: node.start ?? 1 }
          : node.type === "table"
            ? { caption: node.caption ?? null }
            : undefined;
    const type = names[node.type] ?? node.type;
    if (
      ![
        "doc",
        "paragraph",
        "heading",
        "bulletList",
        "orderedList",
        "listItem",
        "blockquote",
        "hardBreak",
        "horizontalRule",
        "table",
        "tableRow",
      ].includes(type)
    )
      throw new Error(`Unsupported RichText node: ${node.type}`);
    return [
      {
        type,
        ...(attrs ? { attrs } : {}),
        ...(["hardBreak", "horizontalRule"].includes(type) ? {} : { content: children() }),
      },
    ];
  };
  return convert(value as Node)[0]!;
}

export function editorToRichText(document: JSONContent): Node {
  let count = 0;
  const convert = (node: JSONContent, depth = 0): Node | null => {
    if (++count > 10_000 || depth > 32) throw new Error("RichText document exceeds limits");
    // Empty text leaves are dropped (see the text branch), so children are
    // filtered rather than mapped.
    const children = (): Node[] =>
      (node.content ?? [])
        .map((child) => convert(child, depth + 1))
        .filter((child): child is Node => child !== null);
    if (node.type === "text") {
      const marks = (node.marks ?? [])
        .filter((mark) => mark.type !== "link")
        .map((mark) => {
          const value = reverseMarks[mark.type];
          if (!value) throw new Error(`Unsupported mark: ${mark.type}`);
          return value;
        });
      // Tiptap materializes empty text leaves transiently (an emptied
      // selection, a collapsed mark). The AST contract forbids them, so an
      // empty leaf is dropped instead of being persisted as a bare tag.
      const text = node.text ?? "";
      if (text === "") return null;
      const leaf: Node = {
        type: "text",
        text,
        ...(marks.length ? { marks } : {}),
      };
      const link = node.marks?.find((mark) => mark.type === "link");
      return link ? { type: "link", href: link.attrs?.href, content: [leaf] } : leaf;
    }
    if (node.type === "image")
      return {
        type: "image",
        ...(node.attrs?.mediaId ? { media_id: node.attrs.mediaId } : { src: node.attrs?.src }),
        alt: node.attrs?.alt ?? "",
        ...(node.attrs?.title ? { title: node.attrs.title } : {}),
        ...(node.attrs?.caption !== null && node.attrs?.caption !== undefined
          ? { caption: node.attrs.caption }
          : {}),
      };
    if (node.type === "codeBlock")
      return {
        type: "code_block",
        code: (node.content ?? []).map((child) => child.text ?? "").join(""),
        ...(node.attrs?.language ? { language: node.attrs.language } : {}),
      };
    if (node.type === "tableCell" || node.type === "tableHeader") {
      if ((node.attrs?.colspan ?? 1) !== 1 || (node.attrs?.rowspan ?? 1) !== 1)
        throw new Error("Merged cells are not supported");
      return {
        type: "table_cell",
        ...(node.type === "tableHeader" ? { header: node.attrs?.header ?? "column" } : {}),
        content: children(),
      };
    }
    const type = reverse[node.type ?? ""] ?? node.type;
    if (
      !type ||
      ![
        "document",
        "paragraph",
        "heading",
        "bullet_list",
        "ordered_list",
        "list_item",
        "blockquote",
        "hard_break",
        "horizontal_rule",
        "table",
        "table_row",
      ].includes(type)
    )
      throw new Error(`Unsupported editor node: ${node.type}`);
    return {
      type,
      ...(type === "document" ? { schema_version: 2 } : {}),
      ...(type === "heading" ? { level: node.attrs?.level } : {}),
      ...(type === "ordered_list" && node.attrs?.start !== 1 ? { start: node.attrs?.start } : {}),
      ...(type === "table" && node.attrs?.caption !== null && node.attrs?.caption !== undefined
        ? { caption: node.attrs.caption }
        : {}),
      ...(["hard_break", "horizontal_rule"].includes(type) ? {} : { content: children() }),
    };
  };
  const result = convert(document);
  if (result === null) throw new Error("RichText document produced no content");
  return result;
}
