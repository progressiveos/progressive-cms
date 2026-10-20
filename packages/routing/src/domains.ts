// Domain bindings and Host validation (PCMS-NAV-T013; Navigation spec
// §36–§39). Allowed hosts are derived exclusively from configured domain
// bindings — an arbitrary `Host` header is never trusted, which prevents
// host-header poisoning of canonical/social URLs (spec §38). The canonical
// scheme comes from the binding's scheme policy (production: https, §39);
// proxy `X-Forwarded-Proto` handling stays in the Operations trusted-proxy
// layer and is never second-guessed here.
import { type DbPool, isStableId, newStableId } from "@pcms/core";
import { RoutingError } from "./errors.js";

export type DomainSchemePolicy = "https" | "http";
export type CanonicalRedirectPolicy = "redirect" | "serve";

export interface DomainBindingRecord {
  readonly id: string;
  readonly siteId: string;
  /** Lowercased hostname without port/path (the allowlist key). */
  readonly hostname: string;
  readonly schemePolicy: DomainSchemePolicy;
  readonly isPrimary: boolean;
  /** Non-primary hosts 301 to the primary ("redirect") or serve as-is. */
  readonly canonicalRedirectPolicy: CanonicalRedirectPolicy;
  readonly locale: string | null;
  readonly createdAt: Date;
}

export interface AddDomainBindingInput {
  readonly siteId: string;
  readonly hostname: string;
  readonly schemePolicy?: DomainSchemePolicy;
  readonly isPrimary?: boolean;
  readonly canonicalRedirectPolicy?: CanonicalRedirectPolicy;
  readonly locale?: string | null;
}

interface DomainRow extends Record<string, unknown> {
  id: string;
  site_id: string;
  hostname: string;
  scheme_policy: string;
  is_primary: boolean;
  canonical_redirect_policy: string;
  locale: string | null;
  created_at: Date;
}

function toRecord(row: DomainRow | undefined): DomainBindingRecord {
  if (row === undefined) throw new RoutingError("DOMAIN_NOT_ALLOWED", `binding row missing`);
  return {
    id: row.id,
    siteId: row.site_id,
    hostname: row.hostname,
    schemePolicy: row.scheme_policy as DomainBindingRecord["schemePolicy"],
    isPrimary: row.is_primary,
    canonicalRedirectPolicy:
      row.canonical_redirect_policy as DomainBindingRecord["canonicalRedirectPolicy"],
    locale: row.locale,
    createdAt: row.created_at,
  };
}

/** Conservative hostname shape: letters/digits/hyphens/dots, or an IPv4 dev literal. */
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Strips exactly what a reverse proxy may prepend — scheme, port, path,
 * trailing dot — and validates the remainder. Returns the lowercased
 * allowlist key or throws DOMAIN_NOT_ALLOWED for garbage input.
 */
export function normalizeHostname(input: string): string {
  let host = input.trim().toLowerCase();
  if (host.includes("://")) host = host.slice(host.indexOf("://") + 3);
  if (host.includes("/")) host = host.slice(0, host.indexOf("/"));
  if (host.includes("@")) host = host.slice(host.indexOf("@") + 1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.includes(":")) {
    // A single colon may carry a port; anything else (multiple colons,
    // non-numeric suffix) is a hostile header shape.
    const colon = host.indexOf(":");
    const port = host.slice(colon + 1);
    if (port.includes(":") || !/^\d{1,5}$/.test(port)) {
      throw new RoutingError("DOMAIN_NOT_ALLOWED", `hostname is not a valid allowlist key`, {
        details: { hostname: input },
      });
    }
    host = host.slice(0, colon);
  }
  if (!HOSTNAME_PATTERN.test(host) || host.length > 253) {
    throw new RoutingError("DOMAIN_NOT_ALLOWED", `hostname is not a valid allowlist key`, {
      details: { hostname: input },
    });
  }
  return host;
}

export interface DomainService {
  addDomainBinding(input: AddDomainBindingInput): Promise<DomainBindingRecord>;
  listDomainBindings(siteId?: string): Promise<DomainBindingRecord[]>;
  /** Exact allowlist lookup — null for unconfigured hosts. */
  findDomainByHostname(hostname: string): Promise<DomainBindingRecord | null>;
  /** Strict Host validation (spec §38): throws DOMAIN_NOT_ALLOWED. */
  resolveHost(hostname: string): Promise<DomainBindingRecord>;
  /** Reassigns the canonical primary role within a site (one primary max). */
  setPrimaryDomain(bindingId: string): Promise<DomainBindingRecord>;
  removeDomainBinding(id: string): Promise<void>;
}

export function createDomainService(pool: DbPool): DomainService {
  return {
    async addDomainBinding(input) {
      if (!isStableId(input.siteId)) throw new RoutingError("SITE_NOT_FOUND", `invalid site id`);
      const hostname = normalizeHostname(input.hostname);
      const schemePolicy = input.schemePolicy ?? "https";
      const canonicalRedirectPolicy = input.canonicalRedirectPolicy ?? "redirect";
      return pool.withTransaction(async (tx) => {
        let isPrimary = input.isPrimary ?? false;
        if (isPrimary) {
          // Only one primary per site (spec §37).
          await tx.query(`UPDATE domain_bindings SET is_primary = false WHERE site_id = $1`, [
            input.siteId,
          ]);
        } else {
          const anyPrimary = await tx.query<{ n: string }>(
            `SELECT COUNT(*) AS n FROM domain_bindings WHERE site_id = $1 AND is_primary`,
            [input.siteId],
          );
          // The first binding of a site becomes primary by default — a site
          // without a canonical origin cannot generate absolute URLs.
          isPrimary = Number(anyPrimary.rows[0]?.n ?? "0") === 0;
        }
        const id = newStableId();
        try {
          await tx.query(
            `INSERT INTO domain_bindings (id, site_id, hostname, scheme_policy, is_primary, canonical_redirect_policy, locale)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              id,
              input.siteId,
              hostname,
              schemePolicy,
              isPrimary,
              canonicalRedirectPolicy,
              input.locale ?? null,
            ],
          );
        } catch (err) {
          if ((err as { code?: string }).code === "23505") {
            throw new RoutingError("DOMAIN_ALREADY_BOUND", `hostname already bound`, {
              details: { hostname },
            });
          }
          throw err;
        }
        const row = await tx.query<DomainRow>(`SELECT * FROM domain_bindings WHERE id = $1`, [id]);
        return toRecord(row.rows[0]);
      });
    },

    async listDomainBindings(siteId) {
      const result =
        siteId === undefined
          ? await pool.query<DomainRow>(`SELECT * FROM domain_bindings ORDER BY hostname`)
          : await pool.query<DomainRow>(
              `SELECT * FROM domain_bindings WHERE site_id = $1 ORDER BY hostname`,
              [siteId],
            );
      return result.rows.map(toRecord);
    },

    async findDomainByHostname(hostname) {
      const host = normalizeHostname(hostname);
      const result = await pool.query<DomainRow>(
        `SELECT * FROM domain_bindings WHERE hostname = $1`,
        [host],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async resolveHost(hostname) {
      const binding = await this.findDomainByHostname(hostname);
      if (binding === null) {
        throw new RoutingError("DOMAIN_NOT_ALLOWED", `host is not a configured domain binding`, {
          details: { hostname: normalizeHostname(hostname) },
        });
      }
      return binding;
    },

    async setPrimaryDomain(bindingId) {
      if (!isStableId(bindingId)) {
        throw new RoutingError("DOMAIN_NOT_ALLOWED", `invalid binding id`);
      }
      return pool.withTransaction(async (tx) => {
        const current = await tx.query<DomainRow>(`SELECT * FROM domain_bindings WHERE id = $1`, [
          bindingId,
        ]);
        if (current.rows[0] === undefined) {
          throw new RoutingError("DOMAIN_NOT_ALLOWED", `binding not found`, {
            details: { binding_id: bindingId },
          });
        }
        await tx.query(`UPDATE domain_bindings SET is_primary = false WHERE site_id = $1`, [
          current.rows[0].site_id,
        ]);
        await tx.query(`UPDATE domain_bindings SET is_primary = true WHERE id = $1`, [bindingId]);
        const row = await tx.query<DomainRow>(`SELECT * FROM domain_bindings WHERE id = $1`, [
          bindingId,
        ]);
        return toRecord(row.rows[0]);
      });
    },

    async removeDomainBinding(id) {
      await pool.query(`DELETE FROM domain_bindings WHERE id = $1`, [id]);
    },
  };
}
