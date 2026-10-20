// Upload quarantine/accept pipeline (PCMS-MEDIA-T003; Media spec §40/§41).
//
// Upload is untrusted input (§2.7). Every upload lands in a separate
// quarantine storage first; only bytes that pass validation are persisted
// into the content-addressed blob store and registered as an accepted
// MediaAsset with its immutable version 1 — in one transaction, so an asset
// without an accepted original never exists. Invalid input never becomes a
// ready asset: its rejected bytes stay quarantined for diagnostics and no
// domain rows are written.
import { type DbPool, newStableId, type StableId } from "@pcms/core";
import { MediaError } from "./errors.js";
import { readImageMetadata } from "./image.js";
import { DEFAULT_TYPE_REGISTRY, validateUploadType } from "./mime.js";
import {
  createAssetWithFirstVersion,
  ensureBlobRow,
  listVersions,
  type MediaAssetRecord,
  type MediaBlobRecord,
  type MediaVersionRecord,
} from "./model.js";
import type { MediaStorage } from "./storage.js";
import { validateSvg } from "./svg.js";

export interface IngestLimits {
  /** Hard ceiling for one image/document upload (bomb first guard). */
  readonly maxUploadBytes: number;
  /**
   * Ceiling for one video upload (files are large; kind-checked after sniff).
   * Optional: absent = the product default applies (a hand-built limits
   * object must never disable the ceiling).
   */
  readonly maxVideoUploadBytes?: number;
  /** Ceiling for one audio upload (podcast episodes); optional, as video. */
  readonly maxAudioUploadBytes?: number;
  /** Decoded-pixel ceiling (decompression bombs, Media spec §26). */
  readonly maxImagePixels: number;
  /** Per-axis dimension ceiling. */
  readonly maxImageDimension: number;
  /**
   * Instance policy: MIME types from the baseline registry that this site
   * refuses. Can only narrow (the sniffed-signature registry stays closed by
   * default — Media spec §29/§30); unknown entries are ignored.
   */
  readonly disabledTypes?: readonly string[];
}

const DEFAULT_MAX_VIDEO_BYTES = 268_435_456; // 256 MiB
const DEFAULT_MAX_AUDIO_BYTES = 268_435_456; // 256 MiB

/** Deployment-tunable ingest policy; defaults are restrictive. */
export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  maxUploadBytes: 26_214_400, // 25 MiB
  maxVideoUploadBytes: DEFAULT_MAX_VIDEO_BYTES,
  maxAudioUploadBytes: DEFAULT_MAX_AUDIO_BYTES,
  maxImagePixels: 64_000_000, // 64 MP
  maxImageDimension: 16_384,
};

export interface UploadInput {
  /** Raw uploaded bytes. Callers must have bounded the read themselves. */
  readonly bytes: Buffer;
  /** Original filename — human metadata only, never a filesystem authority. */
  readonly filename: string;
  /** Browser-provided Content-Type; untrusted, validated against the sniff. */
  readonly declaredMimeType?: string;
  /** Privileged/trusted upload path (SVG policy, Media spec §24). */
  readonly privileged?: boolean;
  readonly createdBy: string;
  readonly note?: string | null;
}

export interface AcceptedMedia {
  readonly asset: MediaAssetRecord;
  readonly version: MediaVersionRecord;
  readonly blob: MediaBlobRecord;
  /**
   * True when the exact bytes already existed as a blob (Media spec §35/§45):
   * storage is deduplicated, but this upload is still its own logical asset —
   * semantic duplicates are never auto-merged.
   */
  readonly duplicateBlob: boolean;
}

export interface IngestDependencies {
  readonly pool: DbPool;
  /** Content-addressed blob store (accepted bytes only). */
  readonly storage: MediaStorage;
  /** Separate quarantine volume; rejected bytes are retained here. */
  readonly quarantine: MediaStorage;
  readonly limits?: IngestLimits;
}

/**
 * Quarantine → validate → hash → persist → accept. Returns the accepted
 * media (asset + version + blob). Throws `MediaError` with a stable code on
 * any rejection; asset rows are then never created (acceptance of T003).
 */
export async function uploadMedia(
  deps: IngestDependencies,
  input: UploadInput,
): Promise<AcceptedMedia> {
  const limits = deps.limits ?? DEFAULT_INGEST_LIMITS;
  const createdBy = input.createdBy;
  if (!createdBy?.trim()) {
    throw new MediaError("MEDIA_ACTOR_REQUIRED", "uploads need a createdBy actor");
  }

  // 1. Content-signature validation first (T004): the sniffed type decides
  // which size ceiling applies (video/audio get dedicated caps). The sniffed
  // type wins over the untrusted declared MIME/filename; kind follows the
  // registry descriptor.
  const disabledTypes = limits.disabledTypes ?? [];
  const type_ = validateUploadType({
    bytes: input.bytes,
    filename: input.filename,
    ...(input.declaredMimeType === undefined ? {} : { declaredMimeType: input.declaredMimeType }),
    privileged: input.privileged === true,
    ...(disabledTypes.length === 0
      ? {}
      : {
          registry: new Map(
            DEFAULT_TYPE_REGISTRY.filter((entry) => !disabledTypes.includes(entry.mimeType)).map(
              (entry) => [entry.mimeType, entry],
            ),
          ),
        }),
  });

  // 1b. Size ceiling per sniffed kind — before anything touches the bytes.
  // `?? DEFAULT` guards hand-built limits objects (tests, embedders): a
  // missing field must never disable the ceiling.
  const maxBytes =
    type_.kind === "video"
      ? (limits.maxVideoUploadBytes ?? DEFAULT_MAX_VIDEO_BYTES)
      : type_.kind === "audio"
        ? (limits.maxAudioUploadBytes ?? DEFAULT_MAX_AUDIO_BYTES)
        : limits.maxUploadBytes;
  if (input.bytes.length > maxBytes) {
    throw new MediaError("MEDIA_TOO_LARGE", `upload exceeds the ${maxBytes}-byte limit`);
  }
  if (input.bytes.length === 0) {
    throw new MediaError("MEDIA_EMPTY", "upload is empty");
  }

  // 2. Quarantine: unvalidated bytes never enter the blob store.
  const quarantined = await deps.quarantine.put(input.bytes);

  // 3. SVG active-content validation (T013): the privileged path accepts
  // only provably inert SVG (Media spec §24).
  if (type_.mimeType === "image/svg+xml") {
    validateSvg(input.bytes);
  }

  // 4. Raster images: bounded header decode (T006) — rejects decompression
  // bombs before pixels are processed and yields display dimensions with
  // EXIF orientation applied (T007 policy).
  let width: number | null = null;
  let height: number | null = null;
  if (type_.kind === "image" && type_.mimeType !== "image/svg+xml") {
    const metadata = await readImageMetadata(input.bytes, {
      maxPixels: limits.maxImagePixels,
      maxDimension: limits.maxImageDimension,
    });
    width = metadata.width;
    height = metadata.height;
  }

  // 5. Persist content-addressed (dedupes physically), register blob row.
  const stored = await deps.storage.put(input.bytes);
  const { blob, duplicated } = await ensureBlobRow(deps.pool, {
    sha256: stored.sha256,
    sizeBytes: stored.sizeBytes,
    storageKey: stored.key,
  });

  // 6. Accept: asset + immutable version 1 in one transaction.
  const assetId = newStableId() as StableId;
  const mimeType = type_.mimeType;
  const asset = await createAssetWithFirstVersion(
    deps.pool,
    {
      id: assetId,
      kind: type_.kind,
      originalBlobId: blob.id,
      filenameOriginal: input.filename,
      mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      width,
      height,
      createdBy,
    },
    {
      blobId: blob.id,
      filenameOriginal: input.filename,
      mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      width,
      height,
      note: input.note ?? null,
      createdBy,
    },
  );
  const version = (await listVersions(deps.pool, asset.id))[0];
  if (version === undefined) {
    throw new MediaError("MEDIA_NOT_READY", "accepted version is missing after accept");
  }

  // 8. Accepted → the quarantine copy is no longer needed. Best effort: a
  // leftover quarantined copy of accepted bytes is cleaned by operations.
  await deps.quarantine.delete(quarantined.key).catch(() => {});
  return { asset, version, blob, duplicateBlob: duplicated };
}
