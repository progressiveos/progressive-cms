// Variant generation (PCMS-MEDIA-T010/T012; Media spec §18/§21/§25).
//
// Generates the preset-derived derivatives of one immutable media version:
// for each preset and each declared output format, the deterministic variant
// key decides whether the derivative already exists (idempotent, safe under
// concurrency) or is transformed, stored content-addressed and recorded.
// Missing variants are rebuildable at any time — variant rows are caches.
import { type DbPool, newStableId } from "@pcms/core";
import { MediaError } from "./errors.js";
import { transformImage } from "./image.js";
import { ensureBlobRow, type MediaAssetRecord } from "./model.js";
import { type MediaPreset, type MediaPresetRegistry, variantKeyFor } from "./presets.js";
import type { MediaStorage } from "./storage.js";

export interface MediaVariantRecord {
  readonly id: string;
  readonly assetId: string;
  readonly versionNo: number;
  readonly presetId: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly blobId: string;
  readonly variantKey: string;
  readonly createdAt: Date;
}

interface VariantRow extends Record<string, unknown> {
  id: string;
  asset_id: string;
  version_no: number;
  preset_id: string;
  format: string;
  width: number;
  height: number;
  size_bytes: string;
  blob_id: string;
  variant_key: string;
  created_at: Date;
}

function toVariant(row: VariantRow): MediaVariantRecord {
  return {
    id: row.id,
    assetId: row.asset_id,
    versionNo: row.version_no,
    presetId: row.preset_id,
    format: row.format,
    width: row.width,
    height: row.height,
    sizeBytes: Number(row.size_bytes),
    blobId: row.blob_id,
    variantKey: row.variant_key,
    createdAt: row.created_at,
  };
}

export async function listVariants(
  pool: DbPool,
  assetId: string,
  versionNo?: number,
): Promise<MediaVariantRecord[]> {
  const result =
    versionNo === undefined
      ? await pool.query<VariantRow>(
          `SELECT * FROM media_variants WHERE asset_id = $1 ORDER BY preset_id, format, width`,
          [assetId],
        )
      : await pool.query<VariantRow>(
          `SELECT * FROM media_variants WHERE asset_id = $1 AND version_no = $2
           ORDER BY preset_id, format, width`,
          [assetId, versionNo],
        );
  return result.rows.map(toVariant);
}

export async function getVariant(
  pool: DbPool,
  assetId: string,
  versionNo: number,
  variantKey: string,
): Promise<MediaVariantRecord | null> {
  const result = await pool.query<VariantRow>(
    `SELECT * FROM media_variants WHERE asset_id = $1 AND version_no = $2 AND variant_key = $3`,
    [assetId, versionNo, variantKey],
  );
  return result.rows[0] === undefined ? null : toVariant(result.rows[0]);
}

export interface VariantDependencies {
  readonly pool: DbPool;
  readonly storage: MediaStorage;
  /** Read bound for source blobs (bounded memory, Media spec §33). */
  readonly maxSourceBytes: number;
}

export interface GeneratedVariant extends MediaVariantRecord {
  /** True when a byte-identical variant already existed (idempotent run). */
  readonly reused: boolean;
}

/**
 * Generates all missing preset variants for the asset's CURRENT version.
 * Skips SVG (active content is never rasterized silently, Media spec §24)
 * and non-image kinds. Safe to run repeatedly: existing variants with
 * matching keys are reused, not regenerated — except exact-dimension
 * presets (og-v1/favicon-v1), whose cached rows are rebuilt whenever the
 * stored dimensions violate the declared contract (R18).
 */
export async function generateVariantsForAsset(
  deps: VariantDependencies,
  asset: MediaAssetRecord,
  registry: MediaPresetRegistry,
  presets?: readonly MediaPreset[],
): Promise<GeneratedVariant[]> {
  if (asset.kind !== "image" || asset.mimeType === "image/svg+xml") {
    return [];
  }
  const selected = presets ?? registry.listPresets();
  const blob = await deps.pool.query<{ storage_key: string; sha256: string }>(
    `SELECT b.storage_key, b.sha256 FROM media_blobs b
     JOIN media_versions v ON v.blob_id = b.id
     WHERE v.asset_id = $1 AND v.version_no = $2`,
    [asset.id, asset.currentVersionNo],
  );
  const source = blob.rows[0];
  if (source === undefined) {
    throw new MediaError("MEDIA_BLOB_NOT_FOUND", "current version blob is missing");
  }
  const sourceBytes = await deps.storage.getBuffer(source.storage_key, deps.maxSourceBytes);

  const generated: GeneratedVariant[] = [];
  for (const preset of selected) {
    for (const format of preset.formats) {
      const variantKey = variantKeyFor({
        sourceSha256: source.sha256,
        versionNo: asset.currentVersionNo,
        presetId: preset.id,
        width: preset.width,
        height: preset.height,
        fit: preset.fit,
        crop: preset.crop,
        focalX: asset.focalX,
        focalY: asset.focalY,
        quality: preset.quality,
        format,
      });
      const existing = await getVariant(deps.pool, asset.id, asset.currentVersionNo, variantKey);
      if (existing !== null) {
        const exact = preset.exactDimensions === true;
        if (
          !exact ||
          (existing.width === preset.width &&
            existing.height === preset.height &&
            existing.format === format)
        ) {
          generated.push({ ...existing, reused: true });
          continue;
        }
        // Exact-dimension preset (R18): the cached row violates the declared
        // dimensions (written under an older size policy). Rebuild the cache
        // row instead of reusing it; the variant key is unchanged, so the
        // public URL stays stable while the bytes become contract-true.
        await deps.pool.query(`DELETE FROM media_variants WHERE id = $1`, [existing.id]);
      }
      const instruction = {
        width: preset.width,
        ...(preset.height === null ? {} : { height: preset.height }),
        fit: preset.fit,
        ...(asset.focalX === null && asset.focalY === null
          ? { cropStrategy: preset.crop === "center" ? ("center" as const) : preset.crop }
          : { focalX: asset.focalX ?? 0.5, focalY: asset.focalY ?? 0.5 }),
        format,
        quality: preset.quality,
        // Letterboxed derivatives (contain) pad transparent on alpha-capable
        // formats — a logo must never grow black bars (logo-v1 contract).
        ...(preset.fit === "contain" && format !== "jpeg"
          ? { background: { r: 0, g: 0, b: 0, alpha: 0 } as const }
          : {}),
        ...(preset.exactDimensions === true ? { allowEnlargement: true as const } : {}),
      };
      const transformed = await transformImage(sourceBytes, instruction, {
        maxPixels: 64_000_000,
        maxDimension: 16_384,
      });
      if (
        preset.exactDimensions === true &&
        (transformed.width !== preset.width || transformed.height !== preset.height)
      ) {
        throw new MediaError(
          "MEDIA_DERIVATIVE_DIMENSION_MISMATCH",
          `core derivative ${preset.id} produced ${transformed.width}×${transformed.height}, ` +
            `expected ${preset.width}×${preset.height}`,
        );
      }
      const stored = await deps.storage.put(transformed.bytes);
      const { blob: variantBlob } = await ensureBlobRow(deps.pool, {
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.key,
      });
      const id = newStableId();
      await deps.pool.query(
        `INSERT INTO media_variants (
           id, asset_id, version_no, preset_id, format, width, height,
           size_bytes, blob_id, variant_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (asset_id, version_no, variant_key) DO NOTHING`,
        [
          id,
          asset.id,
          asset.currentVersionNo,
          preset.id,
          format,
          transformed.width,
          transformed.height,
          stored.sizeBytes,
          variantBlob.id,
          variantKey,
        ],
      );
      const storedVariant = await getVariant(
        deps.pool,
        asset.id,
        asset.currentVersionNo,
        variantKey,
      );
      if (storedVariant === null) {
        // Concurrent generation won the race — reuse the winner's row.
        continue;
      }
      generated.push({ ...storedVariant, reused: false });
    }
  }
  return generated;
}

/** Reads the bytes of one variant blob (bounded). */
export async function readVariantBytes(
  deps: VariantDependencies,
  variant: MediaVariantRecord,
): Promise<Buffer> {
  const blob = await deps.pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM media_blobs WHERE id = $1`,
    [variant.blobId],
  );
  const key = blob.rows[0]?.storage_key;
  if (key === undefined) {
    throw new MediaError("MEDIA_BLOB_NOT_FOUND", "variant blob is missing");
  }
  return deps.storage.getBuffer(key, deps.maxSourceBytes);
}
