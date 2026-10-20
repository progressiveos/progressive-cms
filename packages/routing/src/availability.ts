// Route availability / proposal preflight (PCMS-NAV-T018; Navigation spec
// §30/§54). Draft entries may propose a path before it exists: the preflight
// works purely on the future route key — no public route is activated and
// nothing is reserved beyond what this check reports. Slug normalization
// follows the site Routing Policy; collision/reserved/redirect conflicts
// come back as machine-readable issues.
import type { DbPool } from "@pcms/core";
import { RoutingError } from "./errors.js";
import { normalizeStoredPath } from "./path.js";
import { createReservedRouteRegistry } from "./reserved.js";
import { createRouteService, type RouteService } from "./routes.js";
import { slugSegmentsToPath } from "./slug.js";

export interface RouteAvailabilityIssue {
  readonly code:
    | "ROUTE_COLLISION"
    | "ROUTE_RESERVED"
    | "ROUTE_PATH_INVALID"
    | "ROUTE_INVALID_ENCODING";
  /** Why the path is not claimable (machine-readable detail). */
  readonly reason: "active-route" | "active-redirect" | "reserved" | "invalid" | "encoding";
  readonly path: string;
}

export interface RouteAvailabilityResult {
  readonly path: string;
  readonly available: boolean;
  readonly issues: readonly RouteAvailabilityIssue[];
}

export interface CheckRouteInput {
  readonly siteId: string;
  readonly path: string;
  readonly locale?: string | null;
  readonly domainBindingId?: string | null;
}

export interface ProposeRouteInput {
  readonly siteId: string;
  /** Slug segments, e.g. ["services", "plant-modernization"]. */
  readonly segments: readonly string[];
  readonly locale?: string | null;
}

export interface RouteProposalService {
  checkRouteAvailable(input: CheckRouteInput): Promise<RouteAvailabilityResult>;
  /**
   * Proposes the next available path for slug segments: normalizes via the
   * site policy and appends `-2`, `-3`, … when the base path is taken.
   * Proposals never reserve anything — activation remains explicit.
   */
  proposeRoutePath(input: ProposeRouteInput): Promise<RouteAvailabilityResult>;
}

const MAX_PROPOSAL_CANDIDATES = 20;

export function createRouteProposalService(pool: DbPool): RouteProposalService {
  const routes: RouteService = createRouteService(pool);
  const reserved = createReservedRouteRegistry();

  async function check(input: CheckRouteInput): Promise<RouteAvailabilityResult> {
    const site = await routes.getSite(input.siteId);
    const locale = input.locale ?? site.defaultLocale;
    const policy = await routes.getPolicy(site.id);
    const path = input.path;
    let normalized: string;
    try {
      normalized = normalizeStoredPath(path, policy);
    } catch (err) {
      const code = err instanceof RoutingError ? err.code : "ROUTE_PATH_INVALID";
      return {
        path,
        available: false,
        issues: [
          {
            code:
              code === "ROUTE_INVALID_ENCODING" ? "ROUTE_INVALID_ENCODING" : "ROUTE_PATH_INVALID",
            reason: code === "ROUTE_INVALID_ENCODING" ? "encoding" : "invalid",
            path,
          },
        ],
      };
    }
    const reservedIssue: RouteAvailabilityIssue[] = reserved.isReserved(normalized)
      ? [{ code: "ROUTE_RESERVED", reason: "reserved", path: normalized }]
      : [];
    if (reservedIssue.length > 0)
      return { path: normalized, available: false, issues: reservedIssue };

    const active = await routes.findActiveRoute(site.id, normalized, {
      locale,
      domainBindingId: input.domainBindingId ?? null,
    });
    if (active !== null) {
      return {
        path: normalized,
        available: false,
        issues: [{ code: "ROUTE_COLLISION", reason: "active-route", path: normalized }],
      };
    }
    // A historical redirect occupying the path is a soft conflict: claiming
    // the path retires the redirect, which must be an explicit decision.
    const redirectCheck = await pool.query(
      `SELECT id FROM route_history
       WHERE site_id = $1 AND locale = $2 AND old_path = $3 AND retired_at IS NULL`,
      [site.id, locale, normalized],
    );
    if (redirectCheck.rows.length > 0) {
      return {
        path: normalized,
        available: false,
        issues: [{ code: "ROUTE_COLLISION", reason: "active-redirect", path: normalized }],
      };
    }
    return { path: normalized, available: true, issues: [] };
  }

  return {
    checkRouteAvailable: check,

    async proposeRoutePath(input) {
      const site = await routes.getSite(input.siteId);
      const policy = await routes.getPolicy(site.id);
      let candidate = slugSegmentsToPath(input.segments, policy.slug);
      let result = await check({ ...input, path: candidate });
      let suffix = 2;
      while (!result.available && suffix < MAX_PROPOSAL_CANDIDATES) {
        candidate = slugSegmentsToPath(
          input.segments.map((segment, index) =>
            index === input.segments.length - 1 ? `${segment}-${suffix}` : segment,
          ),
          policy.slug,
        );
        result = await check({ ...input, path: candidate });
        suffix += 1;
      }
      return result;
    },
  };
}
