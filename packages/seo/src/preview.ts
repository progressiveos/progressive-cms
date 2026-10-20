// SEO/social/schema preview services (PCMS-SEO-T023; SEO spec §59/§60/§8/§27).
// Deterministic machine-readable previews: Admin (M10) and agents see the
// resolved values, their provenance and the JSON-LD without parsing HTML.
// A preview is an estimate, never a promise of a specific search snippet.
import { type CanonicalProvenance, resolveCanonical } from "./canonical.js";
import type { SeoDiagnostic } from "./diagnostics.js";
import type { SeoDocument } from "./document.js";
import { applyEnvironmentGuard, type SeoEnvironment } from "./environment.js";
import type { SemanticPageFacts } from "./fallback.js";
import { type ResolvedSeoMetadata, resolveSeoMetadata } from "./fallback.js";
import type { FaviconViewModel, SeoFaviconPort } from "./favicon.js";
import { buildFaviconIcons } from "./favicon.js";
import { buildSeoHeadModel, type SeoHeadViewModel } from "./head-model.js";
import { renderRobotsMeta } from "./robots-meta.js";
import {
  type ComposedStructuredData,
  composeStructuredData,
  type StructuredDataPageInput,
} from "./schema/compose.js";
import type { ArticleFacts } from "./schema/facts.js";
import {
  type SeoSiteIdentity,
  selectOrganizationSchema,
  toSiteSeoDefaults,
} from "./site-identity.js";
import type { SeoSocialImagePort, SocialImageViewModel } from "./social.js";
import { validateSeoPage } from "./validate.js";

export interface SeoPreviewPorts {
  readonly socialImage: SeoSocialImagePort;
  readonly favicon: SeoFaviconPort | null;
}

export interface SeoPreviewRequest {
  readonly entryId: string;
  readonly document: SeoDocument | null;
  readonly facts: SemanticPageFacts;
  readonly identity: SeoSiteIdentity | null;
  /** Routing primary origin (never a request Host). */
  readonly origin: string | null;
  readonly routeCanonicalUrl: string | null;
  readonly environment: SeoEnvironment;
  /** Resolved locale context. */
  readonly locale?: string | null;
  readonly contentTypeKey?: string | null;
  /** Site Identity logo's generated public URL (§33), resolved upstream
   * through the logo port; null/absent → the Organization node omits it. */
  readonly logoUrl?: string | null;
  readonly openGraph?: boolean;
  readonly twitterCard?: boolean;
  readonly allowExternalCanonical?: boolean;
}

export interface SeoPreviewResult {
  readonly entryId: string;
  readonly resolved: ResolvedSeoMetadata;
  readonly social_image: SocialImageViewModel | null;
  readonly favicon: FaviconViewModel | null;
  readonly head: SeoHeadViewModel;
  readonly canonical: { readonly url: string | null; readonly source: CanonicalProvenance | null };
  readonly robots: string | null;
  readonly structured_data: ComposedStructuredData;
  readonly diagnostics: readonly SeoDiagnostic[];
  readonly counts: Readonly<Record<"error" | "warning" | "recommendation", number>>;
}

/**
 * Site graph facts derived deterministically from Site Identity (§21/§33):
 * WebSite mirrors the routing origin; the selection policy (§34) decides
 * Organization vs LocalBusiness. Page-level facts (webpage/article/…) are
 * composition knowledge — they arrive via the request, never guessed here.
 */
export function siteFactsFromIdentity(
  identity: SeoSiteIdentity | null,
  origin: string | null,
  logoUrl?: string | null,
): Pick<StructuredDataPageInput, "website" | "organization"> {
  if (identity == null || origin == null) return { website: null, organization: null };
  const clean = origin.replace(/\/$/, "");
  const selection = selectOrganizationSchema(identity);
  return {
    website: {
      id: `${clean}/#website`,
      name: identity.site_name,
      ...(identity.alternate_site_name != null
        ? { alternate_name: identity.alternate_site_name }
        : {}),
      url: clean,
    },
    organization: {
      id: `${clean}/#organization`,
      name: identity.site_name,
      ...(identity.legal_name != null ? { legal_name: identity.legal_name } : {}),
      ...(identity.alternate_site_name != null
        ? { alternate_name: identity.alternate_site_name }
        : {}),
      url: clean,
      // The logo rides the resolved generated representation (logo-v1), never
      // the source document URL (Media §33) and never a fabricated value.
      ...(logoUrl != null && logoUrl !== "" ? { logo: logoUrl } : {}),
      ...(identity.phone != null ? { telephone: identity.phone } : {}),
      ...(identity.email != null ? { email: identity.email } : {}),
      ...(identity.address != null ? { address: identity.address } : {}),
      ...(identity.social_profiles != null ? { same_as: identity.social_profiles } : {}),
      ...(selection.type === "LocalBusiness" && selection.local_business != null
        ? { local_business: selection.local_business }
        : {}),
    },
  };
}

/** preview_seo (§59): resolved values, provenance, projections, JSON-LD. */
export async function previewSeo(
  ports: SeoPreviewPorts,
  request: SeoPreviewRequest,
  pageFacts?: Partial<Omit<StructuredDataPageInput, "website" | "organization">>,
): Promise<SeoPreviewResult> {
  const siteDefaults = toSiteSeoDefaults(request.identity);
  const resolved = resolveSeoMetadata(request.document, request.facts, siteDefaults);

  // Social image follows the RESOLVED chain (explicit → hero → site default;
  // owner 2026-10-08): the site default reached resolved metadata but never
  // the preview/public OG tags — every surface now shares the one choice.
  const socialImage =
    resolved.social_image.value !== null
      ? await ports.socialImage.resolveSocialImage(resolved.social_image.value)
      : null;
  const faviconRef = request.identity?.favicon ?? null;
  const favicon =
    faviconRef != null && ports.favicon != null
      ? await ports.favicon.resolveFavicon(faviconRef)
      : null;

  const canonical = resolveCanonical(request.document, request.routeCanonicalUrl);
  // Article family (§31/§35): two native classifications reach the Article
  // renderer — the per-entry structured_data_type_hint (carries the schema
  // subtype) and the site-level article_content_types classification (plain
  // Article). Facts are only the truthful data resolved above — the registry
  // maps, it never invents (R21, 2026-10-03: the hint reached og:type but
  // never the JSON-LD graph, so article semantics never reached engines).
  const hint = request.document?.structured_data_type_hint ?? null;
  const typeFromHint =
    hint === "article" || hint === "news_article" || hint === "blog_posting" ? hint : null;
  const contentTypeKey = request.facts.content_type_key ?? null;
  const articleType =
    typeFromHint ??
    (contentTypeKey !== null &&
    (request.identity?.article_content_types ?? []).includes(contentTypeKey)
      ? "article"
      : null);
  const cleanOrigin = request.origin === null ? null : request.origin.replace(/\/$/, "");
  const article: ArticleFacts | null =
    articleType === null || canonical.url === null || resolved.title.value === null
      ? null
      : {
          id: `${canonical.url}#article`,
          type: articleType,
          headline: resolved.title.value,
          url: canonical.url,
          date_published: request.facts.published_at ?? null,
          date_modified: request.facts.modified_at ?? null,
          author: null,
          publisher:
            cleanOrigin === null || request.identity === null
              ? null
              : {
                  id: `${cleanOrigin}/#organization`,
                  name: request.identity.site_name,
                },
          ...(socialImage === null ? {} : { image_urls: [socialImage.url] }),
          description: resolved.description.value,
          is_part_of: `${canonical.url}#webpage`,
          in_language: request.locale ?? null,
        };
  const structured_data = composeStructuredData({
    ...siteFactsFromIdentity(request.identity, request.origin, request.logoUrl),
    webpage:
      canonical.url === null || resolved.title.value === null
        ? null
        : {
            id: `${canonical.url}#webpage`,
            name: resolved.title.value,
            url: canonical.url,
            in_language: request.locale ?? null,
          },
    article,
    breadcrumbs: null,
    video: null,
    ...pageFacts,
  });

  const { head } = buildSeoHeadModel({
    document: request.document,
    facts: request.facts,
    site: siteDefaults,
    routeCanonicalUrl: request.routeCanonicalUrl,
    ...(request.allowExternalCanonical === undefined
      ? {}
      : { allowExternalCanonical: request.allowExternalCanonical }),
    ...(request.openGraph === undefined ? {} : { openGraph: request.openGraph }),
    ...(request.twitterCard === undefined ? {} : { twitterCard: request.twitterCard }),
    locale: request.locale ?? null,
    contentTypeKey: request.contentTypeKey ?? contentTypeKey,
    ...(request.identity?.article_content_types === undefined
      ? {}
      : { articleContentTypes: request.identity.article_content_types }),
    socialImage,
    favicon,
    environment: request.environment,
  });

  const validation = validateSeoPage({
    entryId: request.entryId,
    document: request.document,
    facts: request.facts,
    site: siteDefaults,
    routeCanonicalUrl: request.routeCanonicalUrl,
    socialImage,
    favicon,
    faviconDeclared: request.identity?.favicon != null,
    environment: request.environment,
    structuredData: structured_data,
    ...(request.allowExternalCanonical === undefined
      ? {}
      : { allowExternalCanonical: request.allowExternalCanonical }),
  });

  return {
    entryId: request.entryId,
    resolved,
    social_image: socialImage,
    favicon,
    head: { ...head, json_ld: structured_data.json_ld, icons: buildFaviconIcons(favicon) },
    canonical,
    robots: renderRobotsMeta(
      applyEnvironmentGuard(request.document?.robots_policy ?? null, request.environment).policy,
    ),
    structured_data,
    diagnostics: validation.issues,
    counts: validation.counts,
  };
}

/** preview_structured_data (§60): JSON-LD + diagnostics before publication. */
export function previewStructuredData(facts: StructuredDataPageInput): ComposedStructuredData {
  return composeStructuredData(facts);
}
