// Canonical URL resolver (PCMS-NAV-T014; Navigation spec §23/§37–§39/§42).
// One canonical URL per public entry per site/domain + locale context. The
// absolute form is built exclusively from configured domain bindings —
// never from an incoming Host header (spec §38) — and the scheme comes from
// the binding's scheme policy (production: https, §39). The homepage entry
// canonicalizes to "/" via its explicit binding (§42).
import { type DbPool, isStableId } from "@pcms/core";
import type { DomainBindingRecord } from "./domains.js";
import { createDomainService, type DomainService } from "./domains.js";
import { RoutingError } from "./errors.js";
import type { RouteRecord } from "./routes.js";
import { createRouteService, type RouteService } from "./routes.js";

export interface CanonicalUrlOptions {
  /** Site the entry belongs to; defaults to the site of `hostname`, or the
   * "default" site when both are omitted (single-site baseline). */
  readonly siteId?: string;
  /** Host to canonicalize against; defaults to the site's primary binding. */
  readonly hostname?: string;
  readonly locale?: string | null;
}

export interface CanonicalUrlService {
  /** Absolute canonical URL for an entry; NAV_TARGET_MISSING if unrouted. */
  getCanonicalUrl(entryId: string, options?: CanonicalUrlOptions): Promise<string>;
  /** scheme://host of the site's canonical primary binding. */
  primaryOrigin(siteId: string): Promise<string>;
  /** The active canonical route record for an entry (path-level detail). */
  findRouteByEntry(
    entryId: string,
    options?: CanonicalUrlOptions,
  ): Promise<{ route: RouteRecord | null; isHome: boolean; binding: DomainBindingRecord }>;
}

interface RouteRow extends Record<string, unknown> {
  id: string;
  site_id: string;
  domain_binding_id: string | null;
  locale: string;
  path: string;
  target_type: string;
  target_id: string;
  is_canonical: boolean;
  created_at: Date;
  retired_at: Date | null;
}

/**
 * Public path of a route: secondary-locale routes (real BCP-47 locale code,
 * path stored without prefix) are served under their locale's path prefix
 * (e.g. "en-US" + "/services/" → "/en/services/"); default-locale routes
 * (sentinel locale) keep unprefixed paths.
 */
export function localizedRoutePath(route: {
  readonly locale: string;
  readonly path: string;
}): string {
  if (route.locale === "" || route.locale === "x-default" || route.locale === "default") {
    return route.path;
  }
  const dash = route.locale.indexOf("-");
  const subtag = dash === -1 ? route.locale : route.locale.slice(0, dash);
  return `/${subtag.toLowerCase()}${route.path}`;
}

export function createCanonicalUrlService(pool: DbPool): CanonicalUrlService {
  const routes: RouteService = createRouteService(pool);
  const domains: DomainService = createDomainService(pool);

  async function resolveContext(options?: CanonicalUrlOptions): Promise<{
    siteId: string;
    locale: string;
    binding: DomainBindingRecord;
  }> {
    if (options?.hostname !== undefined) {
      const binding = await domains.resolveHost(options.hostname);
      const site = await routes.getSite(binding.siteId);
      return { siteId: site.id, locale: options.locale ?? site.defaultLocale, binding };
    }
    const site =
      options?.siteId !== undefined
        ? await routes.getSite(options.siteId)
        : await routes.findSiteByKey("default");
    if (site === null) throw new RoutingError("SITE_NOT_FOUND", `no default site`);
    const bindings = await domains.listDomainBindings(site.id);
    const binding = bindings.find((d) => d.isPrimary);
    if (binding === undefined) {
      throw new RoutingError("DOMAIN_NOT_ALLOWED", `site has no primary domain binding`, {
        details: { site_id: site.id },
      });
    }
    return { siteId: site.id, locale: options?.locale ?? site.defaultLocale, binding };
  }

  return {
    async findRouteByEntry(entryId, options) {
      if (!isStableId(entryId)) {
        throw new RoutingError("NAV_TARGET_MISSING", `invalid entry id`, {
          details: { entry_id: entryId },
        });
      }
      const { siteId, locale, binding } = await resolveContext(options);
      const site = await routes.getSite(siteId);
      if (site.homeEntryId === entryId) {
        return { route: null, isHome: true, binding };
      }
      const result = await pool.query<RouteRow>(
        `SELECT * FROM routes
         WHERE target_id = $1 AND site_id = $2 AND locale = $3
           AND retired_at IS NULL AND is_canonical
           AND (domain_binding_id = $4 OR domain_binding_id IS NULL)
         ORDER BY (domain_binding_id = $4) DESC
         LIMIT 1`,
        [entryId, siteId, locale, binding.id],
      );
      const row = result.rows[0];
      const route: RouteRecord | null =
        row === undefined
          ? null
          : {
              id: row.id,
              siteId: row.site_id,
              domainBindingId: row.domain_binding_id,
              locale: row.locale,
              path: row.path,
              targetType: row.target_type as RouteRecord["targetType"],
              targetId: row.target_id,
              isCanonical: row.is_canonical,
              createdAt: row.created_at,
              retiredAt: row.retired_at,
            };
      return { route, isHome: false, binding };
    },

    async getCanonicalUrl(entryId, options) {
      const { route, isHome, binding } = await this.findRouteByEntry(entryId, options);
      if (!isHome && route === null) {
        throw new RoutingError("NAV_TARGET_MISSING", `entry has no active canonical route`, {
          details: { entry_id: entryId },
        });
      }
      const path =
        isHome || route === null
          ? "/"
          : localizedRoutePath({ locale: route.locale, path: route.path });
      const origin = `${binding.schemePolicy}://${binding.hostname}`;
      return `${origin}${path}`;
    },

    async primaryOrigin(siteId) {
      const site = await routes.getSite(siteId);
      const bindings = await domains.listDomainBindings(site.id);
      const binding = bindings.find((d) => d.isPrimary);
      if (binding === undefined) {
        throw new RoutingError("DOMAIN_NOT_ALLOWED", `site has no primary domain binding`, {
          details: { site_id: site.id },
        });
      }
      return `${binding.schemePolicy}://${binding.hostname}`;
    },
  };
}
