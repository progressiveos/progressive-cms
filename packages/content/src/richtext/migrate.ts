// RichText runtime utilities (v2 only).
//
// Media discovery walks a validated document and returns the referenced
// MediaAsset ids. It is used by the revision snapshot, the media usage graph
// and the public Web composition, all of which store/compare v2 documents —
// validation here is the same `validateRichText` the write path uses, so a
// legacy document fails loudly rather than being silently walked.
//
// The v1 → v2 conversion lives in `tools/migrations/richtext-v1-to-v2/` and is
// an offline operator step, never part of this package.
import { ContentError } from "../errors.js";
import { validateRichText } from "./ast.js";
import type { RichTextNode } from "./markdown.js";

/** Validated discovery is shared by revision snapshots and application composition. */
export function collectRichTextMediaIds(document: unknown): string[] {
  const result = validateRichText(document);
  if (!result.ok)
    throw new ContentError("RICHTEXT_INVALID", "Cannot inspect invalid RichText", {
      details: result.issues,
    });
  const ids = new Set<string>();
  const walk = (node: RichTextNode): void => {
    if (node.type === "image" && typeof node.media_id === "string") ids.add(node.media_id);
    if (Array.isArray(node.content)) for (const child of node.content) walk(child as RichTextNode);
    if (Array.isArray(node.caption)) for (const child of node.caption) walk(child as RichTextNode);
  };
  walk(document as RichTextNode);
  return [...ids];
}
