// Environment safety guard (PCMS-SEO-T021; SEO spec §13).
// Non-production environments are globally noindex: a staging site can never
// become indexable because a Theme or editor forgot metadata. The guard is
// an SEO-safety belt, not an access control — real staging protection lives
// at the Operations/Auth/network layer (M15/M08).
import type { SeoRobotsPolicy } from "./document.js";

export type SeoEnvironment = "production" | "staging" | "development";

/** Only an explicit production environment is indexable (fail-secure). */
export function environmentAllowsIndexing(environment: SeoEnvironment): boolean {
  return environment === "production";
}

/**
 * Merges the page policy with the environment guard. The guard only ever
 * tightens: production keeps the page policy verbatim, non-production
 * forces index:false (provenance travels with the head model).
 */
export function applyEnvironmentGuard(
  policy: SeoRobotsPolicy | null,
  environment: SeoEnvironment,
): { readonly policy: SeoRobotsPolicy; readonly guarded: boolean } {
  if (environmentAllowsIndexing(environment)) {
    return { policy: policy ?? { index: true, follow: true }, guarded: false };
  }
  return {
    policy: {
      index: false,
      follow: policy?.follow ?? true,
      ...(policy?.noarchive === true ? { noarchive: true } : {}),
      ...(policy?.nosnippet === true ? { nosnippet: true } : {}),
      ...(policy?.max_snippet !== undefined ? { max_snippet: policy.max_snippet } : {}),
      ...(policy?.max_image_preview !== undefined
        ? { max_image_preview: policy.max_image_preview }
        : {}),
      ...(policy?.max_video_preview !== undefined
        ? { max_video_preview: policy.max_video_preview }
        : {}),
    },
    guarded: true,
  };
}
