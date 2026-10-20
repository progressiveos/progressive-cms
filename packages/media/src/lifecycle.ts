// Media lifecycle services: logical document replacement, version audit,
// archive/delete impact (PCMS-MEDIA-T015/T016/T018; Media spec §8/§9/§38).
//
// Replacement policy (§51/§52): documents (and generic files) version in
// place under their stable asset ID — ten pages keep referencing the asset
// while the bytes move to version N+1. Images never replace silently: a
// materially new image is a new asset (history/revisions must not change
// appearance retroactively); SVG replacement re-runs the validation.
import type { DbPool } from "@pcms/core";
import { MediaError } from "./errors.js";
import { validateUploadType } from "./mime.js";
import {
  commitReplacementVersion,
  ensureBlobRow,
  getAsset,
  listVersions,
  type MediaAssetRecord,
  type MediaVersionRecord,
} from "./model.js";
import type { MediaStorage } from "./storage.js";
import { validateSvg } from "./svg.js";

export interface ReplaceDependencies {
  readonly pool: DbPool;
  readonly storage: MediaStorage;
  /** Read bound for the current-blob fetch during consistency checks. */
  readonly maxSourceBytes: number;
}

export interface ReplacementInput {
  readonly assetId: string;
  readonly bytes: Buffer;
  readonly filename: string;
  readonly createdBy: string;
  readonly note?: string | null;
  /** Required for replacing an SVG asset (privileged content, §24). */
  readonly privileged?: boolean;
}

export interface ReplacementResult {
  readonly asset: MediaAssetRecord;
  readonly version: MediaVersionRecord;
  readonly duplicateBlob: boolean;
}

/**
 * Replaces the bytes of a document-kind asset: appends an immutable version
 * row and moves the asset's current pointer in one transaction, so every
 * content reference to the asset ID sees the new version atomically (§8).
 */
export async function replaceDocument(
  deps: ReplaceDependencies,
  input: ReplacementInput,
): Promise<ReplacementResult> {
  const asset = await getAsset(deps.pool, input.assetId as never);
  if (asset === null) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist");
  }
  if (asset.archivedAt !== null) {
    throw new MediaError("MEDIA_ARCHIVED", "archived assets cannot be replaced");
  }
  if (asset.kind === "image") {
    throw new MediaError(
      "MEDIA_IMAGE_REPLACEMENT_FORBIDDEN",
      "images are replaced by creating a new asset (Media spec §52)",
    );
  }
  if (!input.createdBy?.trim()) {
    throw new MediaError("MEDIA_ACTOR_REQUIRED", "replacements need a createdBy actor");
  }
  // The replacement must be a type-consistent document (PDF stays PDF).
  const type_ = validateUploadType({
    bytes: input.bytes,
    filename: input.filename,
    privileged: input.privileged === true,
  });
  if (type_.mimeType !== asset.mimeType) {
    throw new MediaError(
      "MEDIA_MIME_MISMATCH",
      `replacement type "${type_.mimeType}" does not match the asset type "${asset.mimeType}"`,
    );
  }
  if (type_.mimeType === "image/svg+xml") {
    validateSvg(input.bytes);
  }

  const stored = await deps.storage.put(input.bytes);
  const { blob, duplicated } = await ensureBlobRow(deps.pool, {
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    storageKey: stored.key,
  });
  const versionNo = asset.currentVersionNo + 1;
  const updated = await commitReplacementVersion(deps.pool, {
    assetId: asset.id,
    versionNo,
    blobId: blob.id,
    filenameOriginal: input.filename,
    mimeType: asset.mimeType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    note: input.note ?? null,
    createdBy: input.createdBy,
  });
  const versions = await listVersions(deps.pool, asset.id);
  const version = versions.find((v) => v.versionNo === versionNo);
  if (version === undefined) {
    throw new MediaError("MEDIA_NOT_READY", "replacement version is missing after commit");
  }
  return { asset: updated, version, duplicateBlob: duplicated };
}

/**
 * Historical version audit (PCMS-MEDIA-T016; Media spec §9): the full,
 * stable list of accepted originals under one asset ID, oldest first —
 * rows are insert-only, so audit history is append-only by construction.
 */
export async function getVersionAudit(
  pool: DbPool,
  assetId: string,
): Promise<readonly MediaVersionRecord[]> {
  return listVersions(pool, assetId as never);
}
