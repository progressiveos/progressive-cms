// System document slots (ADR-0016; Analytics spec §2): platform-owned
// injection points into the THEME-OWNED public HTML document. The injection
// mechanics are generic (`injectAfterOpeningTag`); what rides in them is the
// analytics render plan. Applied only to public surfaces (live route, public
// 404, public search) — never to previews, Admin, API or maintenance.
import type { SystemDocumentInjection } from "@pcms/analytics";
import type { ApplicationServices } from "@pcms/api";
import { analyticsInjectionFor } from "@pcms/api";
import { injectAfterOpeningTag } from "@pcms/core";

export interface AnalyticsPageSurface {
  readonly pageId: string;
  readonly pageType: string;
  readonly locale: string;
  readonly isSearch?: boolean;
  readonly isNotFound?: boolean;
}

/** Null when analytics is disabled/failing — zero traces (spec §13). */
export function analyticsPageInjection(
  application: ApplicationServices,
  page: AnalyticsPageSurface,
): SystemDocumentInjection | null {
  try {
    return analyticsInjectionFor(application, {
      siteKey: application.defaultSiteKey,
      pageId: page.pageId,
      pageType: page.pageType,
      locale: page.locale,
      isSearch: page.isSearch === true,
      isNotFound: page.isNotFound === true,
    });
  } catch {
    return null;
  }
}

/** Guards on real documents: fragments never enter non-HTML payloads. */
export function applySystemSlots(html: string, injection: SystemDocumentInjection | null): string {
  if (injection === null || !html.includes("<html")) return html;
  let out = injectAfterOpeningTag(html, "head", injection.headEarlyHtml);
  out = injectAfterOpeningTag(out, "body", injection.bodyStartHtml);
  return out;
}
