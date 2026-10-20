// SEO validation service (PCMS-SEO-T022; SEO spec §57/§58).
// Aggregates every subsystem check into one machine-readable report with
// stable codes and severities. Advisory heuristics never block publication —
// severity is information for Admin/agents, policy decides enforcement.
import {
  type CanonicalProvenance,
  resolveCanonical,
  validateCanonicalOverride,
} from "./canonical.js";
import type { SeoDiagnostic, SeoSeverity } from "./diagnostics.js";
import type { SeoDocument } from "./document.js";
import type { SeoEnvironment } from "./environment.js";
import { applyEnvironmentGuard } from "./environment.js";
import {
  type ResolvedSeoMetadata,
  resolveSeoMetadata,
  type SemanticPageFacts,
  type SiteSeoDefaults,
} from "./fallback.js";
import type { FaviconViewModel } from "./favicon.js";
import { faviconIssues } from "./favicon.js";
import { renderRobotsMeta, robotsConflicts } from "./robots-meta.js";
import type { ComposedStructuredData } from "./schema/compose.js";
import type { SocialImageViewModel } from "./social.js";

export interface SeoValidationInput {
  readonly entryId: string;
  readonly document: SeoDocument | null;
  readonly facts: SemanticPageFacts;
  readonly site: SiteSeoDefaults;
  readonly routeCanonicalUrl: string | null;
  readonly socialImage: SocialImageViewModel | null;
  readonly favicon: FaviconViewModel | null;
  readonly faviconDeclared: boolean;
  readonly environment: SeoEnvironment;
  readonly structuredData: ComposedStructuredData | null;
  readonly allowExternalCanonical?: boolean;
}

export interface SeoValidationReport {
  readonly entryId: string;
  /** Deterministic: ordered error → warning → recommendation, then code/path. */
  readonly issues: readonly SeoDiagnostic[];
  readonly counts: Readonly<Record<SeoSeverity, number>>;
  readonly resolved: ResolvedSeoMetadata;
  readonly canonical_source: CanonicalProvenance | null;
  readonly robots: string | null;
}

const SEVERITY_ORDER: Readonly<Record<SeoSeverity, number>> = {
  error: 0,
  warning: 1,
  recommendation: 2,
};

function lengthAdvisories(resolved: ResolvedSeoMetadata): SeoDiagnostic[] {
  const issues: SeoDiagnostic[] = [];
  const title = resolved.title.value;
  if (title != null) {
    // Advisory only: no false fixed search-engine limit is implied (§5).
    if (title.length > 120 || title.length < 20) {
      issues.push({
        code: "SEO_TITLE_LENGTH",
        severity: "warning",
        message: `title length ${title.length} is unusually ${title.length > 120 ? "long" : "short"}`,
        path: "/seo_title",
      });
    } else if (title.length > 70 || title.length < 30) {
      issues.push({
        code: "SEO_TITLE_LENGTH",
        severity: "recommendation",
        message: `title length ${title.length} is outside the typical display range`,
        path: "/seo_title",
      });
    }
  }
  const description = resolved.description.value;
  if (description != null && (description.length > 320 || description.length < 70)) {
    issues.push({
      code: "SEO_DESCRIPTION_LENGTH",
      severity: description.length > 480 ? "warning" : "recommendation",
      message: `description length ${description.length} is outside the typical display range`,
      path: "/meta_description",
    });
  }
  return issues;
}

/** Full per-entry validation: fallbacks, canonical, robots, favicon, JSON-LD. */
export function validateSeoPage(input: SeoValidationInput): SeoValidationReport {
  const issues: SeoDiagnostic[] = [];

  const resolved = resolveSeoMetadata(input.document, input.facts, input.site);
  issues.push(...resolved.diagnostics, ...lengthAdvisories(resolved));

  const canonical = resolveCanonical(input.document, input.routeCanonicalUrl);
  if (input.document?.canonical_override != null) {
    issues.push(
      ...validateCanonicalOverride(input.document.canonical_override, {
        routeUrl: input.routeCanonicalUrl,
        ...(input.allowExternalCanonical === undefined
          ? {}
          : { allowExternalCanonical: input.allowExternalCanonical }),
      }),
    );
  }

  const guarded = applyEnvironmentGuard(input.document?.robots_policy ?? null, input.environment);
  const robots = renderRobotsMeta(guarded.policy);
  if (input.document?.robots_policy != null) {
    issues.push(...robotsConflicts(input.document.robots_policy));
  }

  issues.push(...faviconIssues(input.favicon, { declared: input.faviconDeclared }));

  if (input.structuredData != null) {
    issues.push(...input.structuredData.diagnostics);
  }

  issues.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return (a.path ?? "").localeCompare(b.path ?? "");
  });
  const counts: Record<SeoSeverity, number> = { error: 0, warning: 0, recommendation: 0 };
  for (const issue of issues) counts[issue.severity] += 1;

  return {
    entryId: input.entryId,
    issues,
    counts,
    resolved,
    canonical_source: canonical.source,
    robots,
  };
}
