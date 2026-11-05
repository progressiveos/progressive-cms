import type { ApplicationServices } from "@pcms/api";
import { validateBlockDocument } from "@pcms/blocks";
import { preparePublishedMarkdown } from "./markdown-projections.js";
import type { MarkdownRenderContext } from "./markdown-render.js";

/** Lightweight seam for callers that already prepared public dependencies. */
export async function assessPublishedMarkdown(
  application: ApplicationServices,
  input: {
    readonly contentTypeId: string;
    readonly payload: unknown;
    readonly locale: string;
    readonly path: string;
    readonly paired: boolean;
    readonly context?: MarkdownRenderContext;
  },
): Promise<string | null> {
  const type = application.contentTypes.getLatestContentType(input.contentTypeId);
  if (!type) return "unknown_content_type";
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload))
    return "invalid_payload";
  const payload = input.payload as { fields?: unknown; blocks?: unknown };
  if (!payload.fields || typeof payload.fields !== "object" || Array.isArray(payload.fields))
    return "invalid_fields";
  if (
    (type.bodyPolicy === "block_document" || payload.blocks != null) &&
    !validateBlockDocument(payload.blocks, application.blocks).ok
  )
    return "invalid_blocks";
  try {
    const projection = await preparePublishedMarkdown(application, {
      ...input,
      siteTitle: "",
      context: input.context ?? {
        htmlUrl: input.path,
        locale: input.locale,
        mediaUrl: () => null,
        actionUrl: async () => null,
      },
    });
    return projection.hasContent ? null : "empty_content";
  } catch {
    return "unproven_projection";
  }
}
