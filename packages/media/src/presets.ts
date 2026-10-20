// Typed Media Presets + ingestion from theme manifests
// (PCMS-MEDIA-T009; Media spec §16/§63/§64).
//
// Themes declare logical presets (hero, card, thumbnail…); the composition
// layer feeds them here for validation and deterministic discovery. Themes
// never build transform URLs — the preset ID is the only transform contract
// (§63). `packages/media` is L1 and cannot import `@pcms/themes`, so this
// module defines the structural shape of a manifest preset and validates it;
// `createThemePresetInputs` is the documented adapter surface.

import { createHash } from "node:crypto";
import { isStableId } from "@pcms/core";
import { MediaError } from "./errors.js";
import { PROCESSOR_ID, processorVersion } from "./image.js";

export type MediaPresetFit = "cover" | "contain" | "fill" | "inside" | "outside";
export type MediaPresetCrop = "center" | "top" | "bottom" | "left" | "right" | "entropy";
export type MediaPresetFormat = "avif" | "webp" | "jpeg" | "png";
export type MediaPresetLoading = "lazy" | "eager";

export interface MediaPreset {
  /** Logical preset ID as declared by the theme (e.g. "card"). */
  readonly id: string;
  readonly width: number;
  readonly height: number | null;
  readonly fit: MediaPresetFit;
  /** Crop hint; asset focal point overrides positional crops (§15). */
  readonly crop: MediaPresetCrop;
  readonly formats: readonly MediaPresetFormat[];
  readonly quality: number;
  readonly loading: MediaPresetLoading;
  /** Core-owned exact-dimension contract (og-v1/favicon-v1): the variant
   * MUST come out at exactly width×height — an undersized source is
   * enlarged, and a cached row violating the declaration is rebuilt.
   * Themes cannot declare it: validatePresetInput never sets it. */
  readonly exactDimensions?: boolean;
}

const PRESET_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const FITS: readonly MediaPresetFit[] = ["cover", "contain", "fill", "inside", "outside"];
const CROPS: readonly MediaPresetCrop[] = ["center", "top", "bottom", "left", "right", "entropy"];
const FORMATS: readonly MediaPresetFormat[] = ["avif", "webp", "jpeg", "png"];

/** Structural validation of one theme-manifest-shaped preset. */
export function validatePresetInput(raw: unknown): MediaPreset {
  if (typeof raw !== "object" || raw === null) {
    throw new MediaError("MEDIA_PRESET_INVALID", "preset must be an object");
  }
  const value = raw as Record<string, unknown>;
  const id = value.id;
  if (typeof id !== "string" || !PRESET_ID_PATTERN.test(id)) {
    throw new MediaError("MEDIA_PRESET_INVALID", `invalid preset id ${JSON.stringify(id)}`);
  }
  const reject = (message: string): never => {
    throw new MediaError("MEDIA_PRESET_INVALID", `preset "${id}": ${message}`);
  };
  const requireInt = (raw: unknown, min: number, max: number, message: string): number => {
    const parsed = intInRange(raw, min, max);
    if (parsed === null) {
      throw new MediaError("MEDIA_PRESET_INVALID", `preset "${id}": ${message}`);
    }
    return parsed;
  };
  const width = requireInt(value.width, 16, 8192, "width must be an integer in 16..8192");
  const height =
    value.height === undefined || value.height === null
      ? null
      : requireInt(value.height, 16, 8192, "height must be an integer in 16..8192");
  const fit = (value.fit ?? "cover") as MediaPresetFit;
  if (!FITS.includes(fit)) reject(`fit "${String(value.fit)}" is not supported`);
  const crop = (value.crop ?? "center") as MediaPresetCrop;
  if (!CROPS.includes(crop)) reject(`crop "${String(value.crop)}" is not supported`);
  const formats = (value.formats ?? ["webp"]) as MediaPresetFormat[];
  if (!Array.isArray(formats) || formats.length === 0 || formats.length > 5) {
    reject("formats must be a non-empty array (max 5)");
  }
  for (const format of formats) {
    if (!FORMATS.includes(format)) reject(`format "${String(format)}" is not supported`);
  }
  const quality =
    value.quality === undefined || value.quality === null
      ? 80
      : requireInt(value.quality, 1, 100, "quality must be an integer in 1..100");
  const loading = (value.loading ?? "lazy") as MediaPresetLoading;
  if (loading !== "lazy" && loading !== "eager") reject("loading must be lazy or eager");
  return { id, width, height, fit, crop, formats, quality, loading };
}

function intInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

export interface MediaPresetRegistry {
  /** Deterministic (ID-sorted) preset discovery. */
  readonly listPresets: () => readonly MediaPreset[];
  readonly getPreset: (id: string) => MediaPreset | null;
}

export function createMediaPresetRegistry(presets: readonly unknown[]): MediaPresetRegistry {
  const byId = new Map<string, MediaPreset>();
  for (const raw of presets) {
    const validated = validatePresetInput(raw);
    if (byId.has(validated.id)) {
      throw new MediaError("MEDIA_PRESET_INVALID", `duplicate preset id "${validated.id}"`);
    }
    byId.set(validated.id, validated);
  }
  return {
    listPresets: () => [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    getPreset: (id) => byId.get(id) ?? null,
  };
}

/**
 * Deterministic variant cache identity (PCMS-MEDIA-T010; Media spec §17/§23):
 * source digest + logical version + every transform parameter + output
 * format + processor version. Two identical requests resolve to the same
 * derivative; a changed source, preset or processor invalidates naturally.
 */
export function variantKeyFor(input: {
  readonly sourceSha256: string;
  readonly versionNo: number;
  readonly presetId: string;
  readonly width: number;
  readonly height: number | null;
  readonly fit: string;
  readonly crop: string;
  readonly focalX: number | null;
  readonly focalY: number | null;
  readonly quality: number;
  readonly format: string;
}): string {
  const hash = createHash("sha256");
  hash.update("pcms-variant-v1|");
  hash.update(input.sourceSha256);
  hash.update(`|v${input.versionNo}`);
  hash.update(`|${input.presetId}|${input.width}x${input.height ?? ""}`);
  hash.update(`|${input.fit}|${input.crop}`);
  hash.update(`|f${input.focalX ?? "-"},${input.focalY ?? "-"}`);
  hash.update(`|q${input.quality}`);
  hash.update(`|${input.format}`);
  hash.update(`|${PROCESSOR_ID}:${processorVersion()}`);
  return hash.digest("hex").slice(0, 32);
}

/** Stable-ID guard reused by preset-aware services. */
export function assertMediaId(id: string): void {
  if (!isStableId(id)) {
    throw new MediaError("MEDIA_ASSET_NOT_FOUND", `invalid media asset id "${id}"`);
  }
}
