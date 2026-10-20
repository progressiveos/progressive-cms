// X/Twitter Card compatibility projection (PCMS-SEO-T008; SEO spec §26).
// Compatibility output of the one social semantic model — no second editor
// data set, no divergence from OG by construction. Default card:
// summary_large_image when a suitably large social image exists, else summary.
import type { ResolvedSeoMetadata } from "./fallback.js";
import type { SocialImageViewModel } from "./social.js";

/** Minimum dimensions for the large-card default (conservative baseline). */
export const LARGE_IMAGE_MIN = { width: 600, height: 300 } as const;

export interface TwitterCardMetaInput {
  readonly resolved: ResolvedSeoMetadata;
  readonly socialImage: SocialImageViewModel | null;
}

/** Deterministic twitter:* projection (name-attribute meta tags). */
export function buildTwitterCardMeta(
  input: TwitterCardMetaInput,
): { name: string; content: string }[] {
  const tags: { name: string; content: string }[] = [];
  const image = input.socialImage;
  const large =
    image != null &&
    image.width != null &&
    image.height != null &&
    image.width >= LARGE_IMAGE_MIN.width &&
    image.height >= LARGE_IMAGE_MIN.height;
  tags.push({ name: "twitter:card", content: large ? "summary_large_image" : "summary" });

  const title = input.resolved.social_title.value ?? input.resolved.title.value;
  if (title != null) tags.push({ name: "twitter:title", content: title });
  const description = input.resolved.social_description.value ?? input.resolved.description.value;
  if (description != null) tags.push({ name: "twitter:description", content: description });
  if (image != null) {
    tags.push({ name: "twitter:image", content: image.url });
    if (image.alt != null) tags.push({ name: "twitter:image:alt", content: image.alt });
  }
  return tags;
}
