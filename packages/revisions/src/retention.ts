// Sealed-revision retention (2026-09-29, site-developer report: sealed
// history grew unbounded). Policy: per entity, keep the newest KEEP sealed
// revisions; the currently published revision is NEVER deleted regardless of
// age/position. Runs through the same sanctioned opt-in as the operation
// delete (transaction-local GUC past revisions_sealed_delete_guard), inside
// one transaction, and detaches children first (parent_revision_id is
// provenance). WORKING drafts are never touched — they are editable content.
import type { DbPool } from "@pcms/core";

export const REVISIONS_RETENTION_KEEP_DEFAULT = 50;

export interface RevisionsRetentionStats {
  readonly entities_scanned: number;
  readonly deleted: number;
}

export async function sweepSealedRevisions(
  pool: DbPool,
  options: { readonly keep?: number; readonly now?: Date } = {},
): Promise<RevisionsRetentionStats> {
  const keep = Math.max(1, options.keep ?? REVISIONS_RETENTION_KEEP_DEFAULT);
  return pool.withTransaction(async (tx) => {
    // Sanctioned path only: the guard trigger keeps every other writer out.
    await tx.query("SET LOCAL pcms.allow_sealed_delete = 'on'");
    const doomed = await tx.query<{ id: string; entities: number }>(
      `WITH ranked AS (
         SELECT r.id,
                ROW_NUMBER() OVER (
                  PARTITION BY r.entity_type, r.entity_id
                  ORDER BY r.revision_no DESC
                ) AS rn,
                COUNT(*) OVER (PARTITION BY r.entity_type, r.entity_id) AS entities
         FROM revisions r
         WHERE r.entity_type = 'entry' AND r.state = 'SEALED'
       ),
       published AS (
         SELECT DISTINCT current_revision_id FROM publications
         WHERE state = 'PUBLISHED' AND current_revision_id IS NOT NULL
       )
       SELECT id, entities FROM ranked
       WHERE rn > $1
         AND id NOT IN (SELECT current_revision_id FROM published)`,
      [keep],
    );
    if (doomed.rows.length === 0) return { entities_scanned: 0, deleted: 0 };
    const ids = doomed.rows.map((row) => row.id);
    const entities = Math.max(...doomed.rows.map((row) => row.entities));
    await tx.query(
      `UPDATE revisions SET parent_revision_id = NULL WHERE parent_revision_id = ANY($1::uuid[])`,
      [ids],
    );
    const deleted = await tx.query<{ count: string }>(
      "WITH gone AS (DELETE FROM revisions WHERE id = ANY($1::uuid[]) RETURNING id) SELECT count(*) FROM gone",
      [ids],
    );
    return { entities_scanned: Number(entities), deleted: Number(deleted.rows[0]?.count ?? 0) };
  });
}
