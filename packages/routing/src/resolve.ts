// Request resolution and redirect-graph safety (PCMS-NAV-T016; Navigation
// spec §33/§44). Resolution follows the normative order: validate host →
// normalize path conservatively → direct active route → historical redirect
// → system/home → not found. The graph validator rejects loops, self
// redirects and chains beyond the configured threshold; old aliases are kept
// collapsed so visitors reach the current canonical in one hop.
import type { DbPool } from "@pcms/core";
import { createCanonicalUrlService } from "./canonical.js";
import { createDomainService, type DomainService } from "./domains.js";
import {
  createRouteHistoryService,
  type RouteHistoryRecord,
  type RouteHistoryService,
} from "./history.js";
import type { SiteLocalizationService } from "./localization.js";
import { decideRequestPath } from "./path.js";
import type { RoutePathPolicy } from "./policy.js";
import { DEFAULT_MAX_REDIRECT_CHAIN } from "./policy.js";
import { createRouteService, type RouteRecord, type RouteService } from "./routes.js";

export type RequestResolution =
  | { readonly kind: "home"; readonly entryId: string; readonly locale?: string }
  | { readonly kind: "route"; readonly route: RouteRecord; readonly locale?: string }
  | {
      readonly kind: "redirect";
      readonly statusCode: 301 | 302 | 307 | 308;
      readonly location: string;
    }
  | { readonly kind: "gone" }
  | { readonly kind: "invalid"; readonly code: "ROUTE_INVALID_ENCODING" | "ROUTE_PATH_INVALID" }
  | { readonly kind: "host_not_allowed" }
  | { readonly kind: "not_found" };

export interface ResolveInput {
  readonly path: string;
  /** Validated against the domain allowlist when provided (spec §38). */
  readonly hostname?: string;
  readonly siteId?: string;
  readonly locale?: string | null;
  readonly domainBindingId?: string | null;
}

export interface RequestResolverOptions {
  /**
   * Opt-in site localization (multilingual). When provided and enabled,
   * secondary-locale paths (/en/...) are peeled before resolution and the
   * resolution carries the request locale. Default-locale behavior is
   * byte-identical to the single-language baseline.
   */
  readonly localization?: SiteLocalizationService;
}

export interface RedirectGraphIssue {
  readonly code: "REDIRECT_LOOP" | "REDIRECT_CHAIN_TOO_LONG";
  readonly path: string;
  readonly message: string;
}

export interface RequestResolver {
  resolve(input: ResolveInput): Promise<RequestResolution>;
  /** Full-graph safety report (spec §33): loops / self / excessive chains. */
  validateRedirectGraph(
    siteId: string,
    options?: { maxChain?: number; locale?: string | null },
  ): Promise<RedirectGraphIssue[]>;
}

interface HistoryRow extends Record<string, unknown> {
  id: string;
  site_id: string;
  domain_binding_id: string | null;
  locale: string;
  old_path: string;
  target_type: string | null;
  target_id: string | null;
  status_code: number;
  reason: string | null;
  created_at: Date;
  retired_at: Date | null;
}

export function createRequestResolver(
  pool: DbPool,
  options?: RequestResolverOptions,
): RequestResolver {
  const routes: RouteService = createRouteService(pool);
  const domains: DomainService = createDomainService(pool);
  const history: RouteHistoryService = createRouteHistoryService(pool);
  const canonical = createCanonicalUrlService(pool);
  const localization = options?.localization ?? null;

  /** True when a path has an active route, redirect source, or home binding. */
  async function canonicalTargetExists(
    siteId: string,
    location: string,
    options: { locale: string | null; domainBindingId: string | null },
  ): Promise<boolean> {
    let route = await routes.findActiveRoute(siteId, location, options);
    if (route === null && options.domainBindingId !== null) {
      route = await routes.findActiveRoute(siteId, location, {
        locale: options.locale,
        domainBindingId: null,
      });
    }
    if (route !== null) return true;
    const redirect = await history.findActiveRedirect(siteId, location, options.locale);
    if (redirect !== null) return true;
    if (location === "/") {
      const site = await routes.getSite(siteId);
      if (site.homeEntryId !== null) return true;
    }
    return false;
  }

  return {
    async resolve(input) {
      // 1. Host validation — only configured bindings are trusted (§38).
      let siteId = input.siteId;
      let domainBindingId = input.domainBindingId ?? null;
      if (input.hostname !== undefined) {
        try {
          const binding = await domains.resolveHost(input.hostname);
          siteId = binding.siteId;
          domainBindingId = binding.id;
        } catch {
          return { kind: "host_not_allowed" };
        }
      }
      if (siteId === undefined) {
        const site = await routes.findSiteByKey("default");
        if (site === null) return { kind: "not_found" };
        siteId = site.id;
      }
      // 1.5 Locale path prefix (opt-in multilingual): a secondary-locale
      // prefix is peeled before normalization so policy redirects stay
      // inside the locale scope — their locations re-carry the prefix. The
      // default locale keeps unprefixed URLs and the legacy sentinel
      // behavior (`locale` stays unset for it).
      let requestPath = input.path;
      let requestLocale: string | null = null;
      let prefix = "";
      if (localization !== null) {
        const peeled = await localization.peelPrefix(requestPath);
        if (peeled !== null) {
          requestLocale = peeled.locale;
          requestPath = peeled.path;
          prefix = peeled.prefix;
        }
      }
      const scope = (location: string): string => `${prefix}${location}`;
      // 2. Site Routing Policy, then conservative normalization; alternate
      // forms redirect (§25/§45).
      const routePolicy = await routes.getPolicy(siteId);
      const decision = decideRequestPath(requestPath, routePolicy);
      if (decision.kind === "invalid") return { kind: "invalid", code: decision.code };
      if (decision.kind === "redirect") {
        // Redirect only when the canonical target actually exists — never
        // point a request at a future 404.
        const exists = await canonicalTargetExists(siteId, decision.location, {
          locale: requestLocale,
          domainBindingId,
        });
        if (!exists) return { kind: "not_found" };
        return {
          kind: "redirect",
          statusCode: decision.statusCode,
          location: scope(decision.location),
        };
      }
      const path = decision.path;
      // 3. Direct active route: binding-scoped first, then site-wide.
      let route = await routes.findActiveRoute(siteId, path, {
        locale: requestLocale,
        domainBindingId,
      });
      if (route === null && domainBindingId !== null) {
        route = await routes.findActiveRoute(siteId, path, {
          locale: requestLocale,
          domainBindingId: null,
        });
      }
      if (route !== null) {
        return {
          kind: "route",
          route,
          ...(requestLocale === null ? {} : { locale: requestLocale }),
        };
      }
      // 4. Historical redirect (rows are collapsed — one hop, §33). Entry
      // targets resolve to the entry's CURRENT canonical path at answer time.
      const redirect = await history.findActiveRedirect(siteId, path, requestLocale);
      if (redirect !== null) {
        if (redirect.statusCode === 410 || redirect.targetId === null) return { kind: "gone" };
        if (redirect.targetType === "entry" && redirect.targetId !== null) {
          const found = await canonical.findRouteByEntry(redirect.targetId, {
            siteId,
            locale: requestLocale,
          });
          if (!found.isHome && found.route === null) return { kind: "not_found" };
          return {
            kind: "redirect",
            statusCode: redirect.statusCode as 301 | 302 | 307 | 308,
            location: scope(found.isHome ? "/" : (found.route?.path ?? "/")),
          };
        }
        return {
          kind: "redirect",
          statusCode: redirect.statusCode as 301 | 302 | 307 | 308,
          location: scope(redirect.targetId ?? "/"),
        };
      }
      // 5. System/home route. The home binding is site-level (default
      // locale); a peeled locale request still resolves home and the
      // composition swaps in the translation of that locale when present.
      const resolution = await routes.resolveRoute(siteId, path, {
        locale: requestLocale,
        domainBindingId,
      });
      if (resolution.kind === "home") {
        return {
          kind: "home",
          entryId: resolution.entryId,
          ...(requestLocale === null ? {} : { locale: requestLocale }),
        };
      }
      if (resolution.kind === "route") return { kind: "route", route: resolution.route };
      // 6. Not found — unknown paths never fabricate a target.
      return { kind: "not_found" };
    },

    async validateRedirectGraph(siteId, options) {
      const maxChain = options?.maxChain ?? DEFAULT_MAX_REDIRECT_CHAIN;
      const locale = options?.locale;
      const result = await pool.query<HistoryRow>(
        `SELECT * FROM route_history WHERE site_id = $1 AND retired_at IS NULL`,
        [siteId],
      );
      const rows = result.rows;
      const byPath = new Map<string, HistoryRow>();
      for (const row of rows) {
        if (locale !== undefined && row.locale !== locale) continue;
        byPath.set(row.old_path, row);
      }
      const issues: RedirectGraphIssue[] = [];
      for (const row of byPath.values()) {
        if (row.target_type !== "path" || row.target_id === null) continue; // entry/gone targets are terminal
        if (row.target_id === row.old_path) {
          issues.push({
            code: "REDIRECT_LOOP",
            path: row.old_path,
            message: `self redirect`,
          });
          continue;
        }
        // Walk the chain; revisiting any node is a loop, length is bounded.
        // `edges` counts redirect hops: old_path → target is the first edge.
        const seen = new Set<string>([row.old_path]);
        let current: string | null = row.target_id;
        let edges = 1;
        while (current !== null) {
          if (seen.has(current)) {
            issues.push({
              code: "REDIRECT_LOOP",
              path: row.old_path,
              message: `redirect loop through "${current}"`,
            });
            break;
          }
          seen.add(current);
          const next = byPath.get(current);
          if (next === undefined || next.target_type !== "path" || next.target_id === null) break;
          edges += 1;
          if (edges > maxChain) {
            issues.push({
              code: "REDIRECT_CHAIN_TOO_LONG",
              path: row.old_path,
              message: `chain longer than ${maxChain} hops`,
            });
            break;
          }
          current = next.target_id;
        }
      }
      return issues;
    },
  };
}
