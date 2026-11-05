import { type ApplicationServices, mapEntryRichText } from "@pcms/api";
import { validateBlockDocument } from "@pcms/blocks";
import { collectRichTextMediaIds } from "@pcms/content";
import { safeMarkdown } from "@pcms/themes";
import {
  escapeMarkdownInline,
  type MarkdownRenderContext,
  MarkdownRenderError,
  renderMarkdownBlocks,
  renderMarkdownRichText,
  renderMarkdownSemanticFields,
} from "./markdown-render.js";

/** The public route and discovery use the same semantic projection, without HTML or Liquid. */
export async function preparePublishedMarkdown(
  application: ApplicationServices,
  input: {
    readonly contentTypeId: string;
    readonly payload: unknown;
    readonly paired: boolean;
    readonly siteTitle: string;
    readonly context: MarkdownRenderContext;
  },
) {
  const definition = application.contentTypes.getLatestContentType(input.contentTypeId);
  if (!definition) throw new MarkdownRenderError("content type is unavailable");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload))
    throw new MarkdownRenderError("published payload is invalid");
  const payload = input.payload as { fields?: unknown; blocks?: unknown; body?: unknown };
  if (!payload.fields || typeof payload.fields !== "object" || Array.isArray(payload.fields))
    throw new MarkdownRenderError("published fields are invalid");
  const fields = payload.fields as Record<string, unknown>;
  let blocks: Record<string, unknown>[] = [];
  if (definition.bodyPolicy === "block_document" || payload.blocks != null) {
    const parsed = validateBlockDocument(payload.blocks, application.blocks);
    if (!parsed.ok) throw new MarkdownRenderError("published BlockDocument is invalid");
    blocks = parsed.value.blocks as unknown as Record<string, unknown>[];
  }
  mapEntryRichText(input.payload, definition, application.blocks, (document) => {
    collectRichTextMediaIds(document);
    return document;
  });
  const context = input.context;
  const body =
    definition.bodyPolicy === "block_document" ? undefined : (payload.body ?? fields.body);
  const blocksMarkdown =
    definition.bodyPolicy === "block_document" ? await renderMarkdownBlocks(blocks, context) : "";
  const bodyMarkdown =
    body !== undefined && body !== null && body !== "" ? renderMarkdownRichText(body, context) : "";
  const introMarkdown =
    typeof fields.intro === "string"
      ? fields.intro
          .split(/\n\s*\n/)
          .map((part) => part.split(/\r?\n/).map(escapeMarkdownInline).join("  \n"))
          .join("\n\n")
      : fields.intro !== null && typeof fields.intro === "object"
        ? renderMarkdownRichText(fields.intro, context)
        : "";
  const semanticFieldsMarkdown = renderMarkdownSemanticFields(
    input.contentTypeId,
    fields,
    definition.fieldSchema.fields,
    context,
    context.locale ?? "en",
    definition.version,
  );
  const title = typeof fields.title === "string" ? fields.title : input.siteTitle;
  const heading = typeof fields.h1 === "string" && fields.h1.trim() ? fields.h1 : title;
  if (!input.paired && /[\r\n]/.test(heading))
    throw new MarkdownRenderError("page heading must fit one Markdown heading line");
  const fieldProjections: Record<string, unknown> = {};
  const contentPaths = [
    "fallback_markdown",
    "body_markdown",
    "blocks_markdown",
    "entry.fields.intro_markdown",
    "entry.fields.body_markdown",
  ];
  if (input.paired) {
    for (const [key, schema] of Object.entries(definition.fieldSchema.fields)) {
      const value = fields[key];
      if (schema.type === "rich_text" && value !== undefined && value !== null && value !== "") {
        fieldProjections[`${key}_markdown`] = safeMarkdown(renderMarkdownRichText(value, context));
        contentPaths.push(`entry.fields.${key}_markdown`);
      }
      if (
        ["string", "text"].includes(schema.type) &&
        !["title", "h1", "slug"].includes(key) &&
        typeof value === "string"
      )
        contentPaths.push(`entry.fields.${key}`);
    }
  }
  const hasContent = [semanticFieldsMarkdown, introMarkdown, blocksMarkdown, bodyMarkdown].some(
    (part) => part.trim(),
  );
  const fallbackMarkdown = [
    `# ${escapeMarkdownInline(heading)}`,
    semanticFieldsMarkdown,
    introMarkdown,
    blocksMarkdown,
    bodyMarkdown,
  ]
    .filter(Boolean)
    .join("\n\n");
  // A heading alone is not a substantive witness, even though its projection is nonempty.
  if (!hasContent) contentPaths.splice(contentPaths.indexOf("fallback_markdown"), 1);
  const markdownFields = input.paired
    ? {
        ...fields,
        ...fieldProjections,
        body_markdown: safeMarkdown(bodyMarkdown),
        intro_markdown: safeMarkdown(introMarkdown),
      }
    : {
        title,
        h1: heading,
        ...(typeof fields.intro === "string" ? { intro: fields.intro } : {}),
        intro_markdown: safeMarkdown(introMarkdown),
        body_markdown: safeMarkdown(bodyMarkdown),
      };
  return {
    title,
    heading,
    blocks,
    markdownFields,
    blocksMarkdown,
    bodyMarkdown,
    fallbackMarkdown,
    hasContent,
    contentPaths,
  };
}
