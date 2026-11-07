import { randomUUID } from "node:crypto";
import type { DbPool } from "@pcms/core";
import { ExtensionError } from "./errors.js";

const KEY = "update.exclusive_lease";
// A durable handoff survives the web process stopping during extension activation.
export async function reserveUpdateLease(pool: DbPool, productId: string): Promise<string> {
  const id = randomUUID();
  await pool.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1, $2)", [180519, 67]);
    const existing = await tx.query("SELECT value FROM pcms_kernel_metadata WHERE key = $1", [KEY]);
    if (existing.rows.length)
      throw new ExtensionError(
        "UPDATE_ALREADY_RUNNING",
        "another update owns the installation; inspect update status before recovery",
      );
    await tx.query(
      "INSERT INTO pcms_kernel_metadata (key, value, updated_at) VALUES ($1, $2, now())",
      [
        KEY,
        JSON.stringify({
          id,
          product_id: productId,
          state: "STAGED",
          started_at: new Date().toISOString(),
        }),
      ],
    );
  });
  return id;
}

export async function claimUpdateLease(pool: DbPool, id: string): Promise<void> {
  const result = await pool.query(
    "UPDATE pcms_kernel_metadata SET value = jsonb_set(value::jsonb, '{state}', '\"RUNNING\"'::jsonb)::text, updated_at = now() WHERE key = $1 AND value::jsonb->>'id' = $2 AND value::jsonb->>'state' = 'STAGED' RETURNING key",
    [KEY, id],
  );
  if (!result.rowCount)
    throw new ExtensionError(
      "UPDATE_ALREADY_RUNNING",
      "update lease is absent, changed or already claimed",
    );
}

export async function releaseUpdateLease(pool: DbPool, id: string): Promise<void> {
  await pool.query(
    "DELETE FROM pcms_kernel_metadata WHERE key = $1 AND value::jsonb->>'id' = $2 AND value::jsonb->>'state' IN ('STAGED', 'RUNNING')",
    [KEY, id],
  );
}

/** A successful in-Web Core update still owns the host during its restart fuse. */
export async function deferUpdateLeaseUntilWebBoot(
  pool: DbPool,
  id: string,
  version: string,
): Promise<void> {
  const result = await pool.query(
    "UPDATE pcms_kernel_metadata SET value = (value::jsonb || jsonb_build_object('state', 'AWAITING_WEB_BOOT', 'target_version', $3::text))::text, updated_at = now() WHERE key = $1 AND value::jsonb->>'id' = $2 AND value::jsonb->>'product_id' = 'progressive.cms' AND value::jsonb->>'state' = 'RUNNING' RETURNING key",
    [KEY, id, version],
  );
  if (!result.rowCount)
    throw new ExtensionError(
      "UPDATE_ALREADY_RUNNING",
      "Core restart no longer owns its update lease",
    );
}

export async function finishCoreUpdateLeaseAfterWebBoot(
  pool: DbPool,
  version: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM pcms_kernel_metadata AS lease WHERE key = $1
     AND value::jsonb->>'product_id' = 'progressive.cms'
     AND value::jsonb->>'state' = 'AWAITING_WEB_BOOT'
     AND value::jsonb->>'target_version' = $2
     AND EXISTS (SELECT 1 FROM pcms_update_history AS history WHERE history.status = 'SUCCEEDED'
       AND history.validation_summary->>'update_lease_id' = lease.value::jsonb->>'id')`,
    [KEY, version],
  );
}
