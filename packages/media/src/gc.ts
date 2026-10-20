// Orphan garbage collection (PCMS-MEDIA-T028 (P1); Media spec §39).
//
// GC works only on provably unreachable objects, proven by DB reachability
// — never by file age or naming heuristics. A blob row is reachable while
// ANY of these holds:
//   - a media_versions row points at it (immutable history is retained);
//   - a media_variants row points at it (rebuildable but still referenced);
//   - a media_assets.original_blob_id points at it.
// Originals are therefore structurally protected: their version rows exist
// as long as the asset/audit does. Dry-run first, destructive apply second.
import type { DbPool } from "@pcms/core";
import type { MediaStorage } from "./storage.js";

export interface GcCandidateBlob {
  readonly id: string;
  readonly sha256: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
}

export interface GcReport {
  /** Unreferenced blob rows + their physical objects. */
  readonly unreachableBlobs: readonly GcCandidateBlob[];
  /** Variant rows whose blob row is already gone (dangling caches). */
  readonly danglingVariants: readonly { readonly id: string; readonly blobId: string }[];
}

export async function gcDryRun(pool: DbPool): Promise<GcReport> {
  const blobs = await pool.query<GcCandidateBlob & Record<string, unknown>>(
    `SELECT b.id, b.sha256, b.storage_key AS "storageKey", b.size_bytes AS "sizeBytes"
     FROM media_blobs b
     WHERE NOT EXISTS (SELECT 1 FROM media_versions v WHERE v.blob_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM media_variants m WHERE m.blob_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM media_assets a WHERE a.original_blob_id = b.id)
     ORDER BY b.id`,
  );
  const dangling = await pool.query<{ id: string; blobId: string }>(
    `SELECT m.id, m.blob_id AS "blobId" FROM media_variants m
     WHERE NOT EXISTS (SELECT 1 FROM media_blobs b WHERE b.id = m.blob_id)
     ORDER BY m.id`,
  );
  return {
    unreachableBlobs: blobs.rows.map((row) => ({
      id: row.id,
      sha256: row.sha256,
      storageKey: row.storageKey,
      sizeBytes: Number(row.sizeBytes),
    })),
    danglingVariants: dangling.rows,
  };
}

export interface GcApplyResult {
  readonly removedBlobRows: number;
  readonly removedPhysicalObjects: number;
  readonly removedDanglingVariantRows: number;
  /** Bytes reclaimed by physical object removal. */
  readonly reclaimedBytes: number;
}

/**
 * Applies a dry-run report: deletes the dangling variant rows, the
 * unreachable blob rows and their physical objects. Blobs that appeared
 * between dry-run and apply are skipped conservatively — per blob, the
 * reachability re-check and the row delete run inside one transaction that
 * holds `FOR UPDATE` on the blob row (F-42), so a reference added mid-GC
 * aborts the delete. The physical storage object is removed only AFTER the
 * row-delete commit: a crash in between leaves an unreachable storage
 * object without a DB row — the conservative failure mode (the database
 * stays authoritative); deleting first could not be undone and would leave
 * a live row pointing at a removed object.
 */
export async function gcApply(
  pool: DbPool,
  storage: MediaStorage,
  report: GcReport,
): Promise<GcApplyResult> {
  let removedBlobRows = 0;
  let removedPhysicalObjects = 0;
  let reclaimedBytes = 0;

  for (const candidate of report.unreachableBlobs) {
    const deletedRow = await pool.withTransaction(async (tx) => {
      const locked = await tx.query<{ id: string }>(
        `SELECT id FROM media_blobs WHERE id = $1 FOR UPDATE`,
        [candidate.id],
      );
      if (locked.rows.length === 0) return false; // already gone (another GC)
      const stillUnreachable = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM media_versions v WHERE v.blob_id = $1
         UNION ALL
         SELECT count(*)::int AS n FROM media_variants m WHERE m.blob_id = $1
         UNION ALL
         SELECT count(*)::int AS n FROM media_assets a WHERE a.original_blob_id = $1`,
        [candidate.id],
      );
      if (stillUnreachable.rows.some((row) => row.n > 0)) return false;
      const deleted = await tx.query(`DELETE FROM media_blobs WHERE id = $1`, [candidate.id]);
      return (deleted.rowCount ?? 0) > 0;
    });
    if (!deletedRow) continue;
    removedBlobRows += 1;
    const removed = await storage.delete(candidate.storageKey).catch(() => false);
    if (removed) {
      removedPhysicalObjects += 1;
      reclaimedBytes += candidate.sizeBytes;
    }
  }

  let removedDanglingVariantRows = 0;
  for (const dangling of report.danglingVariants) {
    const deleted = await pool.query(`DELETE FROM media_variants WHERE id = $1`, [dangling.id]);
    removedDanglingVariantRows += deleted.rowCount ?? 0;
  }

  return { removedBlobRows, removedPhysicalObjects, removedDanglingVariantRows, reclaimedBytes };
}
