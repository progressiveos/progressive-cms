// Structured-data facts input (PCMS-SEO-T011+; SEO spec §30–§42).
// Normalized, typed facts flow in from Site Identity / Content / Routing /
// Media through composition. The registry turns facts into JSON-LD nodes —
// arbitrary user JSON is never rendered (spec §70).
import type { SeoMediaRef } from "../document.js";

export interface PostalAddressFacts {
  readonly street_address?: string | null;
  readonly locality?: string | null;
  readonly region?: string | null;
  readonly postal_code?: string | null;
  readonly country?: string | null;
}

export interface WebSiteFacts {
  /** Stable absolute @id, e.g. "https://example.ru/#website". */
  readonly id: string;
  readonly name: string;
  readonly alternate_name?: string | null;
  /** Site origin URL from the routing domain binding. */
  readonly url: string;
}

export interface OrganizationFacts {
  /** Stable absolute @id, e.g. "https://example.ru/#organization". */
  readonly id: string;
  readonly name: string;
  readonly legal_name?: string | null;
  readonly alternate_name?: string | null;
  readonly url?: string | null;
  /** Absolute logo URL (Media provider result). */
  readonly logo?: string | null;
  readonly telephone?: string | null;
  readonly email?: string | null;
  readonly address?: PostalAddressFacts | null;
  /** sameAs profiles — validated absolute http(s) URLs only. */
  readonly same_as?: readonly string[] | null;
  readonly local_business?: LocalBusinessFacts | null;
}

/** LocalBusiness selection is always explicit (spec §34) — never inferred. */
export interface LocalBusinessFacts {
  /** schema.org subtype name, e.g. "ProfessionalService". */
  readonly subtype?: string | null;
  readonly telephone?: string | null;
  readonly opening_hours?: string | null;
  readonly price_range?: string | null;
  readonly geo?: { readonly latitude: number; readonly longitude: number } | null;
  readonly image?: SeoMediaRef | null;
}

/** Author is Person only when explicitly named (spec §37) — never invented. */
export interface ArticleAuthorFacts {
  readonly name: string;
  readonly url?: string | null;
}

export interface ArticlePublisherFacts {
  readonly id: string;
  readonly name: string;
  readonly logo?: string | null;
}

export type ArticleSchemaType = "article" | "news_article" | "blog_posting";

export interface ArticleFacts {
  /** Stable absolute @id, e.g. "https://example.ru/news/x/#article". */
  readonly id: string;
  /** Article | NewsArticle | BlogPosting (spec §35). */
  readonly type: ArticleSchemaType;
  readonly headline: string;
  readonly url: string;
  /** Public publication facts from the Publication subsystem (spec §35/§55) — ISO 8601. */
  readonly date_published: string | null;
  readonly date_modified: string | null;
  /** Explicitly named author, or null — no anonymous person is invented. */
  readonly author: ArticleAuthorFacts | null;
  /** Absolute image URLs from the Media provider (spec §36). */
  readonly image_urls?: readonly string[];
  readonly publisher: ArticlePublisherFacts | null;
  readonly description?: string | null;
  readonly is_part_of?: string | null;
  readonly in_language?: string | null;
}

/**
 * Normalized breadcrumb trail (spec §38): composition resolves it from the
 * Navigation/Routing breadcrumb strategy — SEO never guesses a trail from
 * menus or parent URLs; a missing strategy simply produces no node.
 */
export interface BreadcrumbFacts {
  /** Stable absolute @id, e.g. "https://example.ru/services/#breadcrumb". */
  readonly id: string;
  /** Position order; the last (current) item may omit its url. */
  readonly items: readonly {
    readonly name: string;
    readonly url: string | null;
  }[];
}

/**
 * Video facts (spec §39): supplied by the Video Block/provider through
 * composition. Only genuinely available provider metadata is emitted —
 * nothing is invented or guessed from URLs.
 */
export interface VideoFacts {
  /** Stable absolute @id, e.g. "https://example.ru/video/x/#video". */
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  /** Absolute thumbnail URL (Media provider result). */
  readonly thumbnail_url?: string | null;
  /** ISO 8601 instant, only when actually known. */
  readonly upload_date?: string | null;
  /** ISO 8601 duration (e.g. "PT1M30S"), only when actually known. */
  readonly duration?: string | null;
  readonly embed_url?: string | null;
  readonly content_url?: string | null;
}

export interface WebPageFacts {
  /** Stable absolute @id, e.g. "https://example.ru/foo/#webpage". */
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** @id of the site's WebSite node when part of the same graph. */
  readonly is_part_of?: string | null;
  readonly in_language?: string | null;
  /** Absolute URL of the page's primary social/hero image. */
  readonly primary_image_url?: string | null;
  /** @id of the page's BreadcrumbList node when present. */
  readonly breadcrumb?: string | null;
}
