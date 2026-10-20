// Image decode/processing adapter over sharp/libvips (PCMS-MEDIA-T006/T008;
// Media spec §10/§11/§23/§25/§26).
//
// The approved processor baseline is Sharp/libvips, pinned exactly in
// package.json (no shell-out, no ImageMagick). All decode work is bounded:
// `limitInputPixels` guards decompression bombs at the header level and the
// explicit dimension/pixel checks run before any pixel is decoded.
import sharp, { type Sharp } from "sharp";
import { MediaError } from "./errors.js";

export const PROCESSOR_ID = "sharp";
/**
 * Processor identity for deterministic variant keys (Media spec §17/§23):
 * a sharp/libvips upgrade can change binary output, so the version belongs
 * in the cache identity.
 */
export function processorVersion(): string {
  return `${sharp.versions.sharp}+vips${sharp.versions.vips}`;
}

export interface ImageDecodeLimits {
  /** Maximum decoded pixels (width × height) — decompression-bomb bound. */
  readonly maxPixels: number;
  /** Maximum width/height per axis. */
  readonly maxDimension: number;
}

export const DEFAULT_IMAGE_DECODE_LIMITS: ImageDecodeLimits = {
  maxPixels: 64_000_000, // 64 MP
  maxDimension: 16_384,
};

export interface ImageTechnicalMetadata {
  /** Display dimensions — EXIF orientation already applied (Media spec §11). */
  readonly width: number;
  readonly height: number;
  readonly format: string;
  /** Stored EXIF orientation (1..8) before normalization. */
  readonly orientation: number;
  /** Multi-page (animated) GIF/WebP/AVIF — policy keeps them intact (§25). */
  readonly animated: boolean;
  readonly hasAlpha: boolean;
  /** "srgb" | "cmyk" | … — color profile summary (§12). */
  readonly colorSpace: string;
}

/**
 * Reads trusted technical metadata from image bytes. Corrupt/truncated
 * input is a MEDIA_DECODE_FAILED; oversized declarations are rejected as
 * MEDIA_PIXEL_LIMIT before decode work starts.
 */
export async function readImageMetadata(
  bytes: Buffer,
  limits: ImageDecodeLimits = DEFAULT_IMAGE_DECODE_LIMITS,
): Promise<ImageTechnicalMetadata> {
  // Header parse reads chunk metadata only — no pixel allocation. sharp's
  // built-in pixel guard refuses gigantic declarations at this stage; the
  // explicit checks below give precise codes for the configured limits.
  const raw = await sharp(bytes)
    .metadata()
    .catch((error: unknown) => {
      if (error instanceof Error && /exceeds pixel limit/i.test(error.message)) {
        throw new MediaError("MEDIA_PIXEL_LIMIT", "image declares an excessive pixel count", {
          cause: error,
        });
      }
      throw new MediaError("MEDIA_DECODE_FAILED", "image header could not be decoded", {
        cause: error,
      });
    });
  if (raw.width === undefined || raw.height === undefined) {
    throw new MediaError("MEDIA_DECODE_FAILED", "image lacks usable dimensions");
  }
  const swapped = raw.orientation !== undefined && raw.orientation >= 5;
  const width = swapped ? raw.height : raw.width;
  const height = swapped ? raw.width : raw.height;
  if (width > limits.maxDimension || height > limits.maxDimension) {
    throw new MediaError(
      "MEDIA_PIXEL_LIMIT",
      `image dimensions ${width}×${height} exceed the ${limits.maxDimension}px axis limit`,
    );
  }
  if (width * height > limits.maxPixels) {
    throw new MediaError(
      "MEDIA_PIXEL_LIMIT",
      `image declares ${width * height} pixels, over the ${limits.maxPixels}-pixel limit`,
    );
  }
  return {
    width,
    height,
    format: normalizeFormat(raw.format ?? "unknown", bytes),
    orientation: raw.orientation ?? 1,
    animated: (raw.pages ?? 1) > 1,
    hasAlpha: raw.hasAlpha ?? false,
    colorSpace: raw.space ?? "unknown",
  };
}

/**
 * libvips reports AVIF (an HEIF container brand) as "heif"; the CMS speaks
 * the web format name. The brand check keeps the mapping honest.
 */
function normalizeFormat(format: string, bytes: Buffer): string {
  if (format === "heif" && bytes.subarray(8, 12).toString("latin1") === "avif") {
    return "avif";
  }
  return format;
}

/**
 * Privacy/orientation/color policy applied to every public derivative
 * (PCMS-MEDIA-T007; Media spec §11/§12):
 *   - auto-orient (EXIF orientation applied to pixels, then dropped);
 *   - sharp's default metadata stripping stays active — GPS, camera serials,
 *     user comments never survive into public outputs;
 *   - pixels are normalized to sRGB so non-sRGB ICC profiles (Display P3,
 *     CMYK JPEGs) keep their intended visual color instead of drifting.
 * Animated sources keep their untouched original; derivatives render the
 * first frame only (static preview, §25) — nothing is flattened in place.
 */
export const DERIVATIVE_METADATA_POLICY = {
  orientationApplied: true,
  metadataStripped: true,
  outputColorspace: "srgb",
  derivativesStaticPreview: true,
} as const;

export interface TransformInstruction {
  readonly width?: number;
  readonly height?: number;
  /** cover | contain | fill | inside | outside (sharp fit values). */
  readonly fit: "cover" | "contain" | "fill" | "inside" | "outside";
  /** Focal point 0..1 for cover crops; undefined = center (§15). */
  readonly focalX?: number;
  readonly focalY?: number;
  /** Output format for the derivative. */
  readonly format: "avif" | "webp" | "jpeg" | "png";
  readonly quality: number;
  /** Crop position/strategy when no focal point is given. */
  readonly cropStrategy?: "center" | "top" | "bottom" | "left" | "right" | "entropy" | "attention";
  /** Core-owned exact-dimension presets (og-v1/favicon-v1) upscale small
   * sources to reach the declared dimensions. Ordinary theme presets keep
   * the never-enlarge policy: an undersized source yields a smaller image
   * (Media spec §18). */
  readonly allowEnlargement?: boolean;
  /** Padding color for fits that letterbox (contain). Alpha-capable formats
   * (png/webp/avif) pass transparent so logos never get black bars. */
  readonly background?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly alpha: number;
  };
}

/**
 * Applies one deterministic transform to source bytes. Determinism contract
 * (T008): same input bytes + same instruction + same processor version ⇒
 * byte-identical output (no timestamps, no trailing metadata beyond policy).
 */
export async function transformImage(
  source: Buffer,
  instruction: TransformInstruction,
  limits: ImageDecodeLimits = DEFAULT_IMAGE_DECODE_LIMITS,
): Promise<{ bytes: Buffer; width: number; height: number; format: string }> {
  // Default input option reads only the first page → static previews (§25).
  let pipeline = sharp(source, {
    limitInputPixels: limits.maxPixels,
    sequentialRead: true,
  });
  // Orientation → sRGB normalization; metadata stripping is sharp's default
  // and deliberately not opted out of (Media spec §11).
  pipeline = pipeline.rotate().toColourspace("srgb");
  pipeline = await applyCrop(pipeline, instruction);
  pipeline = pipeline.toFormat(
    instruction.format,
    formatOptions(instruction.format, instruction.quality),
  );
  try {
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      width: info.width,
      height: info.height,
      format: normalizeFormat(info.format, data),
    };
  } catch (error) {
    throw new MediaError("MEDIA_VARIANT_FAILED", "image transform failed", { cause: error });
  }
}

async function applyCrop(pipeline: Sharp, instruction: TransformInstruction): Promise<Sharp> {
  const width = instruction.width;
  const height = instruction.height;
  if (width === undefined && height === undefined) return pipeline;
  if (
    instruction.fit === "cover" &&
    (instruction.focalX !== undefined || instruction.focalY !== undefined)
  ) {
    // Focal-point cover crop (T012): compute the exact source crop window
    // that keeps the focal point in frame, extract, then scale to target —
    // sharp's built-in gravity positions are too coarse for focal crops.
    const meta = await pipeline.metadata();
    if (meta.width === undefined || meta.height === undefined) return pipeline;
    const sourceW = meta.width;
    const sourceH = meta.height;
    const targetW = width ?? Number.POSITIVE_INFINITY;
    const targetH = height ?? Number.POSITIVE_INFINITY;
    const scale = Math.max(
      Number.isFinite(targetW) ? targetW / sourceW : 0,
      Number.isFinite(targetH) ? targetH / sourceH : 0,
    );
    if (scale > 0 && scale < Number.POSITIVE_INFINITY) {
      const cropW = Math.min(Math.round(targetW / scale), sourceW);
      const cropH = Math.min(Math.round(targetH / scale), sourceH);
      const clamp01 = (value: number | undefined): number =>
        value === undefined || Number.isNaN(value) ? 0.5 : Math.min(Math.max(value, 0), 1);
      const fx = clamp01(instruction.focalX);
      const fy = clamp01(instruction.focalY);
      const left = Math.min(Math.max(Math.round(fx * sourceW - cropW / 2), 0), sourceW - cropW);
      const top = Math.min(Math.max(Math.round(fy * sourceH - cropH / 2), 0), sourceH - cropH);
      return pipeline.extract({ left, top, width: cropW, height: cropH }).resize({
        width: width ?? undefined,
        height: height ?? undefined,
        fit: "fill",
        withoutEnlargement: instruction.allowEnlargement !== true,
      });
    }
  }
  const position =
    instruction.focalX === undefined && instruction.focalY === undefined
      ? cropPosition(instruction.cropStrategy ?? "center")
      : undefined;
  return pipeline.resize({
    width,
    height,
    fit: instruction.fit,
    ...(position === undefined ? {} : { position }),
    ...(instruction.background === undefined ? {} : { background: instruction.background }),
    withoutEnlargement: instruction.allowEnlargement !== true,
  });
}

function formatOptions(
  format: TransformInstruction["format"],
  quality: number,
): Record<string, unknown> {
  const bounded = Math.min(Math.max(quality, 1), 100);
  switch (format) {
    case "avif":
      return { quality: bounded, effort: 4 };
    case "webp":
      return { quality: bounded, effort: 3 };
    case "jpeg":
      return { quality: bounded, mozjpeg: true };
    case "png":
      return { compressionLevel: 9 };
  }
}

function cropPosition(
  strategy: NonNullable<TransformInstruction["cropStrategy"]>,
): number | string {
  switch (strategy) {
    case "entropy":
      return sharp.strategy.entropy;
    case "attention":
      return sharp.strategy.attention;
    default:
      return "centre";
  }
}
