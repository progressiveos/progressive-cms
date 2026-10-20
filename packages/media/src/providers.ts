// Media acquisition provider contracts (ADR-0013, Media spec §71).
//
// Stock search and image generation providers are contributed by trusted
// deployed extensions and consumed by the media provider registries at
// composition. The contracts are provider-neutral: adapters translate to
// provider-specific APIs, and errors are normalized to the typed taxonomy
// below before they cross the application boundary. Candidate metadata is
// server-side data — transports decide what is safe to expose (preview
// URLs yes, trusted download URLs never).

import { MediaError } from "./errors.js";
import {
  DEFAULT_REMOTE_IMPORT_LIMITS,
  fetchRemoteMedia,
  type RemoteFetchResult,
  validateRemoteUrl,
} from "./remote.js";

/** Stable typed error codes for provider failures (Media spec §71.1). */
export type ProviderErrorCode =
  | "PROVIDER_UNAUTHORIZED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_INVALID_REQUEST"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_FAILED";

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
]);

/** Normalized provider failure — no provider payload, no credential material. */
export class ProviderError extends MediaError {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

/** Maps an HTTP status from a provider API to the typed taxonomy. */
export function providerErrorFromStatus(status: number, providerId: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      "PROVIDER_UNAUTHORIZED",
      `provider "${providerId}" rejected the credentials`,
    );
  }
  if (status === 429) {
    return new ProviderError(
      "PROVIDER_RATE_LIMITED",
      `provider "${providerId}" rate limit exceeded`,
    );
  }
  if (status === 400 || status === 422) {
    return new ProviderError(
      "PROVIDER_INVALID_REQUEST",
      `provider "${providerId}" rejected the request`,
    );
  }
  if (status === 404) {
    return new ProviderError(
      "PROVIDER_INVALID_REQUEST",
      `provider "${providerId}" resource not found`,
    );
  }
  return new ProviderError(
    "PROVIDER_UNAVAILABLE",
    `provider "${providerId}" is unavailable (HTTP ${status})`,
  );
}

export function providerErrorFromTransport(cause: unknown, providerId: string): ProviderError {
  if (cause instanceof ProviderError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/abort|timeout|timed out/i.test(message)) {
    return new ProviderError("PROVIDER_TIMEOUT", `provider "${providerId}" timed out`, { cause });
  }
  return new ProviderError(
    "PROVIDER_UNAVAILABLE",
    `provider "${providerId}" could not be reached`,
    { cause },
  );
}

/** Provider fetch context — opaque to adapters; used for tracing only. */
export interface ProviderContext {
  readonly requestId: string;
}

export type StockOrientation = "landscape" | "portrait" | "square";

export interface StockSearchRequest {
  readonly query: string;
  readonly orientation?: StockOrientation | null;
  readonly minWidth?: number | null;
  readonly minHeight?: number | null;
  /** Bounded page size (clamped by the application layer to 1..50). */
  readonly limit: number;
  /** Opaque continuation cursor issued by the provider adapter. */
  readonly cursor?: string | null;
}

/**
 * Server-side candidate record. `previewUrl` may be shown to admins/agents;
 * `downloadUrl` (when the adapter keeps one) is consumed server-side only
 * and must never be serialized into an API/MCP response.
 */
export interface StockCandidate {
  readonly providerId: string;
  readonly providerAssetId: string;
  readonly previewUrl: string | null;
  readonly downloadUrl: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly creatorName: string | null;
  readonly creatorUrl: string | null;
  readonly sourceUrl: string | null;
  readonly licenseName: string | null;
  readonly licenseUrl: string | null;
}

export interface StockSearchResult {
  readonly candidates: readonly StockCandidate[];
  readonly nextCursor: string | null;
}

export interface ProviderHealth {
  readonly ok: boolean;
  readonly message: string | null;
}

export interface FetchedMedia {
  readonly bytes: Buffer;
  readonly mimeType: string | null;
  readonly filename: string;
}

export interface StockProviderCapabilities {
  readonly providerId: string;
  readonly displayName: string;
}

/** Stock search contract (Unsplash, Pexels, future providers). */
export interface MediaStockProvider {
  readonly providerId: string;
  readonly displayName: string;
  capabilities(): StockProviderCapabilities;
  search(ctx: ProviderContext, request: StockSearchRequest): Promise<StockSearchResult>;
  fetch(ctx: ProviderContext, candidate: StockCandidate): Promise<FetchedMedia>;
  testConnection(ctx: ProviderContext): Promise<ProviderHealth>;
}

export interface GenerationRequest {
  readonly prompt: string;
  readonly negativePrompt?: string | null;
  /** Semantic size intent, e.g. "16:9"; adapters map to concrete dimensions. */
  readonly aspect?: string | null;
  /** Coarse resolution intent ("1k"|"2k"|"4k"); honored per model contract. */
  readonly resolution?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly count: number;
  readonly model?: string | null;
  readonly seed?: number | null;
  /** Reference images resolved server-side from media assets (img2img). */
  readonly referenceImages?: readonly ReferenceImage[];
}

export interface GeneratedCandidate {
  readonly index: number;
  readonly previewUrl: string | null;
  /** Server-side download location — never serialized to a client. */
  readonly downloadUrl: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly mimeType: string | null;
  readonly model: string | null;
  readonly providerRequestId: string | null;
  readonly seed: number | null;
  readonly cost: number | null;
}

export interface GenerationResult {
  readonly candidates: readonly GeneratedCandidate[];
  readonly providerRequestId: string | null;
  readonly cost: number | null;
}

export interface GenerationProviderCapabilities {
  readonly providerId: string;
  readonly displayName: string;
  readonly models: readonly string[];
  readonly maxCount: number;
  readonly supportsSeed: boolean;
  readonly supportsNegativePrompt: boolean;
  readonly aspects: readonly string[];
}

// ---- Model contracts v2 (Image Generation v2, plan T1.1) ------------------
// Per-model capability snapshots derived from provider-published contracts
// (Runware docs schema.json, OpenRouter endpoints) or from catalog search.

/** Count ladder (owner decision 2026-09-28): the MCP agent path is clamped
 *  to 1, the human REST surface defaults to DEFAULT_COUNT and offers up to
 *  MAX_COUNT_HUMAN (the "2" option is tucked away in the studio UI). The
 *  frontend candidate grid renders up to MAX_COUNT_CEILING cards without
 *  changes, so raising the limit later is a backend-only edit: this
 *  constant + the REST body bound. */
export const MAX_COUNT_CEILING = 4;
export const MAX_COUNT_HUMAN = 2;
export const DEFAULT_COUNT = 1;

/** Effective per-run candidate limit: model ceiling ∩ surface ladder. */
export function effectiveMaxCount(
  modelMax: number | null | undefined,
  layer: "agent" | "human",
): number {
  const layerCap = layer === "agent" ? 1 : MAX_COUNT_HUMAN;
  return Math.min(modelMax ?? MAX_COUNT_CEILING, MAX_COUNT_CEILING, layerCap);
}

/** Default freshness window for persisted capability snapshots (owner
 *  requirement: Runware drifts its contracts — stale snapshots must be
 *  surfaced, never silently trusted forever). */
export const MODEL_SNAPSHOT_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** True when a capability snapshot is missing or older than the TTL. Stale
 *  snapshots stay usable — generation never blocks on a re-sync — but the
 *  wire surface flags them so the UI can demand a refresh. */
export function isModelStale(
  capabilities: Pick<ModelCapabilities, "lastSyncedAt"> | null | undefined,
  now = Date.now(),
  ttlMs = MODEL_SNAPSHOT_STALE_TTL_MS,
): boolean {
  if (capabilities === undefined || capabilities === null) return true;
  const synced = Date.parse(capabilities.lastSyncedAt);
  if (!Number.isFinite(synced)) return true;
  return now - synced > ttlMs;
}

/** Coarse resolution tier label shared by catalogs and the studio UI. */
export type ResolutionTier = "0.5k" | "1k" | "2k" | "4k";

/** One selectable aspect/size combination for a model, multipleOf-aligned. */
export interface ModelSizeOption {
  readonly ratio: string;
  readonly width: number;
  readonly height: number;
  readonly tier: ResolutionTier | null;
}

/** How the model wants dimensions and which optional knobs it accepts. */
export interface ModelRequestProfile {
  readonly dimensionMode: "widthHeight" | "resolutionOrWidthHeight";
  /** Tier → provider-native resolution value ("1k" → "1K"), when the model
   *  contract exposes a resolution enum instead of bounded width/height. */
  readonly resolutionMap?: Readonly<Partial<Record<ResolutionTier, string>>>;
  readonly sendSteps: boolean;
  readonly sendCfgScale: boolean;
  readonly sendScheduler: boolean;
  readonly sendSeed: boolean;
  readonly sendStrength: boolean;
  /** 0 = model takes no reference images. */
  readonly maxReferenceImages: number;
  readonly providerSettings?: Readonly<Record<string, unknown>>;
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** Persisted per-model contract snapshot (schema/catalog derived). */
export interface ModelCapabilities {
  readonly providerId: string;
  readonly model: string;
  readonly displayName: string;
  readonly sizeOptions: readonly ModelSizeOption[];
  readonly requestProfile: ModelRequestProfile;
  readonly maxCount: number;
  readonly supportsNegativePrompt: boolean;
  /** Provider-published price lines (Image Generation v2 T1.6): Runware
   *  `x-pricing.measured` → unit "configuration" (+width/height);
   *  OpenRouter endpoint pricing → unit "image" | "megapixel" | "token"
   *  (+variant for resolution-tiered lines). Display + cost estimation. */
  readonly pricing?: readonly {
    readonly unit: string;
    readonly costUsd: number;
    readonly width?: number;
    readonly height?: number;
    readonly variant?: string;
  }[];
  readonly source: "schema" | "catalog" | "preset";
  /** Runware schema hash — drift detector between syncs. */
  readonly schemaSha256: string | null;
  readonly lastSyncedAt: string;
}

/**
 * Normalizes a persisted per-model contract snapshot into ModelCapabilities
 * (2026-09-29 prod incident): the Admin stores the WIRE shape (snake_case,
 * flat request profile), while adapters previously cast stored snapshots
 * blindly — `sizeOptions.map` then crashed and configured models never
 * appeared. Accepts both the wire shape and the runtime shape; null when
 * neither is present (adapter degrades to live resolution as before).
 */
export function normalizeModelCapabilities(
  value: unknown,
  fallbackProviderId: string,
): ModelCapabilities | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const model = typeof raw["model"] === "string" ? raw["model"] : "";
  if (model.length === 0) return null;

  const profileRaw =
    typeof raw["requestProfile"] === "object" && raw["requestProfile"] !== null
      ? (raw["requestProfile"] as Record<string, unknown>)
      : typeof raw["request_profile"] === "object" && raw["request_profile"] !== null
        ? (raw["request_profile"] as Record<string, unknown>)
        : raw; // wire shape flattens the profile into the snapshot itself

  const profile = (key: string): unknown =>
    profileRaw === raw ? raw[key] : ((profileRaw as Record<string, unknown>)[key] ?? raw[key]);

  const sizeOptionsRaw =
    raw["sizeOptions"] ??
    raw["size_options"] ??
    (profileRaw === raw ? raw["sizeOptions"] : undefined);
  const sizeOptions = Array.isArray(sizeOptionsRaw)
    ? sizeOptionsRaw
        .map((option) => {
          if (typeof option !== "object" || option === null) return null;
          const o = option as Record<string, unknown>;
          if (
            typeof o["ratio"] !== "string" ||
            typeof o["width"] !== "number" ||
            typeof o["height"] !== "number"
          )
            return null;
          return {
            ratio: o["ratio"],
            width: o["width"],
            height: o["height"],
            tier: typeof o["tier"] === "string" ? (o["tier"] as ResolutionTier) : null,
          };
        })
        .filter((option): option is ModelSizeOption => option !== null)
    : [];

  const dimensionMode =
    profile("dimensionMode") === "resolutionOrWidthHeight" ||
    profile("dimension_mode") === "resolutionOrWidthHeight"
      ? ("resolutionOrWidthHeight" as const)
      : ("widthHeight" as const);
  const resolutionMapRaw0 = profile("resolutionMap");
  const resolutionMapRaw =
    resolutionMapRaw0 === undefined ? profile("resolution_map") : resolutionMapRaw0;
  const bool = (key: string, snake: string): boolean =>
    profile(key) === true || profile(snake) === true;
  const maxReferenceImages = profile("maxReferenceImages") ?? profile("max_reference_images");

  const requestProfile: ModelRequestProfile = {
    dimensionMode,
    ...(typeof resolutionMapRaw === "object" && resolutionMapRaw !== null
      ? { resolutionMap: resolutionMapRaw as Readonly<Partial<Record<ResolutionTier, string>>> }
      : {}),
    sendSteps: bool("sendSteps", "send_steps"),
    sendCfgScale: bool("sendCfgScale", "send_cfg_scale"),
    sendScheduler: bool("sendScheduler", "send_scheduler"),
    sendSeed: bool("sendSeed", "send_seed"),
    sendStrength: bool("sendStrength", "send_strength"),
    maxReferenceImages: typeof maxReferenceImages === "number" ? maxReferenceImages : 0,
    ...(typeof profile("providerSettings") === "object" && profile("providerSettings") !== null
      ? { providerSettings: profile("providerSettings") as Record<string, unknown> }
      : typeof profile("provider_settings") === "object" && profile("provider_settings") !== null
        ? { providerSettings: profile("provider_settings") as Record<string, unknown> }
        : {}),
    ...(typeof profile("settings") === "object" && profile("settings") !== null
      ? { settings: profile("settings") as Record<string, unknown> }
      : {}),
  };

  const maxCount =
    typeof raw["maxCount"] === "number"
      ? raw["maxCount"]
      : typeof raw["max_count"] === "number"
        ? raw["max_count"]
        : 4;
  const displayName =
    typeof raw["displayName"] === "string" && raw["displayName"].length > 0
      ? raw["displayName"]
      : typeof raw["display_name"] === "string" && raw["display_name"].length > 0
        ? raw["display_name"]
        : model;

  return {
    providerId: typeof raw["providerId"] === "string" ? raw["providerId"] : fallbackProviderId,
    model,
    displayName,
    sizeOptions,
    requestProfile,
    maxCount,
    supportsNegativePrompt:
      raw["supportsNegativePrompt"] === true || raw["supports_negative_prompt"] === true,
    ...(Array.isArray(raw["pricing"])
      ? {
          pricing: (raw["pricing"] as Exclude<ModelCapabilities["pricing"], undefined>).map(
            (line) => ({ ...line }),
          ),
        }
      : {}),
    source: raw["source"] === "catalog" || raw["source"] === "preset" ? raw["source"] : "schema",
    schemaSha256:
      typeof raw["schemaSha256"] === "string"
        ? raw["schemaSha256"]
        : typeof raw["schema_sha256"] === "string"
          ? raw["schema_sha256"]
          : null,
    lastSyncedAt:
      typeof raw["lastSyncedAt"] === "string"
        ? raw["lastSyncedAt"]
        : typeof raw["last_synced_at"] === "string"
          ? raw["last_synced_at"]
          : new Date(0).toISOString(),
  };
}

/** Catalog entry from provider.listModels (setup-time discovery). */
export interface ProviderModelSummary {
  readonly model: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly thumbnail: string | null;
  readonly status: string | null;
}

/** Reference image resolved server-side from media assets; adapters map it
 *  into provider-specific input fields (data URIs on both Runware and
 *  OpenRouter). Raw download URLs never appear here. */
export interface ReferenceImage {
  readonly dataUri: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** Image generation contract (Runware, OpenRouter, future engines). */
export interface ImageGenerationProvider {
  readonly providerId: string;
  readonly displayName: string;
  capabilities(): GenerationProviderCapabilities;
  generate(ctx: ProviderContext, request: GenerationRequest): Promise<GenerationResult>;
  fetch(ctx: ProviderContext, candidate: GeneratedCandidate): Promise<FetchedMedia>;
  testConnection(ctx: ProviderContext): Promise<ProviderHealth>;
  /** Configured model snapshots (config v2; empty for scalar-only configs). */
  configuredModels?(): readonly ModelCapabilities[];
  /** Setup-time model discovery against the provider catalog. */
  listModels?(
    ctx: ProviderContext,
    query: { readonly search?: string; readonly limit?: number },
  ): Promise<readonly ProviderModelSummary[]>;
  /** Live per-model contract resolution (fresh sync from the provider);
   *  null when the provider cannot resolve a contract for the model. */
  resolveModelCapabilities?(ctx: ProviderContext, model: string): Promise<ModelCapabilities | null>;
}

export type MediaProvider = MediaStockProvider | ImageGenerationProvider;

/**
 * Shape of the named module export a provider registration points at: a
 * factory invoked at composition with the extension's validated config and
 * resolved secret slots (ADR-0013, Extensions spec §52.2).
 */
export interface ProviderFactoryInput {
  readonly config: Record<string, unknown>;
  readonly secrets: Readonly<Record<string, string>>;
}

export type MediaProviderFactory = (input: ProviderFactoryInput) => MediaProvider;

/**
 * Bounded JSON fetch helper for provider adapters: timeout, JSON parsing
 * with a size cap, typed error normalization. Provider-specific headers,
 * payload mapping and egress hosts stay in the adapters. SSRF-gated like
 * every other outbound contour (Media spec §43): the target host is
 * resolved + checked before the request, redirects are never followed
 * (an unvalidated hop could not be guarded here without losing auth
 * headers).
 */
export async function providerFetchJson(
  providerId: string,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<unknown> {
  try {
    await validateRemoteUrl(url);
  } catch (cause) {
    throw providerDownloadError(providerId, cause);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch (cause) {
    throw providerErrorFromTransport(cause, providerId);
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel();
    throw new ProviderError(
      "PROVIDER_FAILED",
      `provider "${providerId}" answered a JSON request with a redirect`,
    );
  }
  if (!response.ok) throw providerErrorFromStatus(response.status, providerId);
  // Provider JSON responses are small; a cap keeps a hostile payload from
  // exhausting memory.
  const text = await response.text();
  if (text.length > 4 * 1024 * 1024) {
    throw new ProviderError("PROVIDER_FAILED", `provider "${providerId}" response too large`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ProviderError(
      "PROVIDER_FAILED",
      `provider "${providerId}" sent a malformed response`,
      {
        cause,
      },
    );
  }
}

/**
 * Normalizes remote.ts SSRF-guard failures into the provider taxonomy
 * (Media spec §71.1) without losing retryability semantics.
 */
function providerDownloadError(providerId: string, cause: unknown): ProviderError {
  if (cause instanceof ProviderError) return cause;
  if (cause instanceof MediaError) {
    const answered = /^remote server answered (\d+)$/.exec(cause.message);
    if (answered !== null) return providerErrorFromStatus(Number(answered[1]), providerId);
    if (cause.code === "MEDIA_IMPORT_TIMEOUT") {
      return new ProviderError("PROVIDER_TIMEOUT", `provider "${providerId}" timed out`, { cause });
    }
    if (cause.code === "MEDIA_IMPORT_FETCH_FAILED") {
      return new ProviderError(
        "PROVIDER_UNAVAILABLE",
        `provider "${providerId}" could not be reached`,
        { cause },
      );
    }
    // SSRF-blocked host, invalid URL, redirect limit, oversized body.
    return new ProviderError(
      "PROVIDER_FAILED",
      `provider "${providerId}" download rejected: ${cause.message}`,
      { cause },
    );
  }
  return providerErrorFromTransport(cause, providerId);
}

/**
 * Downloads candidate bytes (server-side) with size and time bounds.
 * Candidate download URLs come out of provider API responses, so the fetch
 * rides the same SSRF guard as media_import_url (`fetchRemoteMedia`): every
 * hop's DNS resolution is checked against the blocked ranges and redirects
 * are re-validated from scratch. Connections are made by original hostname,
 * so TLS SNI/Host stay the provider's CDN (no IP-pin rewrite).
 */
export async function providerFetchBytes(
  providerId: string,
  url: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchedMedia> {
  let result: RemoteFetchResult;
  try {
    result = await fetchRemoteMedia(url, {
      maxBytes: options.maxBytes ?? DEFAULT_REMOTE_IMPORT_LIMITS.maxBytes,
      timeoutMs: options.timeoutMs ?? DEFAULT_REMOTE_IMPORT_LIMITS.timeoutMs,
      maxRedirects: DEFAULT_REMOTE_IMPORT_LIMITS.maxRedirects,
    });
  } catch (cause) {
    throw providerDownloadError(providerId, cause);
  }
  return {
    bytes: result.body,
    mimeType: result.contentType,
    filename: new URL(result.finalUrl).pathname.split("/").pop() ?? `${providerId}-asset`,
  };
}
