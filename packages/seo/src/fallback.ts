// Deterministic fallback resolver with provenance (PCMS-SEO-T002; SEO
// spec §4/§59). Every resolved SEO value answers: the value, the source it
// came from, and why that source was chosen. Same normalized input always
// yields the same output — no hidden randomness, no unexplainable magic.
import type { SeoDiagnostic } from "./diagnostics.js";
import type { SeoDocument, SeoMediaRef } from "./document.js";

/** Semantic page facts — normalizer input provided by the Content side. */
export interface SemanticPageFacts {
  readonly page_title: string | null;
  readonly intro: string | null;
  readonly hero_image: SeoMediaRef | null;
  /**
   * Effective image of the nearest ancestor section in the Content Tree
   * (CORE-RC19 B), already resolved by the Content side: the closest ancestor
   * with a usable image, itself taking its explicit social image first and its
   * hero/featured image second. Null when the entry is a root or no ancestor
   * offers one. Computed at read time — never written into the entry, so
   * changing a section image needs no child update and no migration.
   */
  readonly inherited_social_image?: SeoMediaRef | null;
  /** Content type key of the entry (article_content_types classification). */
  readonly content_type_key?: string | null;
  /**
   * Publication-contract times (ISO 8601, spec §35/§55) from the Publication
   * subsystem: first publication and the contract's own modified_at (set only
   * when the published payload actually changed) — never file mtimes. Absent
   * or null when the entry has no live publication record.
   */
  readonly published_at?: string | null;
  readonly modified_at?: string | null;
}

/** Site-level SEO defaults (SEO spec §63/§64). */
export interface SiteSeoDefaults {
  readonly site_name: string | null;
  /** Optional title pattern, e.g. "{page_title} — {site_name}" (§64). */
  readonly title_pattern: string | null;
  readonly default_social_image: SeoMediaRef | null;
  /** Whether the intro may back the meta/social description (§4 "where policy permits"). */
  readonly allow_intro_description_fallback: boolean;
}

export const DEFAULT_SITE_SEO_DEFAULTS: SiteSeoDefaults = {
  site_name: null,
  title_pattern: null,
  default_social_image: null,
  allow_intro_description_fallback: true,
};

/** Where a resolved value came from — the machine-answerable "why". */
export type SeoProvenanceSource =
  | "seo_title"
  | "page_title"
  | "site_name"
  | "meta_description"
  | "intro"
  | "social_title"
  | "social_description"
  | "social_image"
  | "hero_image"
  | "parent_section_image"
  | "site_default_social_image";

export interface ResolvedSeoValue<T> {
  readonly value: T | null;
  readonly source: SeoProvenanceSource;
  /** Extra deterministic context, e.g. that the title pattern was applied. */
  readonly note?: string;
}

export interface ResolvedSeoMetadata {
  readonly title: ResolvedSeoValue<string>;
  readonly description: ResolvedSeoValue<string>;
  readonly social_title: ResolvedSeoValue<string>;
  readonly social_description: ResolvedSeoValue<string>;
  readonly social_image: ResolvedSeoValue<SeoMediaRef>;
  readonly diagnostics: readonly SeoDiagnostic[];
}

const TITLE_PATTERN_BOUND = 200;

/** A valid pattern mentions only the two known placeholders and nothing hostile. */
function isValidTitlePattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > TITLE_PATTERN_BOUND) return false;
  if (/[\n\r\t]/.test(pattern)) return false;
  return pattern.replace(/\{page_title\}|\{site_name\}/g, "").indexOf("{") === -1;
}

/**
 * Fallback chains (SEO spec §4), verbatim:
 *   title:            seo_title → page_title (+ optional site title pattern)
 *   meta_description: meta_description → intro (policy permitting)
 *   social_title:     social_title → seo_title → page_title
 *   social_description: social_description → meta_description → intro
 *   social_image:     social_image → hero_image → inherited parent-section
 *                     image → site default_social_image
 */
export function resolveSeoMetadata(
  document: SeoDocument | null,
  facts: SemanticPageFacts,
  site: SiteSeoDefaults,
): ResolvedSeoMetadata {
  const diagnostics: SeoDiagnostic[] = [];
  const titleBase: ResolvedSeoValue<string> =
    document?.seo_title != null
      ? { value: document.seo_title, source: "seo_title" }
      : facts.page_title != null
        ? { value: facts.page_title, source: "page_title" }
        : { value: null, source: "page_title" };

  let title: ResolvedSeoValue<string> = titleBase;
  if (
    titleBase.value != null &&
    site.title_pattern != null &&
    isValidTitlePattern(site.title_pattern)
  ) {
    if (site.site_name != null || !site.title_pattern.includes("{site_name}")) {
      const composed = site.title_pattern
        .replaceAll("{page_title}", titleBase.value)
        .replaceAll("{site_name}", site.site_name ?? "");
      title = { value: composed, source: titleBase.source, note: "site title pattern applied" };
    }
  } else if (titleBase.value == null && site.site_name != null) {
    // Last resort for indexable pages without any title input (typically the
    // homepage): the site name is the deterministic floor, never a guess.
    title = { value: site.site_name, source: "site_name" };
  }
  if (title.value == null) {
    diagnostics.push({
      code: "SEO_TITLE_MISSING",
      severity: "warning",
      message: "no seo_title, page title or site name available",
      path: "/seo_title",
    });
  }

  const descriptionBase: ResolvedSeoValue<string> =
    document?.meta_description != null
      ? { value: document.meta_description, source: "meta_description" }
      : site.allow_intro_description_fallback && facts.intro != null
        ? { value: facts.intro, source: "intro" }
        : { value: null, source: "meta_description" };
  if (descriptionBase.value == null) {
    diagnostics.push({
      code: "SEO_DESCRIPTION_MISSING",
      severity: "warning",
      message: "no meta_description and no permitted intro fallback",
      path: "/meta_description",
    });
  }

  const socialTitle: ResolvedSeoValue<string> =
    document?.social_title != null
      ? { value: document.social_title, source: "social_title" }
      : titleBase;

  const socialDescription: ResolvedSeoValue<string> =
    document?.social_description != null
      ? { value: document.social_description, source: "social_description" }
      : descriptionBase;

  const socialImage: ResolvedSeoValue<SeoMediaRef> =
    document?.social_image != null
      ? { value: document.social_image, source: "social_image" }
      : facts.hero_image != null
        ? { value: facts.hero_image, source: "hero_image" }
        : facts.inherited_social_image != null
          ? { value: facts.inherited_social_image, source: "parent_section_image" }
          : site.default_social_image != null
            ? { value: site.default_social_image, source: "site_default_social_image" }
            : { value: null, source: "social_image" };
  if (socialImage.value == null) {
    diagnostics.push({
      code: "SEO_SOCIAL_IMAGE_MISSING",
      severity: "recommendation",
      message: "no explicit, hero, parent-section or site-default social image",
      path: "/social_image",
    });
  }

  return {
    title,
    description: descriptionBase,
    social_title: socialTitle,
    social_description: socialDescription,
    social_image: socialImage,
    diagnostics,
  };
}
