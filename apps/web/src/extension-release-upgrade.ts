import type { DbPool } from "@pcms/core";
import type { ExtensionLifecycleService } from "@pcms/extensions/internal";

/** Old orchestrators reconcile the old catalog; finish once in the activated release. */
export async function finishBundledExtensionUpgrade(input: {
  readonly pool: DbPool;
  readonly version: string;
  /** Only the release's first-party catalog, never independent packages. */
  readonly lifecycle: Pick<ExtensionLifecycleService, "reconcileIdentity">;
}): Promise<void> {
  await input.pool.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1, $2)", [180519, 68]);
    const history = await tx.query<{ id: string }>(
      `SELECT id FROM pcms_update_history WHERE to_version = $1 AND from_version <> to_version
       AND status = 'SUCCEEDED' ORDER BY completed_at DESC LIMIT 1`,
      [input.version],
    );
    const id = history.rows[0]?.id;
    if (id === undefined) return;
    const key = `update.bundled_reconciled.${id}`;
    const done = await tx.query("SELECT key FROM pcms_kernel_metadata WHERE key = $1", [key]);
    if (done.rows.length > 0) return;
    await input.lifecycle.reconcileIdentity();
    await tx.query(
      "INSERT INTO pcms_kernel_metadata (key, value, updated_at) VALUES ($1, $2, now())",
      [key, input.version],
    );
  });
}
