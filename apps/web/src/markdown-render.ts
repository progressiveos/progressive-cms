import type { FieldSchema } from "@pcms/content";
import { richTextToMarkdown, validateRichText } from "@pcms/content";

export class MarkdownRenderError extends Error {
  readonly code = "MARKDOWN_DOCUMENT_UNSUPPORTED";

  constructor(
    message: string,
    readonly blockType?: string,
  ) {
    super(message);
    this.name = "MarkdownRenderError";
  }
}

export interface MarkdownRenderContext {
  readonly mediaUrl: (id: string) => string | null;
  readonly mediaAlt?: (id: string) => string | null;
  readonly actionUrl: (action: Readonly<Record<string, unknown>>) => Promise<string | null>;
  readonly relatedCards?: Readonly<
    Record<
      string,
      readonly {
        readonly href: string;
        readonly title: string;
        readonly description: string | null;
        readonly date?: string | null;
        readonly tags?: readonly string[];
        readonly image?: string | null;
        readonly image_alt?: string | null;
      }[]
    >
  >;
  readonly htmlUrl: string;
  readonly locale?: string;
  readonly quizTitles?: Readonly<Record<string, string>>;
}

export function escapeMarkdownInline(value: string): string {
  let output = "";
  for (const character of value.replace(/[\r\n]+/g, " "))
    output += "\\`*_{}[]()#+.!<>|~-".includes(character) ? `\\${character}` : character;
  return output;
}

function inline(value: unknown): string {
  if (typeof value !== "string") throw new MarkdownRenderError("expected text value");
  if (/[\r\n]/.test(value))
    throw new MarkdownRenderError("multiline text cannot be placed in an inline Markdown position");
  return escapeMarkdownInline(value);
}

function paragraph(value: string): string {
  return value
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.split(/\r?\n/).map(escapeMarkdownInline).join("  \n"))
    .join("\n\n");
}

function safeUrl(value: string): string {
  if (!/^(https?:\/\/|\/(?!\/)|#|mailto:|tel:)/i.test(value) || /[\s<>\\]/.test(value))
    throw new MarkdownRenderError("link URL is not safe for Markdown");
  return value.replace(/[()]/g, (part) => (part === "(" ? "%28" : "%29"));
}

function richText(value: unknown, context: MarkdownRenderContext): string {
  const validated = validateRichText(value);
  if (!validated.ok) throw new MarkdownRenderError("invalid RichText document");

  const visit = (node: Record<string, unknown>): Record<string, unknown>[] => {
    const result: Record<string, unknown> = { ...node };
    if (node.type === "link" && typeof node.href === "string") result.href = safeUrl(node.href);
    if (node.type === "image") {
      if (typeof node.media_id === "string") {
        const src = context.mediaUrl(node.media_id);
        if (src === null)
          throw new MarkdownRenderError("RichText image has no public URL", "image");
        result.src = safeUrl(src);
        delete result.media_id;
      } else if (typeof node.src === "string") {
        result.src = safeUrl(node.src);
      }
      delete result.caption;
    }
    if (Array.isArray(node.content))
      result.content = node.content.flatMap((child) => visit(child as Record<string, unknown>));
    const output = [result];
    if (node.type === "image" && Array.isArray(node.caption) && node.caption.length > 0)
      output.push({ type: "paragraph", content: node.caption });
    return output;
  };

  const document = visit(validated.value as unknown as Record<string, unknown>)[0];
  if (document === undefined) return "";
  try {
    return richTextToMarkdown(document);
  } catch (error) {
    throw new MarkdownRenderError(
      error instanceof Error ? error.message : "RichText is not representable",
    );
  }
}

function actionLabel(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null) return fallback;
  const label = (value as Record<string, unknown>).anchor_text;
  return typeof label === "string" && label !== "" ? label : fallback;
}

function localized(context: MarkdownRenderContext, ru: string, en: string): string {
  return context.locale?.toLowerCase().startsWith("ru") ? ru : en;
}

async function action(
  value: unknown,
  context: MarkdownRenderContext,
  fallback: string,
): Promise<string> {
  if (!value || typeof value !== "object") return inline(fallback);
  const record = value as Record<string, unknown>;
  const kind = String(record.type ?? "");
  if (kind === "none") return "";
  const label = actionLabel(record, fallback);
  if (kind === "form") return `[${inline(label)}](${safeUrl(context.htmlUrl)})`;
  const href = await context.actionUrl(record);
  if (href === null) throw new MarkdownRenderError(`action ${kind} has no public URL`);
  return `[${inline(label)}](${safeUrl(href)})`;
}

function publicMedia(id: unknown, context: MarkdownRenderContext): string {
  if (typeof id !== "string") throw new MarkdownRenderError("media block has no media reference");
  const href = context.mediaUrl(id);
  if (href === null) throw new MarkdownRenderError("media has no public URL");
  return safeUrl(href);
}

function image(
  id: unknown,
  alt: unknown,
  caption: unknown,
  context: MarkdownRenderContext,
): string {
  const label =
    typeof alt === "string"
      ? inline(alt)
      : typeof id === "string"
        ? inline(context.mediaAlt?.(id) ?? "")
        : "";
  const note = typeof caption === "string" && caption !== "" ? `\n\n${paragraph(caption)}` : "";
  return `![${label}](${publicMedia(id, context)})${note}`;
}

function video(value: Record<string, unknown>, context: MarkdownRenderContext): string {
  const title =
    typeof value.title === "string" ? inline(value.title) : localized(context, "Видео", "Video");
  const provider = value.provider;
  const href =
    typeof value.url === "string"
      ? value.url
      : typeof value.video_id === "string" && provider === "youtube"
        ? `https://www.youtube.com/watch?v=${value.video_id}`
        : typeof value.video_id === "string" && provider === "vimeo"
          ? `https://vimeo.com/${value.video_id}`
          : typeof value.video_id === "string" && provider === "rutube"
            ? `https://rutube.ru/video/${value.video_id}/`
            : typeof value.video_id === "string" && provider === "vkvideo"
              ? `https://vk.com/video${value.video_id}`
              : typeof value.media_asset_id === "string"
                ? context.mediaUrl(value.media_asset_id)
                : typeof value.media_id === "string"
                  ? context.mediaUrl(value.media_id)
                  : null;
  if (href === null) throw new MarkdownRenderError("video has no public URL", "video");
  const startAt =
    Number.isInteger(value.start_at) && Number(value.start_at) > 0 ? Number(value.start_at) : null;
  let startNote = "";
  let videoHref = href;
  if (startAt !== null) {
    if (provider === "youtube") videoHref += `${videoHref.includes("?") ? "&" : "?"}t=${startAt}s`;
    else if (provider === "vimeo") videoHref += `#t=${startAt}s`;
    else if (provider === "upload" || typeof value.media_asset_id === "string")
      videoHref += `#t=${startAt}`;
    else
      startNote = `\n\n${localized(context, `Начало с ${startAt} с.`, `Starts at ${startAt} seconds.`)}`;
  }
  return `[${title}](${safeUrl(videoHref)})${typeof value.caption === "string" ? `\n\n${paragraph(value.caption)}` : ""}${startNote}`;
}

async function renderBlock(
  node: Record<string, unknown>,
  context: MarkdownRenderContext,
): Promise<string> {
  const type = typeof node.type === "string" ? node.type : "unknown";
  if (node.schemaVersion !== 1)
    throw new MarkdownRenderError(
      `no Markdown serializer for ${type}@${String(node.schemaVersion)}`,
      type,
    );
  if (Array.isArray(node.children) && node.children.length > 0)
    throw new MarkdownRenderError(
      "nested blocks are not supported by the Markdown serializer",
      type,
    );
  const props = (node.props ?? {}) as Record<string, unknown>;
  const title = typeof props.title === "string" ? inline(props.title) : "";
  const items = props.items ?? props.markers;

  switch (type) {
    case "text":
      return richText(props.rich_text, context);
    case "heading": {
      const level = Number(props.level);
      if (!Number.isInteger(level) || level < 1 || level > 6)
        throw new MarkdownRenderError("invalid heading level", type);
      if (
        props.anchor !== undefined &&
        (typeof props.anchor !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(props.anchor))
      )
        throw new MarkdownRenderError("invalid heading anchor", type);
      const anchor = typeof props.anchor === "string" ? ` <a id="${props.anchor}"></a>` : "";
      return `${"#".repeat(level)} ${inline(props.text)}${anchor}`;
    }
    case "image":
      return image(props.media_id, props.alt_override, props.caption, context);
    case "gallery": {
      if (!Array.isArray(items)) throw new MarkdownRenderError("gallery items are malformed", type);
      const output = items.map((item) => {
        const row = item as Record<string, unknown>;
        return image(row.media_id, row.alt_override, row.caption, context);
      });
      if (typeof props.caption === "string") output.unshift(paragraph(props.caption));
      return output.join("\n\n");
    }
    case "video_gallery": {
      if (!Array.isArray(items))
        throw new MarkdownRenderError("video gallery items are malformed", type);
      const output = items.map((item) => video(item as Record<string, unknown>, context));
      if (typeof props.caption === "string") output.unshift(paragraph(props.caption));
      return output.join("\n\n");
    }
    case "quote": {
      const body = richText(props.rich_text, context)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      const author = typeof props.author === "string" ? `\n>\n> — ${inline(props.author)}` : "";
      const source =
        typeof props.source_url === "string"
          ? `\n>\n> [${inline(typeof props.source === "string" ? props.source : props.source_url)}](${safeUrl(props.source_url)})`
          : typeof props.source === "string"
            ? `\n>\n> ${inline(props.source)}`
            : "";
      return `${body}${author}${source}`;
    }
    case "callout": {
      const language = context.locale?.toLowerCase().startsWith("ru") ? "ru" : "en";
      const kindLabels =
        language === "ru"
          ? {
              info: "Информация",
              note: "Примечание",
              warning: "Предупреждение",
              success: "Успешно",
              accent: "Важно",
            }
          : {
              info: "Information",
              note: "Note",
              warning: "Warning",
              success: "Success",
              accent: "Featured",
            };
      const kind =
        typeof props.kind === "string"
          ? kindLabels[props.kind as keyof typeof kindLabels]
          : undefined;
      if (kind === undefined) throw new MarkdownRenderError("callout kind is malformed", type);
      const heading = [kind, title]
        .filter((part, index, parts) => part !== "" && (index === 0 || part !== parts[index - 1]))
        .join(": ");
      return `${heading ? `**${heading}**\n\n` : ""}${richText(props.body, context)}`;
    }
    case "list": {
      if (!Array.isArray(props.items))
        throw new MarkdownRenderError("list items are malformed", type);
      return (
        await Promise.all(
          props.items.map(async (item) => {
            const row = item as Record<string, unknown>;
            const text = row.text === undefined ? "" : richText(row.text, context);
            const rawTitle = typeof row.title === "string" ? row.title : "";
            const title = rawTitle ? inline(rawTitle) : "";
            const link = row.link as Record<string, unknown> | undefined;
            const linkLabel =
              typeof link?.anchor_text === "string" && link.anchor_text !== ""
                ? link.anchor_text
                : rawTitle;
            const linked = row.link
              ? await action(
                  row.link,
                  context,
                  rawTitle || localized(context, "Подробнее", "Learn more"),
                )
              : "";
            const label =
              linked && title && linkLabel !== rawTitle
                ? `${title} — ${linked}`
                : linked || title || text;
            const detail =
              text && (linked || title) && text !== title
                ? `\n  ${text.replace(/\n/g, "\n  ")}`
                : "";
            return `- ${label}${detail}`;
          }),
        )
      ).join("\n");
    }
    case "table": {
      if (!Array.isArray(props.columns) || (props.rows !== undefined && !Array.isArray(props.rows)))
        throw new MarkdownRenderError("table structure is malformed", type);
      const columns = props.columns as Record<string, unknown>[];
      const formatRow = (cells: string[]) => {
        if (cells.some((cell) => /[\r\n]/.test(cell)))
          throw new MarkdownRenderError(
            "multiline table cells cannot be represented without loss",
            type,
          );
        return `| ${cells.join(" | ")} |`;
      };
      const output = [
        formatRow(columns.map((column) => inline(column.title))),
        formatRow(columns.map(() => "---")),
      ];
      for (const rawRow of (props.rows ?? []) as unknown[]) {
        if (!Array.isArray(rawRow) || rawRow.length !== columns.length)
          throw new MarkdownRenderError("table row does not match declared columns", type);
        output.push(
          formatRow(
            rawRow.map((cell) =>
              cell !== null && typeof cell === "object"
                ? richText(cell, context)
                : inline(String(cell ?? "")),
            ),
          ),
        );
      }
      return `${typeof props.caption === "string" ? `${paragraph(props.caption)}\n\n` : ""}${output.join("\n")}`;
    }
    case "code": {
      if (typeof props.code !== "string")
        throw new MarkdownRenderError("code content is malformed", type);
      if (
        props.language !== undefined &&
        (typeof props.language !== "string" || !/^[a-z0-9+#-]{1,24}$/.test(props.language))
      )
        throw new MarkdownRenderError("code language is malformed", type);
      const longest = Math.max(0, ...(props.code.match(/`+/g) ?? [""]).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      const labels = [props.caption, props.filename]
        .filter((value): value is string => typeof value === "string" && value !== "")
        .map(inline);
      const label = labels.length > 0 ? `**${labels.join(" · ")}**\n\n` : "";
      return `${label}${fence}${typeof props.language === "string" ? props.language : ""}\n${props.code}\n${fence}`;
    }
    case "faq": {
      if (!Array.isArray(items)) throw new MarkdownRenderError("FAQ items are malformed", type);
      return items
        .map((item) => {
          const row = item as Record<string, unknown>;
          return `### ${inline(row.question)}\n\n${richText(row.answer, context)}`;
        })
        .join("\n\n");
    }
    case "cta": {
      const media =
        typeof props.media_id === "string" ? image(props.media_id, title, null, context) : "";
      const primary = props.primary_action
        ? await action(props.primary_action, context, localized(context, "Подробнее", "Learn more"))
        : "";
      const secondary = props.secondary_action
        ? await action(
            props.secondary_action,
            context,
            localized(context, "Подробнее", "Learn more"),
          )
        : "";
      return [
        title ? `## ${title}` : "",
        media,
        props.text ? richText(props.text, context) : "",
        primary,
        secondary,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    case "video":
      return video(props, context);
    case "audio": {
      const href = publicMedia(props.media_id, context);
      const label =
        typeof props.title === "string"
          ? inline(props.title)
          : localized(context, "Аудио", "Audio");
      return `[${label}](${href})${typeof props.caption === "string" ? `\n\n${paragraph(props.caption)}` : ""}`;
    }
    case "calculator": {
      const language = context.locale?.toLowerCase().startsWith("ru") ? "ru" : "en";
      const inputs = Array.isArray(props.inputs)
        ? props.inputs.map((input) => inline((input as Record<string, unknown>).label))
        : [];
      const outputs = Array.isArray(props.outputs)
        ? props.outputs.map((output) => inline((output as Record<string, unknown>).label))
        : [];
      const detail = [...inputs, ...outputs].filter(Boolean).join(", ");
      const label = title || (language === "ru" ? "Калькулятор" : "Calculator");
      const link =
        language === "ru" ? "Открыть интерактивную версию" : "Open the interactive version";
      return `**${label}**${detail ? ` — ${detail}` : ""}. [${link}](${safeUrl(context.htmlUrl)})`;
    }
    case "quiz": {
      const language = context.locale?.toLowerCase().startsWith("ru") ? "ru" : "en";
      const definitionId = String(props.quiz_definition_id ?? "");
      const rawLabel =
        context.quizTitles?.[definitionId] || (language === "ru" ? "Викторина" : "Quiz");
      const label = inline(rawLabel);
      const link =
        language === "ru" ? "Открыть интерактивную версию" : "Open the interactive version";
      return `**${label}**. [${link}](${safeUrl(context.htmlUrl)})`;
    }
    case "map": {
      if (!Array.isArray(props.markers))
        throw new MarkdownRenderError("map markers are malformed", type);
      const center = props.center as Record<string, unknown> | undefined;
      const heading = center
        ? `${localized(context, "Карта", "Map")}, ${localized(context, "центр", "center")}: ${String(center.lat)}, ${String(center.lon)}.`
        : "";
      const markers = await Promise.all(
        (props.markers as Record<string, unknown>[]).map(async (marker) => {
          const place = [
            typeof marker.address === "string" ? inline(marker.address) : "",
            typeof marker.lat === "number" && typeof marker.lon === "number"
              ? `(${marker.lat}, ${marker.lon})`
              : "",
          ]
            .filter(Boolean)
            .join(" — ");
          const media =
            typeof marker.media_id === "string"
              ? `\n\n${image(marker.media_id, marker.title, null, context)}`
              : "";
          const description =
            typeof marker.description === "string"
              ? `\n  ${paragraph(marker.description).replace(/\n/g, "\n  ")}`
              : "";
          const link = marker.link
            ? `\n\n${await action(marker.link, context, localized(context, "Подробнее", "Learn more"))}`
            : "";
          return `- **${inline(marker.title)}**${place}${media}${description}${link}`;
        }),
      );
      return `${heading}${heading ? "\n\n" : ""}${markers.join("\n")}`;
    }
    case "timeline": {
      if (!Array.isArray(items))
        throw new MarkdownRenderError("timeline items are malformed", type);
      const rows = await Promise.all(
        (items as Record<string, unknown>[]).map(async (row) => {
          const dateText = typeof row.date_text === "string" ? inline(row.date_text) : "";
          const date =
            dateText && typeof row.date === "string" && dateText !== row.date
              ? `${dateText} (${inline(row.date)})`
              : dateText || inline(typeof row.date === "string" ? row.date : "");
          const media =
            typeof row.media_id === "string"
              ? `\n  ${image(row.media_id, row.title, null, context)}`
              : "";
          const text =
            row.text === undefined
              ? ""
              : `\n  ${richText(row.text, context).replace(/\n/g, "\n  ")}`;
          const link = row.action
            ? `\n  ${await action(row.action, context, localized(context, "Подробнее", "Learn more"))}`
            : "";
          return `- **${date} ${inline(row.title)}**${media}${text}${link}`;
        }),
      );
      return `${title ? `## ${title}\n\n` : ""}${rows.join("\n")}`;
    }
    case "documents": {
      if (!Array.isArray(items))
        throw new MarkdownRenderError("document items are malformed", type);
      const rows = (items as Record<string, unknown>[]).map((row) => {
        const href = publicMedia(row.media_id, context);
        const label =
          typeof row.action_label === "string"
            ? row.action_label
            : typeof row.display_title === "string"
              ? row.display_title
              : localized(context, "Документ", "Document");
        const description =
          typeof row.description === "string"
            ? `\n  ${paragraph(row.description).replace(/\n/g, "\n  ")}`
            : "";
        return `- [${inline(label)}](${href})${description}${typeof row.version_label === "string" ? ` (${inline(row.version_label)})` : ""}`;
      });
      return `${title ? `## ${title}\n\n` : ""}${rows.join("\n")}`;
    }
    case "related_content": {
      const cards = context.relatedCards?.[String(node.id)] ?? [];
      const output = cards.map((card) => {
        if (typeof card.href !== "string" || typeof card.title !== "string")
          throw new MarkdownRenderError("related content card is malformed", type);
        const description =
          typeof card.description === "string"
            ? `\n  ${paragraph(card.description).replace(/\n/g, "\n  ")}`
            : "";
        const date = typeof card.date === "string" ? ` (${inline(card.date)})` : "";
        const tags =
          Array.isArray(card.tags) && card.tags.length > 0
            ? `\n  ${card.tags.map(inline).join(", ")}`
            : "";
        const media =
          typeof card.image === "string" && card.image !== ""
            ? `\n\n  ![${inline(card.image_alt ?? "")}](${safeUrl(card.image)})`
            : "";
        return `- [${inline(card.title)}](${safeUrl(card.href)})${date}${description}${tags}${media}`;
      });
      return `${title ? `## ${title}\n\n` : ""}${output.join("\n")}`;
    }
    case "form":
      return "";
    default:
      throw new MarkdownRenderError(
        `no Markdown serializer for block ${type}@${String(node.schemaVersion)}`,
        type,
      );
  }
}

export async function renderMarkdownBlocks(
  blocks: readonly Record<string, unknown>[],
  context: MarkdownRenderContext,
): Promise<string> {
  return (await Promise.all(blocks.map((block) => renderBlock(block, context))))
    .filter(Boolean)
    .join("\n\n");
}

export function renderMarkdownRichText(value: unknown, context: MarkdownRenderContext): string {
  return richText(value, context);
}

/** Fields whose public meaning is part of the shipped reference Content Types. */
export function renderMarkdownSemanticFields(
  contentTypeKey: string,
  fields: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, FieldSchema>>,
  context: MarkdownRenderContext,
  locale: string,
  contentTypeVersion: number,
): string {
  if (contentTypeVersion !== 1) return "";
  const language = locale.toLowerCase().startsWith("ru") ? "ru" : "en";
  const labels =
    language === "ru"
      ? {
          client: "Клиент",
          completed: "Завершён",
          author: "Автор",
          published: "Опубликовано",
          teaser: "Краткое содержание",
          price: "Цена",
          features: "Состав",
          tags: "Теги",
        }
      : {
          client: "Client",
          completed: "Completed",
          author: "Author",
          published: "Published",
          teaser: "Teaser",
          price: "Price",
          features: "Included",
          tags: "Tags",
        };
  const output: string[] = [];
  const read = (key: string, expectedType: string): unknown => {
    const field = schema[key];
    if (field === undefined) return undefined;
    if (field.type !== expectedType)
      throw new MarkdownRenderError(`public field ${key} has an unexpected type`, key);
    return fields[key];
  };
  const textField = (key: string, expectedType: string, label: keyof typeof labels): void => {
    const value = read(key, expectedType);
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string")
      throw new MarkdownRenderError(`public field ${key} is malformed`, key);
    output.push(`**${labels[label]}:** ${inline(value)}`);
  };

  if (contentTypeKey === "case") {
    textField("client", "string", "client");
    textField("completed_on", "date", "completed");
    const hero = read("hero_image", "media");
    if (hero !== undefined && hero !== null && hero !== "")
      output.push(image(hero, null, null, context));
    const gallery = read("gallery", "media_list");
    if (gallery !== undefined && gallery !== null) {
      if (!Array.isArray(gallery)) throw new MarkdownRenderError("public gallery is malformed");
      output.push(...gallery.map((id) => image(id, null, null, context)));
    }
  } else if (contentTypeKey === "article") {
    textField("author", "string", "author");
    const tags = read("tags", "list");
    if (tags !== undefined && tags !== null) {
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
        throw new MarkdownRenderError("public article tags are malformed");
      if (tags.length > 0)
        output.push(`**${labels.tags}:** ${(tags as string[]).map(inline).join(", ")}`);
    }
  } else if (contentTypeKey === "news") {
    const teaser = read("teaser", "text");
    if (teaser !== undefined && teaser !== null && teaser !== "") {
      if (typeof teaser !== "string")
        throw new MarkdownRenderError("public news teaser is malformed", "teaser");
      output.push(`**${labels.teaser}:**\n\n${paragraph(teaser)}`);
    }
    textField("published_at", "datetime", "published");
  } else if (contentTypeKey === "service") {
    const price = read("price", "money");
    if (price !== undefined && price !== null) {
      if (
        typeof price !== "object" ||
        typeof (price as Record<string, unknown>).amount !== "string" ||
        typeof (price as Record<string, unknown>).currency !== "string"
      )
        throw new MarkdownRenderError("public service price is malformed");
      output.push(
        `**${labels.price}:** ${inline((price as Record<string, string>).amount)} ${inline((price as Record<string, string>).currency)}`,
      );
    }
    const features = read("features", "repeater");
    if (features !== undefined && features !== null) {
      if (!Array.isArray(features))
        throw new MarkdownRenderError("public service features are malformed");
      const lines = features.map((feature) => {
        if (typeof feature !== "object" || feature === null)
          throw new MarkdownRenderError("public service feature is malformed");
        const row = feature as Record<string, unknown>;
        const title = row.feature_title;
        const description = row.feature_text;
        if (title !== undefined && title !== null && typeof title !== "string")
          throw new MarkdownRenderError("public service feature title is malformed");
        if (description !== undefined && description !== null && typeof description !== "string")
          throw new MarkdownRenderError("public service feature text is malformed");
        const label = typeof title === "string" && title !== "" ? `**${inline(title)}**` : "";
        const text =
          typeof description === "string" ? paragraph(description).replace(/\n/g, "\n  ") : "";
        if (!label && !text) return "";
        return `- ${label}${label && text ? ` — ${text}` : text}`;
      });
      const nonempty = lines.filter(Boolean);
      if (nonempty.length > 0) output.push(`**${labels.features}:**\n\n${nonempty.join("\n")}`);
    }
  }
  return output.join("\n\n");
}
