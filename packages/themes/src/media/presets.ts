// Media preset manifest contract + template image helper
// (PCMS-THEME-T015; Theme Contract spec §35/§36/§54).
//
// The theme declares image presets in its manifest; the Media subsystem
// (M05) owns the actual transform pipeline and resolves derivatives against
// these presets. A theme template never writes `?w=640&h=480` — it asks for
// a preset and receives the already-resolved derivative from the Media view
// model. `buildImageModel` turns (asset, preset) into a ready-to-render
// model (src/srcset/width/height/lazy) so template authors never hand-build
// WebP/AVIF URL sets.
import { ThemeError } from "../errors.js";
import type { ThemeManifest, ThemeManifestMediaPreset } from "../manifest/schema.js";
import type { MediaAssetViewModel, MediaDerivativeViewModel } from "../view-models.js";

export interface MediaPresetDescriptor {
  readonly id: string;
  readonly width: number;
  readonly height: number | null;
  readonly fit: string;
  readonly formats: readonly string[];
  readonly loading: "lazy" | "eager";
}

export interface MediaPresetRegistry {
  /** Deterministic preset discovery (consumed by the Media module in M05). */
  listPresets(): readonly MediaPresetDescriptor[];
  getPreset(id: string): ThemeManifestMediaPreset | null;
}

export function createMediaPresetRegistry(manifest: ThemeManifest): MediaPresetRegistry {
  const byId = new Map(manifest.media_presets.map((p) => [p.id, p]));
  return {
    listPresets() {
      return [...byId.values()]
        .map((p) => ({
          id: p.id,
          width: p.width,
          height: p.height ?? null,
          fit: p.fit ?? "cover",
          formats: p.formats ?? ["webp"],
          loading: p.loading ?? "lazy",
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    getPreset(id) {
      return byId.get(id) ?? null;
    },
  };
}

/** Finds the derivative the Media subsystem resolved for a preset. */
export function resolveDerivative(
  asset: MediaAssetViewModel,
  presetId: string,
): MediaDerivativeViewModel | null {
  return asset.derivatives.find((d) => d.preset === presetId) ?? null;
}

export interface ImageSourceModel {
  /** Served MIME type for `<picture><source type=…>`; null when the
   * producing side did not supply one. */
  readonly mime: string | null;
  /** width-descriptor srcset of this MIME family (same preset only). */
  readonly srcset: string;
}

export interface ImageModel {
  readonly src: string;
  /** Combined width-descriptor srcset across the preset's OWN formats —
   * never cross-preset candidates (see `sources` for MIME separation). */
  readonly srcset: string;
  /** MIME-separated same-preset candidate families for `<picture>` sources
   * (the src format family rides `<img srcset>` and is not repeated). */
  readonly sources: readonly ImageSourceModel[];
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string;
  readonly loading: "lazy" | "eager";
  readonly preset: string;
}

/**
 * Builds the template image model for (asset, preset). Throws
 * THEME_MEDIA_PRESET_UNKNOWN when no derivative was resolved — silent
 * fallback to the original file is exactly what §54 forbids.
 */
export function buildImageModel(
  asset: MediaAssetViewModel,
  presetId: string,
  preset?: ThemeManifestMediaPreset | null,
): ImageModel {
  const derivative = resolveDerivative(asset, presetId);
  if (derivative === null) {
    throw new ThemeError(
      "THEME_MEDIA_PRESET_UNKNOWN",
      `no derivative resolved for preset "${presetId}"`,
      {
        details: { assetId: asset.id, preset: presetId },
      },
    );
  }
  // Responsive candidates scope to THIS preset and the asset's current
  // derivatives (Media §61 reconciliation; p-cms.com 0.1.162 audit: the
  // srcset used to mix every other preset in — card images picking up
  // 1500w hero candidates, og-v1/favicon-v1 core derivatives, and
  // duplicate widths across formats).
  const candidates = asset.derivatives
    .filter((d) => d.preset === presetId && d.width !== null)
    .sort((a, b) => (b.width as number) - (a.width as number));
  const srcMime = derivative.mime ?? null;
  const byMime = new Map<string, { mime: string | null; entries: MediaDerivativeViewModel[] }>();
  for (const d of candidates) {
    const mime = d.mime ?? null;
    const key = mime ?? `url:${d.url}`;
    const bucket = byMime.get(key);
    if (bucket === undefined) byMime.set(key, { mime, entries: [d] });
    else bucket.entries.push(d);
  }
  const srcset = (
    byMime
      .get(srcMime === null ? `url:${derivative.url}` : srcMime)
      ?.entries.map((d) => `${d.url} ${d.width}w`) ?? []
  ).join(", ");
  const sources: ImageSourceModel[] = [...byMime.values()]
    .filter((bucket) => bucket.mime !== srcMime)
    .map((bucket) => ({
      mime: bucket.mime,
      srcset: bucket.entries.map((d) => `${d.url} ${d.width}w`).join(", "),
    }));
  return {
    src: derivative.url,
    srcset,
    sources,
    width: derivative.width ?? asset.width,
    height: derivative.height ?? asset.height,
    alt: asset.alt,
    loading: preset?.loading ?? "lazy",
    preset: presetId,
  };
}
