// CMS Maintenance Mode operations (PCMS-OPS-T118). Transport-free: REST,
// MCP and CLI call these functions. Reads gate on site.maintenance; toggles
// and copy edits gate on site.maintenance and AUDIT into the M08
// security-event stream (task brief §33).
import { recordSecurityEvent } from "@pcms/auth";
import { systemClock } from "@pcms/core";
import { readMaintenanceState, updateMaintenanceState } from "@pcms/operations";
import type { ApplicationServices, OperationContext } from "./context.js";
import { auditBase, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export interface MaintenanceSettingsInput {
  readonly enabled?: boolean;
  readonly title?: string;
  readonly message?: string;
  readonly promoLabel?: string;
  readonly promoUrl?: string;
  readonly retryAfterSeconds?: number;
}

export async function getMaintenanceStateOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "site.maintenance");
  const state = await readMaintenanceState(app.pool);
  if (state === null) {
    return { enabled: false, configured: false };
  }
  return { configured: true, ...state };
}

export async function updateMaintenanceStateOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: MaintenanceSettingsInput,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "site.maintenance");
  const before = await readMaintenanceState(app.pool);
  if (before === null) {
    throw new ApiError(
      "MAINTENANCE_NOT_CONFIGURED",
      "maintenance state is not configured (run migrations)",
      {
        status: 409,
      },
    );
  }
  if (
    input.promoUrl !== undefined &&
    !/^https:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[^\s]*)?$/i.test(input.promoUrl)
  ) {
    throw new ApiError("API_REQUEST_INVALID", "promoUrl must be an https:// URL", { status: 422 });
  }
  if (input.retryAfterSeconds !== undefined && !Number.isInteger(input.retryAfterSeconds)) {
    throw new ApiError("API_REQUEST_INVALID", "retryAfterSeconds must be an integer", {
      status: 422,
    });
  }
  const after = await updateMaintenanceState(app.pool, systemClock, input, `user:${ctx.actor.id}`);
  const eventType =
    input.enabled === undefined
      ? "MAINTENANCE_SETTINGS_UPDATED"
      : input.enabled
        ? "MAINTENANCE_ENABLED"
        : "MAINTENANCE_DISABLED";
  await recordSecurityEvent(app.pool, null, {
    type: eventType,
    ...auditBase(ctx),
    subjectType: "site",
    subjectId: "maintenance",
    metadata: {
      enabled: after.enabled,
      previous_enabled: before.enabled,
      // Copy values are public page content, not secrets — only the actor
      // and the toggle transition are recorded here.
      updated_fields: Object.keys(input).sort(),
    },
  });
  return { configured: true, ...after };
}
