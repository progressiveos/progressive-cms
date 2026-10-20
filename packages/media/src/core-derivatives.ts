// Core service presets (OG contract 2026-10-03; owner brief «новый чистый
// контракт для social images и favicon»): og-v1 and favicon-v1 are
// versioned core-owned derivative presets. They are deliberately NOT part
// of the theme-declared preset registry, so upload/import never generates
// them; they materialize only at their semantic points — assignment of the
// source reference, social preview, publication validation and publish —
// and the public renderer resolves an EXISTING derivative without ever
// generating one. The derivative is rebuildable generated data: the CMS
// stores the semantic choice of the source media asset separately from this
// presentation representation. Future revisions (og-v2, favicon-v2) are new
// preset ids — no source-media migration.

import type { DbPool } from "@pcms/core";
import { MediaError } from "./errors.js";
import type { MediaAssetRecord } from "./model.js";
import type { MediaPresetRegistry } from "./presets.js";
import {
  generateVariantsForAsset,
  listVariants,
  type MediaVariantRecord,
  type VariantDependencies,
} from "./variants.js";

/** OG/social derivative: 1200×630 cover-cropped JPEG (contract §1). */
export const OG_IMAGE_PRESET_ID = "og-v1";
/** Branding canonical source variant: 512×512 PNG (contract §7). */
export const FAVICON_PRESET_ID = "favicon-v1";
/** Branding logo representation: 512×512 contain-fitted PNG (Organization
 * structured data §33): the whole mark stays in frame, letterboxing pads
 * transparent. */
export const LOGO_PRESET_ID = "logo-v1";
export const RICHTEXT_IMAGE_PRESET_ID = "richtext-v1";
const RICHTEXT_IMAGE_PRESET = {
  id: RICHTEXT_IMAGE_PRESET_ID,
  width: 1600,
  height: 1600,
  fit: "inside" as const,
  crop: "center" as const,
  formats: ["webp" as const],
  quality: 85,
  loading: "lazy" as const,
};

const OG_IMAGE_PRESET = {
  id: OG_IMAGE_PRESET_ID,
  width: 1200,
  height: 630,
  fit: "cover" as const,
  crop: "center" as const,
  formats: ["jpeg" as const],
  quality: 82,
  loading: "lazy" as const,
  exactDimensions: true,
};

const FAVICON_PRESET = {
  id: FAVICON_PRESET_ID,
  width: 512,
  height: 512,
  fit: "cover" as const,
  crop: "center" as const,
  formats: ["png" as const],
  quality: 90,
  loading: "lazy" as const,
  exactDimensions: true,
};

const LOGO_PRESET = {
  id: LOGO_PRESET_ID,
  width: 512,
  height: 512,
  fit: "contain" as const,
  crop: "center" as const,
  formats: ["png" as const],
  quality: 90,
  loading: "lazy" as const,
  exactDimensions: true,
};

/** Generates (idempotently) the core derivative for the asset's CURRENT
 * version and retires superseded same-preset rows left by an earlier focal
 * point or crop metadata. Deterministic: same source bytes + version +
 * preset + focal ⇒ same output. Throws MediaError on generation failure —
 * callers map it onto their machine-readable contract codes. */
export async function ensureCoreDerivative(
  deps: VariantDependencies,
  asset: MediaAssetRecord,
  registry: MediaPresetRegistry,
  presetId:
    | typeof OG_IMAGE_PRESET_ID
    | typeof FAVICON_PRESET_ID
    | typeof LOGO_PRESET_ID
    | typeof RICHTEXT_IMAGE_PRESET_ID,
): Promise<MediaVariantRecord> {
  const preset =
    presetId === RICHTEXT_IMAGE_PRESET_ID
      ? RICHTEXT_IMAGE_PRESET
      : presetId === OG_IMAGE_PRESET_ID
        ? OG_IMAGE_PRESET
        : presetId === LOGO_PRESET_ID
          ? LOGO_PRESET
          : FAVICON_PRESET;
  const [generated] = await generateVariantsForAsset(deps, asset, registry, [preset]);
  if (generated === undefined) {
    throw new MediaError(
      "MEDIA_DERIVATIVE_FAILED",
      `core derivative ${presetId} produced no output`,
    );
  }
  // Focal/crop metadata changes produce a NEW variant key; retire the
  // superseded same-preset rows so orphaned derivatives do not accumulate.
  await deps.pool.query(
    `DELETE FROM media_variants
     WHERE asset_id = $1 AND version_no = $2 AND preset_id = $3 AND id <> $4`,
    [asset.id, asset.currentVersionNo, presetId, generated.id],
  );
  return generated;
}

/** Resolves an EXISTING core derivative for the asset's CURRENT version —
 * the public renderer uses this and never generates (OG contract §5). */
export async function findCoreDerivative(
  pool: DbPool,
  assetId: string,
  versionNo: number,
  presetId: string,
): Promise<MediaVariantRecord | null> {
  const variants = await listVariants(pool, assetId, versionNo);
  return variants.find((variant) => variant.presetId === presetId) ?? null;
}
