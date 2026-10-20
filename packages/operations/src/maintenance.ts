// CMS Maintenance Mode service (PCMS-OPS-T118; Operations spec §62,
// task brief §19–§34, §68).
//
// Maintenance mode is site state in the database (singleton row, migration
// 1501): the public Internet sees the branded Core-owned 503 page, while
// holders of `site.maintenance.bypass` keep seeing the real site and Admin
// stays reachable. The service owns state reads/writes only — transport
// surfaces (REST/CLI/middleware) and audit wiring live in their own layers.
// The table is absent on pre-M15 databases: reads report `null` and callers
// decide the honest wording.
import type { DbPool } from "@pcms/core";

export interface MaintenanceState {
  readonly enabled: boolean;
  readonly title: string;
  readonly message: string;
  readonly promoLabel: string;
  readonly promoUrl: string;
  readonly retryAfterSeconds: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface MaintenanceStatePatch {
  readonly enabled?: boolean;
  readonly title?: string;
  readonly message?: string;
  readonly promoLabel?: string;
  readonly promoUrl?: string;
  readonly retryAfterSeconds?: number;
}

export interface MaintenanceClock {
  now(): Date;
}

export async function maintenanceStateTableExists(pool: DbPool): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('pcms_maintenance_state') IS NOT NULL AS exists",
  );
  return result.rows[0]?.exists === true;
}

/** Reads the singleton state; `null` when the table/row does not exist yet. */
export async function readMaintenanceState(pool: DbPool): Promise<MaintenanceState | null> {
  if (!(await maintenanceStateTableExists(pool))) return null;
  const result = await pool.query<{
    enabled: boolean;
    title: string;
    message: string;
    promo_label: string;
    promo_url: string;
    retry_after_seconds: number;
    updated_at: string;
    updated_by: string;
  }>(
    `SELECT enabled, title, message, promo_label, promo_url, retry_after_seconds,
            updated_at::text AS updated_at, updated_by
     FROM pcms_maintenance_state WHERE id = 1`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    enabled: row.enabled,
    title: row.title,
    message: row.message,
    promoLabel: row.promo_label,
    promoUrl: row.promo_url,
    retryAfterSeconds: row.retry_after_seconds,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Applies a partial patch in one transaction and stamps the actor. The
 * actor reference is an identity STRING (e.g. `user:<id>` / `cli:operator`)
 * — this layer never resolves sessions itself.
 */
export async function updateMaintenanceState(
  pool: DbPool,
  clock: MaintenanceClock,
  patch: MaintenanceStatePatch,
  updatedBy: string,
): Promise<MaintenanceState> {
  return pool.withClient(async (client) => {
    const fields: string[] = [];
    const values: unknown[] = [];
    let index = 1;
    const add = (column: string, value: unknown): void => {
      fields.push(`${column} = $${index}`);
      values.push(value);
      index += 1;
    };
    if (patch.enabled !== undefined) add("enabled", patch.enabled);
    if (patch.title !== undefined) add("title", patch.title);
    if (patch.message !== undefined) add("message", patch.message);
    if (patch.promoLabel !== undefined) add("promo_label", patch.promoLabel);
    if (patch.promoUrl !== undefined) add("promo_url", patch.promoUrl);
    if (patch.retryAfterSeconds !== undefined) add("retry_after_seconds", patch.retryAfterSeconds);
    add("updated_at", clock.now());
    add("updated_by", updatedBy);
    const result = await client.query(
      `UPDATE pcms_maintenance_state SET ${fields.join(", ")} WHERE id = 1
       RETURNING enabled, title, message, promo_label, promo_url, retry_after_seconds,
                 updated_at::text AS updated_at, updated_by`,
      values,
    );
    const row = result.rows[0] as
      | {
          enabled: boolean;
          title: string;
          message: string;
          promo_label: string;
          promo_url: string;
          retry_after_seconds: number;
          updated_at: string;
          updated_by: string;
        }
      | undefined;
    if (row === undefined) {
      // The migration seeds the singleton row; a missing row means the
      // deployment predates the seed — fail loudly instead of inventing one.
      throw new Error("pcms_maintenance_state singleton row missing (run migrations)");
    }
    return {
      enabled: row.enabled,
      title: row.title,
      message: row.message,
      promoLabel: row.promo_label,
      promoUrl: row.promo_url,
      retryAfterSeconds: row.retry_after_seconds,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  });
}
