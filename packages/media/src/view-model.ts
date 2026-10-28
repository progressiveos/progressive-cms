// Media public URL identity + responsive image View Model
// (PCMS-MEDIA-T011/T020; Media spec §19/§20/§33/§34/§61/§62/§63).
//
// Media URLs are generated, never stored as identity (§33): variant URLs
// carry the version number and the deterministic variant key so content
// changes move the URL (immutable long-cache safe), while the logical asset
// ID stays stable. Themes receive resolved presentation data — src/srcset/
// sources/width/height/loading — and can never express a transform in a URL
// (§63). Full-resolution originals are deliberately absent.
import type { DbPool } from "@pcms/core";
import { MediaError } from "./errors.js";
import { getAsset, getAssetsByIds, type MediaAssetRecord } from "./model.js";
import type { MediaPresetRegistry } from "./presets.js";
import { assertMediaId } from "./presets.js";
import type { MediaVariantRecord } from "./variants.js";
import { listVariants, listVariantsForAssets } from "./variants.js";

/** Extension for a generated output format. */
const FORMAT_EXTENSION: Readonly<Record<string, string>> = {
  avif: "avif",
  webp: "webp",
  jpeg: "jpg",
  png: "png",
};

/**
 * Public URL of one generated variant — versioned + content-fingerprinted
 * (PCMS-MEDIA-T020): replacing a document version or regenerating with a new
 * processor produces different URLs, so caches never serve stale bytes.
 */
export function variantPublicUrl(input: {
  readonly assetId: string;
  readonly versionNo: number;
  readonly presetId: string;
  readonly variantKey: string;
  readonly format: string;
}): string {
  assertMediaId(input.assetId);
  const ext = FORMAT_EXTENSION[input.format];
  if (ext === undefined) {
    throw new MediaError(
      "MEDIA_TYPE_NOT_ALLOWED",
      `no public extension for format "${input.format}"`,
    );
  }
  return `/media/a/${input.assetId}/v${input.versionNo}/${input.presetId}-${input.variantKey.slice(0, 16)}.${ext}`;
}

export interface ImageSourceModel {
  /** MIME type of the format family, e.g. "image/avif". */
  readonly mime: string;
  /** width-descriptor srcset entries for this format. */
  readonly srcset: string;
}

export interface ResponsiveImageModel {
  readonly assetId: string;
  readonly preset: string;
  /** Best default URL (fallback format when declared, else first variant). */
  readonly src: string;
  /** Combined width-descriptor srcset across the preset's formats. */
  readonly srcset: string;
  /** Caller-provided sizes intent; passthrough (Media spec §19). */
  readonly sizes: string | null;
  readonly width: number;
  readonly height: number;
  /** Per-format source lists for `<picture>` markup. */
  readonly sources: readonly ImageSourceModel[];
  readonly alt: string;
  readonly loading: "lazy" | "eager";
}

const FORMAT_MIME: Readonly<Record<string, string>> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** Formats in preference order: modern first, JPEG/PNG last. */
const FORMAT_PREFERENCE = ["avif", "webp", "jpeg", "png"] as const;

/**
 * Builds the responsive image model for (asset, preset) from the variant
 * rows the generation service produced (PCMS-MEDIA-T011). Throws
 * MEDIA_VARIANT_MISSING when the preset has no generated variants — silent
 * fallback to the original file would hide broken pipelines.
 */
export function buildResponsiveImageModel(input: {
  readonly asset: MediaAssetRecord;
  readonly variants: readonly MediaVariantRecord[];
  readonly presetId: string;
  readonly registry: MediaPresetRegistry;
  readonly sizes?: string;
  /** Usage-level alt override (Media spec §14; resolved in T024). */
  readonly altOverride?: string | null;
  /** Decorative images signal an explicitly empty alt. */
  readonly decorative?: boolean;
}): ResponsiveImageModel {
  assertMediaId(input.asset.id);
  const preset = input.registry.getPreset(input.presetId);
  if (preset === null) {
    throw new MediaError("MEDIA_PRESET_UNKNOWN", `preset "${input.presetId}" is not declared`);
  }
  const versions = input.variants
    .filter((v) => v.presetId === input.presetId && v.versionNo === input.asset.currentVersionNo)
    .sort((a, b) => {
      const order =
        FORMAT_PREFERENCE.indexOf(a.format as never) - FORMAT_PREFERENCE.indexOf(b.format as never);
      return order !== 0 ? order : b.width - a.width;
    });
  if (versions.length === 0) {
    throw new MediaError(
      "MEDIA_VARIANT_MISSING",
      `no generated variants for preset "${input.presetId}" — run variant generation first`,
    );
  }
  const sources: ImageSourceModel[] = [];
  for (const format of FORMAT_PREFERENCE) {
    const family = versions.filter((v) => v.format === format);
    if (family.length === 0) continue;
    sources.push({
      mime: FORMAT_MIME[format] ?? `image/${format}`,
      srcset: family
        .map(
          (v) =>
            `${variantPublicUrl({
              assetId: input.asset.id,
              versionNo: v.versionNo,
              presetId: v.presetId,
              variantKey: v.variantKey,
              format: v.format,
            })} ${v.width}w`,
        )
        .join(", "),
    });
  }
  const fallbackFamily = [...versions].sort((a, b) => {
    const order =
      FORMAT_PREFERENCE.indexOf(a.format as never) - FORMAT_PREFERENCE.indexOf(b.format as never);
    return order !== 0 ? order : b.width - a.width;
  });
  const best = fallbackFamily[0]!;
  const src = variantPublicUrl({
    assetId: input.asset.id,
    versionNo: best.versionNo,
    presetId: best.presetId,
    variantKey: best.variantKey,
    format: best.format,
  });
  const alt = input.decorative === true ? "" : (input.altOverride ?? input.asset.altDefault ?? "");
  return {
    assetId: input.asset.id,
    preset: input.presetId,
    src,
    srcset: sources.map((source) => source.srcset).join(", "),
    sizes: input.sizes ?? null,
    width: best.width,
    height: best.height,
    sources,
    alt,
    loading: preset.loading,
  };
}

/**
 * Sanitized public filename slug (Media spec §49/§50): the original
 * filename is metadata only — the slug keeps human readability (Unicode
 * letters preserved) but can never carry traversal or markup characters.
 */
export function sanitizeFilenameSlug(filename: string): string {
  const base = filename.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  // No NFKD decomposition: it destroys Cyrillic й (и + breve) and friends.
  // Category-based filtering keeps all letters/digits, drops markup.
  const slug = stem
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug === "" ? "file" : slug.slice(0, 80);
}

/**
 * Document download URLs (Media spec §32/§34): the versioned URL is
 * fingerprinted (immutable long-cache material); the logical "current"
 * URL is stable per asset and resolved (with a short cache) by the
 * delivery layer to the current version.
 */
function filenameExtensionSlug(filename: string): string {
  const base = filename.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const ext = base
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return ext === "" ? "" : `.${ext}`;
}

export function documentDownloadUrl(input: {
  readonly assetId: string;
  readonly versionNo: number;
  readonly filename: string;
}): string {
  assertMediaId(input.assetId);
  return `/media/a/${input.assetId}/v${input.versionNo}/dl/${sanitizeFilenameSlug(input.filename)}${filenameExtensionSlug(input.filename)}`;
}

export function documentCurrentUrl(input: {
  readonly assetId: string;
  readonly filename: string;
}): string {
  assertMediaId(input.assetId);
  return `/media/a/${input.assetId}/current/${sanitizeFilenameSlug(input.filename)}${filenameExtensionSlug(input.filename)}`;
}

/**
 * Usage-level alt resolution (PCMS-MEDIA-T024; Media spec §14): decorative
 * wins with an explicit empty alt, then the usage override, then the asset
 * default, else empty — alt belongs to the usage context, not the file.
 */
export function resolveAlt(input: {
  readonly asset: Pick<MediaAssetRecord, "altDefault">;
  readonly altOverride?: string | null;
  readonly decorative?: boolean;
}): string {
  if (input.decorative === true) return "";
  if (input.altOverride !== undefined && input.altOverride !== null && input.altOverride !== "") {
    return input.altOverride;
  }
  return input.asset.altDefault ?? "";
}

// --- View Model provider (PCMS-MEDIA-T025; Media spec §61/§62) -------------

/** Derivative entry — structurally the Theme contract's derivative shape. */
export interface PublicDerivative {
  readonly preset: string;
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  /** Served MIME type of the variant (Theme <picture> sources, §61). */
  readonly mime: string;
}

/**
 * Public asset model handed to the Theme layer: resolved URLs and metadata
 * only — no storage keys, no blob credentials, no transform syntax
 * (Media spec §61; Theme receives what buildImageModel expects).
 */
export interface MediaAssetPublicViewModel {
  readonly id: string;
  readonly kind: string;
  readonly alt: string;
  readonly caption: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly derivatives: readonly PublicDerivative[];
  /** Document assets expose their public download URLs (Media spec §32). */
  readonly download: { readonly href: string; readonly versionedHref: string } | null;
}

export interface MediaViewModelProvider {
  /** Resolves the safe public model of one asset; null when unknown. */
  readonly getAssetViewModel: (
    mediaId: string,
    options?: { readonly altOverride?: string | null; readonly decorative?: boolean },
  ) => Promise<MediaAssetPublicViewModel | null>;
  /**
   * Bounded batch port: one assets query and one variants query per 500 ids.
   * Archived assets resolve to null by default, as required by feed cards;
   * includeArchived preserves the single-item port's existing semantics.
   */
  readonly getAssetViewModels: (
    mediaIds: readonly string[],
    options?: { readonly includeArchived?: boolean },
  ) => Promise<Record<string, MediaAssetPublicViewModel | null>>;
}

function publicViewModel(
  asset: MediaAssetRecord,
  variants: readonly MediaVariantRecord[],
): MediaAssetPublicViewModel {
  const derivatives = variants
    .map((variant) => ({
      preset: variant.presetId,
      url: variantPublicUrl({
        assetId: asset.id,
        versionNo: variant.versionNo,
        presetId: variant.presetId,
        variantKey: variant.variantKey,
        format: variant.format,
      }),
      width: variant.width,
      height: variant.height,
      mime: FORMAT_MIME[variant.format] ?? `image/${variant.format}`,
    }))
    .sort((a, b) => a.preset.localeCompare(b.preset) || a.url.localeCompare(b.url));
  const download =
    asset.kind === "image"
      ? null
      : {
          href: documentCurrentUrl({ assetId: asset.id, filename: asset.filenameOriginal }),
          versionedHref: documentDownloadUrl({
            assetId: asset.id,
            versionNo: asset.currentVersionNo,
            filename: asset.filenameOriginal,
          }),
        };
  return {
    id: asset.id,
    kind: asset.kind,
    alt: resolveAlt({ asset }),
    caption: asset.captionDefault ?? null,
    width: asset.width,
    height: asset.height,
    derivatives,
    download,
  };
}

export function createMediaViewModelProvider(input: {
  readonly pool: DbPool;
  readonly registry: MediaPresetRegistry;
}): MediaViewModelProvider {
  return {
    async getAssetViewModel(mediaId, options) {
      const asset = await getAsset(input.pool, mediaId as never);
      if (asset === null) return null;
      const variants = await listVariants(input.pool, asset.id, asset.currentVersionNo);
      const model = publicViewModel(asset, variants);
      if (options?.altOverride === undefined && options?.decorative === undefined) return model;
      return {
        ...model,
        alt: resolveAlt({
          asset,
          ...(options?.altOverride === undefined ? {} : { altOverride: options.altOverride }),
          ...(options?.decorative === undefined ? {} : { decorative: options.decorative }),
        }),
      };
    },
    async getAssetViewModels(mediaIds, options) {
      const ids = [...new Set(mediaIds)];
      const out: Record<string, MediaAssetPublicViewModel | null> = {};
      for (const id of ids) out[id] = null;
      if (ids.length === 0) return out;
      for (let offset = 0; offset < ids.length; offset += 500) {
        const assets = await getAssetsByIds(input.pool, ids.slice(offset, offset + 500));
        const live = assets.filter(
          (asset) => options?.includeArchived === true || asset.archivedAt === null,
        );
        if (live.length === 0) continue;
        const variants = await listVariantsForAssets(
          input.pool,
          live.map((asset) => ({ assetId: asset.id, versionNo: asset.currentVersionNo })),
        );
        const grouped = new Map<string, MediaVariantRecord[]>();
        for (const variant of variants) {
          const group = grouped.get(variant.assetId) ?? [];
          group.push(variant);
          grouped.set(variant.assetId, group);
        }
        for (const asset of live)
          out[asset.id] = publicViewModel(asset, grouped.get(asset.id) ?? []);
      }
      return out;
    },
  };
}
