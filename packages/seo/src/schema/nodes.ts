// JSON-LD node builders (PCMS-SEO-T011; SEO spec §21/§31/§33/§40/§41).
// Builders turn typed facts into plain schema.org nodes with stable @id.
// Truthfulness rule (§32): only supplied facts are emitted — builders map,
// they never invent. URLs must be absolute http(s) (crawlable), otherwise
// the builder throws SEO_STRUCTURED_DATA_INVALID.
import { SeoError } from "../errors.js";
import type {
  ArticleFacts,
  BreadcrumbFacts,
  OrganizationFacts,
  PostalAddressFacts,
  VideoFacts,
  WebPageFacts,
  WebSiteFacts,
} from "./facts.js";

export type JsonLdNode = Record<string, unknown> & { readonly "@type": string | readonly string[] };

function assertAbsoluteUrl(
  value: string | null | undefined,
  field: string,
  nodeId: string,
): string | null {
  if (value == null) return null;
  if (!/^https:\/\//i.test(value) && !/^http:\/\//i.test(value)) {
    throw new SeoError("SEO_STRUCTURED_DATA_INVALID", `${field} must be an absolute http(s) URL`, {
      details: { node: nodeId, field, value },
    });
  }
  return value;
}

function addressNode(
  address: PostalAddressFacts | null | undefined,
): Record<string, unknown> | null {
  if (address == null) return null;
  const node: Record<string, unknown> = { "@type": "PostalAddress" };
  if (address.street_address != null) node.streetAddress = address.street_address;
  if (address.locality != null) node.addressLocality = address.locality;
  if (address.region != null) node.addressRegion = address.region;
  if (address.postal_code != null) node.postalCode = address.postal_code;
  if (address.country != null) node.addressCountry = address.country;
  return Object.keys(node).length > 1 ? node : null;
}

/** WebSite (§21): emitted on the homepage with name/alternateName/url. */
export function buildWebSiteNode(facts: WebSiteFacts): JsonLdNode {
  assertAbsoluteUrl(facts.url, "url", facts.id);
  return {
    "@type": "WebSite",
    "@id": facts.id,
    name: facts.name,
    ...(facts.alternate_name != null ? { alternateName: facts.alternate_name } : {}),
    url: facts.url,
  };
}

/**
 * Organization (§33): only actual supplied data. When explicit
 * LocalBusiness facts are present the type becomes LocalBusiness (+subtype);
 * selection is never automatic (§34).
 */
export function buildOrganizationNode(facts: OrganizationFacts): JsonLdNode {
  assertAbsoluteUrl(facts.url ?? null, "url", facts.id);
  const lb = facts.local_business;
  const type = lb != null ? "LocalBusiness" : "Organization";
  const node: JsonLdNode = {
    "@type": lb?.subtype != null ? ["LocalBusiness", lb.subtype] : type,
    "@id": facts.id,
    name: facts.name,
    ...(facts.legal_name != null ? { legalName: facts.legal_name } : {}),
    ...(facts.alternate_name != null ? { alternateName: facts.alternate_name } : {}),
    ...(facts.url != null ? { url: facts.url } : {}),
    ...(assertAbsoluteUrl(facts.logo ?? null, "logo", facts.id) != null
      ? { logo: facts.logo }
      : {}),
    ...(facts.telephone != null ? { telephone: facts.telephone } : {}),
    ...(facts.email != null ? { email: facts.email } : {}),
    ...(addressNode(facts.address) != null ? { address: addressNode(facts.address) } : {}),
    ...(facts.same_as != null && facts.same_as.length > 0
      ? { sameAs: facts.same_as.map((u) => assertAbsoluteUrl(u, "sameAs", facts.id)) }
      : {}),
  };
  if (lb != null) {
    if (lb.telephone != null) node.telephone = lb.telephone;
    if (lb.opening_hours != null) node.openingHours = lb.opening_hours;
    if (lb.price_range != null) node.priceRange = lb.price_range;
    if (lb.geo != null) {
      node.geo = {
        "@type": "GeoCoordinates",
        latitude: lb.geo.latitude,
        longitude: lb.geo.longitude,
      };
    }
  }
  return node;
}

/** WebPage (§40): the contextual page node tying a graph together. */
export function buildWebPageNode(facts: WebPageFacts): JsonLdNode {
  assertAbsoluteUrl(facts.url, "url", facts.id);
  assertAbsoluteUrl(facts.primary_image_url ?? null, "primary_image_url", facts.id);
  return {
    "@type": "WebPage",
    "@id": facts.id,
    name: facts.name,
    url: facts.url,
    ...(facts.is_part_of != null ? { isPartOf: { "@id": facts.is_part_of } } : {}),
    ...(facts.in_language != null ? { inLanguage: facts.in_language } : {}),
    ...(facts.primary_image_url != null ? { primaryImageOfPage: facts.primary_image_url } : {}),
    ...(facts.breadcrumb != null ? { breadcrumb: { "@id": facts.breadcrumb } } : {}),
  };
}

const SCHEMA_TYPE_BY_ARTICLE: Record<string, string> = {
  article: "Article",
  news_article: "NewsArticle",
  blog_posting: "BlogPosting",
};

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Article family (§35): dates must be public publication facts (Publication
 * subsystem), authors only when explicitly named, images only when the Media
 * provider actually provides them (§36/§37).
 */
export function buildArticleNode(facts: ArticleFacts): JsonLdNode {
  assertAbsoluteUrl(facts.url, "url", facts.id);
  const schemaType = SCHEMA_TYPE_BY_ARTICLE[facts.type];
  if (schemaType === undefined) {
    throw new SeoError("SEO_STRUCTURED_DATA_INVALID", `unknown article type: ${facts.type}`, {
      details: { node: facts.id, field: "type" },
    });
  }
  for (const [field, value] of [
    ["date_published", facts.date_published],
    ["date_modified", facts.date_modified],
  ] as const) {
    if (value != null && !ISO_8601_RE.test(value)) {
      throw new SeoError("SEO_STRUCTURED_DATA_INVALID", `${field} must be an ISO 8601 date`, {
        details: { node: facts.id, field, value },
      });
    }
  }
  const images = (facts.image_urls ?? []).map((u) => assertAbsoluteUrl(u, "image_urls", facts.id));
  return {
    "@type": schemaType,
    "@id": facts.id,
    headline: facts.headline,
    url: facts.url,
    ...(facts.description != null ? { description: facts.description } : {}),
    ...(facts.date_published != null ? { datePublished: facts.date_published } : {}),
    ...(facts.date_modified != null ? { dateModified: facts.date_modified } : {}),
    ...(facts.author != null
      ? {
          author: {
            "@type": "Person",
            name: facts.author.name,
            ...(facts.author.url != null
              ? { url: assertAbsoluteUrl(facts.author.url, "author.url", facts.id) }
              : {}),
          },
        }
      : {}),
    ...(facts.publisher != null
      ? {
          publisher: {
            "@type": "Organization",
            "@id": facts.publisher.id,
            name: facts.publisher.name,
            ...(assertAbsoluteUrl(facts.publisher.logo ?? null, "publisher.logo", facts.id) != null
              ? { logo: facts.publisher.logo }
              : {}),
          },
        }
      : {}),
    ...(images.length > 0 ? { image: images } : {}),
    ...(facts.is_part_of != null ? { isPartOf: { "@id": facts.is_part_of } } : {}),
    ...(facts.in_language != null ? { inLanguage: facts.in_language } : {}),
  };
}

/**
 * BreadcrumbList (§38): positions are 1-based in trail order; the current
 * item may omit its url (item/url "where appropriate").
 */
export function buildBreadcrumbNode(facts: BreadcrumbFacts): JsonLdNode {
  if (facts.items.length === 0) {
    throw new SeoError("SEO_STRUCTURED_DATA_INVALID", "breadcrumb trail must not be empty", {
      details: { node: facts.id, field: "items" },
    });
  }
  return {
    "@type": "BreadcrumbList",
    "@id": facts.id,
    itemListElement: facts.items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      ...(item.url != null ? { item: assertAbsoluteUrl(item.url, "items[].url", facts.id) } : {}),
    })),
  };
}

const ISO_DURATION_RE =
  /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

/**
 * VideoObject (§39): name plus exactly the provider facts that exist. A
 * custom provider without thumbnails/dates produces a truthful minimal node.
 */
export function buildVideoNode(facts: VideoFacts): JsonLdNode {
  const thumb = assertAbsoluteUrl(facts.thumbnail_url ?? null, "thumbnail_url", facts.id);
  const embed = assertAbsoluteUrl(facts.embed_url ?? null, "embed_url", facts.id);
  const content = assertAbsoluteUrl(facts.content_url ?? null, "content_url", facts.id);
  if (facts.upload_date != null && !ISO_8601_RE.test(facts.upload_date)) {
    throw new SeoError("SEO_STRUCTURED_DATA_INVALID", "upload_date must be an ISO 8601 date", {
      details: { node: facts.id, field: "upload_date", value: facts.upload_date },
    });
  }
  if (facts.duration != null && !ISO_DURATION_RE.test(facts.duration)) {
    throw new SeoError("SEO_STRUCTURED_DATA_INVALID", "duration must be an ISO 8601 duration", {
      details: { node: facts.id, field: "duration", value: facts.duration },
    });
  }
  return {
    "@type": "VideoObject",
    "@id": facts.id,
    name: facts.name,
    ...(facts.description != null ? { description: facts.description } : {}),
    ...(thumb != null ? { thumbnailUrl: thumb } : {}),
    ...(facts.upload_date != null ? { uploadDate: facts.upload_date } : {}),
    ...(facts.duration != null ? { duration: facts.duration } : {}),
    ...(embed != null ? { embedUrl: embed } : {}),
    ...(content != null ? { contentUrl: content } : {}),
  };
}

/**
 * Internal structural validation (§46): required-by-adapter properties and
 * absolute crawlable @id/url values. Returns issue descriptions rather than
 * throwing — the validation service (T022) aggregates them.
 */
export function validateGraphNode(node: JsonLdNode): readonly string[] {
  const issues: string[] = [];
  if (typeof node["@type"] !== "string" && !Array.isArray(node["@type"])) {
    issues.push("missing @type");
  }
  for (const key of ["@id", "url"] as const) {
    const value = node[key];
    if (value != null && typeof value === "string" && !/^(https?:\/\/|_)/.test(value)) {
      issues.push(`${key} must be an absolute http(s) URL`);
    }
  }
  if (node["@type"] === "WebSite" && typeof node.name !== "string")
    issues.push("WebSite requires name");
  if (node["@type"] === "Organization" && typeof node.name !== "string")
    issues.push("Organization requires name");
  if (node["@type"] === "WebPage" && typeof node.name !== "string")
    issues.push("WebPage requires name");
  return issues;
}
