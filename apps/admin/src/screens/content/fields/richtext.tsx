import { type Editor, getMarkRange, Mark, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Fragment, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { handlePaste as handleTablePaste, isInTable } from "@tiptap/pm/tables";
import {
  EditorContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../../design/dialog.js";
import { Tooltip } from "../../../design/tooltip.js";
import {
  type AdminIconName,
  Button,
  Field,
  Icon,
  Input,
  Select,
  Switch,
} from "../../../design/ui.js";
import { t } from "../../../i18n/index.js";
import { loadMediaMeta, MediaPickerDialog } from "./pickers.js";
import type { FieldControlProps } from "./registry.js";
import {
  applyEditorLink,
  editorToRichText,
  linkAttributesFromMark,
  richTextToEditor,
} from "./richtext-adapter.js";

function MediaImageView({ node, editor, getPos, selected }: NodeViewProps) {
  const mediaId = typeof node.attrs.mediaId === "string" ? node.attrs.mediaId : null;
  const caption = inlineText(node.attrs.caption);
  const label =
    typeof node.attrs.alt === "string" && node.attrs.alt
      ? node.attrs.alt
      : t("blocks.richtext_image");
  const src = mediaId
    ? `/api/v1/media/${encodeURIComponent(mediaId)}/file?preview=thumbnail`
    : typeof node.attrs.src === "string"
      ? node.attrs.src
      : null;
  return (
    <NodeViewWrapper
      as="figure"
      className={`pcms-richtext__figure${selected ? " is-selected" : ""}`}
      contentEditable={false}
      data-testid="richtext-image"
      onClick={() => {
        const position = getPos();
        if (typeof position === "number") editor.commands.setNodeSelection(position);
      }}
    >
      {src ? (
        <img src={src} alt={label} loading="lazy" />
      ) : (
        <span role="img" aria-label={label}>
          {label}
        </span>
      )}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </NodeViewWrapper>
  );
}

function inlineText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (part === null || typeof part !== "object") return "";
      const node = part as { text?: unknown; content?: unknown };
      return typeof node.text === "string" ? node.text : inlineText(node.content);
    })
    .join("");
}

function focusAfterTable(editor: Editor): void {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "table") continue;
    const after = $from.before(depth) + node.nodeSize;
    const tr = editor.state.tr;
    const paragraph = editor.state.schema.nodes.paragraph;
    if (!paragraph) return;
    if (tr.doc.nodeAt(after)?.type.name !== "paragraph") tr.insert(after, paragraph.create());
    editor.view.dispatch(
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1), 1)).scrollIntoView(),
    );
    editor.view.focus();
    return;
  }
}

const DocumentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mediaId: { default: null, rendered: false },
      caption: { default: null, rendered: false },
    };
  },
  renderHTML({ HTMLAttributes, node }) {
    const label = node.attrs.alt || t("blocks.richtext_image");
    return node.attrs.mediaId
      ? [
          "span",
          {
            class: "pcms-richtext__media",
            contenteditable: "false",
            role: "img",
            "aria-label": label,
          },
          label,
        ]
      : ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MediaImageView);
  },
});
const DocumentTable = Table.extend({
  addAttributes() {
    return { ...this.parent?.(), caption: { default: null, rendered: false } };
  },
});
const DocumentHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      header: {
        default: "column",
        parseHTML: (element) => (element.getAttribute("scope") === "row" ? "row" : "column"),
        renderHTML: (attrs) => ({ scope: attrs.header === "row" ? "row" : "col" }),
      },
    };
  },
});
const LINK_TARGETS = ["_self", "_blank", "_new"] as const;
const LINK_RELS = ["nofollow", "sponsored", "ugc", "noopener", "noreferrer"] as const;

/** Mirrors the canonical href policy: no unsafe scheme, no whitespace. */
function isAllowedEditorHref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 32 || character === "\\")
  );
}

/** Allowlists editor HTML attributes before they become mark attributes. */
function editorRelTokens(value: unknown): string[] {
  const candidates = typeof value === "string" ? value.split(/\s+/) : [];
  const tokens = new Set<string>();
  for (const token of candidates)
    if ((LINK_RELS as readonly string[]).includes(token)) tokens.add(token);
  return LINK_RELS.filter((token) => tokens.has(token));
}

/**
 * Link mark with the extended settings (CORE-ADMIN-EDITOR-UX-01 §4).
 *
 * The stock StarterKit link mark injects `target="_blank" rel="noopener
 * noreferrer nofollow"` from its default HTMLAttributes into every link it
 * renders, which would invent attributes the operator never chose and smuggle
 * rel tokens into the AST on the next save. This mark has no defaults, renders
 * no attribute for an absent value, rejects an href outside the canonical
 * policy when parsing pasted HTML, and allowlists target/rel/title so unknown
 * values never reach the editor state (the adapter re-validates on the way to
 * the AST).
 */
const DocumentLink = Mark.create({
  name: "link",
  priority: 1000,
  keepOnSplit: false,
  exitable: true,
  inclusive: false,
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute("href");
          return isAllowedEditorHref(value) ? value : null;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.href === "string" && attributes.href !== ""
            ? { href: attributes.href }
            : {},
      },
      target: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute("target");
          return (LINK_TARGETS as readonly string[]).includes(value ?? "") ? value : null;
        },
        renderHTML: (attributes: Record<string, unknown>) =>
          (LINK_TARGETS as readonly string[]).includes(String(attributes.target))
            ? { target: String(attributes.target) }
            : {},
      },
      rel: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const tokens = editorRelTokens(element.getAttribute("rel"));
          return tokens.length > 0 ? tokens.join(" ") : null;
        },
        renderHTML: (attributes: Record<string, unknown>) => {
          const tokens = editorRelTokens(attributes.rel);
          return tokens.length > 0 ? { rel: tokens.join(" ") } : {};
        },
      },
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("title"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.title === "string" && attributes.title !== ""
            ? { title: attributes.title }
            : {},
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "a[href]",
        getAttrs: (element: HTMLElement) =>
          isAllowedEditorHref(element.getAttribute("href")) ? null : false,
      },
    ];
  },
  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return ["a", mergeAttributes(HTMLAttributes), 0];
  },
});

const extensions = [
  StarterKit.configure({
    strike: false,
    underline: false,
    // The extended link mark replaces the stock one (same name, priority 1000).
    link: false,
  }),
  DocumentLink,
  DocumentImage.configure({ allowBase64: false }),
  DocumentTable.configure({ resizable: false }),
  TableRow,
  TableCell,
  DocumentHeader,
];

export function RichTextEditor(props: FieldControlProps) {
  const emitted = useRef<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"table" | "link" | "image" | "caption" | null>(null);
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(4);
  const [href, setHref] = useState("");
  // Link dialog state (CORE-ADMIN-EDITOR-UX-01 §4): every saved link property
  // is prefilled from the caret's link mark and written back on apply.
  const [linkText, setLinkText] = useState("");
  const [linkTextOriginal, setLinkTextOriginal] = useState("");
  const [linkTarget, setLinkTarget] = useState<"_self" | "_blank" | "_new">("_self");
  const [linkTitle, setLinkTitle] = useState("");
  const [linkRel, setLinkRel] = useState<string[]>([]);
  const [linkRange, setLinkRange] = useState<{ from: number; to: number } | null>(null);
  const [alt, setAlt] = useState("");
  const [caption, setCaption] = useState("");
  const [captionOriginal, setCaptionOriginal] = useState<unknown>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const mediaPickSequence = useRef(0);
  const [decorative, setDecorative] = useState(false);
  const [picking, setPicking] = useState(false);
  const editor = useEditor({
    extensions,
    shouldRerenderOnTransaction: true,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    editable: !props.disabled,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": t("blocks.richtext_area"),
        "aria-multiline": "true",
        class: "pcms-richtext__document",
      },
      handlePaste: (view, event) => {
        const html = event.clipboardData?.getData("text/html") ?? "";
        if (/<table\b/i.test(html)) {
          const parsed = new DOMParser().parseFromString(html, "text/html");
          const tables = [...parsed.querySelectorAll("table")];
          if (
            tables.length !== 1 ||
            tables.some((table) => table.parentElement?.closest("table") !== null) ||
            tables.some((table) => {
              const rows = [...table.rows];
              const columns = rows[0]?.cells.length ?? 0;
              return (
                table.querySelector("caption") !== null ||
                rows.length < 1 ||
                rows.length > 2000 ||
                columns < 1 ||
                columns > 50 ||
                rows.length * columns > 10_000 ||
                rows.some((row) => row.cells.length !== columns) ||
                [...table.querySelectorAll("td,th")].some(
                  (cell) =>
                    Number(cell.getAttribute("rowspan") ?? 1) !== 1 ||
                    Number(cell.getAttribute("colspan") ?? 1) !== 1,
                )
              );
            })
          ) {
            setError(t("blocks.richtext_paste_unsupported"));
            return true;
          }
          return false;
        }
        const plain = event.clipboardData?.getData("text/plain") ?? "";
        if (!plain.includes("\t")) return false;
        const rows = plain.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
        const cells = rows.map((row) => row.split("\t"));
        const columns = Math.max(0, ...cells.map((row) => row.length));
        if (
          new TextEncoder().encode(plain).length > 1_048_576 ||
          cells.length > 2000 ||
          columns > 50 ||
          columns * cells.length > 1000 ||
          cells.some((row) => row.length !== columns)
        ) {
          setError(t("blocks.richtext_table_limit"));
          return true;
        }
        const schema = view.state.schema;
        const rowsContent = cells.map((row) =>
          schema.nodes.tableRow!.create(
            null,
            row.map((value) =>
              schema.nodes.tableCell!.create(null, [
                schema.nodes.paragraph!.create(null, value === "" ? [] : [schema.text(value)]),
              ]),
            ),
          ),
        );
        if (isInTable(view.state)) {
          const handled = handleTablePaste(
            view,
            event,
            new Slice(Fragment.fromArray(rowsContent), 0, 0),
          );
          if (handled) setError(null);
          return handled;
        }
        view.dispatch(
          view.state.tr
            .replaceSelectionWith(schema.nodes.table!.create(null, rowsContent))
            .scrollIntoView(),
        );
        setError(null);
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      try {
        const next = editorToRichText(current.getJSON());
        emitted.current = next;
        props.onChange(next);
        setError(null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
  });
  useEffect(() => {
    if (!editor || props.value === emitted.current) return;
    try {
      editor.commands.setContent(richTextToEditor(props.value), { emitUpdate: false });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [editor, props.value]);
  useEffect(() => {
    editor?.setEditable(!props.disabled, false);
  }, [editor, props.disabled]);
  // Toolbar commands are ICON buttons (CORE-RC19 C): the label is the
  // accessible name and the tooltip, the glyph comes from the shared Admin
  // icon registry. `active` reflects the current selection state (aria-pressed),
  // `disabled` the command's availability — both inherited from the editor.
  const command = (
    label: string,
    icon: AdminIconName,
    action: (value: Editor) => void,
    options: { disabled?: boolean; active?: boolean } = {},
  ) => {
    // A command that reports `active` is a toggle (bold, lists, …) and always
    // carries aria-pressed (APG); a pure action (undo, insert separator) has no
    // pressed state at all and omits the attribute.
    const toggle = options.active !== undefined;
    return (
      <Tooltip key={label} content={label}>
        <button
          type="button"
          className={`pcms-iconbtn pcms-richtext__btn${options.active === true ? " is-active" : ""}`}
          aria-label={label}
          aria-pressed={toggle ? options.active === true : undefined}
          onMouseDown={(event) => event.preventDefault()}
          disabled={!editor || props.disabled || options.disabled === true}
          onClick={() => {
            if (editor) action(editor);
          }}
        >
          <Icon name={icon} />
        </button>
      </Tooltip>
    );
  };
  // Link dialog helpers. `noopener` is forced for any target other than
  // `_self` (the same rule the public renderer enforces at render time), and
  // the checkbox is shown checked+disabled there so the operator sees it.
  const linkForcesNoopener = linkTarget !== "_self";
  const linkRelShown = linkForcesNoopener
    ? LINK_RELS.filter((token) => token === "noopener" || linkRel.includes(token))
    : LINK_RELS.filter((token) => linkRel.includes(token));
  const linkRelForApply = LINK_RELS.filter(
    (token) => linkRel.includes(token) || (linkForcesNoopener && token === "noopener"),
  );
  const openLinkDialog = (e: Editor) => {
    const { state } = e;
    const type = state.schema.marks.link;
    const range = type ? getMarkRange(state.selection.$from, type) : undefined;
    const attrs = linkAttributesFromMark(type ? { attrs: e.getAttributes("link") } : undefined);
    const text = range ? state.doc.textBetween(range.from, range.to, " ") : "";
    setHref(attrs.href);
    setLinkText(text);
    setLinkTextOriginal(text);
    setLinkTarget(attrs.target ?? "_self");
    setLinkTitle(attrs.title ?? "");
    setLinkRel(attrs.rel === null ? [] : attrs.rel.split(" "));
    setLinkRange(
      range
        ? { from: range.from, to: range.to }
        : { from: state.selection.from, to: state.selection.to },
    );
    setDialog("link");
  };
  const toggleLinkRel = (token: string, checked: boolean) =>
    setLinkRel((current) =>
      checked
        ? LINK_RELS.filter((value) => value === token || current.includes(value))
        : current.filter((value) => value !== token),
    );
  const applyLink = (e: Editor) => {
    if (
      href &&
      (!/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href) ||
        Array.from(href).some((character) => character.charCodeAt(0) <= 32 || character === "\\"))
    ) {
      setError(t("blocks.richtext_link_invalid"));
      return;
    }
    const title = linkTitle.trim();
    const titleInvalid =
      linkTitle !== "" &&
      (title === "" ||
        title.length > 500 ||
        Array.from(linkTitle).some((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127;
        }));
    if (titleInvalid) {
      setError(t("blocks.richtext_link_title_invalid"));
      return;
    }
    if (!href) {
      // Empty URL removes the link (the text stays); unsetMark with
      // extendEmptyMarkRange also clears a stored link at a collapsed caret.
      e.chain().focus().unsetMark("link", { extendEmptyMarkRange: true }).run();
      close();
      return;
    }
    let range = linkRange ?? { from: e.state.selection.from, to: e.state.selection.to };
    const display = linkText.replace(/\s+/g, " ").trim();
    if (linkText !== linkTextOriginal) {
      if (display === "") {
        setError(t("blocks.richtext_link_text_invalid"));
        return;
      }
      e.view.dispatch(e.state.tr.replaceWith(range.from, range.to, e.schema.text(display)));
      range = { from: range.from, to: range.from + display.length };
    } else if (range.from === range.to && display !== "") {
      // A collapsed caret with typed display text: insert that text and link it.
      e.view.dispatch(e.state.tr.insertText(display, range.from));
      range = { from: range.from, to: range.from + display.length };
    }
    applyEditorLink(e, range, {
      href,
      target: linkTarget,
      rel: linkRelForApply.length > 0 ? linkRelForApply.join(" ") : null,
      title: title === "" ? null : title,
    });
    close();
  };
  const close = () => setDialog(null);
  return (
    <div className="pcms-richtext" data-testid="richtext-editor">
      {/* CORE-ADMIN-EDITOR-UX-01 §3: the toolbars sit ABOVE the scrolling
       * document (not inside it), so formatting stays reachable however long
       * the content is; the document itself is height-bounded and manually
       * resizable. */}
      <div className="pcms-richtext__toolbars" data-testid="richtext-toolbars">
        <div
          className="pcms-richtext__toolbar"
          role="toolbar"
          aria-label={t("blocks.richtext_toolbar")}
        >
          <span className="pcms-richtext__group">
            {command(
              t("blocks.richtext_bold"),
              "bold",
              (e) => {
                e.chain().focus().toggleBold().run();
              },
              { active: editor?.isActive("bold") },
            )}
            {command(
              t("blocks.richtext_italic"),
              "italic",
              (e) => {
                e.chain().focus().toggleItalic().run();
              },
              { active: editor?.isActive("italic") },
            )}
            {command(
              t("blocks.richtext_code"),
              "code",
              (e) => {
                e.chain().focus().toggleCode().run();
              },
              { active: editor?.isActive("code") },
            )}
            {command(
              t("blocks.richtext_heading"),
              "heading",
              (e) => {
                e.chain().focus().toggleHeading({ level: 2 }).run();
              },
              { active: editor?.isActive("heading", { level: 2 }) },
            )}
          </span>
          <span className="pcms-richtext__group">
            {command(
              t("blocks.richtext_bullets"),
              "list",
              (e) => {
                e.chain().focus().toggleBulletList().run();
              },
              { active: editor?.isActive("bulletList") },
            )}
            {command(
              t("blocks.richtext_numbered"),
              "listOrdered",
              (e) => {
                e.chain().focus().toggleOrderedList().run();
              },
              { active: editor?.isActive("orderedList") },
            )}
            {command(
              t("blocks.richtext_quote"),
              "quote",
              (e) => {
                e.chain().focus().toggleBlockquote().run();
              },
              { active: editor?.isActive("blockquote") },
            )}
            {command(
              t("blocks.richtext_code_block"),
              "codeBlock",
              (e) => {
                e.chain().focus().toggleCodeBlock().run();
              },
              { active: editor?.isActive("codeBlock") },
            )}
            {command(t("blocks.richtext_separator"), "separator", (e) => {
              e.chain().focus().setHorizontalRule().run();
            })}
          </span>
          <span className="pcms-richtext__group">
            {command(t("blocks.richtext_link"), "link", openLinkDialog, {
              active: editor?.isActive("link"),
            })}
            {command(t("blocks.richtext_table"), "table", () => setDialog("table"))}
            {command(t("blocks.richtext_image"), "image", () => {
              const attrs = editor?.isActive("image") ? editor.getAttributes("image") : null;
              setMediaId(typeof attrs?.mediaId === "string" ? attrs.mediaId : null);
              setAlt(typeof attrs?.alt === "string" ? attrs.alt : "");
              setDecorative(attrs?.alt === "");
              setCaption(inlineText(attrs?.caption));
              setCaptionOriginal(attrs?.caption ?? null);
              setDialog("image");
              setPicking(!attrs?.mediaId);
            })}
          </span>
          <span className="pcms-richtext__group">
            {command(t("blocks.richtext_undo"), "undo", (e) => {
              e.chain().focus().undo().run();
            })}
            {command(t("blocks.richtext_redo"), "redo", (e) => {
              e.chain().focus().redo().run();
            })}
          </span>
        </div>
        {editor?.isActive("table") ? (
          <div
            className="pcms-richtext__toolbar"
            role="toolbar"
            aria-label={t("blocks.richtext_table")}
          >
            <span className="pcms-richtext__group">
              {command(t("blocks.richtext_row_add"), "rowAdd", (e) => {
                e.chain().focus().addRowAfter().run();
              })}
              {command(t("blocks.richtext_row_delete"), "rowDelete", (e) => {
                e.chain().focus().deleteRow().run();
              })}
            </span>
            <span className="pcms-richtext__group">
              {command(t("blocks.richtext_column_add"), "columnAdd", (e) => {
                e.chain().focus().addColumnAfter().run();
              })}
              {command(t("blocks.richtext_column_delete"), "columnDelete", (e) => {
                e.chain().focus().deleteColumn().run();
              })}
            </span>
            <span className="pcms-richtext__group">
              {command(t("blocks.richtext_header_column"), "headerColumn", (e) => {
                e.chain().focus().toggleHeaderCell().setCellAttribute("header", "column").run();
              })}
              {command(t("blocks.richtext_header_row"), "headerRow", (e) => {
                e.chain().focus().toggleHeaderCell().setCellAttribute("header", "row").run();
              })}
              {command(t("blocks.richtext_caption"), "caption", (e) => {
                const original = e.getAttributes("table").caption ?? null;
                setCaption(inlineText(original));
                setCaptionOriginal(original);
                setDialog("caption");
              })}
            </span>
            <span className="pcms-richtext__group">
              {command(t("blocks.richtext_after_table"), "textAfter", focusAfterTable)}
              {command(t("blocks.richtext_table_delete"), "tableDelete", (e) => {
                e.chain().focus().deleteTable().run();
              })}
            </span>
          </div>
        ) : null}
      </div>
      <div
        className="pcms-richtext__scroll"
        data-testid="richtext-scroll"
        // The native resize handle only works on an overflow container; the
        // initial height lives in CSS (350–400 px desktop, share of the
        // viewport on small screens) and the user may stretch it back and
        // forth. Height is local UI state, never part of the document.
      >
        <EditorContent editor={editor} />
      </div>
      {error ? (
        <p className="pcms-field__error" role="alert">
          {error}
        </p>
      ) : null}
      {dialog !== null && !picking ? (
        <Dialog open onClose={close} title={t(`blocks.richtext_${dialog}`)}>
          {dialog === "table" ? (
            <>
              <Field label={t("blocks.richtext_rows")}>
                <Input
                  type="number"
                  min={1}
                  max={2000}
                  value={rows}
                  onChange={(e) => setRows(Number(e.target.value))}
                />
              </Field>
              <Field label={t("blocks.richtext_columns")}>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={columns}
                  onChange={(e) => setColumns(Number(e.target.value))}
                />
              </Field>
            </>
          ) : null}
          {dialog === "link" ? (
            <>
              <Field label={t("blocks.richtext_link")}>
                <Input value={href} autoComplete="off" onChange={(e) => setHref(e.target.value)} />
              </Field>
              <Field label={t("blocks.richtext_link_text")}>
                <Input
                  value={linkText}
                  onChange={(e) => setLinkText(e.target.value)}
                  placeholder={t("blocks.richtext_link_text_placeholder")}
                />
              </Field>
              <Field label={t("blocks.richtext_link_target")}>
                <Select
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value as "_self" | "_blank" | "_new")}
                >
                  <option value="_self">{t("blocks.richtext_link_target_self")}</option>
                  <option value="_blank">{t("blocks.richtext_link_target_blank")}</option>
                  <option value="_new">{t("blocks.richtext_link_target_new")}</option>
                </Select>
              </Field>
              <Field
                label={t("blocks.richtext_link_title")}
                optional
                hint={t("blocks.richtext_link_title_hint")}
              >
                <Input value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} />
              </Field>
              <fieldset className="pcms-richtext__rel">
                <legend className="pcms-field__label">{t("blocks.richtext_link_rel")}</legend>
                {LINK_RELS.map((token) => (
                  <Switch
                    key={token}
                    label={t(`blocks.richtext_link_rel_${token}`)}
                    checked={linkRelShown.includes(token)}
                    disabled={token === "noopener" && linkForcesNoopener}
                    onChange={(checked) => toggleLinkRel(token, checked)}
                  />
                ))}
                {linkForcesNoopener ? (
                  <p className="pcms-field__hint">{t("blocks.richtext_link_noopener_hint")}</p>
                ) : null}
              </fieldset>
            </>
          ) : null}
          {dialog === "image" ? (
            <>
              <Field label={t("blocks.richtext_image_alt")}>
                <Input value={alt} disabled={decorative} onChange={(e) => setAlt(e.target.value)} />
              </Field>
              <label className="pcms-richtext__decorative">
                <input
                  type="checkbox"
                  checked={decorative}
                  onChange={(event) => setDecorative(event.target.checked)}
                />
                {t("blocks.richtext_image_decorative")}
              </label>
              {mediaId ? (
                <Button variant="ghost" onClick={() => setPicking(true)}>
                  {t("blocks.richtext_image_change_asset")}
                </Button>
              ) : null}
            </>
          ) : null}
          {dialog === "image" || dialog === "caption" ? (
            <Field label={t("blocks.richtext_caption")}>
              <Input value={caption} onChange={(e) => setCaption(e.target.value)} />
            </Field>
          ) : null}
          <Button
            onClick={() => {
              if (!editor) return;
              if (dialog === "table") {
                if (
                  !Number.isInteger(rows) ||
                  !Number.isInteger(columns) ||
                  rows < 1 ||
                  rows > 2000 ||
                  columns < 1 ||
                  columns > 50 ||
                  rows * columns > 1000
                ) {
                  setError(t("blocks.richtext_table_limit"));
                  return;
                }
                editor
                  .chain()
                  .focus()
                  .insertTable({ rows, cols: columns, withHeaderRow: false })
                  .run();
              }
              if (dialog === "link") {
                applyLink(editor);
                return;
              }
              if (dialog === "image" && mediaId) {
                if (!decorative && alt.trim() === "") {
                  setError(t("blocks.richtext_image_invalid"));
                  return;
                }
                const attrs = {
                  mediaId,
                  alt: decorative ? "" : alt,
                  caption:
                    inlineText(captionOriginal) === caption
                      ? captionOriginal
                      : caption
                        ? [{ type: "text", text: caption }]
                        : null,
                };
                if (editor.isActive("image"))
                  editor.chain().focus().updateAttributes("image", attrs).run();
                else editor.chain().focus().insertContent({ type: "image", attrs }).run();
              }
              if (dialog === "caption")
                editor
                  .chain()
                  .focus()
                  .updateAttributes("table", {
                    caption:
                      inlineText(captionOriginal) === caption
                        ? captionOriginal
                        : caption
                          ? [{ type: "text", text: caption }]
                          : null,
                  })
                  .run();
              close();
            }}
          >
            {t("blocks.richtext_apply")}
          </Button>
        </Dialog>
      ) : null}
      {picking ? (
        <MediaPickerDialog
          open
          title={t("blocks.richtext_image_library")}
          onClose={() => {
            setPicking(false);
          }}
          onPick={(id, label) => {
            const sequence = ++mediaPickSequence.current;
            setMediaId(id);
            setAlt(label);
            setDecorative(false);
            setPicking(false);
            void loadMediaMeta(id)
              .then((asset) => {
                if (sequence !== mediaPickSequence.current) return;
                if (asset.kind !== "image" || asset.archivedAt) {
                  setMediaId(null);
                  setError(t("blocks.richtext_image_invalid"));
                }
              })
              .catch((reason) => {
                if (sequence !== mediaPickSequence.current) return;
                setMediaId(null);
                setError(String(reason));
              });
          }}
        />
      ) : null}
    </div>
  );
}
