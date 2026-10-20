// Bulk redirect import (PCMS-NAV-T022; Navigation spec §60/§33).
// Migration tooling feeds `old URL → new Entry/URL` batches; the validator
// produces a per-row report (shape, reserved paths, self redirects, batch
// duplicates, loops and chains across the batch AND existing history)
// before anything is written. Apply is atomic: any error aborts the batch.
import { type DbPool, isStableId } from "@pcms/core";
import { RoutingError } from "./errors.js";
import { normalizeStoredPath } from "./path.js";
import { DEFAULT_MAX_REDIRECT_CHAIN, parsePathPolicy } from "./policy.js";
import { createReservedRouteRegistry } from "./reserved.js";

export type ImportStatusCode = 301 | 302 | 307 | 308 | 410;

/** Abuse bound: a single import batch stays reviewable. */
export const MAX_IMPORT_ROWS = 10_000;

export interface RedirectImportRow {
  /** Old path, e.g. "/old-page.html". */
  readonly source: string;
  /** New site-relative path or a stable Entry ID; ignored with 410. */
  readonly target: string | null;
  readonly statusCode?: ImportStatusCode;
  readonly reason?: string | null;
}

export interface ImportRowReport {
  readonly index: number;
  readonly status: "ok" | "error";
  readonly oldPath: string;
  readonly target: string | null;
  readonly statusCode: ImportStatusCode;
  readonly code?:
    | "ROUTE_PATH_INVALID"
    | "ROUTE_INVALID_ENCODING"
    | "ROUTE_RESERVED"
    | "REDIRECT_LOOP"
    | "ROUTE_COLLISION"
    | "REDIRECT_STATUS_INVALID"
    | "ROUTE_TARGET_INVALID";
  readonly message?: string;
}

export interface ImportReport {
  readonly ok: boolean;
  readonly rows: readonly ImportRowReport[];
  readonly issues: readonly {
    code: "REDIRECT_LOOP" | "REDIRECT_CHAIN_TOO_LONG";
    path: string;
    message: string;
  }[];
}

interface ValidRow {
  readonly oldPath: string;
  readonly targetType: "entry" | "path" | null;
  readonly targetId: string | null;
  readonly statusCode: ImportStatusCode;
  readonly reason: string | null;
}

const RESERVED = createReservedRouteRegistry();
const VALID_STATUS: readonly ImportStatusCode[] = [301, 302, 307, 308, 410];

/**
 * Validates an import batch against the site Routing Policy and the existing
 * redirect graph (which is collapsed — chains are short). Pure: writes nothing.
 */
export async function validateRedirectImports(
  pool: DbPool,
  siteId: string,
  rows: readonly RedirectImportRow[],
  options?: { maxChain?: number },
): Promise<ImportReport> {
  const maxChain = options?.maxChain ?? DEFAULT_MAX_REDIRECT_CHAIN;
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new RoutingError("REDIRECT_IMPORT_TOO_LARGE", `import batch exceeds the row bound`, {
      details: { rows: rows.length, max: MAX_IMPORT_ROWS },
    });
  }
  const policyRow = await pool.query<{ path_policy: unknown }>(
    `SELECT path_policy FROM sites WHERE id = $1`,
    [siteId],
  );
  if (policyRow.rows[0] === undefined) throw new RoutingError("SITE_NOT_FOUND", `site not found`);
  const policy = parsePathPolicy(policyRow.rows[0].path_policy);

  const reports: ImportRowReport[] = [];
  const valid: ValidRow[] = [];
  const seenSources = new Map<string, number>();

  for (const [index, row] of rows.entries()) {
    const statusCode = row.statusCode ?? 301;
    const fail = (
      code: NonNullable<ImportRowReport["code"]>,
      message: string,
    ): ImportRowReport => ({
      index,
      status: "error",
      oldPath: row.source,
      target: row.target,
      statusCode,
      code,
      message,
    });
    if (!VALID_STATUS.includes(statusCode)) {
      reports.push(fail("REDIRECT_STATUS_INVALID", `status must be 301/302/307/308/410`));
      continue;
    }
    let oldPath: string;
    try {
      oldPath = normalizeStoredPath(row.source, policy);
    } catch (err) {
      reports.push(
        fail(
          err instanceof RoutingError && err.code === "ROUTE_INVALID_ENCODING"
            ? "ROUTE_INVALID_ENCODING"
            : "ROUTE_PATH_INVALID",
          `invalid source path`,
        ),
      );
      continue;
    }
    if (RESERVED.isReserved(oldPath)) {
      reports.push(fail("ROUTE_RESERVED", `source claims a reserved namespace`));
      continue;
    }
    // A source may not shadow an active route (spec §60 preflight).
    const activeRoute = await pool.query(
      `SELECT id FROM routes WHERE site_id = $1 AND path = $2 AND retired_at IS NULL AND is_canonical`,
      [siteId, oldPath],
    );
    if (activeRoute.rows.length > 0) {
      reports.push(fail("ROUTE_COLLISION", `source is an active route; retire it first`));
      continue;
    }
    const duplicateOf = seenSources.get(oldPath);
    if (duplicateOf !== undefined) {
      reports.push(fail("ROUTE_COLLISION", `duplicate source of row ${duplicateOf}`));
      continue;
    }
    seenSources.set(oldPath, index);
    // An already-active redirect for the same source would break the
    // (site_id, locale, old_path) unique index at apply time — report it as
    // a preflight collision instead (spec §60: nothing silently overwritten).
    const existingRedirect = await pool.query(
      `SELECT 1 FROM route_history
       WHERE site_id = $1 AND old_path = $2 AND retired_at IS NULL
       LIMIT 1`,
      [siteId, oldPath],
    );
    if (existingRedirect.rows.length > 0) {
      reports.push(
        fail(
          "ROUTE_COLLISION",
          `source already has an active redirect; retire it first or change the existing row`,
        ),
      );
      continue;
    }

    let targetType: "entry" | "path" | null = null;
    let targetId: string | null = null;
    if (statusCode !== 410) {
      if (row.target === null || row.target === undefined || row.target === "") {
        reports.push(fail("ROUTE_TARGET_INVALID", `non-410 rows need a target`));
        continue;
      }
      if (isStableId(row.target)) {
        targetType = "entry";
        targetId = row.target;
      } else {
        try {
          targetId = normalizeStoredPath(row.target, policy);
        } catch {
          reports.push(fail("ROUTE_PATH_INVALID", `invalid target path`));
          continue;
        }
        if (RESERVED.isReserved(targetId)) {
          reports.push(fail("ROUTE_RESERVED", `target claims a reserved namespace`));
          continue;
        }
        targetType = "path";
        if (targetId === oldPath) {
          reports.push(fail("REDIRECT_LOOP", `self redirect`));
          continue;
        }
      }
    } else if (row.target !== null && row.target !== undefined && row.target !== "") {
      reports.push(fail("ROUTE_TARGET_INVALID", `410 rows must not carry a target`));
      continue;
    }
    reports.push({ index, status: "ok", oldPath, target: targetId, statusCode });
    valid.push({ oldPath, targetType, targetId, statusCode, reason: row.reason ?? "bulk-import" });
  }

  // Graph safety over the batch merged with existing history rows (§33).
  const graph = new Map<string, string | null>();
  const existing = await pool.query<{
    old_path: string;
    target_type: string | null;
    target_id: string | null;
  }>(
    `SELECT old_path, target_type, target_id FROM route_history WHERE site_id = $1 AND retired_at IS NULL`,
    [siteId],
  );
  for (const row of existing.rows) {
    graph.set(row.old_path, row.target_type === "path" ? row.target_id : null);
  }
  for (const row of valid) {
    graph.set(row.oldPath, row.targetType === "path" ? row.targetId : null);
  }
  const issues: {
    code: "REDIRECT_LOOP" | "REDIRECT_CHAIN_TOO_LONG";
    path: string;
    message: string;
  }[] = [];
  for (const [source, target] of graph.entries()) {
    if (target === null) continue;
    const seen = new Set<string>([source]);
    let current: string | null = target;
    let edges = 1;
    let verdict: {
      code: "REDIRECT_LOOP" | "REDIRECT_CHAIN_TOO_LONG";
      path: string;
      message: string;
    } | null = null;
    while (current !== null) {
      if (seen.has(current)) {
        verdict = { code: "REDIRECT_LOOP", path: source, message: `loop through "${current}"` };
        break;
      }
      seen.add(current);
      const next = graph.get(current);
      if (next === undefined) break;
      edges += 1;
      if (edges > maxChain) {
        verdict = {
          code: "REDIRECT_CHAIN_TOO_LONG",
          path: source,
          message: `chain longer than ${maxChain}`,
        };
        break;
      }
      current = next;
    }
    if (verdict !== null) issues.push(verdict);
  }

  return {
    ok: issues.length === 0 && reports.every((r) => r.status === "ok"),
    rows: reports,
    issues,
  };
}

/**
 * Validates and applies the batch atomically: any error (row-level or graph)
 * aborts the whole import.
 */
export async function applyRedirectImports(
  pool: DbPool,
  siteId: string,
  rows: readonly RedirectImportRow[],
  options?: { maxChain?: number },
): Promise<ImportReport> {
  const report = await validateRedirectImports(pool, siteId, rows, options);
  if (!report.ok) return report;
  const site = await pool.query<{ id: string; default_locale: string }>(
    `SELECT id, default_locale FROM sites WHERE id = $1`,
    [siteId],
  );
  const siteRow = site.rows[0];
  if (siteRow === undefined) throw new RoutingError("SITE_NOT_FOUND", `site not found`);
  await pool.withTransaction(async (tx) => {
    for (const row of report.rows) {
      if (row.status !== "ok") continue;
      await tx.query(
        `INSERT INTO route_history (id, site_id, locale, old_path, target_type, target_id, status_code, reason)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
        [
          siteId,
          siteRow.default_locale,
          row.oldPath,
          row.target === null ? null : isStableId(row.target) ? "entry" : "path",
          row.target,
          row.statusCode,
          "bulk-import",
        ],
      );
    }
  });
  return report;
}
