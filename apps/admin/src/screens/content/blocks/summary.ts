import type { BlockNodeWire } from "../../../api/blocks.js";
import { t } from "../../../i18n/index.js";

/** Flattens a RichText AST to plain text for block summaries. */
function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join(" ");
  if (typeof value === "object" && value !== null) {
    const node = value as { text?: unknown; content?: unknown };
    if (typeof node.text === "string") return node.text;
    return extractText(node.content ?? "");
  }
  return "";
}

export function summaryOf(block: BlockNodeWire): string {
  for (const key of [
    "text",
    "title",
    "question",
    "code",
    "formula",
    "body",
    "rich_text",
    "caption",
  ]) {
    const value = block.props[key];
    if (typeof value === "string" && value.trim() !== "") {
      const plain = value.replace(/[*`>#[\]()]/g, "").trim();
      if (plain !== "") return plain.slice(0, 60);
    }
    if (typeof value === "object" && value !== null) {
      const text = extractText(value).trim();
      if (text !== "") return text.slice(0, 60);
    }
  }
  if (typeof block.props["media_id"] === "string" && block.props["media_id"].trim())
    return t("blocks.summary_media");
  const items = block.props["items"];
  if (Array.isArray(items) && items.length > 0)
    return t("blocks.summary_items", { n: items.length });
  return t("blocks.summary_empty");
}
