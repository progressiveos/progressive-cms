// Provider-neutral media acquisition operations (PCMS-MPA-T009…T011;
// ADR-0013 §8, Media spec §71.4–§71.9). REST, MCP and Admin call exactly
// these functions. Candidates are server-authoritative: stock candidates
// travel as signed opaque tokens; generated candidates reference the
// server-owned run row. Import/accept always ingest through the existing
// media pipeline (uploadMedia) — no parallel storage, no client-supplied
// URLs. A provider failure never fails a multi-provider search.

import { systemActor } from "@pcms/auth";
import {
  CandidateTokenError,
  createGenerationRun,
  DEFAULT_COUNT,
  deleteExpiredGenerationRuns,
  effectiveMaxCount,
  findAssetIdByProviderAsset,
  type GeneratedCandidate,
  getAsset,
  getBlobByHash,
  listVersions,
  type MediaStockProvider,
  markGenerationRunFailed,
  markGenerationRunReady,
  markGenerationRunRunning,
  type ProviderContext,
  ProviderError,
  recordCandidateAccept,
  requireGenerationRun,
  type StockCandidate,
  type StockOrientation,
  setAssetProvenance,
  signStockCandidate,
  updateAssetMetadata,
  uploadMedia,
  verifyStockCandidate,
} from "@pcms/media";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";
import { generateVariantsAfterAccept } from "./operations.js";

const SEARCH_LIMIT_DEFAULT = 24;
const SEARCH_LIMIT_MAX = 50;
const GENERATION_MAX_PROMPT = 2000;

function providerCtx(ctx: OperationContext): ProviderContext {
  return { requestId: ctx.requestId };
}

function signingKey(app: ApplicationServices): string {
  if (app.mediaCandidateSigningKey === undefined) {
    throw new ApiError(
      "MEDIA_ACQUISITION_NOT_CONFIGURED",
      "stock candidate signing key is not configured for this deployment",
      { status: 409 },
    );
  }
  return app.mediaCandidateSigningKey;
}

/** Wire shape of a stock candidate — token + safe metadata for the grid. */
export interface StockCandidateView {
  readonly candidate_ref: string;
  readonly provider_id: string;
  readonly provider_asset_id: string;
  readonly preview_url: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly creator_name: string | null;
  readonly creator_url: string | null;
  readonly source_url: string | null;
  readonly license_name: string | null;
  readonly license_url: string | null;
}

function candidateView(candidate: StockCandidate, candidateRef: string): StockCandidateView {
  return {
    candidate_ref: candidateRef,
    provider_id: candidate.providerId,
    provider_asset_id: candidate.providerAssetId,
    preview_url: candidate.previewUrl,
    width: candidate.width,
    height: candidate.height,
    creator_name: candidate.creatorName,
    creator_url: candidate.creatorUrl,
    source_url: candidate.sourceUrl,
    license_name: candidate.licenseName,
    license_url: candidate.licenseUrl,
  };
}

export async function searchStockMediaOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly query: string;
    readonly provider_id?: string | null;
    readonly orientation?: StockOrientation | null;
    readonly min_width?: number | null;
    readonly min_height?: number | null;
    readonly limit?: number | null;
    readonly cursor?: string | null;
  },
) {
  requirePermission(app, ctx, "media.stock.search");
  const query = input.query.trim();
  if (query.length === 0) {
    throw new ApiError("MEDIA_STOCK_QUERY_REQUIRED", "stock search requires a non-empty query", {
      status: 422,
    });
  }
  const limit = Math.min(Math.max(input.limit ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);
  const key = signingKey(app);
  const providers: readonly MediaStockProvider[] =
    input.provider_id === undefined || input.provider_id === null
      ? await app.mediaProviders.stockProviders()
      : await (async () => {
          const single = await app.mediaProviders.stock(input.provider_id as string);
          return single === null ? [] : [single];
        })();
  if (providers.length === 0) {
    throw new ApiError("PROVIDER_NOT_CONFIGURED", "no stock provider is installed and configured", {
      status: 409,
    });
  }
  // Per-provider cursors ride one opaque combined cursor (base64url JSON).
  let cursors: Record<string, string | null> = {};
  if (input.cursor) {
    try {
      cursors = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<
        string,
        string | null
      >;
    } catch {
      throw new ApiError("API_REQUEST_INVALID", "stock search cursor is not valid", {
        status: 400,
      });
    }
  }
  const items: StockCandidateView[] = [];
  const errors: { provider_id: string; code: string }[] = [];
  // Multi-provider search tolerates partial failure: providers that answer
  // contribute candidates; failures are reported per provider.
  await Promise.all(
    providers.map(async (provider) => {
      try {
        const result = await provider.search(providerCtx(ctx), {
          query,
          orientation: input.orientation ?? null,
          minWidth: input.min_width ?? null,
          minHeight: input.min_height ?? null,
          limit,
          cursor: cursors[provider.providerId] ?? null,
        });
        for (const candidate of result.candidates) {
          items.push(candidateView(candidate, signStockCandidate(candidate, key)));
        }
        if (result.nextCursor !== null) cursors[provider.providerId] = result.nextCursor;
        else delete cursors[provider.providerId];
      } catch (error) {
        errors.push({
          provider_id: provider.providerId,
          code: error instanceof ProviderError ? error.code : "PROVIDER_FAILED",
        });
      }
    }),
  );
  items.sort((a, b) =>
    a.provider_id === b.provider_id
      ? a.provider_asset_id < b.provider_asset_id
        ? -1
        : 1
      : a.provider_id < b.provider_id
        ? -1
        : 1,
  );
  const remainingCursors = Object.keys(cursors);
  return {
    items,
    ...(errors.length > 0 ? { errors } : {}),
    next_cursor:
      remainingCursors.length === 0
        ? null
        : Buffer.from(JSON.stringify(cursors)).toString("base64url"),
  };
}

export async function importStockCandidateOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly candidate_ref: string; readonly folder_id?: string | null },
) {
  requirePermission(app, ctx, "media.stock.import");
  const storage = app.mediaStorage;
  if (storage === null || app.mediaQuarantine === null) {
    throw new ApiError("MEDIA_STORAGE_UNAVAILABLE", "media storage is not configured", {
      status: 409,
    });
  }
  let candidate: StockCandidate;
  try {
    candidate = verifyStockCandidate(input.candidate_ref, signingKey(app));
  } catch (error) {
    if (error instanceof CandidateTokenError) {
      throw new ApiError(error.code, error.message, { status: 409 });
    }
    throw error;
  }
  // Duplicate-safe re-import: the same provider asset maps to the same asset.
  const existing = await findAssetIdByProviderAsset(
    app.pool,
    candidate.providerId,
    candidate.providerAssetId,
  );
  if (existing !== null) {
    return { media_id: existing, duplicate: true };
  }
  const provider = await app.mediaProviders.stock(candidate.providerId);
  if (provider === null) {
    throw new ApiError(
      "PROVIDER_NOT_CONFIGURED",
      `stock provider "${candidate.providerId}" is not installed or not configured`,
      { status: 409 },
    );
  }
  const fetched = await provider.fetch(providerCtx(ctx), candidate);
  const accepted = await uploadMedia(
    {
      pool: app.pool,
      storage,
      quarantine: app.mediaQuarantine,
      ...(app.mediaLimits === undefined ? {} : { limits: app.mediaLimits }),
    },
    {
      bytes: fetched.bytes,
      filename: fetched.filename,
      ...(fetched.mimeType === null ? {} : { declaredMimeType: fetched.mimeType }),
      createdBy: ctx.actor.id,
    },
  );
  await updateAssetMetadata(app.pool, accepted.asset.id, {
    ...(candidate.creatorName === null ? {} : { sourceName: candidate.creatorName }),
    ...(candidate.creatorUrl === null ? {} : { description: candidate.creatorUrl }),
    ...(candidate.sourceUrl === null ? {} : { sourceUrl: candidate.sourceUrl }),
    ...(candidate.licenseName === null ? {} : { license: candidate.licenseName }),
  });
  await setAssetProvenance(app.pool, accepted.asset.id, {
    origin: "stock",
    providerId: candidate.providerId,
    providerAssetId: candidate.providerAssetId,
    provenance: {
      creator_name: candidate.creatorName,
      creator_url: candidate.creatorUrl,
      source_url: candidate.sourceUrl,
      license_name: candidate.licenseName,
      license_url: candidate.licenseUrl,
      imported_at: new Date().toISOString(),
    },
  });
  await generateVariantsAfterAccept(app, accepted);
  return { media_id: accepted.asset.id, duplicate: false, duplicate_blob: accepted.duplicateBlob };
}

export async function createMediaGenerationOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly prompt: string;
    readonly provider_id?: string | null;
    readonly negative_prompt?: string | null;
    readonly aspect?: string | null;
    readonly resolution?: string | null;
    readonly width?: number | null;
    readonly height?: number | null;
    readonly count?: number | null;
    readonly model?: string | null;
    readonly seed?: number | null;
    readonly reference_media_ids?: readonly string[] | null;
  },
) {
  requirePermission(app, ctx, "media.generate");
  const prompt = input.prompt.trim();
  if (prompt.length === 0 || prompt.length > GENERATION_MAX_PROMPT) {
    throw new ApiError(
      "MEDIA_GENERATION_PROMPT_INVALID",
      "generation prompt must be 1..2000 characters",
      {
        status: 422,
      },
    );
  }
  const generators = await app.mediaProviders.generationProviders();
  if (generators.length === 0) {
    throw new ApiError(
      "PROVIDER_NOT_CONFIGURED",
      "no image generation provider is installed and configured",
      {
        status: 409,
      },
    );
  }
  const provider =
    input.provider_id === undefined || input.provider_id === null
      ? generators[0]
      : generators.find((entry) => entry.providerId === input.provider_id);
  if (provider === undefined) {
    throw new ApiError(
      "MEDIA_PROVIDER_UNKNOWN",
      `no generation provider "${String(input.provider_id)}"`,
      {
        status: 404,
      },
    );
  }
  const capabilities = provider.capabilities();
  // Count ladder (owner decision 2026-09-28): the REST/MCP body bounds are
  // the primary gates; this op clamp is the last line (human surface).
  const count = Math.min(
    Math.max(input.count ?? DEFAULT_COUNT, 1),
    effectiveMaxCount(capabilities.maxCount, "human"),
  );
  const model = input.model ?? capabilities.models[0] ?? null;
  const configuredModels = provider.configuredModels?.() ?? [];
  const modelCapabilities =
    (model === null ? undefined : configuredModels.find((entry) => entry.model === model)) ?? null;
  if (
    input.aspect !== undefined &&
    input.aspect !== null &&
    !capabilities.aspects.includes(input.aspect)
  ) {
    throw new ApiError(
      "MEDIA_GENERATION_ASPECT_UNSUPPORTED",
      `provider "${provider.providerId}" does not support aspect "${input.aspect}"`,
      { status: 422, details: [capabilities.aspects] },
    );
  }
  // Server-side pixel derivation (owner decision №8): agents and the studio
  // express intent as aspect+resolution; exact pixels come from the model's
  // own size options — no cross-transport guessing.
  let derivedWidth = input.width ?? null;
  let derivedHeight = input.height ?? null;
  if (
    derivedWidth === null &&
    derivedHeight === null &&
    modelCapabilities !== null &&
    modelCapabilities.sizeOptions.length > 0
  ) {
    const tier = input.resolution ?? null;
    const matches = modelCapabilities.sizeOptions.filter(
      (option) =>
        (input.aspect === undefined || input.aspect === null || option.ratio === input.aspect) &&
        (tier === null || option.tier === tier),
    );
    const chosen =
      (matches.length > 0 ? matches : tier === null ? [] : modelCapabilities.sizeOptions)[0] ??
      null;
    if (chosen !== null) {
      derivedWidth = chosen.width;
      derivedHeight = chosen.height;
    }
  }
  const referenceMediaIds = input.reference_media_ids ?? null;
  if (referenceMediaIds !== null && referenceMediaIds.length === 0) {
    throw new ApiError("MEDIA_GENERATION_REFERENCE_EMPTY", "reference_media_ids is empty", {
      status: 422,
    });
  }
  const extensionId = await extensionIdForProvider(app, provider.providerId);
  const run = await createGenerationRun(app.pool, {
    providerId: provider.providerId,
    extensionId,
    prompt,
    negativePrompt: capabilities.supportsNegativePrompt ? (input.negative_prompt ?? null) : null,
    settings: {
      aspect: input.aspect ?? null,
      resolution: input.resolution ?? null,
      width: derivedWidth,
      height: derivedHeight,
      count,
      seed: capabilities.supportsSeed ? (input.seed ?? null) : null,
      reference_media_ids: referenceMediaIds,
    },
    model,
    createdBy: ctx.actor.id,
  });
  // Media-owned job lifecycle: the worker executes the provider call; the
  // client polls get_media_generation (Media spec §71.7).
  await app.jobs.enqueue({
    type: "media.generation",
    payload: { run_id: run.id },
    idempotencyKey: `media-generation:${run.id}`,
    maxAttempts: 3,
    origin: "media.acquisition",
  });
  return { generation_id: run.id, status: run.status, provider_id: provider.providerId };
}

export async function getMediaGenerationOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly generation_id: string },
) {
  requirePermission(app, ctx, "media.generate");
  const run = await requireGenerationRun(app.pool, input.generation_id);
  return generationView(run);
}

/** Candidate wire shape — downloadUrl never leaves the server. */
function generationView(run: Awaited<ReturnType<typeof requireGenerationRun>>) {
  return {
    generation_id: run.id,
    provider_id: run.providerId,
    status: run.status,
    prompt: run.prompt,
    ...(run.errorCode === null
      ? {}
      : { error: { code: run.errorCode, message: run.errorMessage } }),
    cost: run.cost,
    candidates: run.candidates.map((candidate: GeneratedCandidate) => ({
      index: candidate.index,
      preview_url: candidate.previewUrl,
      width: candidate.width,
      height: candidate.height,
      mime_type: candidate.mimeType,
      model: candidate.model,
      seed: candidate.seed,
      cost: candidate.cost,
      ...(run.accepted[String(candidate.index)] === undefined
        ? {}
        : { media_id: run.accepted[String(candidate.index)] }),
    })),
    created_at: run.createdAt.toISOString(),
  };
}

/** Imports one generated candidate into the canonical media pipeline
 *  (Image Generation v2 T2.1): provider fetch → upload → metadata →
 *  provenance → accept record → variants. Shared by the operator accept
 *  route and the worker's auto-import of every candidate — owner decision
 *  2026-09-28: paid-for images must never be lost, so all results of a run
 *  land in the media library regardless of acceptance. */
async function importCandidateToAsset(
  app: ApplicationServices,
  ctx: OperationContext,
  run: Awaited<ReturnType<typeof requireGenerationRun>>,
  candidate: GeneratedCandidate,
): Promise<{ media_id: string; duplicate: boolean }> {
  const provider = await app.mediaProviders.generation(run.providerId);
  if (provider === null) {
    throw new ApiError(
      "PROVIDER_NOT_CONFIGURED",
      `generation provider "${run.providerId}" is not installed or not configured`,
      { status: 409 },
    );
  }
  const fetched = await provider.fetch(providerCtx(ctx), candidate);
  const accepted = await uploadMedia(
    {
      pool: app.pool,
      storage: app.mediaStorage!,
      quarantine: app.mediaQuarantine!,
      ...(app.mediaLimits === undefined ? {} : { limits: app.mediaLimits }),
    },
    {
      bytes: fetched.bytes,
      filename: fetched.filename,
      ...(fetched.mimeType === null ? {} : { declaredMimeType: fetched.mimeType }),
      createdBy: ctx.actor.id,
    },
  );
  await updateAssetMetadata(app.pool, accepted.asset.id, {
    ...(candidate.model === null ? {} : { description: `generated by ${candidate.model}` }),
  });
  await setAssetProvenance(app.pool, accepted.asset.id, {
    origin: "generated",
    providerId: run.providerId,
    providerAssetId: candidate.providerRequestId ?? `${run.id}#${candidate.index}`,
    provenance: {
      model: candidate.model ?? run.model,
      provider_request_id: run.providerRequestId ?? candidate.providerRequestId,
      prompt: run.prompt,
      negative_prompt: run.negativePrompt,
      seed: candidate.seed,
      settings: run.settings,
      cost: candidate.cost,
      generation_id: run.id,
      generated_at: run.completedAt?.toISOString() ?? new Date().toISOString(),
    },
  });
  await recordCandidateAccept(app.pool, run.id, candidate.index, accepted.asset.id);
  await generateVariantsAfterAccept(app, accepted);
  return { media_id: accepted.asset.id, duplicate: false };
}

export async function acceptGeneratedMediaOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly generation_id: string; readonly candidate_index: number },
) {
  requirePermission(app, ctx, "media.generate");
  const storage = app.mediaStorage;
  if (storage === null || app.mediaQuarantine === null) {
    throw new ApiError("MEDIA_STORAGE_UNAVAILABLE", "media storage is not configured", {
      status: 409,
    });
  }
  const run = await requireGenerationRun(app.pool, input.generation_id);
  if (run.status !== "ready") {
    throw new ApiError(
      "MEDIA_GENERATION_NOT_READY",
      `generation run is "${run.status}", not ready`,
      { status: 409 },
    );
  }
  const candidate = run.candidates.find(
    (entry: GeneratedCandidate) => entry.index === input.candidate_index,
  );
  if (candidate === undefined) {
    throw new ApiError("MEDIA_GENERATION_CANDIDATE_UNKNOWN", "candidate index is out of range", {
      status: 404,
    });
  }
  // Replay semantics: a re-accepted candidate returns the original asset.
  const alreadyAccepted = run.accepted[String(candidate.index)];
  if (alreadyAccepted !== undefined) {
    return { media_id: alreadyAccepted, duplicate: true };
  }
  return importCandidateToAsset(app, ctx, run, candidate);
}

async function extensionIdForProvider(
  app: ApplicationServices,
  providerId: string,
): Promise<string> {
  const summary = await app.mediaProviders.get(providerId);
  if (summary === null) {
    throw new ApiError("MEDIA_PROVIDER_UNKNOWN", `no media provider "${providerId}"`, {
      status: 404,
    });
  }
  return summary.extension_id;
}

/**
 * Worker job handler: executes the provider generation call for a run and
 * records the outcome (Media spec §71.7). Runs ride the durable job queue
 * with bounded retries; failure marks the run failed — it never blocks the
 * queue.
 */
export function createMediaGenerationJobHandler(app: ApplicationServices) {
  return async (payload: { run_id?: unknown }): Promise<void> => {
    const runId = typeof payload.run_id === "string" ? payload.run_id : "";
    if (runId === "") return;
    const run = await requireGenerationRun(app.pool, runId);
    if (run.status !== "pending" && run.status !== "running") return;
    const provider = await app.mediaProviders.generation(run.providerId);
    if (provider === null) {
      await markGenerationRunFailed(
        app.pool,
        runId,
        "PROVIDER_NOT_CONFIGURED",
        "provider is not available",
      );
      return;
    }
    await markGenerationRunRunning(app.pool, runId);
    const settings = run.settings as {
      aspect?: string | null;
      resolution?: string | null;
      width?: number | null;
      height?: number | null;
      count?: number | null;
      seed?: number | null;
      reference_media_ids?: readonly string[] | null;
    };
    try {
      // Reference images are resolved server-side from canonical assets —
      // adapters receive data URIs, never library URLs or provider links.
      let referenceImages: { dataUri: string; width: number | null; height: number | null }[] = [];
      const storage = app.mediaStorage;
      if (
        settings.reference_media_ids !== undefined &&
        settings.reference_media_ids !== null &&
        storage !== null
      ) {
        referenceImages = [];
        for (const mediaId of settings.reference_media_ids) {
          const asset = await getAsset(app.pool, mediaId as never);
          if (asset === null) {
            throw new ProviderError(
              "PROVIDER_INVALID_REQUEST",
              `reference media "${mediaId}" does not exist`,
            );
          }
          const versions = await listVersions(app.pool, mediaId as never);
          const current =
            versions.find((version) => version.versionNo === asset.currentVersionNo) ?? versions[0];
          if (current === undefined) {
            throw new ProviderError(
              "PROVIDER_INVALID_REQUEST",
              `reference media "${mediaId}" has no readable version`,
            );
          }
          const blob = await getBlobByHash(app.pool, current.sha256);
          if (blob === null) {
            throw new ProviderError(
              "PROVIDER_INVALID_REQUEST",
              `reference media "${mediaId}" blob is missing`,
            );
          }
          const bytes = await storage.getBuffer(blob.storageKey, Math.max(asset.sizeBytes, 1024));
          referenceImages.push({
            dataUri: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
            width: asset.width ?? null,
            height: asset.height ?? null,
          });
        }
      }
      const result = await provider.generate(
        { requestId: runId },
        {
          prompt: run.prompt,
          negativePrompt: run.negativePrompt,
          aspect: settings.aspect ?? null,
          resolution: settings.resolution ?? null,
          width: settings.width ?? null,
          height: settings.height ?? null,
          count: settings.count ?? 1,
          model: run.model,
          seed: settings.seed ?? null,
          referenceImages,
        },
      );
      const candidates: GeneratedCandidate[] = result.candidates.map((candidate, index) => ({
        ...candidate,
        index: candidate.index ?? index,
      }));
      await markGenerationRunReady(app.pool, runId, candidates, {
        providerRequestId: result.providerRequestId,
        cost: result.cost,
        model: run.model,
      });
      // Image Generation v2 (T2.1, owner decision 2026-09-28): every paid
      // candidate is auto-imported into the media library — acceptance is a
      // replay-safe later concern, not the only path that persists bytes.
      // A failed single import never fails the run or its siblings.
      const importCtx: OperationContext = {
        actor: systemActor(run.createdBy),
        transport: "cli",
        requestId: runId,
      };
      if (app.mediaStorage === null || app.mediaQuarantine === null) return;
      for (const candidate of candidates) {
        try {
          await importCandidateToAsset(app, importCtx, run, candidate);
        } catch (error) {
          // Structured failure marker: the run stays ready — the candidate
          // can still be imported through the operator accept route.
          const message = error instanceof Error ? error.message : "candidate import failed";
          console.error(
            JSON.stringify({
              event: "worker.media.candidate_import_failed",
              run_id: runId,
              candidate_index: candidate.index,
              error: message,
            }),
          );
        }
      }
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : "PROVIDER_FAILED";
      const message = error instanceof Error ? error.message : "generation failed";
      await markGenerationRunFailed(app.pool, runId, code, message);
    }
  };
}

/** Worker TTL sweep: purge unaccepted generation runs older than the cutoff. */
export async function sweepGenerationRunsOp(
  app: ApplicationServices,
  olderThanDays = 7,
): Promise<number> {
  return deleteExpiredGenerationRuns(
    app.pool,
    new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000),
  );
}
