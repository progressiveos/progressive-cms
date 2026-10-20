// Redirect-import operations (PCMS-NAV-T022 surface; Navigation spec
// §33/§60). Thin permission-checked wrappers over @pcms/routing's
// validateRedirectImports/applyRedirectImports: the invariants (open-redirect
// guard, loop/chain graph checks, batch bound, atomic apply) live there.

import {
  applyRedirectImports,
  type ImportReport,
  type RedirectImportRow,
  validateRedirectImports,
} from "@pcms/routing";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export interface RedirectImportWireRow {
  readonly source: unknown;
  readonly target: unknown;
  readonly status_code?: unknown;
  readonly reason?: unknown;
}

export interface RedirectImportInput {
  readonly site?: string;
  readonly rows: readonly RedirectImportWireRow[];
}

async function requireSite(app: ApplicationServices, siteKey: string | undefined) {
  const key = siteKey ?? app.defaultSiteKey;
  if (typeof key !== "string" || key === "") {
    throw new ApiError("API_REQUEST_INVALID", "site key is required", { status: 400 });
  }
  const site = await app.routes.findSiteByKey(key);
  if (site === null) {
    throw new ApiError("SITE_NOT_FOUND", `site "${key}" does not exist`, { status: 404 });
  }
  return site;
}

function wireRows(input: RedirectImportInput): readonly RedirectImportRow[] {
  if (!Array.isArray(input.rows)) {
    throw new ApiError("API_REQUEST_INVALID", "rows must be an array", { status: 400 });
  }
  if (input.rows.length === 0) {
    throw new ApiError("API_REQUEST_INVALID", "rows must not be empty", { status: 400 });
  }
  return input.rows.map((row) => {
    if (typeof row.source !== "string" || row.source === "") {
      throw new ApiError("API_REQUEST_INVALID", "row.source must be a non-empty string", {
        status: 400,
      });
    }
    if (row.target !== undefined && row.target !== null && typeof row.target !== "string") {
      throw new ApiError("API_REQUEST_INVALID", "row.target must be a string or null", {
        status: 400,
      });
    }
    if (
      row.status_code !== undefined &&
      row.status_code !== null &&
      typeof row.status_code !== "number"
    ) {
      throw new ApiError("API_REQUEST_INVALID", "row.status_code must be a number", {
        status: 400,
      });
    }
    if (row.reason !== undefined && row.reason !== null && typeof row.reason !== "string") {
      throw new ApiError("API_REQUEST_INVALID", "row.reason must be a string", { status: 400 });
    }
    return {
      source: row.source,
      target: row.target === undefined ? null : (row.target as string | null),
      ...(row.status_code === undefined || row.status_code === null
        ? {}
        : { statusCode: row.status_code as 301 | 302 | 307 | 308 | 410 }),
      ...(row.reason === undefined || row.reason === null ? {} : { reason: row.reason as string }),
    };
  });
}

async function resolveSiteId(app: ApplicationServices, siteKey: string | undefined) {
  const site = await requireSite(app, siteKey);
  return site.id as string;
}

/** Dry-run: per-row report + graph issues, writes nothing. */
export async function validateRedirectImportOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: RedirectImportInput,
): Promise<{ report: ImportReport }> {
  requirePermission(app, ctx, "routing.redirects.import");
  const siteId = await resolveSiteId(app, input.site);
  const report = await validateRedirectImports(app.pool, siteId, wireRows(input));
  return { report };
}

/** Validate + atomic apply: any row or graph error aborts the whole batch. */
export async function applyRedirectImportOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: RedirectImportInput,
): Promise<{ report: ImportReport; applied: boolean }> {
  requirePermission(app, ctx, "routing.redirects.import");
  const siteId = await resolveSiteId(app, input.site);
  const report = await applyRedirectImports(app.pool, siteId, wireRows(input));
  return { report, applied: report.ok };
}
