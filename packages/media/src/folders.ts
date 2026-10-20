// Logical media folders (editorial organization ONLY): a folder never
// touches asset identity, storage keys/URLs or content references — moving
// an asset is a single metadata UPDATE. Deleting a non-empty folder is
// blocked (MEDIA_FOLDER_NOT_EMPTY); nothing cascades.
import { type DbPool, isStableId, newStableId, type StableId } from "@pcms/core";
import { MediaError } from "./errors.js";

export interface MediaFolderRecord {
  readonly id: StableId;
  readonly name: string;
  readonly parentId: StableId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface FolderRow extends Record<string, unknown> {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Ancestor-walk bound for move validation (corruption guard, content-tree precedent). */
const FOLDER_WALK_LIMIT = 64;

function toRecord(row: FolderRow): MediaFolderRecord {
  return {
    id: row.id as StableId,
    name: row.name,
    parentId: (row.parent_id as StableId | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createMediaFolder(
  pool: DbPool,
  input: { name: string; parentId?: string | null; createdBy: string },
): Promise<MediaFolderRecord> {
  const name = input.name.trim();
  if (name === "" || name.length > 200) {
    throw new MediaError("MEDIA_FOLDER_NAME_INVALID", "folder name must be 1..200 characters");
  }
  const parentId = input.parentId ?? null;
  if (parentId !== null && !isStableId(parentId)) {
    throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "invalid parent folder id");
  }
  const id = newStableId();
  const inserted = await pool.query<FolderRow>(
    `INSERT INTO media_folders (id, name, parent_id, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, name, parentId, input.createdBy],
  );
  return toRecord(inserted.rows[0] as FolderRow);
}

export async function listMediaFolders(pool: DbPool): Promise<MediaFolderRecord[]> {
  const result = await pool.query<FolderRow>(`SELECT * FROM media_folders ORDER BY name, id`);
  return result.rows.map(toRecord);
}

export async function updateMediaFolder(
  pool: DbPool,
  input: {
    folderId: string;
    name?: string;
    /** Reparent; null = root. Cycle-protected. */
    parentId?: string | null;
  },
): Promise<MediaFolderRecord> {
  const folderId = input.folderId;
  if (!isStableId(folderId)) {
    throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "invalid folder id");
  }
  if (input.parentId !== undefined) {
    const parentId = input.parentId;
    if (parentId !== null) {
      if (!isStableId(parentId)) {
        throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "invalid parent folder id");
      }
      if (parentId === folderId) {
        throw new MediaError("MEDIA_FOLDER_CYCLE", "a folder cannot be its own parent");
      }
      const chain = await pool.query<{ parent_id: string | null }>(
        `WITH RECURSIVE chain AS (
           SELECT id, parent_id, 0 AS depth FROM media_folders WHERE id = $1
           UNION ALL
           SELECT f.id, f.parent_id, c.depth + 1
           FROM media_folders f JOIN chain c ON f.id = c.parent_id
           WHERE c.depth < $2
         )
         SELECT parent_id FROM chain WHERE id = $3`,
        [parentId, FOLDER_WALK_LIMIT, folderId],
      );
      if (chain.rows.length > 0) {
        throw new MediaError("MEDIA_FOLDER_CYCLE", "cannot move a folder inside its own subtree");
      }
    }
  }
  const updated = await pool.query<FolderRow>(
    `UPDATE media_folders SET
       name = COALESCE($2, name),
       parent_id = CASE WHEN $3::boolean THEN $4 ELSE parent_id END,
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [folderId, input.name?.trim() ?? null, input.parentId !== undefined, input.parentId ?? null],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "folder not found");
  }
  return toRecord(row);
}

/** BLOCKED for non-empty folders (assets attached or child folders exist). */
export async function deleteMediaFolder(pool: DbPool, folderId: string): Promise<void> {
  if (!isStableId(folderId)) {
    throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "invalid folder id");
  }
  const assets = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM media_assets WHERE folder_id = $1 AND archived_at IS NULL`,
    [folderId],
  );
  const children = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM media_folders WHERE parent_id = $1`,
    [folderId],
  );
  if (Number(assets.rows[0]?.n ?? "0") > 0 || Number(children.rows[0]?.n ?? "0") > 0) {
    throw new MediaError(
      "MEDIA_FOLDER_NOT_EMPTY",
      "move or remove the folder's contents before deleting it",
    );
  }
  const deleted = await pool.query(`DELETE FROM media_folders WHERE id = $1`, [folderId]);
  if (deleted.rowCount === 0) {
    throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "folder not found");
  }
}

/** Logical move only — asset id, blobs/URLs and content references stay. */
export async function moveMediaAsset(
  pool: DbPool,
  input: { assetId: string; folderId: string | null },
): Promise<void> {
  if (!isStableId(input.assetId)) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", "invalid asset id");
  }
  if (input.folderId !== null && !isStableId(input.folderId)) {
    throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "invalid folder id");
  }
  if (input.folderId !== null) {
    const exists = await pool.query(`SELECT 1 FROM media_folders WHERE id = $1`, [input.folderId]);
    if (exists.rowCount === 0) {
      throw new MediaError("MEDIA_FOLDER_NOT_FOUND", "folder not found");
    }
  }
  const updated = await pool.query(`UPDATE media_assets SET folder_id = $2 WHERE id = $1`, [
    input.assetId,
    input.folderId,
  ]);
  if (updated.rowCount === 0) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset not found");
  }
}
