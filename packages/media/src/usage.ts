// Media usage graph + archive/delete impact
// (PCMS-MEDIA-T017/T018; Media spec §37/§38; Content spec §60/§61).
//
// Media is L1 and never imports @pcms/content: inbound references arrive
// through the MediaUsagePort, which the composition layer implements from
// the Content reference graph (entry fields) plus declared block references
// (body BlockDocuments). The service answers "where is this asset used?"
// and enforces the delete rules: archive is the default, hard delete is a
// privileged operation that is blocked while references exist.

import type { DbPool } from "@pcms/core";
import { isStableId } from "@pcms/core";
import { MediaError } from "./errors.js";
import { deleteAssetRows, getAsset } from "./model.js";

export type UsageOrigin = "field" | "block" | "external" | "theme_settings" | "seo" | "extension";

export interface UsageReference {
  /** Entry (or other source) that references the asset. */
  readonly sourceEntryId: string;
  /** JSON-pointer-ish location inside the source (field path or block path). */
  readonly sourcePath: string;
  readonly origin: UsageOrigin;
}

export interface MediaUsagePort {
  /**
   * Every inbound reference to one Media Asset ID across the whole system
   * (entry fields, block documents, globals — whatever the composition
   * layer projects).
   */
  readonly listInboundReferences: (mediaId: string) => Promise<readonly UsageReference[]>;
}

export interface MediaUsageReport {
  readonly assetId: string;
  readonly inboundCount: number;
  readonly distinctSources: number;
  readonly references: readonly UsageReference[];
}

export interface MediaUsageService {
  /** "Where is this MediaAsset used?" (Media spec §37) — also serves
   * as the delete-impact preview before any destructive step. */
  readonly getUsage: (mediaId: string) => Promise<MediaUsageReport>;
}

export function createMediaUsageService(port: MediaUsagePort): MediaUsageService {
  const getUsage = async (mediaId: string): Promise<MediaUsageReport> => {
    if (!isStableId(mediaId)) {
      throw new MediaError("MEDIA_ASSET_NOT_FOUND", "invalid media asset id");
    }
    const references = await port.listInboundReferences(mediaId);
    const distinct = new Set(references.map((r) => r.sourceEntryId));
    return {
      assetId: mediaId,
      inboundCount: references.length,
      distinctSources: distinct.size,
      references,
    };
  };
  return { getUsage };
}

export interface HardDeleteDependencies {
  readonly pool: DbPool;
  readonly port: MediaUsagePort;
}

export interface HardDeleteRequest {
  readonly assetId: string;
  readonly actor: string;
  /**
   * Hard delete is privileged (Media spec §38/§56): the caller must hold a
   * capability granted by the auth layer (M08). v1 shape: a non-empty
   * capability token presented by the composition layer.
   */
  readonly deleteCapability?: string;
}

export interface HardDeleteResult {
  readonly deleted: boolean;
  readonly removedVersions: number;
  /**
   * Physical blob rows are NOT removed here: blobs are content-addressed and
   * may be shared by other assets/versions/variants. Unreachable blobs go
   * through the garbage collector (T028), never through this path.
   */
  readonly blobsDeferredToGc: true;
}

/**
 * Privileged hard delete (PCMS-MEDIA-T018): refuses unknown assets,
 * in-use assets (MEDIA_IN_USE with the impact list) and unprivileged
 * callers. Domain rows go away; physical bytes stay until proven
 * unreachable by GC.
 */
export async function hardDeleteAsset(
  deps: HardDeleteDependencies,
  request: HardDeleteRequest,
): Promise<HardDeleteResult> {
  if (!request.deleteCapability) {
    throw new MediaError(
      "MEDIA_DELETE_FORBIDDEN",
      "hard delete requires the media.delete capability (M08)",
    );
  }
  const asset = await getAsset(deps.pool, request.assetId as never);
  if (asset === null) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", "asset does not exist");
  }
  const usage = await (async () => {
    const refs = await deps.port.listInboundReferences(request.assetId);
    return refs;
  })();
  if (usage.length > 0) {
    throw new MediaError(
      "MEDIA_IN_USE",
      `asset is referenced by ${usage.length} location(s); archive instead or remove references first`,
      { cause: { references: usage } },
    );
  }
  let removedVersions = 0;
  await deps.pool.withTransaction(async (tx) => {
    const counted = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM media_versions WHERE asset_id = $1`,
      [request.assetId],
    );
    removedVersions = counted.rows[0]?.n ?? 0;
    await deleteAssetRows(tx, request.assetId as never);
  });
  return { deleted: true, removedVersions, blobsDeferredToGc: true };
}
