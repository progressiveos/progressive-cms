// Cost preview for image generation (Image Generation v2, plan T1.6):
// a pure estimator over a model's published pricing lines. Provider prices
// are display data — the estimate is approximate by construction and the
// authoritative cost is the one the provider returns with the generation
// (usage.cost / includeCost). Never guessed: when the basis cannot support
// a number (token-priced models, unpublished prices) perImageUsd is null
// and the hint explains why.
import type { ModelCapabilities, ModelSizeOption } from "./providers.js";

export type CostBasis =
  | "configuration"
  | "megapixel"
  | "image"
  | "token"
  | "unpublished"
  | "size-unknown";

export interface GenerationCostEstimate {
  /** Per-image price, null when the basis cannot produce an honest number. */
  readonly perImageUsd: number | null;
  /** perImageUsd × count, null when perImageUsd is null. */
  readonly totalUsd: number | null;
  readonly approximate: boolean;
  readonly basis: CostBasis;
  /** Operator-facing explanation (English; i18n is a client concern). */
  readonly hint: string | null;
}

export interface GenerationCostIntent {
  readonly aspect?: string | null;
  readonly resolution?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly count: number;
}

function megapixels(width: number, height: number): number {
  return (width * height) / 1_000_000;
}

/** Resolves the requested generation size through the model's sizeOptions —
 *  the same table the studio renders, so the estimate always matches what
 *  will actually be sent. Returns null when the intent is underspecified. */
function resolveSizeOption(
  capabilities: Pick<ModelCapabilities, "sizeOptions">,
  intent: GenerationCostIntent,
): ModelSizeOption | null {
  const explicit =
    typeof intent.width === "number" &&
    intent.width > 0 &&
    typeof intent.height === "number" &&
    intent.height > 0
      ? { width: intent.width, height: intent.height }
      : null;
  if (explicit !== null) return { ratio: "", tier: null, ...explicit };
  const wantedTier = intent.resolution ?? null;
  const matches = capabilities.sizeOptions.filter(
    (option) =>
      (intent.aspect === undefined || intent.aspect === null || option.ratio === intent.aspect) &&
      (wantedTier === null || option.tier === wantedTier),
  );
  return matches[0] ?? capabilities.sizeOptions[0] ?? null;
}

function configurationLines(
  capabilities: ModelCapabilities,
): { width: number; height: number; costUsd: number }[] {
  return (capabilities.pricing ?? []).flatMap((line) =>
    line.unit === "configuration" &&
    typeof line.width === "number" &&
    typeof line.height === "number"
      ? [{ width: line.width, height: line.height, costUsd: line.costUsd }]
      : [],
  );
}

/** Interpolates per-image price between the two measured configurations
 *  nearest (by megapixels) to the request, clamped at the range ends —
 *  provider per-megapixel rates drift with size, so this stays approximate. */
function interpolateFromConfigurations(
  lines: { width: number; height: number; costUsd: number }[],
  mp: number,
): number {
  const points = [...lines]
    .sort((a, b) => megapixels(a.width, a.height) - megapixels(b.width, b.height))
    .map((line) => ({ mp: megapixels(line.width, line.height), price: line.costUsd }));
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (mp <= first.mp) return first.price;
  if (mp >= last.mp) return last.price;
  for (let i = 1; i < points.length; i += 1) {
    const upper = points[i];
    if (upper === undefined) break;
    if (mp <= upper.mp) {
      const lower = points[i - 1];
      if (lower === undefined) break;
      const t = (mp - lower.mp) / (upper.mp - lower.mp);
      return lower.price + t * (upper.price - lower.price);
    }
  }
  return last.price;
}

/**
 * Estimates the generation cost for the requested settings against a
 * model's published pricing. Order of preference: exact measured
 * configuration → interpolation between measured configurations → flat
 * per-image price → per-megapixel price → honest refusal (token-priced or
 * unpublished).
 */
export function estimateGenerationCost(
  capabilities: ModelCapabilities,
  intent: GenerationCostIntent,
): GenerationCostEstimate {
  const count = Math.max(1, Math.trunc(intent.count) || 1);
  const pricing = capabilities.pricing ?? [];

  // Flat per-image lines (unit "image"); a line whose variant matches the
  // requested tier (e.g. "2K" for resolution "2k") wins over the first line.
  const imageLines = pricing.filter((line) => line.unit === "image");
  const wantedTier = intent.resolution?.toLowerCase() ?? null;
  const flatImage =
    imageLines.find((line) => wantedTier !== null && line.variant?.toLowerCase() === wantedTier) ??
    imageLines[0];
  const mpLines = pricing.filter((line) => line.unit === "megapixel");
  const tokenPriced = pricing.some((line) => line.unit === "token");

  const size = resolveSizeOption(capabilities, intent);
  const configs = configurationLines(capabilities);

  if (size !== null && configs.length > 0) {
    const mp = megapixels(size.width, size.height);
    const exact = configs.find((line) => line.width === size.width && line.height === size.height);
    if (exact !== undefined) {
      return {
        perImageUsd: exact.costUsd,
        totalUsd: exact.costUsd * count,
        approximate: false,
        basis: "configuration",
        hint: null,
      };
    }
    const perImage = interpolateFromConfigurations(configs, mp);
    return {
      perImageUsd: perImage,
      totalUsd: perImage * count,
      approximate: true,
      basis: "megapixel",
      hint: "estimated from the provider's measured prices at nearby sizes",
    };
  }

  if (flatImage !== undefined) {
    return {
      perImageUsd: flatImage.costUsd,
      totalUsd: flatImage.costUsd * count,
      approximate: false,
      basis: "image",
      hint: null,
    };
  }

  if (size !== null) {
    const mpLine = mpLines[0];
    if (mpLine !== undefined) {
      const mp = megapixels(size.width, size.height);
      const perImage = mpLine.costUsd * mp;
      return {
        perImageUsd: perImage,
        totalUsd: perImage * count,
        approximate: true,
        basis: "megapixel",
        hint: "estimated from the provider's per-megapixel rate",
      };
    }
  }

  if (tokenPriced) {
    return {
      perImageUsd: null,
      totalUsd: null,
      approximate: true,
      basis: "token",
      hint: "priced by output tokens — the exact cost is returned with the generation",
    };
  }

  if (size === null && configs.length === 0) {
    return {
      perImageUsd: null,
      totalUsd: null,
      approximate: true,
      basis: "size-unknown",
      hint: "pick a model and size to see a cost estimate",
    };
  }

  return {
    perImageUsd: null,
    totalUsd: null,
    approximate: true,
    basis: "unpublished",
    hint: "the provider does not publish prices",
  };
}
