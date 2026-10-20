// Route history and explicit canonical route changes (PCMS-NAV-T015;
// Navigation spec §31/§32/§59). Renaming a canonical path never destroys the
// old one: the retired path becomes a historical redirect source. Route
// mutation is an explicit high-risk operation — it is a separate service
// call, never a side effect of content edits (LLM agents included, §59).
import { type DbClient, type DbPool, isStableId, newStableId } from "@pcms/core";
import { RoutingError } from "./errors.js";
import { normalizeStoredPath } from "./path.js";
import { parsePathPolicy, type RoutePathPolicy } from "./policy.js";
import { createReservedRouteRegistry } from "./reserved.js";

export type RedirectStatusCode = 301 | 302 | 307 | 308 | 410;

export interface RouteHistoryRecord {
  readonly id: string;
  readonly siteId: string;
  readonly domainBindingId: string | null;
  readonly locale: string;
  readonly oldPath: string;
  /** "entry" = target Entry ID, "path" = internal target path, null = gone. */
  readonly targetType: "entry" | "path" | null;
  readonly targetId: string | null;
  readonly statusCode: RedirectStatusCode;
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly retiredAt: Date | null;
}

export interface ChangeRouteInput {
  readonly siteId: string;
  /** The entry whose canonical path changes. */
  readonly entryId: string;
  /** Current canonical path of the entry. */
  readonly fromPath: string;
  readonly toPath: string;
  readonly locale?: string | null;
  readonly domainBindingId?: string | null;
  /** Canonical migrations default to a permanent redirect (spec §32). */
  readonly statusCode?: RedirectStatusCode;
  readonly reason?: string | null;
}

export interface RecordRedirectInput {
  readonly siteId: string;
  readonly oldPath: string;
  readonly targetType: "entry" | "path" | null;
  readonly targetId: string | null;
  readonly statusCode: RedirectStatusCode;
  readonly locale?: string | null;
  readonly domainBindingId?: string | null;
  readonly reason?: string | null;
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

function toHistoryRecord(row: HistoryRow | undefined): RouteHistoryRecord {
  if (row === undefined) throw new RoutingError("REDIRECT_NOT_FOUND", `history row missing`);
  return {
    id: row.id,
    siteId: row.site_id,
    domainBindingId: row.domain_binding_id,
    locale: row.locale,
    oldPath: row.old_path,
    targetType: row.target_type as RouteHistoryRecord["targetType"],
    targetId: row.target_id,
    statusCode: row.status_code as RedirectStatusCode,
    reason: row.reason,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
  };
}

const VALID_STATUS: readonly RedirectStatusCode[] = [301, 302, 307, 308, 410];

export interface RouteHistoryService {
  /**
   * Explicit canonical route change (spec §59): retires the old route,
   * activates the new one, writes a history row and collapses prior alias
   * rows to point straight at the new path (spec §33). Atomic (§41).
   */
  changeRoute(input: ChangeRouteInput): Promise<{ oldPath: string; newPath: string }>;
  /** Operator-authored redirect (bulk import / manual fixes). */
  recordRedirect(input: RecordRedirectInput): Promise<RouteHistoryRecord>;
  listHistory(siteId: string): Promise<RouteHistoryRecord[]>;
  /** The active redirect registered for a path, if any. */
  findActiveRedirect(
    siteId: string,
    path: string,
    locale?: string | null,
  ): Promise<RouteHistoryRecord | null>;
  retireRedirect(input: { siteId: string; oldPath: string; locale?: string | null }): Promise<void>;
  /**
   * Transaction-scoped redirect write (PCMS-PUB-T015 additive seam,
   * Publication spec §18): identical behavior to `recordRedirect` on a
   * caller-owned DbClient so unpublish route policies join one publication
   * transaction.
   */
  recordRedirectWithinTx(client: DbClient, input: RecordRedirectInput): Promise<RouteHistoryRecord>;
}

export function createRouteHistoryService(pool: DbPool): RouteHistoryService {
  const reserved = createReservedRouteRegistry();

  /** Loads the site's stored Routing Policy (single normalization source). */
  async function sitePolicy(siteId: string): Promise<RoutePathPolicy> {
    const result = await pool.query<{ path_policy: unknown }>(
      `SELECT path_policy FROM sites WHERE id = $1`,
      [siteId],
    );
    return parsePathPolicy(result.rows[0]?.path_policy);
  }

  function assertStatus(statusCode: RedirectStatusCode): void {
    if (!VALID_STATUS.includes(statusCode)) {
      throw new RoutingError(
        "REDIRECT_STATUS_INVALID",
        `status must be one of 301/302/307/308/410`,
        {
          details: { status_code: statusCode },
        },
      );
    }
  }

  /** Shared write core: runs on the supplied executor (pool tx or caller tx). */
  async function recordRedirectOn(
    client: DbClient,
    input: RecordRedirectInput,
    policy: RoutePathPolicy,
  ): Promise<RouteHistoryRecord> {
    const oldPath = normalizeStoredPath(input.oldPath, policy);
    reserved.assertNotReserved(oldPath);
    if (input.targetType === "path" && input.targetId !== null) {
      if (normalizeStoredPath(input.targetId, policy) === oldPath) {
        throw new RoutingError("REDIRECT_LOOP", `a path cannot redirect to itself`, {
          details: { path: oldPath },
        });
      }
    }
    const site = await client.query<{ id: string; default_locale: string }>(
      `SELECT id, default_locale FROM sites WHERE id = $1`,
      [input.siteId],
    );
    const siteRow = site.rows[0];
    if (siteRow === undefined) throw new RoutingError("SITE_NOT_FOUND", `site not found`);
    const locale = input.locale ?? siteRow.default_locale;
    const id = newStableId();
    try {
      await client.query(
        `INSERT INTO route_history (id, site_id, domain_binding_id, locale, old_path, target_type, target_id, status_code, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          siteRow.id,
          input.domainBindingId ?? null,
          locale,
          oldPath,
          input.targetType,
          input.targetId,
          input.statusCode,
          input.reason ?? null,
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new RoutingError("ROUTE_COLLISION", `a redirect already exists for this path`, {
          details: { path: oldPath },
        });
      }
      throw err;
    }
    const row = await client.query<HistoryRow>(`SELECT * FROM route_history WHERE id = $1`, [id]);
    return toHistoryRecord(row.rows[0]);
  }

  return {
    async changeRoute(input) {
      if (!isStableId(input.entryId)) {
        throw new RoutingError("NAV_TARGET_MISSING", `invalid entry id`);
      }
      const statusCode = input.statusCode ?? 301;
      assertStatus(statusCode);
      const policy = await sitePolicy(input.siteId);
      const fromPath = normalizeStoredPath(input.fromPath, policy);
      const toPath = normalizeStoredPath(input.toPath, policy);
      reserved.assertNotReserved(toPath);
      if (fromPath === toPath) {
        throw new RoutingError("REDIRECT_LOOP", `a path cannot redirect to itself`, {
          details: { path: fromPath },
        });
      }
      return pool.withTransaction(async (tx) => {
        const site = await tx.query<{ id: string; default_locale: string }>(
          `SELECT id, default_locale FROM sites WHERE id = $1`,
          [input.siteId],
        );
        const siteRow = site.rows[0];
        if (siteRow === undefined) throw new RoutingError("SITE_NOT_FOUND", `site not found`);
        const locale = input.locale ?? siteRow.default_locale;
        const domainBindingId = input.domainBindingId ?? null;

        // The old route must exist and belong to this entry.
        const old = await tx.query<RouteRow>(
          `SELECT * FROM routes
           WHERE site_id = $1 AND path = $2 AND locale = $3
             AND domain_binding_id IS NOT DISTINCT FROM $4
             AND retired_at IS NULL AND is_canonical`,
          [siteRow.id, fromPath, locale, domainBindingId],
        );
        const oldRoute = old.rows[0];
        if (oldRoute === undefined) {
          throw new RoutingError("ROUTE_NOT_FOUND", `no active route at fromPath`, {
            details: { path: fromPath },
          });
        }
        if (oldRoute.target_id !== input.entryId) {
          throw new RoutingError("ROUTE_COLLISION", `fromPath belongs to a different entry`, {
            details: { path: fromPath, entry_id: oldRoute.target_id },
          });
        }
        // The new path must be free (fail before activation, spec §30).
        const clash = await tx.query<RouteRow>(
          `SELECT id FROM routes
           WHERE site_id = $1 AND path = $2 AND locale = $3
             AND domain_binding_id IS NOT DISTINCT FROM $4
             AND retired_at IS NULL AND is_canonical`,
          [siteRow.id, toPath, locale, domainBindingId],
        );
        if (clash.rows[0] !== undefined) {
          throw new RoutingError("ROUTE_COLLISION", `an active route already claims the new path`, {
            details: { path: toPath },
          });
        }
        // Retire old, activate new.
        await tx.query(`UPDATE routes SET retired_at = now() WHERE id = $1`, [oldRoute.id]);
        await tx.query(
          `INSERT INTO routes (id, site_id, domain_binding_id, locale, path, target_type, target_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newStableId(), siteRow.id, domainBindingId, locale, toPath, "entry", input.entryId],
        );
        // History: the old path now redirects to the new canonical path.
        await tx.query(
          `INSERT INTO route_history (id, site_id, domain_binding_id, locale, old_path, target_type, target_id, status_code, reason)
           VALUES ($1, $2, $3, $4, $5, 'path', $6, $7, $8)`,
          [
            newStableId(),
            siteRow.id,
            domainBindingId,
            locale,
            fromPath,
            toPath,
            statusCode,
            input.reason ?? null,
          ],
        );
        // Collapse prior aliases that pointed at fromPath straight to toPath
        // (spec §33): A → B, B → C becomes A → C, B → C.
        await tx.query(
          `UPDATE route_history
           SET target_id = $2, status_code = $3
           WHERE site_id = $1 AND retired_at IS NULL AND target_type = 'path' AND target_id = $4`,
          [siteRow.id, toPath, statusCode, fromPath],
        );
        return { oldPath: fromPath, newPath: toPath };
      });
    },

    async recordRedirect(input) {
      assertStatus(input.statusCode);
      const policy = await sitePolicy(input.siteId);
      return pool.withTransaction(async (tx) => recordRedirectOn(tx, input, policy));
    },

    async recordRedirectWithinTx(client, input) {
      assertStatus(input.statusCode);
      const policy = await sitePolicy(input.siteId);
      return recordRedirectOn(client, input, policy);
    },

    async listHistory(siteId) {
      const result = await pool.query<HistoryRow>(
        `SELECT * FROM route_history WHERE site_id = $1 AND retired_at IS NULL ORDER BY created_at, old_path`,
        [siteId],
      );
      return result.rows.map(toHistoryRecord);
    },

    async findActiveRedirect(siteId, path, locale) {
      const site = await pool.query<{ id: string; default_locale: string }>(
        `SELECT id, default_locale FROM sites WHERE id = $1`,
        [siteId],
      );
      const siteRow = site.rows[0];
      if (siteRow === undefined) throw new RoutingError("SITE_NOT_FOUND", `site not found`);
      const result = await pool.query<HistoryRow>(
        `SELECT * FROM route_history
         WHERE site_id = $1 AND locale = $2 AND old_path = $3 AND retired_at IS NULL`,
        [siteRow.id, locale ?? siteRow.default_locale, path],
      );
      const row = result.rows[0];
      return row === undefined ? null : toHistoryRecord(row);
    },

    async retireRedirect({ siteId, oldPath, locale }) {
      await pool.withTransaction(async (tx) => {
        const site = await tx.query<{ id: string; default_locale: string }>(
          `SELECT id, default_locale FROM sites WHERE id = $1`,
          [siteId],
        );
        const siteRow = site.rows[0];
        if (siteRow === undefined) throw new RoutingError("SITE_NOT_FOUND", `site not found`);
        const result = await tx.query<{ id: string }>(
          `UPDATE route_history SET retired_at = now()
           WHERE site_id = $1 AND locale = $2 AND old_path = $3 AND retired_at IS NULL
           RETURNING id`,
          [siteRow.id, locale ?? siteRow.default_locale, oldPath],
        );
        if (result.rows.length === 0) {
          throw new RoutingError("REDIRECT_NOT_FOUND", `no active redirect for this path`, {
            details: { path: oldPath },
          });
        }
      });
    },
  };
}
