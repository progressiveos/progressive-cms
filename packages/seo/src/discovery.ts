// Agent discovery hooks/scopes contract (PCMS-SEO-T027; SEO spec §61/§71).
// Machine-readable SEO surface for agents (M16) and the API/MCP transport
// (M09): every operation names its required scope, the SEO document schema
// is inspectable without reading sources, and a content agent can validate
// and preview before publish. Pure application layer — no transport.

import type { SeoCanonicalPort } from "./canonical.js";
import { validateCanonicalOverride } from "./canonical.js";
import type { SeoDiagnostic } from "./diagnostics.js";
import { SEO_DOCUMENT_KEYS, type SeoDocument, STRUCTURED_DATA_TYPE_HINTS } from "./document.js";
import {
  applyEnvironmentGuard,
  environmentAllowsIndexing,
  type SeoEnvironment,
} from "./environment.js";
import type { SemanticPageFacts } from "./fallback.js";
import { type ResolvedSeoMetadata, resolveSeoMetadata } from "./fallback.js";
import {
  buildFaviconIcons,
  type SeoFaviconPort,
  type SeoHeadIcon,
  type SeoLogoPort,
} from "./favicon.js";
import { previewSeo, type SeoPreviewResult } from "./preview.js";
import { renderRobotsMeta } from "./robots-meta.js";
import type { RobotsTxtPolicy } from "./robots-txt.js";
import type { SeoSiteIdentity } from "./site-identity.js";
import { toSiteSeoDefaults } from "./site-identity.js";
import type { SitemapCandidate } from "./sitemap.js";
import { buildSitemapEntries, renderSitemapXml } from "./sitemap.js";
import type { SeoSocialImagePort } from "./social.js";
import type { SeoStore } from "./store.js";
import { type SeoValidationInput, type SeoValidationReport, validateSeoPage } from "./validate.js";

/** Agent scopes (spec §61). Content agents edit ordinary page SEO; the
 * privileged scopes gate canonical/domain/global policy. */
export const SEO_AGENT_SCOPES = [
  "seo.read",
  "seo.edit",
  "seo.validate",
  "seo.canonical_override",
  "seo.indexing_policy",
  "seo.site_settings",
] as const;
export type SeoAgentScope = (typeof SEO_AGENT_SCOPES)[number];

export interface SeoOperationDescriptor {
  readonly name: string;
  readonly scope: SeoAgentScope;
  readonly description: string;
}

export interface SeoDocumentSchemaDescriptor {
  readonly fields: readonly {
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly description: string;
  }[];
  readonly structured_data_type_hints: readonly string[];
  readonly robots_directives: readonly string[];
}

/** Omitted context is editorial; public callers select publication or an exact revision. */
export interface SeoFactsContext {
  readonly locale?: string | null;
  readonly revisionId?: string;
  readonly published?: boolean;
  /** Social preview / validation surfaces materialize the og-v1 derivative
   * before resolving (OG contract §3) — never set by the public renderer. */
  readonly materializeSocial?: boolean;
}

export interface SeoDiscoveryDeps {
  readonly store: SeoStore;
  readonly environment: SeoEnvironment;
  /** Site identity lookup (single-site baseline: the site's settings). */
  readonly getSiteIdentity: () => Promise<SeoSiteIdentity | null>;
  /** Routing primary origin for the site (never a request Host). */
  readonly getOrigin: () => Promise<string | null>;
  readonly canonical: SeoCanonicalPort;
  /** Semantic page facts provider (Content side). */
  readonly getFacts: (
    entryId: string,
    context?: SeoFactsContext,
  ) => Promise<SemanticPageFacts | null>;
  readonly socialImage: SeoSocialImagePort;
  readonly favicon: SeoFaviconPort | null;
  /** Site Identity logo port (§33): resolves the logo's generated public
   * representation (logo-v1); omitted/null when not wired. */
  readonly logo?: SeoLogoPort | null;
  /** Materializes the og-v1 derivative for the referenced asset (OG
   * contract §3): called from preview/validate surfaces, never from the
   * public renderer. */
  readonly materializeSocialDerivative?: (ref: { readonly asset_id: string }) => Promise<void>;
  /** Sitemap candidates provider (routing + eligibility composition). */
  readonly getSitemapCandidates: () => Promise<readonly SitemapCandidate[]>;
  readonly getRobotsPolicy: () => Promise<RobotsTxtPolicy>;
}

export interface SeoDiscovery {
  readonly scopes: readonly SeoAgentScope[];
  readonly operations: readonly SeoOperationDescriptor[];
  getSeoSchema(): SeoDocumentSchemaDescriptor;
  resolveSeoMetadataFor(
    entryId: string,
    context?: SeoFactsContext,
  ): Promise<{
    readonly entryId: string;
    readonly resolved: ResolvedSeoMetadata;
    readonly canonical: string | null;
    readonly robots: string | null;
  } | null>;
  previewSeoFor(
    entryId: string,
    options?: SeoFactsContext & {
      readonly openGraph?: boolean;
      readonly twitterCard?: boolean;
      readonly locale?: string | null;
    },
  ): Promise<SeoPreviewResult | null>;
  validateSeoFor(entryId: string, context?: SeoFactsContext): Promise<SeoValidationReport | null>;
  getSiteIdentity(): Promise<Omit<SeoSiteIdentity, "verification"> | null>;
  /**
   * Server-only projection (2026-10-18 ownership-verification task): the
   * site's meta verification tags for the PUBLIC HOME PAGE head. Reads the
   * full identity through the authorized service — deliberately NOT part of
   * the agent operations list (verification records are site-owner facts,
   * not agent-readable semantics) and deliberately scoped to the exact
   * provider meta tags Core emits.
   */
  getSiteVerificationMeta(): Promise<
    readonly { readonly name: string; readonly content: string }[]
  >;
  /**
   * Server-only projection: the stored provider verification root files
   * (exact filename + validated body) served by the public web root.
   * Same trust boundary as getSiteVerificationMeta.
   */
  getOwnershipProofFiles(): Promise<
    readonly { readonly filename: string; readonly body: string }[]
  >;
  /** Site Identity favicon icon links for core-rendered surfaces without an
   * entry (search results page, error pages): identity ref → media port →
   * the same buildFaviconIcons chain the entry head uses. Empty when the
   * identity declares no favicon or its derivative is not materialized. */
  siteFaviconIcons(): Promise<readonly SeoHeadIcon[]>;
  getIndexingPolicy(
    entryId: string,
    context?: SeoFactsContext,
  ): Promise<{
    readonly entryId: string;
    readonly policy: { readonly index: boolean; readonly follow: boolean };
    readonly robots: string | null;
    readonly indexable: boolean;
    readonly environment_guarded: boolean;
    readonly override_issues: readonly SeoDiagnostic[];
  } | null>;
  getSitemapStatus(): Promise<{
    readonly environment_indexable: boolean;
    readonly candidates: number;
    readonly included: number;
    readonly excluded: readonly { readonly entryId: string; readonly reason: string }[];
  }>;
  /**
   * Rendered sitemap.xml document for the current site, or null when the
   * environment is not indexable or no primary origin exists (M17 §44: the
   * public route serves nothing rather than a wrong document).
   */
  getSitemapDocument(): Promise<string | null>;
  getRobotsPolicy(): Promise<RobotsTxtPolicy>;
}

const OPERATIONS: readonly SeoOperationDescriptor[] = [
  {
    name: "get_seo_schema",
    scope: "seo.read",
    description: "typed SEO document schema and hint sets",
  },
  {
    name: "resolve_seo_metadata",
    scope: "seo.read",
    description: "resolved values with provenance for an entry",
  },
  {
    name: "preview_seo",
    scope: "seo.read",
    description: "deterministic head/social/JSON-LD preview",
  },
  {
    name: "preview_structured_data",
    scope: "seo.read",
    description: "JSON-LD + diagnostics before publish",
  },
  {
    name: "validate_seo",
    scope: "seo.validate",
    description: "machine-readable validation report",
  },
  {
    name: "get_site_identity",
    scope: "seo.read",
    description: "site identity facts (public subset)",
  },
  {
    name: "get_indexing_policy",
    scope: "seo.read",
    description: "effective indexing policy with guard provenance",
  },
  { name: "get_sitemap_status", scope: "seo.read", description: "sitemap eligibility summary" },
  { name: "get_robots_policy", scope: "seo.read", description: "generated robots.txt policy" },
];

const FIELD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  seo_title: "explicit search title; falls back to the page title",
  meta_description: "explicit meta description; falls back to the intro where policy permits",
  canonical_override: "privileged canonical URL override (scoped: seo.canonical_override)",
  robots_policy: "typed indexing policy object",
  social_title: "explicit social title override",
  social_description: "explicit social description override",
  social_image: "media asset reference with optional version pin",
  structured_data_type_hint: "article family hint for the structured-data registry",
};

export function createSeoDiscovery(deps: SeoDiscoveryDeps): SeoDiscovery {
  async function loadContext(
    entryId: string,
    context?: SeoFactsContext,
  ): Promise<{
    document: SeoDocument | null;
    facts: SemanticPageFacts;
    identity: SeoSiteIdentity | null;
    routeCanonicalUrl: string | null;
  } | null> {
    const [document, facts, identity, routeCanonicalUrl] = await Promise.all([
      deps.store.getDocument(entryId),
      deps.getFacts(entryId, context),
      deps.getSiteIdentity(),
      deps.canonical.canonicalUrl(entryId, context?.locale),
    ]);
    if (facts == null) return null;
    return { document, facts, identity, routeCanonicalUrl };
  }

  return {
    scopes: SEO_AGENT_SCOPES,
    operations: OPERATIONS,

    getSeoSchema(): SeoDocumentSchemaDescriptor {
      return {
        fields: [...SEO_DOCUMENT_KEYS].map((name) => ({
          name,
          type:
            name === "robots_policy" ? "object" : name === "social_image" ? "media_ref" : "string",
          required: false,
          description: FIELD_DESCRIPTIONS[name] ?? "",
        })),
        structured_data_type_hints: [...STRUCTURED_DATA_TYPE_HINTS],
        robots_directives: [
          "index",
          "follow",
          "noarchive",
          "nosnippet",
          "max_snippet",
          "max_image_preview",
          "max_video_preview",
        ],
      };
    },

    async resolveSeoMetadataFor(entryId, context) {
      const ctx = await loadContext(entryId, context);
      if (ctx == null) return null;
      const resolved = resolveSeoMetadata(ctx.document, ctx.facts, toSiteSeoDefaults(ctx.identity));
      const guarded = applyEnvironmentGuard(ctx.document?.robots_policy ?? null, deps.environment);
      return {
        entryId,
        resolved,
        canonical: ctx.routeCanonicalUrl,
        robots: renderRobotsMeta(guarded.policy),
      };
    },

    async previewSeoFor(entryId, options) {
      const ctx = await loadContext(entryId, options);
      if (ctx == null) return null;
      // Social preview is a materialization point (OG contract §3): the
      // og-v1 derivative is generated here — the SAME pipeline publish
      // uses — so the preview shows the real result.
      // Materialize the RESOLVED social image (explicit → hero → site
      // default; owner 2026-10-08) — the same choice the head builder makes.
      const materializeRef = resolveSeoMetadata(
        ctx.document,
        ctx.facts,
        toSiteSeoDefaults(ctx.identity),
      ).social_image.value;
      if (
        options?.materializeSocial === true &&
        materializeRef !== null &&
        deps.materializeSocialDerivative !== undefined
      ) {
        await deps.materializeSocialDerivative(materializeRef);
      }
      // Organization logo (§33): resolves only the generated logo-v1
      // representation — absence omits the node field, never fabricates.
      const logoRef = ctx.identity?.logo ?? null;
      const logo =
        logoRef != null && deps.logo != null ? await deps.logo.resolveLogo(logoRef) : null;
      return previewSeo(
        { socialImage: deps.socialImage, favicon: deps.favicon },
        {
          entryId,
          document: ctx.document,
          facts: ctx.facts,
          identity: ctx.identity,
          origin: await deps.getOrigin(),
          routeCanonicalUrl: ctx.routeCanonicalUrl,
          environment: deps.environment,
          ...(logo?.url != null && logo.url !== "" ? { logoUrl: logo.url } : {}),
          ...(options?.locale != null ? { locale: options.locale } : {}),
          ...(options?.openGraph === undefined ? {} : { openGraph: options.openGraph }),
          ...(options?.twitterCard === undefined ? {} : { twitterCard: options.twitterCard }),
        },
      );
    },

    async validateSeoFor(entryId, context) {
      const ctx = await loadContext(entryId, context);
      if (ctx == null) return null;
      const socialRef = resolveSeoMetadata(ctx.document, ctx.facts, toSiteSeoDefaults(ctx.identity))
        .social_image.value;
      const socialImage =
        socialRef !== null ? await deps.socialImage.resolveSocialImage(socialRef) : null;
      const faviconRef = ctx.identity?.favicon ?? null;
      const favicon =
        faviconRef != null && deps.favicon != null
          ? await deps.favicon.resolveFavicon(faviconRef)
          : null;
      // OG contract (§4): the entry must declare an explicit ogImage, and
      // the og-v1 derivative must materialize successfully with the
      // contracted dimensions/format before publication.
      const ogIssues: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      }[] = [];
      if (socialRef === null) {
        ogIssues.push({
          code: "OG_IMAGE_MISSING",
          message:
            "no explicit, hero or site-default social image — assign page.seo.ogImage or set the site default",
        });
      } else if (deps.materializeSocialDerivative !== undefined) {
        try {
          await deps.materializeSocialDerivative(socialRef);
        } catch (error) {
          // Stable surface code — the provider's own code travels in details,
          // keeping the report's diagnostic registry closed (append-only §74).
          const original = (error as { code?: string }).code;
          ogIssues.push({
            code: "OG_DERIVATIVE_FAILED",
            message: (error as Error).message,
            ...(original === undefined || original === "OG_DERIVATIVE_FAILED"
              ? {}
              : { details: { original_code: original } }),
          });
        }
      }
      const report = validateSeoPage({
        entryId,
        document: ctx.document,
        facts: ctx.facts,
        site: toSiteSeoDefaults(ctx.identity),
        routeCanonicalUrl: ctx.routeCanonicalUrl,
        socialImage,
        favicon,
        faviconDeclared: ctx.identity?.favicon != null,
        environment: deps.environment,
        structuredData: null,
      });
      // Canonical override permission check is part of the agent contract:
      // external overrides need the privileged scope decision upstream.
      const canonicalIssues =
        ctx.document?.canonical_override != null
          ? validateCanonicalOverride(ctx.document.canonical_override, {
              routeUrl: ctx.routeCanonicalUrl,
            })
          : [];
      const issues = [
        ...report.issues,
        ...ogIssues.map((issue) => ({ ...issue, severity: "error" as const })),
        ...canonicalIssues,
      ];
      const counts = { error: 0, warning: 0, recommendation: 0 };
      for (const issue of issues) counts[issue.severity]++;
      return { ...report, issues, counts };
    },

    async getSiteIdentity() {
      const identity = await deps.getSiteIdentity();
      if (identity == null) return null;
      // Verification records are site-owner facts, not agent-readable semantics.
      const { verification: _verification, ...publicIdentity } = identity;
      void _verification;
      return publicIdentity;
    },

    async getSiteVerificationMeta() {
      const identity = await deps.getSiteIdentity();
      const verification = identity?.verification ?? [];
      const meta: { name: string; content: string }[] = [];
      for (const entry of verification) {
        if ((entry.method ?? "meta") !== "meta") continue;
        if (entry.provider === "google" || entry.provider === "yandex") {
          meta.push({
            name: entry.provider === "google" ? "google-site-verification" : "yandex-verification",
            content: entry.content,
          });
        }
      }
      return meta;
    },

    async getOwnershipProofFiles() {
      const identity = await deps.getSiteIdentity();
      const verification = identity?.verification ?? [];
      const files: { filename: string; body: string }[] = [];
      for (const entry of verification) {
        if (entry.method !== "file" || entry.file === undefined) continue;
        if (entry.provider === "google" || entry.provider === "yandex") {
          files.push({ filename: entry.file.filename, body: entry.file.body });
        }
      }
      return files;
    },

    async siteFaviconIcons() {
      const identity = await deps.getSiteIdentity();
      const ref = identity?.favicon ?? null;
      if (ref == null || deps.favicon == null) return [];
      const favicon = await deps.favicon.resolveFavicon(ref);
      return buildFaviconIcons(favicon);
    },

    async getIndexingPolicy(entryId, context) {
      const ctx = await loadContext(entryId, context);
      if (ctx == null) return null;
      const guarded = applyEnvironmentGuard(ctx.document?.robots_policy ?? null, deps.environment);
      if (ctx.document?.canonical_override != null) {
        // Surface (not enforce) override issues so agents can react.
        void validateCanonicalOverride(ctx.document.canonical_override, {
          routeUrl: ctx.routeCanonicalUrl,
        });
      }
      return {
        entryId,
        policy: { index: guarded.policy.index, follow: guarded.policy.follow },
        robots: renderRobotsMeta(guarded.policy),
        indexable: environmentAllowsIndexing(deps.environment) && guarded.policy.index,
        environment_guarded: guarded.guarded,
        override_issues: [],
      };
    },

    async getSitemapStatus() {
      const candidates = await deps.getSitemapCandidates();
      const origin = await deps.getOrigin();
      const environmentIndexable = environmentAllowsIndexing(deps.environment);
      if (origin == null || !environmentIndexable) {
        // Environment guard (§13): non-production sitemaps list nothing.
        return {
          environment_indexable: environmentIndexable,
          candidates: candidates.length,
          included: 0,
          excluded: candidates.map((c) => ({
            entryId: c.entryId,
            reason: origin == null ? "no_origin" : "environment",
          })),
        };
      }
      const result = buildSitemapEntries({ origin, candidates });
      return {
        environment_indexable: environmentIndexable,
        candidates: candidates.length,
        included: result.urls.length,
        excluded: result.excluded,
      };
    },

    async getSitemapDocument(): Promise<string | null> {
      const origin = await deps.getOrigin();
      if (origin === null || !environmentAllowsIndexing(deps.environment)) return null;
      const candidates = await deps.getSitemapCandidates();
      const built = buildSitemapEntries({ origin, candidates });
      return renderSitemapXml(built.urls);
    },

    async getRobotsPolicy() {
      return deps.getRobotsPolicy();
    },
  };
}

// Keep the ValidationInput type import used for the public report shape.
export type { SeoValidationInput };
