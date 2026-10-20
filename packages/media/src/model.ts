// Media domain persistence (PCMS-MEDIA-T002; Media spec §3/§6/§8/§9).
// Plain SQL over the shared `pg` pool (ADR-0002) — no ORM. The invariant the
// queries encode: original/version rows are insert-only; the asset's
// denormalized "current" columns change only inside the replacement
// transaction that also appends the new version row.
import type { DbClient, DbPool } from "@pcms/core";
import { isStableId, newStableId, type StableId } from "@pcms/core";
import { MediaError } from "./errors.js";

export type MediaKind = "image" | "document" | "generic_file" | "video" | "audio";
export const MEDIA_KINDS: readonly MediaKind[] = [
  "image",
  "document",
  "generic_file",
  "video",
  "audio",
];

export interface MediaMetadata {
  readonly title?: string | null;
  readonly altDefault?: string | null;
  readonly captionDefault?: string | null;
  readonly description?: string | null;
  readonly sourceName?: string | null;
  readonly sourceUrl?: string | null;
  readonly author?: string | null;
  readonly license?: string | null;
  readonly copyright?: string | null;
}

export interface MediaAssetRecord extends MediaMetadata {
  readonly id: StableId;
  readonly kind: MediaKind;
  /** Pointer to the current original (logical replacement, Media spec §8). */
  readonly currentVersionNo: number;
  readonly filenameOriginal: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  /** Default focal point, x/y in 0..1 (Media spec §15). */
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export interface MediaVersionRecord {
  readonly assetId: StableId;
  readonly versionNo: number;
  readonly blobId: StableId;
  readonly filenameOriginal: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface MediaBlobRecord {
  readonly id: StableId;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
  readonly createdAt: Date;
}

export interface NewVersionInput {
  readonly assetId: StableId;
  readonly versionNo: number;
  readonly blobId: StableId;
  readonly filenameOriginal: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly note?: string | null;
  readonly createdBy: string;
}

interface AssetRow extends Record<string, unknown> {
  id: string;
  kind: string;
  current_version_no: number;
  original_blob_id: string;
  filename_original: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  focal_x: string | null;
  focal_y: string | null;
  title: string | null;
  alt_default: string | null;
  caption_default: string | null;
  description: string | null;
  source_name: string | null;
  source_url: string | null;
  author: string | null;
  license: string | null;
  copyright: string | null;
  created_by: string;
  created_at: Date;
  archived_at: Date | null;
}

function assertAssetId(id: StableId): void {
  if (!isStableId(id)) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", "invalid media asset id");
  }
}

function toAsset(row: AssetRow): MediaAssetRecord {
  return {
    id: row.id as StableId,
    kind: row.kind as MediaKind,
    currentVersionNo: row.current_version_no,
    filenameOriginal: row.filename_original,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    focalX: row.focal_x === null ? null : Number(row.focal_x),
    focalY: row.focal_y === null ? null : Number(row.focal_y),
    title: row.title,
    altDefault: row.alt_default,
    captionDefault: row.caption_default,
    description: row.description,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    author: row.author,
    license: row.license,
    copyright: row.copyright,
    createdBy: row.created_by,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

interface VersionRow extends Record<string, unknown> {
  asset_id: string;
  version_no: number;
  blob_id: string;
  filename_original: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  width: number | null;
  height: number | null;
  note: string | null;
  created_by: string;
  created_at: Date;
}

function toVersion(row: VersionRow): MediaVersionRecord {
  return {
    assetId: row.asset_id as StableId,
    versionNo: row.version_no,
    blobId: row.blob_id as StableId,
    filenameOriginal: row.filename_original,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Inserts a blob row, deduplicating by SHA-256 (Media spec §35): when the
 * digest already exists the existing row wins — physical bytes are stored
 * once no matter how many assets/versions reference them. Caller persists
 * the bytes through the storage adapter before/alongside this call.
 */
export async function ensureBlobRow(
  client: DbClient,
  input: { sha256: string; sizeBytes: number; storageKey: string },
): Promise<{ blob: MediaBlobRecord; duplicated: boolean }> {
  const id = newStableId();
  const inserted = await client.query<Record<string, unknown>>(
    `INSERT INTO media_blobs (id, sha256, size_bytes, storage_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sha256) DO NOTHING
     RETURNING id`,
    [id, input.sha256, input.sizeBytes, input.storageKey],
  );
  const selected = await client.query<Record<string, unknown>>(
    `SELECT id, sha256, size_bytes, storage_key, created_at
     FROM media_blobs WHERE sha256 = $1`,
    [input.sha256],
  );
  const row = selected.rows[0];
  if (row === undefined) {
    throw new MediaError("MEDIA_BLOB_NOT_FOUND", "blob row vanished during upsert");
  }
  return {
    blob: {
      id: row.id as StableId,
      sha256: row.sha256 as string,
      sizeBytes: Number(row.size_bytes),
      storageKey: row.storage_key as string,
      createdAt: row.created_at as Date,
    },
    duplicated: inserted.rowCount === 0,
  };
}

export async function getBlobByHash(pool: DbPool, sha256: string): Promise<MediaBlobRecord | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT id, sha256, size_bytes, storage_key, created_at
     FROM media_blobs WHERE sha256 = $1`,
    [sha256],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        id: row.id as StableId,
        sha256: row.sha256 as string,
        sizeBytes: Number(row.size_bytes),
        storageKey: row.storage_key as string,
        createdAt: row.created_at as Date,
      };
}

export interface NewAssetInput {
  readonly id: StableId;
  readonly kind: MediaKind;
  readonly originalBlobId: StableId;
  readonly filenameOriginal: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly createdBy: string;
}

/**
 * Creates an asset together with its immutable version 1 in one transaction
 * (an asset without an accepted original version never exists, Media spec §40).
 */
export async function createAssetWithFirstVersion(
  pool: DbPool,
  asset: NewAssetInput,
  version: Omit<NewVersionInput, "assetId" | "versionNo">,
): Promise<MediaAssetRecord> {
  return pool.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO media_assets (
         id, kind, current_version_no, original_blob_id, filename_original,
         mime_type, size_bytes, sha256, width, height, duration_ms, created_by
       ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        asset.id,
        asset.kind,
        asset.originalBlobId,
        asset.filenameOriginal,
        asset.mimeType,
        asset.sizeBytes,
        asset.sha256,
        asset.width ?? null,
        asset.height ?? null,
        asset.durationMs ?? null,
        asset.createdBy,
      ],
    );
    await insertVersionRow(tx, { ...version, assetId: asset.id, versionNo: 1 });
    const created = await tx.query<AssetRow>(`SELECT * FROM media_assets WHERE id = $1`, [
      asset.id,
    ]);
    return toAsset(created.rows[0]!);
  });
}

/** Insert-only version row (audit trail, Media spec §9). */
async function insertVersionRow(client: DbClient, version: NewVersionInput): Promise<void> {
  await client.query(
    `INSERT INTO media_versions (
       asset_id, version_no, blob_id, filename_original, mime_type,
       size_bytes, sha256, width, height, note, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      version.assetId,
      version.versionNo,
      version.blobId,
      version.filenameOriginal,
      version.mimeType,
      version.sizeBytes,
      version.sha256,
      version.width ?? null,
      version.height ?? null,
      version.note ?? null,
      version.createdBy,
    ],
  );
}

export { insertVersionRow };

/**
 * Logical replacement commit (Media spec §8/§9/§51): appends the immutable
 * version row and moves the asset's current pointer + mirrored columns in
 * the same transaction. Readers never observe a half-replaced document.
 */
export async function commitReplacementVersion(
  pool: DbPool,
  version: NewVersionInput,
): Promise<MediaAssetRecord> {
  assertAssetId(version.assetId);
  return pool.withTransaction(async (tx) => {
    // Locking the asset row (not the aggregate) serializes concurrent
    // replacements and makes the pointer the source of truth for numbering.
    const locked = await tx.query<{ current_version_no: number }>(
      `SELECT current_version_no FROM media_assets WHERE id = $1 FOR UPDATE`,
      [version.assetId],
    );
    if (locked.rows[0] === undefined) {
      throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist");
    }
    const expected = locked.rows[0].current_version_no + 1;
    if (version.versionNo !== expected) {
      throw new MediaError(
        "MEDIA_VERSION_CONFLICT",
        `expected replacement version ${expected}, got ${version.versionNo}`,
      );
    }
    await insertVersionRow(tx, version);
    const updated = await tx.query<AssetRow>(
      `UPDATE media_assets SET
         current_version_no = $2,
         filename_original = $3,
         mime_type = $4,
         size_bytes = $5,
         sha256 = $6,
         width = $7,
         height = $8
       WHERE id = $1
       RETURNING *`,
      [
        version.assetId,
        version.versionNo,
        version.filenameOriginal,
        version.mimeType,
        version.sizeBytes,
        version.sha256,
        version.width ?? null,
        version.height ?? null,
      ],
    );
    if (updated.rows[0] === undefined) {
      throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist");
    }
    return toAsset(updated.rows[0]);
  });
}

export async function getAsset(pool: DbPool, id: StableId): Promise<MediaAssetRecord | null> {
  assertAssetId(id);
  const result = await pool.query<AssetRow>(`SELECT * FROM media_assets WHERE id = $1`, [id]);
  return result.rows[0] === undefined ? null : toAsset(result.rows[0]);
}

export async function listVersions(pool: DbPool, assetId: StableId): Promise<MediaVersionRecord[]> {
  assertAssetId(assetId);
  const result = await pool.query<VersionRow>(
    `SELECT * FROM media_versions WHERE asset_id = $1 ORDER BY version_no`,
    [assetId],
  );
  return result.rows.map(toVersion);
}

export interface MetadataPatch extends MediaMetadata {
  readonly focalX?: number | null;
  readonly focalY?: number | null;
}

const METADATA_COLUMNS: Readonly<Record<string, string>> = {
  title: "title",
  altDefault: "alt_default",
  captionDefault: "caption_default",
  description: "description",
  sourceName: "source_name",
  sourceUrl: "source_url",
  author: "author",
  license: "license",
  copyright: "copyright",
};

/**
 * Updates editorial metadata and/or the default focal point. Technical
 * identity columns (kind/sha256/size/blob) are deliberately unreachable
 * here — bytes change only through the replacement transaction.
 */
export async function updateAssetMetadata(
  pool: DbPool,
  assetId: StableId,
  patch: MetadataPatch,
): Promise<MediaAssetRecord> {
  assertAssetId(assetId);
  const sets: string[] = [];
  const values: unknown[] = [];
  let param = 2;
  for (const [key, column] of Object.entries(METADATA_COLUMNS)) {
    if (key in patch) {
      sets.push(`${column} = $${param}`);
      values.push((patch as Record<string, unknown>)[key] ?? null);
      param += 1;
    }
  }
  for (const [key, column] of [
    ["focalX", "focal_x"],
    ["focalY", "focal_y"],
  ] as const) {
    if (key in patch) {
      const value = (patch as Record<string, unknown>)[key];
      const numeric = typeof value === "number" ? value : null;
      if (numeric !== null && (numeric < 0 || numeric > 1)) {
        throw new MediaError("MEDIA_FOCAL_OUT_OF_RANGE", "focal point coordinates must be in 0..1");
      }
      sets.push(`${column} = $${param}`);
      values.push(value ?? null);
      param += 1;
    }
  }
  if (sets.length === 0) {
    const current = await getAsset(pool, assetId);
    if (current === null) throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist");
    return current;
  }
  const updated = await pool.query<AssetRow>(
    `UPDATE media_assets SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    [assetId, ...values],
  );
  if (updated.rows[0] === undefined) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist");
  }
  return toAsset(updated.rows[0]);
}

/** Archive is a timestamp flag, never a hard delete (Media spec §38). */
export async function archiveAsset(pool: DbPool, assetId: StableId): Promise<MediaAssetRecord> {
  assertAssetId(assetId);
  const updated = await pool.query<AssetRow>(
    `UPDATE media_assets SET archived_at = now()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING *`,
    [assetId],
  );
  if (updated.rows[0] === undefined) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist or is already archived");
  }
  return toAsset(updated.rows[0]);
}

export async function restoreAsset(pool: DbPool, assetId: StableId): Promise<MediaAssetRecord> {
  assertAssetId(assetId);
  const updated = await pool.query<AssetRow>(
    `UPDATE media_assets SET archived_at = NULL
     WHERE id = $1 AND archived_at IS NOT NULL
     RETURNING *`,
    [assetId],
  );
  if (updated.rows[0] === undefined) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist or is not archived");
  }
  return toAsset(updated.rows[0]);
}

/** Removes domain rows only; caller has proven unreachability (T018/T028). */
export async function deleteAssetRows(tx: DbClient, assetId: StableId): Promise<void> {
  await tx.query(`DELETE FROM media_versions WHERE asset_id = $1`, [assetId]);
  await tx.query(`DELETE FROM media_assets WHERE id = $1`, [assetId]);
}
