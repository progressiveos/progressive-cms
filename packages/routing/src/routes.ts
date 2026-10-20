// Route records and activation (PCMS-NAV-T008; Navigation spec §22/§30).
// A route is the mapping site/domain + locale + path → target. Entry
// identity is a stable ID, never the path itself (spec §76.7). Collision is
// prevented twice: an application pre-check with a stable
// ROUTE_COLLISION code, and partial unique indexes as the hard backstop.
import { type DbClient, type DbPool, isStableId, newStableId } from "@pcms/core";
import { RoutingError } from "./errors.js";
import { normalizeStoredPath } from "./path.js";
import { parsePathPolicy, type RoutePathPolicy } from "./policy.js";
import { createReservedRouteRegistry } from "./reserved.js";

export interface SiteRecord {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  /** Explicit homepage binding — never inferred from slug/title (spec §42). */
  readonly homeEntryId: string | null;
  readonly defaultLocale: string;
  readonly createdAt: Date;
}

export interface RouteRecord {
  readonly id: string;
  readonly siteId: string;
  readonly domainBindingId: string | null;
  readonly locale: string;
  readonly path: string;
  readonly targetType: "entry" | "system";
  readonly targetId: string;
  readonly isCanonical: boolean;
  readonly createdAt: Date;
  readonly retiredAt: Date | null;
}

export type RouteResolution =
  | { readonly kind: "home"; readonly entryId: string }
  | { readonly kind: "route"; readonly route: RouteRecord }
  | { readonly kind: "not_found" };

export interface ActivateRouteInput {
  readonly siteId: string;
  /** null = route applies to every host of the site (site-wide default). */
  readonly domainBindingId?: string | null;
  readonly locale?: string | null;
  readonly path: string;
  readonly targetType: "entry" | "system";
  readonly targetId: string;
  /** Route change is explicit; the reason lands in route history. */
  readonly reason?: string | null;
}

interface SiteRow extends Record<string, unknown> {
  id: string;
  key: string;
  title: string;
  home_entry_id: string | null;
  default_locale: string;
  created_at: Date;
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

function toSite(row: SiteRow | undefined): SiteRecord {
  if (row === undefined) throw new RoutingError("SITE_NOT_FOUND", `site row missing`);
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    homeEntryId: row.home_entry_id,
    defaultLocale: row.default_locale,
    createdAt: row.created_at,
  };
}

function toRoute(row: RouteRow | undefined): RouteRecord {
  if (row === undefined) throw new RoutingError("ROUTE_NOT_FOUND", `route row missing`);
  return {
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
}

const SITE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$|^x-default$/;

export interface RouteService {
  /** Get-or-create by key — the single-site baseline uses key "default". */
  ensureSite(key: string, title?: string): Promise<SiteRecord>;
  getSite(id: string): Promise<SiteRecord>;
  findSiteByKey(key: string): Promise<SiteRecord | null>;
  /**
   * Activates the canonical route for a normalized path. Rejects collisions
   * with any active canonical route in the same site/domain + locale + path
   * key (spec §30) before publication-time activation.
   */
  activateRoute(input: ActivateRouteInput): Promise<RouteRecord>;
  /** Preflight-only validation: runs the exact activatability rules apply
   * enforces (path policy, reserved prefixes, §42 homepage binding) without
   * mutating anything (2026-10-03 site-developer report: preflight accepted
   * an entry route for "/" that apply rejected with ROUTE_PATH_INVALID). */
  validateActivatable(input: ActivateRouteInput): Promise<void>;
  /** The site Routing Policy — the single normalization source (spec §27). */
  getPolicy(siteId: string): Promise<RoutePathPolicy>;
  setPolicy(siteId: string, policy: RoutePathPolicy): Promise<SiteRecord>;
  /** Retires a route; history handling belongs to the route-change op. */
  retireRoute(input: { siteId: string; path: string; locale?: string | null }): Promise<void>;
  /** Explicit homepage binding — magic slug/title inference never happens (spec §42). */
  setHomeEntry(siteId: string, entryId: string | null): Promise<SiteRecord>;
  setHomeEntryWithinTx(
    client: DbClient,
    siteId: string,
    entryId: string | null,
  ): Promise<{ readonly site: SiteRecord; readonly previousEntryId: string | null }>;
  /**
   * Resolves a request path (spec §44 subset): `/` resolves to the explicit
   * home binding, anything else to the indexed active-route lookup.
   * Redirects (history/alternate forms) layer on top of this in T016.
   */
  resolveRoute(
    siteId: string,
    path: string,
    options?: { locale?: string | null; domainBindingId?: string | null },
  ): Promise<RouteResolution>;
  /** Indexed active-route lookup (spec §67). */
  findActiveRoute(
    siteId: string,
    path: string,
    options?: { locale?: string | null; domainBindingId?: string | null },
  ): Promise<RouteRecord | null>;
  listRoutes(siteId: string): Promise<RouteRecord[]>;
  /**
   * Transaction-scoped activation (PCMS-PUB-T015 additive seam, Publication
   * spec §18): identical behavior to `activateRoute`, but runs on the
   * caller-supplied DbClient so route operations join one publication
   * transaction. Behavior mirrored by `activateRoute` itself.
   */
  activateRouteWithinTx(client: DbClient, input: ActivateRouteInput): Promise<RouteRecord>;
  /** Transaction-scoped retirement (same seam as `activateRouteWithinTx`). */
  retireRouteWithinTx(
    client: DbClient,
    input: { siteId: string; path: string; locale?: string | null },
  ): Promise<void>;
}

export function createRouteService(
  pool: DbPool,
  options?: {
    /** Custom reserved namespaces beyond the Core defaults (spec §29). */
    reservedPrefixes?: readonly string[];
  },
): RouteService {
  const reserved = createReservedRouteRegistry(options?.reservedPrefixes);
  async function getSite(id: string): Promise<SiteRecord> {
    if (!isStableId(id)) throw new RoutingError("SITE_NOT_FOUND", `invalid site id`);
    const result = await pool.query<SiteRow>(`SELECT * FROM sites WHERE id = $1`, [id]);
    return toSite(result.rows[0]);
  }

  function assertActivatable(
    input: ActivateRouteInput,
    site: SiteRecord,
    policy: RoutePathPolicy,
  ): { locale: string; path: string; domainBindingId: string | null } {
    const locale = input.locale ?? site.defaultLocale;
    if (!LOCALE_PATTERN.test(locale)) {
      throw new RoutingError("ROUTE_LOCALE_INVALID", `locale must be a BCP47-ish tag`, {
        details: { locale },
      });
    }
    if (input.targetType === "entry" && !isStableId(input.targetId)) {
      throw new RoutingError("ROUTE_TARGET_INVALID", `entry targets need a stable Entry ID`, {
        details: { target_id: input.targetId },
      });
    }
    const path = normalizeStoredPath(input.path, policy);
    reserved.assertNotReserved(path);
    if (input.targetType === "entry" && path === "/") {
      // The homepage is a typed binding, never a content route (spec §42).
      throw new RoutingError(
        "ROUTE_PATH_INVALID",
        `entries cannot claim "/"; use the homepage binding`,
        {
          details: { path },
        },
      );
    }
    return { locale, path, domainBindingId: input.domainBindingId ?? null };
  }

  async function activateOn(
    client: DbClient,
    input: ActivateRouteInput,
    site: SiteRecord,
    policy: RoutePathPolicy,
  ): Promise<RouteRecord> {
    const { locale, path, domainBindingId } = assertActivatable(input, site, policy);
    // Application-level collision pre-check first so the error carries a
    // stable code and details (the unique index is the backstop).
    const clash = await client.query<RouteRow>(
      `SELECT * FROM routes
       WHERE site_id = $1 AND locale = $2 AND path = $3
         AND domain_binding_id IS NOT DISTINCT FROM $4
         AND retired_at IS NULL AND is_canonical`,
      [site.id, locale, path, domainBindingId],
    );
    if (clash.rows[0] !== undefined) {
      throw new RoutingError("ROUTE_COLLISION", `an active route already claims this path`, {
        details: {
          site_id: site.id,
          locale,
          path,
          domain_binding_id: domainBindingId,
          existing_route_id: clash.rows[0].id,
        },
      });
    }
    const id = newStableId();
    try {
      await client.query(
        `INSERT INTO routes (id, site_id, domain_binding_id, locale, path, target_type, target_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, site.id, domainBindingId, locale, path, input.targetType, input.targetId],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new RoutingError("ROUTE_COLLISION", `an active route already claims this path`, {
          details: { site_id: site.id, locale, path, domain_binding_id: domainBindingId },
        });
      }
      throw err;
    }
    const row = await client.query<RouteRow>(`SELECT * FROM routes WHERE id = $1`, [id]);
    return toRoute(row.rows[0]);
  }

  async function retireOn(
    client: DbClient,
    input: { siteId: string; path: string; locale?: string | null },
  ): Promise<void> {
    const site = await getSite(input.siteId);
    const result = await client.query<{ id: string }>(
      `UPDATE routes SET retired_at = now()
       WHERE site_id = $1 AND locale = $2 AND path = $3 AND retired_at IS NULL
       RETURNING id`,
      [site.id, input.locale ?? site.defaultLocale, input.path],
    );
    if (result.rows.length === 0) {
      throw new RoutingError("ROUTE_NOT_FOUND", `no active route for this path`, {
        details: { site_id: site.id, path: input.path },
      });
    }
  }

  return {
    async ensureSite(key, title) {
      if (!SITE_KEY_PATTERN.test(key)) {
        throw new RoutingError("SITE_KEY_INVALID", `site key must match ^[a-z][a-z0-9-]{0,63}$`, {
          details: { key },
        });
      }
      const existing = await pool.query<SiteRow>(`SELECT * FROM sites WHERE key = $1`, [key]);
      if (existing.rows[0] !== undefined) return toSite(existing.rows[0]);
      const id = newStableId();
      try {
        await pool.query(`INSERT INTO sites (id, key, title) VALUES ($1, $2, $3)`, [
          id,
          key,
          title ?? key,
        ]);
      } catch (err) {
        // Concurrent ensure — someone else created it first.
        if ((err as { code?: string }).code !== "23505") throw err;
      }
      return this.findSiteByKey(key) as Promise<SiteRecord>;
    },

    getSite,

    async findSiteByKey(key) {
      const result = await pool.query<SiteRow>(`SELECT * FROM sites WHERE key = $1`, [key]);
      const row = result.rows[0];
      return row === undefined ? null : toSite(row);
    },

    async activateRoute(input) {
      const site = await getSite(input.siteId);
      const policy = await this.getPolicy(site.id);
      return pool.withTransaction(async (tx) => activateOn(tx, input, site, policy));
    },

    async validateActivatable(input) {
      const site = await getSite(input.siteId);
      const policy = await this.getPolicy(site.id);
      assertActivatable(input, site, policy);
    },

    async activateRouteWithinTx(client, input) {
      const site = await getSite(input.siteId);
      const policy = await this.getPolicy(site.id);
      return activateOn(client, input, site, policy);
    },

    async retireRoute(input) {
      await pool.withTransaction(async (tx) => retireOn(tx, input));
    },

    async retireRouteWithinTx(client, input) {
      await retireOn(client, input);
    },

    async setHomeEntry(siteId, entryId) {
      const result = await pool.withTransaction((tx) =>
        this.setHomeEntryWithinTx(tx, siteId, entryId),
      );
      return result.site;
    },

    async setHomeEntryWithinTx(client, siteId, entryId) {
      const { rows } = await client.query<SiteRow>(
        `SELECT id, key, title, home_entry_id, default_locale, created_at
         FROM sites WHERE id = $1 FOR UPDATE`,
        [siteId],
      );
      const previous = toSite(rows[0]);
      if (entryId !== null && !isStableId(entryId)) {
        throw new RoutingError("ROUTE_TARGET_INVALID", `home binding needs a stable Entry ID`, {
          details: { entry_id: entryId },
        });
      }
      await client.query(`UPDATE sites SET home_entry_id = $2 WHERE id = $1`, [siteId, entryId]);
      return {
        site: { ...previous, homeEntryId: entryId },
        previousEntryId: previous.homeEntryId,
      };
    },

    async resolveRoute(siteId, path, options) {
      const site = await getSite(siteId);
      const locale = options?.locale ?? site.defaultLocale;
      const domainBindingId = options?.domainBindingId ?? null;
      if (path === "/") {
        return site.homeEntryId === null
          ? { kind: "not_found" }
          : { kind: "home", entryId: site.homeEntryId };
      }
      const route = await this.findActiveRoute(siteId, path, { locale, domainBindingId });
      return route === null ? { kind: "not_found" } : { kind: "route", route };
    },

    async getPolicy(siteId) {
      const site = await getSite(siteId);
      const result = await pool.query<{ path_policy: unknown }>(
        `SELECT path_policy FROM sites WHERE id = $1`,
        [site.id],
      );
      return parsePathPolicy(result.rows[0]?.path_policy);
    },

    async setPolicy(siteId, policy) {
      const site = await getSite(siteId);
      await pool.query(`UPDATE sites SET path_policy = $2 WHERE id = $1`, [
        site.id,
        JSON.stringify({
          trailingSlash: policy.trailingSlash,
          lowercase: policy.lowercase,
          allowedExtensions: [...policy.allowedExtensions],
          slug: { cyrillic: policy.slug.cyrillic },
        }),
      ]);
      return getSite(site.id);
    },

    async findActiveRoute(siteId, path, options) {
      const site = await getSite(siteId);
      const locale = options?.locale ?? site.defaultLocale;
      const domainBindingId = options?.domainBindingId ?? null;
      const result = await pool.query<RouteRow>(
        `SELECT * FROM routes
         WHERE site_id = $1 AND locale = $2 AND path = $3
           AND domain_binding_id IS NOT DISTINCT FROM $4
           AND retired_at IS NULL AND is_canonical`,
        [site.id, locale, path, domainBindingId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRoute(row);
    },

    async listRoutes(siteId) {
      const site = await getSite(siteId);
      const result = await pool.query<RouteRow>(
        `SELECT * FROM routes WHERE site_id = $1 AND retired_at IS NULL ORDER BY path`,
        [site.id],
      );
      return result.rows.map(toRoute);
    },
  };
}
