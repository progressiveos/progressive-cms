import { t } from "../../i18n/index.js";

export interface MediaVariantFailureWire {
  readonly media_id: string;
  readonly preset: string;
  readonly error: string;
}

export function mediaVariantWarning(
  failures: readonly MediaVariantFailureWire[] | undefined,
): string | null {
  if (failures === undefined || failures.length === 0) return null;
  const presets = [...new Set(failures.map((failure) => failure.preset))].sort().join(", ");
  return t("media.variant_generation_incomplete", { presets });
}
