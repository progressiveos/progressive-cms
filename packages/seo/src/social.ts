// Open Graph projection + social image contract (PCMS-SEO-T007; SEO spec
// §16–§17 of the task brief, §23–§28 of the spec). One social semantic model
// is resolved first (fallback resolver + media port); OG is a projection of
// it — never a second data source. Image alt stays accessibility semantics;
// the social description never overrides it (Media alt resolution, M05).
import type { ResolvedSeoMetadata } from "./fallback.js";

/**
 * Resolved social image. The URL/width/height/type come from the Media
 * subsystem's provider result (versioned, fingerprinted public URL) — SEO
 * never computes `/uploads/...`-style URLs itself.
 */
export interface SocialImageViewModel {
  readonly asset_id: string;
  /** Resolved version number (the M07 pinning seam resolves to a version). */
  readonly version: number | null;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly mime_type: string | null;
  /** Media alt semantics — never replaced by the social description. */
  readonly alt: string | null;
}

/**
 * Social image port backed by the Media subsystem at composition: resolves
 * a media reference (asset id + optional pinned version) to the social
 * preset derivative. Null when the asset/version cannot be resolved.
 */
export interface SeoSocialImagePort {
  readonly resolveSocialImage: (ref: {
    readonly asset_id: string;
    readonly version?: number;
  }) => Promise<SocialImageViewModel | null>;
}

/** OG type mapping (spec §25) lives here, not in the Theme. */
export function resolveOgType(input: {
  readonly structuredDataHint?: string | null;
  readonly contentTypeKey?: string | null;
  readonly articleContentTypes?: readonly string[];
}): "website" | "article" {
  if (
    input.structuredDataHint === "article" ||
    input.structuredDataHint === "news_article" ||
    input.structuredDataHint === "blog_posting"
  ) {
    return "article";
  }
  const key = input.contentTypeKey;
  if (key != null && (input.articleContentTypes ?? []).includes(key)) return "article";
  return "website";
}

const ABSOLUTE_URL_RE = /^https?:\/\//i;

export interface OpenGraphMetaInput {
  readonly resolved: ResolvedSeoMetadata;
  readonly canonicalUrl: string | null;
  readonly ogType: "website" | "article";
  readonly siteName: string | null;
  readonly locale: string | null;
  readonly socialImage: SocialImageViewModel | null;
}

/**
 * Baseline OG output (spec §23): og:title, og:type, og:image, og:url are the
 * required protocol baseline "where applicable" (image only when a social
 * image resolved; url only when a canonical exists), plus description,
 * site_name, locale. Image metadata (§24) only for facts the Media provider
 * actually supplied. Deterministic order.
 */
export function buildOpenGraphMeta(
  input: OpenGraphMetaInput,
): { property: string; content: string }[] {
  const tags: { property: string; content: string }[] = [];
  const title = input.resolved.social_title.value ?? input.resolved.title.value;
  if (title != null) tags.push({ property: "og:title", content: title });
  tags.push({ property: "og:type", content: input.ogType });
  if (input.canonicalUrl != null) tags.push({ property: "og:url", content: input.canonicalUrl });

  const image = input.socialImage;
  if (image != null) {
    tags.push({ property: "og:image", content: image.url });
    if (image.url.startsWith("https://")) {
      tags.push({ property: "og:image:secure_url", content: image.url });
    }
    if (image.mime_type != null) tags.push({ property: "og:image:type", content: image.mime_type });
    if (image.width != null)
      tags.push({ property: "og:image:width", content: String(image.width) });
    if (image.height != null)
      tags.push({ property: "og:image:height", content: String(image.height) });
    if (image.alt != null) tags.push({ property: "og:image:alt", content: image.alt });
  }

  const description = input.resolved.social_description.value ?? input.resolved.description.value;
  if (description != null) tags.push({ property: "og:description", content: description });
  if (input.siteName != null) tags.push({ property: "og:site_name", content: input.siteName });
  if (input.locale != null) tags.push({ property: "og:locale", content: input.locale });
  return tags;
}

/** True when the image URL is a crawlable absolute http(s) URL. */
export function isAbsoluteHttpUrl(value: string): boolean {
  return ABSOLUTE_URL_RE.test(value);
}
