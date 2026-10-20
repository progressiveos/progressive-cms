// Typed robots/indexing policy renderer (PCMS-SEO-T004; SEO spec §11/§31).
// The policy is a typed object (SEO spec §11 baseline directives only) — raw
// directive strings are not representable, so user input cannot inject
// arbitrary meta content. The mapping to engine-compatible meta content is
// deterministic; absence of a policy means "no robots meta needed".
import type { SeoDiagnostic } from "./diagnostics.js";
import type { SeoRobotsPolicy } from "./document.js";

const DEFAULT_POLICY: SeoRobotsPolicy = { index: true, follow: true };

/**
 * Engine-compatible meta content for the policy, or null when the page is
 * plainly indexable and no directive needs to be emitted (the common
 * baseline — an explicit "index, follow" tag is redundant noise).
 */
export function renderRobotsMeta(policy: SeoRobotsPolicy | null): string | null {
  const p = policy ?? DEFAULT_POLICY;
  const directives: string[] = [];
  if (!p.index) directives.push("noindex");
  if (!p.follow) directives.push("nofollow");
  if (p.noarchive === true) directives.push("noarchive");
  if (p.nosnippet === true) directives.push("nosnippet");
  if (p.max_snippet !== undefined) directives.push(`max-snippet:${p.max_snippet}`);
  if (p.max_image_preview !== undefined)
    directives.push(`max-image-preview:${p.max_image_preview}`);
  if (p.max_video_preview !== undefined)
    directives.push(`max-video-preview:${p.max_video_preview}`);
  return directives.length === 0 ? null : directives.join(", ");
}

/** True when the effective policy excludes the page from indexes (§15). */
export function isNoindex(policy: SeoRobotsPolicy | null): boolean {
  return (policy ?? DEFAULT_POLICY).index === false;
}

/**
 * Semantic conflicts inside one policy (spec §31: only necessary
 * directives) — e.g. nosnippet together with max-snippet. Advisory.
 */
export function robotsConflicts(policy: SeoRobotsPolicy): readonly SeoDiagnostic[] {
  const issues: SeoDiagnostic[] = [];
  if (policy.nosnippet === true && policy.max_snippet !== undefined) {
    issues.push({
      code: "SEO_ROBOTS_CONFLICT",
      severity: "warning",
      message: "nosnippet makes max_snippet redundant",
      path: "/robots_policy",
    });
  }
  return issues;
}
