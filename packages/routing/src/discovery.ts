// Machine-readable routing discovery (PCMS-NAV-T023; Navigation spec §64).
// The §64 operations on top of the public application services; answers are
// plain serializable data so transports (API/MCP, M09) and agents need no
// source-code knowledge.
import type { DbPool } from "@pcms/core";
import { type ActionUrlService, createActionUrlService, type ResolvableAction } from "./actions.js";
import {
  createRouteProposalService,
  type RouteAvailabilityResult,
  type RouteProposalService,
} from "./availability.js";
import { type CanonicalUrlService, createCanonicalUrlService } from "./canonical.js";
import { createDomainService, type DomainBindingRecord, type DomainService } from "./domains.js";
import { RoutingError } from "./errors.js";
import {
  createRouteHistoryService,
  type RouteHistoryRecord,
  type RouteHistoryService,
} from "./history.js";
import { parsePathPolicy, type RoutePathPolicy } from "./policy.js";
import {
  createRequestResolver,
  type RedirectGraphIssue,
  type RequestResolution,
  type RequestResolver,
} from "./resolve.js";
import { createRouteService, type RouteRecord, type RouteService } from "./routes.js";

export interface RoutingDiscovery {
  /** spec §64 get_route_policy */
  getRoutePolicy(siteRef?: string): Promise<RoutePathPolicy>;
  /** spec §64 resolve_entry_url — canonical absolute URL, null when unrouted. */
  resolveEntryUrl(entryId: string, hostname?: string): Promise<string | null>;
  /** spec §64 resolve_url */
  resolveUrl(path: string, hostname?: string): Promise<RequestResolution>;
  /** spec §64 check_route_available */
  checkRouteAvailable(path: string, siteRef?: string): Promise<RouteAvailabilityResult>;
  /** spec §64 list_redirects */
  listRedirects(siteRef?: string): Promise<RouteHistoryRecord[]>;
  /** spec §64 validate_redirect_graph */
  validateRedirectGraph(siteRef?: string): Promise<RedirectGraphIssue[]>;
  /** spec §64 get_route_history (alias of listRedirects with full rows). */
  getRouteHistory(siteRef?: string): Promise<RouteHistoryRecord[]>;
  /** Additional machine surfaces for agents: active routes + domains. */
  listRoutes(siteRef?: string): Promise<RouteRecord[]>;
  listDomainBindings(siteRef?: string): Promise<DomainBindingRecord[]>;
  /** Typed action → current href (site-relative). */
  resolveAction(
    action: ResolvableAction,
    options?: { hostname?: string; absolute?: boolean },
  ): Promise<Awaited<ReturnType<ActionUrlService["resolveAction"]>>>;
}

interface SiteRow extends Record<string, unknown> {
  id: string;
  key: string;
  title: string;
  home_entry_id: string | null;
  default_locale: string;
  path_policy: unknown;
  created_at: Date;
}

export function createRoutingDiscovery(pool: DbPool): RoutingDiscovery {
  const routes: RouteService = createRouteService(pool);
  const domains: DomainService = createDomainService(pool);
  const history: RouteHistoryService = createRouteHistoryService(pool);
  const resolver: RequestResolver = createRequestResolver(pool);
  const canonical: CanonicalUrlService = createCanonicalUrlService(pool);
  const proposals: RouteProposalService = createRouteProposalService(pool);
  const actions: ActionUrlService = createActionUrlService(pool);

  async function resolveSiteRef(siteRef?: string): Promise<string> {
    if (siteRef === undefined) {
      const site = await routes.findSiteByKey("default");
      if (site === null) throw new RoutingError("SITE_NOT_FOUND", `no default site`);
      return site.id;
    }
    const site = await routes.findSiteByKey(siteRef);
    if (site !== null) return site.id;
    return routes.getSite(siteRef).then((s) => s.id);
  }

  return {
    async getRoutePolicy(siteRef) {
      const siteId = await resolveSiteRef(siteRef);
      const result = await pool.query<SiteRow>(`SELECT * FROM sites WHERE id = $1`, [siteId]);
      return parsePathPolicy(result.rows[0]?.path_policy);
    },

    async resolveEntryUrl(entryId, hostname) {
      try {
        return await canonical.getCanonicalUrl(entryId, hostname ? { hostname } : undefined);
      } catch (err) {
        if (err instanceof RoutingError) return null;
        throw err;
      }
    },

    async resolveUrl(path, hostname) {
      return resolver.resolve(hostname === undefined ? { path } : { path, hostname });
    },

    async checkRouteAvailable(path, siteRef) {
      const siteId = await resolveSiteRef(siteRef);
      return proposals.checkRouteAvailable({ siteId, path });
    },

    async listRedirects(siteRef) {
      const siteId = await resolveSiteRef(siteRef);
      return history.listHistory(siteId);
    },

    async validateRedirectGraph(siteRef) {
      const siteId = await resolveSiteRef(siteRef);
      return resolver.validateRedirectGraph(siteId);
    },

    getRouteHistory(siteRef) {
      return this.listRedirects(siteRef);
    },

    async listRoutes(siteRef) {
      const siteId = await resolveSiteRef(siteRef);
      return routes.listRoutes(siteId);
    },

    async listDomainBindings(siteRef) {
      const siteId = await resolveSiteRef(siteRef);
      return domains.listDomainBindings(siteId);
    },

    resolveAction(action, options) {
      return actions.resolveAction(action, options);
    },
  };
}
