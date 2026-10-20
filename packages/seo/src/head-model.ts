// SeoHeadViewModel builder (PCMS-SEO-T005; SEO spec §47).
//
// SEO Core produces the normalized, protected head model; the Theme renders
// it through the M03 protected-head boundary (assembleHeadHtml) and can
// neither suppress nor reorder the core section. The shape is deliberately
// field-compatible with the themes HeadViewModel core section — composition
// adds the theme extension slot. Provenance and diagnostics travel with the
// model, so Admin/agents can explain every value without parsing HTML.
import {
  type CanonicalProvenance,
  resolveCanonical,
  validateCanonicalOverride,
} from "./canonical.js";
import type { SeoDiagnostic } from "./diagnostics.js";
import type { SeoDocument } from "./document.js";
import { applyEnvironmentGuard, type SeoEnvironment } from "./environment.js";
import {
  type ResolvedSeoMetadata,
  resolveSeoMetadata,
  type SemanticPageFacts,
  type SiteSeoDefaults,
} from "./fallback.js";
import { buildFaviconIcons, type FaviconViewModel, type SeoHeadIcon } from "./favicon.js";
import { renderRobotsMeta, robotsConflicts } from "./robots-meta.js";
import { buildOpenGraphMeta, resolveOgType, type SocialImageViewModel } from "./social.js";
import { buildTwitterCardMeta } from "./twitter.js";

/** The core-protected head model (SEO spec §47). Theme slots are added by composition. */
export interface SeoHeadViewModel {
  readonly title: string | null;
  readonly core_meta: readonly {
    readonly name?: string;
    readonly property?: string;
    readonly content: string;
  }[];
  readonly canonical: string | null;
  readonly robots: string | null;
  /** Site Identity favicon icon links (protected core section). */
  readonly icons: readonly SeoHeadIcon[];
  /** JSON-LD blocks as safely serialized text (composed by the schema registry, T016+). */
  readonly json_ld: readonly string[];
  readonly provenance: readonly {
    readonly field: string;
    readonly source: string;
    readonly note?: string;
  }[];
  readonly diagnostics: readonly SeoDiagnostic[];
}

export interface SeoHeadModelInput {
  readonly document: SeoDocument | null;
  readonly facts: SemanticPageFacts;
  readonly site: SiteSeoDefaults;
  /** Routing-resolved canonical URL for the entry (null when unrouted). */
  readonly routeCanonicalUrl: string | null;
  /** Privileged external-canonical permission (spec §9). */
  readonly allowExternalCanonical?: boolean;
  /** Emit the Open Graph baseline for a public page (spec §79.5). */
  readonly openGraph?: boolean;
  /** Resolved locale context (never hardcoded in SEO). */
  readonly locale?: string | null;
  /** Social image resolved through the Media port before building. */
  readonly socialImage?: SocialImageViewModel | null;
  /** Content type key of the page (OG type mapping, spec §25). */
  readonly contentTypeKey?: string | null;
  /** Site-level article classification (OG type mapping, spec §25). */
  readonly articleContentTypes?: readonly string[] | null;
  /** Site Identity favicon resolved through the Media port (spec §22). */
  readonly favicon?: FaviconViewModel | null;
  /** Emit the X/Twitter compatibility projection (spec §26). */
  readonly twitterCard?: boolean;
  /** Deployment environment (spec §13): non-production is globally noindex. */
  readonly environment?: SeoEnvironment;
}

export interface BuiltSeoHeadModel {
  readonly head: SeoHeadViewModel;
  /** Full fallback resolution with per-field provenance (§59). */
  readonly resolved: ResolvedSeoMetadata;
  readonly canonical_source: CanonicalProvenance | null;
}

export function buildSeoHeadModel(input: SeoHeadModelInput): BuiltSeoHeadModel {
  const { document, facts, site, routeCanonicalUrl } = input;
  const diagnostics: SeoDiagnostic[] = [];
  const resolved = resolveSeoMetadata(document, facts, site);
  diagnostics.push(...resolved.diagnostics);

  // Canonical: routing is the source; the override (if any) is validated.
  const canonical = resolveCanonical(document, routeCanonicalUrl);
  if (document?.canonical_override != null) {
    diagnostics.push(
      ...validateCanonicalOverride(document.canonical_override, {
        routeUrl: routeCanonicalUrl,
        ...(input.allowExternalCanonical === undefined
          ? {}
          : { allowExternalCanonical: input.allowExternalCanonical }),
      }),
    );
  } else if (routeCanonicalUrl == null) {
    diagnostics.push({
      code: "SEO_CANONICAL_MISSING",
      severity: "warning",
      message: "no routing canonical URL and no override",
      path: "/canonical",
    });
  }

  // Robots: typed policy only; the environment guard only ever tightens (§13).
  const { policy: guardedPolicy, guarded } = applyEnvironmentGuard(
    document?.robots_policy ?? null,
    input.environment ?? "production",
  );
  const robots = renderRobotsMeta(guardedPolicy);
  if (document?.robots_policy != null) diagnostics.push(...robotsConflicts(document.robots_policy));

  const core_meta: { name?: string; property?: string; content: string }[] = [];
  if (resolved.description.value != null) {
    core_meta.push({ name: "description", content: resolved.description.value });
  }

  // Open Graph baseline (spec §23): projection of the same social model.
  if (input.openGraph === true) {
    if (document?.social_image != null && input.socialImage == null) {
      diagnostics.push({
        code: "SEO_SOCIAL_IMAGE_INVALID",
        severity: "warning",
        message: "social image reference could not be resolved by the Media subsystem",
        path: "/social_image",
      });
    }
    core_meta.push(
      ...buildOpenGraphMeta({
        resolved,
        canonicalUrl: canonical.url,
        ogType: resolveOgType({
          structuredDataHint: document?.structured_data_type_hint ?? null,
          contentTypeKey: input.contentTypeKey ?? null,
          ...(input.articleContentTypes === undefined || input.articleContentTypes === null
            ? {}
            : { articleContentTypes: input.articleContentTypes }),
        }),
        siteName: site.site_name,
        locale: input.locale ?? null,
        socialImage: input.socialImage ?? null,
      }),
    );
    core_meta.push(
      ...buildTwitterCardMeta({ resolved, socialImage: input.socialImage ?? null }).map((t) => ({
        name: t.name,
        content: t.content,
      })),
    );
  }

  const head: SeoHeadViewModel = {
    title: resolved.title.value,
    core_meta,
    canonical: canonical.url,
    robots,
    icons: buildFaviconIcons(input.favicon ?? null),
    json_ld: [],
    provenance: [
      {
        field: "title",
        source: resolved.title.source,
        ...(resolved.title.note ? { note: resolved.title.note } : {}),
      },
      { field: "description", source: resolved.description.source },
      { field: "social_title", source: resolved.social_title.source },
      { field: "social_description", source: resolved.social_description.source },
      { field: "social_image", source: resolved.social_image.source },
      ...(canonical.source == null ? [] : [{ field: "canonical", source: canonical.source }]),
      ...(guarded ? [{ field: "robots", source: "environment_guard" as const }] : []),
    ],
    diagnostics,
  };
  return { head, resolved, canonical_source: canonical.source };
}
