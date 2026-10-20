// Favicon pipeline (PCMS-SEO-T009; SEO spec §22). The favicon is Site
// Identity media — never a Theme hardcode: composition resolves the media
// reference through the Media subsystem and hands the head model crawlable,
// stable icon tags that render inside the protected core section.
import type { SeoDiagnostic } from "./diagnostics.js";

/** Resolved favicon (Media provider result: stable, versioned public URL). */
export interface FaviconViewModel {
  readonly asset_id: string;
  readonly version: number | null;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly mime_type: string | null;
}

/** Port backed by the Media subsystem; null when unresolved. */
export interface SeoFaviconPort {
  readonly resolveFavicon: (ref: {
    readonly asset_id: string;
    readonly version?: number;
  }) => Promise<FaviconViewModel | null>;
}

/**
 * Site Identity logo port (§33): resolves the identity's logo reference to
 * its generated public representation (logo-v1). Null when the derivative
 * does not exist — the Organization node then simply omits the logo, never
 * a fabricated URL.
 */
export interface SeoLogoPort {
  readonly resolveLogo: (ref: {
    readonly asset_id: string;
    readonly version?: number;
  }) => Promise<FaviconViewModel | null>;
}

export interface SeoHeadIcon {
  readonly rel: string;
  readonly href: string;
  readonly type?: string;
  readonly sizes?: string;
}

/**
 * Icon tags for the resolved favicon: `rel="icon"` (the Google/Yandex
 * baseline) plus `apple-touch-icon` when the source is large enough to be
 * useful (§22: square, stable public URL, crawlable).
 */
export function buildFaviconIcons(favicon: FaviconViewModel | null): readonly SeoHeadIcon[] {
  if (favicon == null) return [];
  const icons: SeoHeadIcon[] = [
    {
      rel: "icon",
      href: favicon.url,
      ...(favicon.mime_type != null ? { type: favicon.mime_type } : {}),
      ...(favicon.width != null && favicon.height != null
        ? { sizes: `${favicon.width}x${favicon.height}` }
        : {}),
    },
  ];
  if (
    favicon.width != null &&
    favicon.height != null &&
    favicon.width >= 180 &&
    favicon.height >= 180
  ) {
    icons.push({ rel: "apple-touch-icon", href: favicon.url });
  }
  return icons;
}

/** Favicon health checks (§22): warn when absent or when the source is tiny. */
export function faviconIssues(
  favicon: FaviconViewModel | null,
  context: { readonly declared: boolean },
): readonly SeoDiagnostic[] {
  const issues: SeoDiagnostic[] = [];
  if (favicon == null) {
    if (context.declared) {
      issues.push({
        code: "SEO_SOCIAL_IMAGE_INVALID",
        severity: "warning",
        message: "favicon reference could not be resolved by the Media subsystem",
        path: "/site_identity/favicon",
      });
    } else {
      issues.push({
        code: "SEO_FAVICON_MISSING",
        severity: "warning",
        message: "site identity declares no favicon",
        path: "/site_identity/favicon",
      });
    }
    return issues;
  }
  if (
    (favicon.width != null && favicon.width < 48) ||
    (favicon.height != null && favicon.height < 48)
  ) {
    issues.push({
      code: "SEO_FAVICON_TOO_SMALL",
      severity: "warning",
      message: "favicon source is smaller than the recommended minimum",
      path: "/site_identity/favicon",
      details: { width: favicon.width, height: favicon.height },
    });
  }
  return issues;
}
