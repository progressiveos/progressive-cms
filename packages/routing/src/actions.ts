// Typed internal Action URL resolution (PCMS-NAV-T019; Navigation spec §11,
// Content spec §47). Internal actions carry stable IDs; the current URL is
// resolved here at request/render time — never stored (spec §76.2). The
// action shapes are a structural mirror of the Content/Navigation Action
// model; composition passes the plain payload through.
import type { DbPool } from "@pcms/core";
import {
  type CanonicalUrlOptions,
  createCanonicalUrlService,
  localizedRoutePath,
} from "./canonical.js";

export type ResolvableAction =
  | { readonly kind: "internal_entry"; readonly entry_id: string }
  | { readonly kind: "external_url"; readonly url: string }
  | { readonly kind: "anchor"; readonly anchor: string; readonly entry_id: string | null }
  | { readonly kind: "form"; readonly form_definition_id: string }
  | { readonly kind: "phone"; readonly phone: string }
  | { readonly kind: "email"; readonly email: string }
  | { readonly kind: "media_download"; readonly media_asset_id: string }
  | { readonly kind: "none" };

export type ActionHrefResolution =
  | { readonly kind: "url"; readonly href: string }
  | { readonly kind: "tel"; readonly href: string }
  | { readonly kind: "mailto"; readonly href: string }
  | { readonly kind: "none" }
  | {
      readonly kind: "unresolved";
      readonly reason:
        | "entry-unrouted"
        | "scheme-forbidden"
        | "media-unavailable-until-m05"
        | "form-unavailable-until-m12";
    };

const SAFE_PHONE = /^\+?[0-9 ()-]{1,20}$/;
const SAFE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Scheme allowlist for external action URLs (defense in depth, spec §69). */
function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export interface ActionUrlService {
  /**
   * Resolves a typed action to its current crawlable href. Site-relative by
   * default; `absolute: true` builds on the canonical domain binding.
   */
  resolveAction(
    action: ResolvableAction,
    options?: CanonicalUrlOptions & { absolute?: boolean },
  ): Promise<ActionHrefResolution>;
}

export function createActionUrlService(pool: DbPool): ActionUrlService {
  const canonical = createCanonicalUrlService(pool);

  return {
    async resolveAction(action, options) {
      switch (action.kind) {
        case "internal_entry": {
          const { route, isHome, binding } = await canonical.findRouteByEntry(
            action.entry_id,
            options,
          );
          if (!isHome && route === null) {
            return { kind: "unresolved", reason: "entry-unrouted" };
          }
          const path =
            isHome || route === null
              ? "/"
              : localizedRoutePath({ locale: route.locale, path: route.path });
          if (options?.absolute === true) {
            return { kind: "url", href: `${binding.schemePolicy}://${binding.hostname}${path}` };
          }
          return { kind: "url", href: path };
        }
        case "external_url": {
          if (!isAllowedExternalUrl(action.url)) {
            return { kind: "unresolved", reason: "scheme-forbidden" };
          }
          return { kind: "url", href: action.url };
        }
        case "anchor": {
          if (action.entry_id === null) {
            return { kind: "url", href: `#${action.anchor}` };
          }
          const { route, isHome } = await canonical.findRouteByEntry(action.entry_id, options);
          if (!isHome && route === null) {
            return { kind: "unresolved", reason: "entry-unrouted" };
          }
          const base =
            isHome || route === null
              ? "/"
              : localizedRoutePath({ locale: route.locale, path: route.path });
          return { kind: "url", href: `${base}#${action.anchor}` };
        }
        case "form":
          // Forms become navigable with the Forms subsystem (M12, ADR-0005).
          return { kind: "unresolved", reason: "form-unavailable-until-m12" };
        case "phone": {
          const digits = action.phone.replace(/[\s()-]/g, "");
          if (!SAFE_PHONE.test(action.phone) || digits.replace(/[^0-9+]/g, "").length < 3) {
            return { kind: "unresolved", reason: "scheme-forbidden" };
          }
          return { kind: "tel", href: `tel:${digits}` };
        }
        case "email": {
          if (!SAFE_EMAIL.test(action.email) || action.email.length > 254) {
            return { kind: "unresolved", reason: "scheme-forbidden" };
          }
          return { kind: "mailto", href: `mailto:${action.email}` };
        }
        case "media_download":
          // Download URLs arrive with the Media subsystem (M05).
          return { kind: "unresolved", reason: "media-unavailable-until-m05" };
        case "none":
          return { kind: "none" };
      }
    },
  };
}
