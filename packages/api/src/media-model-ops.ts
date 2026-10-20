// Media model surface (Image Generation v2, plan T2.2/T2.5): setup-time
// model discovery + capability snapshots + pre-generation cost estimates.
// Two permission tiers: model discovery/sync touches the provider API key
// and is media.providers.manage; the capability snapshot view and the cost
// estimate are runtime surfaces for humans AND agents (media.read /
// media.generate) — an agent must be able to learn a model's contract and
// price before any cost-bearing call (owner decision 2026-09-28).

import {
  DEFAULT_COUNT,
  estimateGenerationCost,
  type GenerationCostEstimate,
  type ImageGenerationProvider,
  isModelStale,
  type ModelCapabilities,
} from "@pcms/media";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

function requireGenerationProvider(
  app: ApplicationServices,
  providerId: string,
): Promise<ImageGenerationProvider> {
  return app.mediaProviders.generation(providerId).then((provider) => {
    if (provider === null) {
      throw new ApiError(
        "PROVIDER_NOT_CONFIGURED",
        `generation provider "${providerId}" is not installed or not configured`,
        { status: 409 },
      );
    }
    return provider;
  });
}

function unsupported(providerId: string): ApiError {
  return new ApiError(
    "MEDIA_MODELS_UNSUPPORTED",
    `generation provider "${providerId}" does not expose a model catalog`,
    { status: 404 },
  );
}

function capabilitiesWire(capabilities: ModelCapabilities): Record<string, unknown> {
  return {
    model: capabilities.model,
    display_name: capabilities.displayName,
    size_options: capabilities.sizeOptions.map((option) => ({
      ratio: option.ratio,
      width: option.width,
      height: option.height,
      tier: option.tier,
    })),
    dimension_mode: capabilities.requestProfile.dimensionMode,
    resolution_map: capabilities.requestProfile.resolutionMap ?? null,
    send_steps: capabilities.requestProfile.sendSteps,
    send_cfg_scale: capabilities.requestProfile.sendCfgScale,
    send_scheduler: capabilities.requestProfile.sendScheduler,
    send_seed: capabilities.requestProfile.sendSeed,
    send_strength: capabilities.requestProfile.sendStrength,
    max_reference_images: capabilities.requestProfile.maxReferenceImages,
    provider_settings: capabilities.requestProfile.providerSettings ?? null,
    settings: capabilities.requestProfile.settings ?? null,
    max_count: capabilities.maxCount,
    supports_negative_prompt: capabilities.supportsNegativePrompt,
    pricing: capabilities.pricing ?? null,
    source: capabilities.source,
    schema_sha256: capabilities.schemaSha256,
    last_synced_at: capabilities.lastSyncedAt,
    stale: isModelStale(capabilities),
  };
}

/** Live model discovery against the provider catalog (setup UI). */
export async function listProviderModelsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly provider_id: string;
    readonly search?: string | null;
    readonly limit?: number | null;
  },
) {
  requirePermission(app, ctx, "media.providers.manage");
  const provider = await requireGenerationProvider(app, input.provider_id);
  if (provider.listModels === undefined) throw unsupported(input.provider_id);
  const items = await provider.listModels(
    { requestId: ctx.requestId },
    {
      ...(input.search === undefined || input.search === null ? {} : { search: input.search }),
      ...(input.limit === undefined || input.limit === null ? {} : { limit: input.limit }),
    },
  );
  return {
    items: items.map((entry) => ({
      model: entry.model,
      display_name: entry.displayName,
      capabilities: entry.capabilities,
      thumbnail: entry.thumbnail,
      status: entry.status,
    })),
  };
}

/** One model's contract: stored snapshot (with stale flag) or live sync. */
export async function getProviderModelOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly provider_id: string;
    readonly model_id: string;
    readonly sync?: boolean | null;
  },
) {
  requirePermission(app, ctx, "media.providers.manage");
  const provider = await requireGenerationProvider(app, input.provider_id);
  if (!input.sync) {
    const snapshot = provider.configuredModels?.().find((entry) => entry.model === input.model_id);
    if (snapshot !== undefined) {
      return { model: capabilitiesWire(snapshot), resolved: "snapshot" as const };
    }
  }
  if (provider.resolveModelCapabilities === undefined) throw unsupported(input.provider_id);
  const resolved = await provider.resolveModelCapabilities(
    { requestId: ctx.requestId },
    input.model_id,
  );
  if (resolved === null) {
    throw new ApiError(
      "MEDIA_MODEL_UNKNOWN",
      `provider "${input.provider_id}" cannot resolve a contract for model "${input.model_id}"`,
      { status: 404 },
    );
  }
  return { model: capabilitiesWire(resolved), resolved: "live" as const };
}

/** Runtime capability surface (media.read): configured models + their
 *  contracts, so agents and the studio can plan a generation. */
export async function getMediaProviderCapabilitiesV2Op(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly provider_id: string },
) {
  requirePermission(app, ctx, "media.read");
  const provider = await requireGenerationProvider(app, input.provider_id);
  const legacy = provider.capabilities();
  const configured = provider.configuredModels?.() ?? [];
  return {
    provider_id: provider.providerId,
    display_name: provider.displayName,
    models: legacy.models,
    max_count: legacy.maxCount,
    supports_seed: legacy.supportsSeed,
    supports_negative_prompt: legacy.supportsNegativePrompt,
    aspects: legacy.aspects,
    configured_models: configured.map(capabilitiesWire),
  };
}

function costWire(estimate: GenerationCostEstimate): Record<string, unknown> {
  return {
    per_image_usd: estimate.perImageUsd,
    total_usd: estimate.totalUsd,
    approximate: estimate.approximate,
    basis: estimate.basis,
    hint: estimate.hint,
  };
}

/** Pre-generation cost estimate (media.generate): approximate by contract,
 *  honest refusals for token-priced/unpublished models. */
export async function estimateMediaGenerationOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly provider_id?: string | null;
    readonly model?: string | null;
    readonly aspect?: string | null;
    readonly resolution?: string | null;
    readonly count?: number | null;
  },
) {
  requirePermission(app, ctx, "media.generate");
  const providerId =
    input.provider_id ?? (await app.mediaProviders.generationProviders())[0]?.providerId;
  if (providerId === undefined) {
    throw new ApiError("PROVIDER_NOT_CONFIGURED", "no generation provider is installed", {
      status: 409,
    });
  }
  const provider = await requireGenerationProvider(app, providerId);
  const configured = provider.configuredModels?.() ?? [];
  const model =
    (input.model === undefined || input.model === null
      ? undefined
      : configured.find((entry) => entry.model === input.model)) ??
    configured[0] ??
    null;
  if (model === null) {
    throw new ApiError(
      "MEDIA_MODEL_UNKNOWN",
      `provider "${providerId}" has no configured model snapshot; sync a model first`,
      { status: 404 },
    );
  }
  const estimate = estimateGenerationCost(model, {
    ...(input.aspect === undefined || input.aspect === null ? {} : { aspect: input.aspect }),
    ...(input.resolution === undefined || input.resolution === null
      ? {}
      : { resolution: input.resolution }),
    count: input.count ?? DEFAULT_COUNT,
  });
  return { provider_id: providerId, model: model.model, estimate: costWire(estimate) };
}
