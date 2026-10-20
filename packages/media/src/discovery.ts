// Machine discovery/search services (PCMS-MEDIA-T026; Media spec §45/§48).
//
// Agents and operators can discover reusable media without guessing:
// `find_media_by_hash` for the dedupe workflow, metadata text search over
// filename/title/caption/source/author, and a full inspect view (asset +
// versions + variants) for diagnostics. Deterministic ordering and bounded
// page sizes keep this safe for transports (M09).
import { type DbPool, isStableId } from "@pcms/core";
import { MediaError } from "./errors.js";
import { getAsset, listVersions, type MediaAssetRecord, type MediaKind } from "./model.js";
import { listVariants } from "./variants.js";

export const MAX_SEARCH_LIMIT = 100;

export interface MediaAssetSummary {
  readonly id: string;
  readonly kind: MediaKind;
  readonly filenameOriginal: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly title: string | null;
  readonly altDefault: string | null;
  readonly captionDefault: string | null;
  readonly sourceName: string | null;
  readonly author: string | null;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly folderId: string | null;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

function toSummary(asset: MediaAssetRecord): MediaAssetSummary {
  return {
    id: asset.id,
    kind: asset.kind,
    filenameOriginal: asset.filenameOriginal,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    width: asset.width,
    height: asset.height,
    title: asset.title ?? null,
    altDefault: asset.altDefault ?? null,
    captionDefault: asset.captionDefault ?? null,
    sourceName: asset.sourceName ?? null,
    author: asset.author ?? null,
    focalX: asset.focalX,
    focalY: asset.focalY,
    folderId: null,
    createdAt: asset.createdAt,
    archivedAt: asset.archivedAt,
  };
}

export interface SearchMediaQuery {
  /** Case-insensitive substring over filename/title/caption/source/author (§48). */
  readonly text?: string;
  readonly kind?: MediaKind;
  readonly mimeType?: string;
  /** Include archived assets (default: only active ones). */
  readonly includeArchived?: boolean;
  /**
   * Logical folder filter: "none" = folder-less assets, a folder id = that
   * folder only. Omitted = the whole library (folder-independent search).
   */
  readonly folderId?: string | "none";
  /** Provenance origin filter — "generated" powers the studio history. */
  readonly origin?: "upload" | "import" | "stock" | "generated";
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchResultPage {
  readonly total: number;
  readonly items: readonly MediaAssetSummary[];
}

export interface MediaDiscoveryService {
  readonly searchAssets: (query?: SearchMediaQuery) => Promise<SearchResultPage>;
  /** §45: exact-bytes hash lookup for the agent dedupe workflow. */
  readonly findAssetsByHash: (sha256: string) => Promise<readonly MediaAssetSummary[]>;
  /** Full diagnostic view: asset + immutable version list + variant rows. */
  readonly inspectAsset: (mediaId: string) => Promise<{
    readonly asset: MediaAssetSummary;
    readonly versions: Awaited<ReturnType<typeof listVersions>>;
    readonly variants: Awaited<ReturnType<typeof listVariants>>;
  }>;
}

interface SummaryRow extends Record<string, unknown> {
  id: string;
  kind: string;
  filename_original: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  width: number | null;
  height: number | null;
  title: string | null;
  alt_default: string | null;
  caption_default: string | null;
  source_name: string | null;
  author: string | null;
  focal_x: string | null;
  focal_y: string | null;
  created_at: Date;
  archived_at: Date | null;
  folder_id: string | null;
}

function rowToSummary(row: SummaryRow): MediaAssetSummary {
  return {
    id: row.id,
    kind: row.kind as MediaKind,
    filenameOriginal: row.filename_original,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    title: row.title,
    altDefault: row.alt_default,
    captionDefault: row.caption_default,
    sourceName: row.source_name,
    author: row.author,
    focalX: row.focal_x === null ? null : Number(row.focal_x),
    focalY: row.focal_y === null ? null : Number(row.focal_y),
    folderId: row.folder_id,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

/**
 * Escapes LIKE wildcards in user text (F-40/§48): a literal `%`, `_` or `\`
 * in a search query must match itself, not act as a pattern. Pair with the
 * `ESCAPE '\'` clause on every ILIKE that receives the result.
 */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function createMediaDiscoveryService(pool: DbPool): MediaDiscoveryService {
  return {
    async searchAssets(query = {}): Promise<SearchResultPage> {
      const conditions: string[] = [];
      const values: unknown[] = [];
      if (query.text !== undefined && query.text !== "") {
        values.push(`%${escapeLikePattern(query.text)}%`);
        const param = `$${values.length} ESCAPE '\\'`;
        conditions.push(
          `(filename_original ILIKE ${param} OR title ILIKE ${param} OR caption_default ILIKE ${param} OR source_name ILIKE ${param} OR author ILIKE ${param})`,
        );
      }
      if (query.folderId !== undefined) {
        if (query.folderId === "none") {
          conditions.push("folder_id IS NULL");
        } else {
          values.push(query.folderId);
          conditions.push(`folder_id = $${values.length}`);
        }
      }
      if (query.kind !== undefined) {
        values.push(query.kind);
        conditions.push(`kind = $${values.length}`);
      }
      if (query.mimeType !== undefined) {
        values.push(query.mimeType);
        conditions.push(`mime_type = $${values.length}`);
      }
      if (query.origin !== undefined) {
        values.push(query.origin);
        conditions.push(`origin = $${values.length}`);
      }
      if (query.includeArchived !== true) {
        conditions.push("archived_at IS NULL");
      }
      const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
      const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_SEARCH_LIMIT);
      const offset = Math.max(query.offset ?? 0, 0);
      const total = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM media_assets ${where}`,
        values,
      );
      values.push(limit, offset);
      const rows = await pool.query<SummaryRow>(
        `SELECT id, kind, filename_original, mime_type, size_bytes, sha256, width, height,
                title, alt_default, caption_default, source_name, author, focal_x, focal_y,
                created_at, archived_at, folder_id
         FROM media_assets ${where}
         ORDER BY created_at DESC, id
         LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return { total: total.rows[0]?.n ?? 0, items: rows.rows.map(rowToSummary) };
    },

    async findAssetsByHash(sha256): Promise<readonly MediaAssetSummary[]> {
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        throw new MediaError(
          "MEDIA_ASSET_NOT_FOUND",
          "hash must be a lowercase sha-256 hex digest",
        );
      }
      const rows = await pool.query<SummaryRow>(
        `SELECT id, kind, filename_original, mime_type, size_bytes, sha256, width, height,
                title, alt_default, caption_default, source_name, author, focal_x, focal_y,
                created_at, archived_at, folder_id
         FROM media_assets WHERE sha256 = $1
         ORDER BY created_at, id`,
        [sha256],
      );
      return rows.rows.map(rowToSummary);
    },

    async inspectAsset(mediaId) {
      if (!isStableId(mediaId)) {
        throw new MediaError("MEDIA_ASSET_NOT_FOUND", "invalid media asset id");
      }
      const asset = await getAsset(pool, mediaId as never);
      if (asset === null) {
        throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist");
      }
      return {
        asset: toSummary(asset),
        versions: await listVersions(pool, asset.id),
        variants: await listVariants(pool, asset.id),
      };
    },
  };
}
