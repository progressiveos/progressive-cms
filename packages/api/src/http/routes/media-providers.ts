// Media provider REST surface (PCMS-MPA-T007/T015; ADR-0013 §8, Media spec
// §71). Discovery reads are media.read (safe metadata only); configuration
// and test operations are media.providers.manage and audited. Secret values
// are write-only — no route here ever returns one.
import type { FastifyRequest } from "fastify";
import type { ApplicationServices, OperationContext } from "../../context.js";
import { ApiError } from "../../errors.js";
import {
  acceptGeneratedMediaOp,
  createMediaGenerationOp,
  getMediaGenerationOp,
  importStockCandidateOp,
  searchStockMediaOp,
} from "../../media-acquisition-ops.js";
import {
  estimateMediaGenerationOp,
  getMediaProviderCapabilitiesV2Op,
  getProviderModelOp,
  listProviderModelsOp,
} from "../../media-model-ops.js";
import {
  clearMediaProviderSecretOp,
  getMediaProviderConfigOp,
  getMediaProviderOp,
  listMediaProvidersOp,
  setMediaProviderSecretOp,
  testMediaProviderOp,
  updateMediaProviderConfigOp,
} from "../../media-provider-ops.js";
import type { ApiRoute, RouteResult } from "../registry.js";

function jsonBody(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.body !== "object" || request.body === null) {
    throw new ApiError("API_REQUEST_INVALID", "a JSON object body is required", { status: 400 });
  }
  return request.body as Record<string, unknown>;
}

async function handle(
  app: ApplicationServices,
  ctx: OperationContext,
  fn: (app: ApplicationServices, ctx: OperationContext) => Promise<unknown> | unknown,
): Promise<RouteResult> {
  return { status: 200, body: await fn(app, ctx) };
}

const PROVIDER_ID_PARAM = {
  type: "object",
  additionalProperties: false,
  required: ["providerId"],
  properties: {
    providerId: {
      type: "string",
      pattern: "^[a-z][a-z0-9-]{0,62}(\\.[a-z0-9][a-z0-9-]{0,62}){0,9}$",
    },
  },
} as const;

const SLOT_PARAM = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "slot"],
  properties: {
    providerId: PROVIDER_ID_PARAM.properties.providerId,
    slot: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" },
  },
} as const;

const GENERATION_ID_PARAM = {
  type: "object",
  additionalProperties: false,
  required: ["generationId"],
  properties: {
    generationId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    },
  },
} as const;

const ACCEPT_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["generationId", "candidateIndex"],
  properties: {
    generationId: GENERATION_ID_PARAM.properties.generationId,
    candidateIndex: { type: "integer", minimum: 0, maximum: 64 },
  },
} as const;

const STOCK_SEARCH_BODY = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1, maxLength: 300 },
    provider_id: { type: "string", minLength: 1, maxLength: 64 },
    orientation: { enum: ["landscape", "portrait", "square"] },
    min_width: { type: "integer", minimum: 1, maximum: 20000 },
    min_height: { type: "integer", minimum: 1, maximum: 20000 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    cursor: { type: "string", maxLength: 4096 },
  },
} as const;

const STOCK_IMPORT_BODY = {
  type: "object",
  required: ["candidate_ref"],
  additionalProperties: false,
  properties: {
    candidate_ref: { type: "string", minLength: 16, maxLength: 8192 },
    folder_id: { type: "string", maxLength: 64 },
  },
} as const;

const GENERATION_BODY = {
  type: "object",
  required: ["prompt"],
  additionalProperties: false,
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 2000 },
    provider_id: { type: "string", minLength: 1, maxLength: 64 },
    negative_prompt: { type: "string", maxLength: 2000 },
    aspect: { type: "string", maxLength: 16 },
    resolution: { type: "string", enum: ["0.5k", "1k", "2k", "4k"] },
    width: { type: "integer", minimum: 16, maximum: 8192 },
    height: { type: "integer", minimum: 16, maximum: 8192 },
    // Count ladder (owner decision 2026-09-28): human REST offers default 1,
    // up to 2. Raise together with MAX_COUNT_CEILING in @pcms/media — the
    // frontend candidate grid already renders up to 4.
    count: { type: "integer", minimum: 1, maximum: 2 },
    model: { type: "string", maxLength: 200 },
    seed: { type: "integer", minimum: 0 },
    reference_media_ids: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 64 },
      maxItems: 16,
    },
  },
} as const;

const CONFIG_BODY = {
  type: "object",
  required: ["config"],
  additionalProperties: false,
  properties: {
    config: { type: "object", additionalProperties: true, maxProperties: 64 },
  },
} as const;

const PROVIDER_MODEL_PARAM = {
  type: "object",
  additionalProperties: false,
  required: ["providerId", "modelId"],
  properties: {
    providerId: PROVIDER_ID_PARAM.properties.providerId,
    modelId: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const PROVIDER_MODELS_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: {
    search: { type: "string", minLength: 1, maxLength: 200 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const PROVIDER_MODEL_QUERY = {
  type: "object",
  additionalProperties: false,
  properties: {
    sync: { type: "boolean" },
  },
} as const;

const ESTIMATE_BODY = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider_id: { type: "string", minLength: 1, maxLength: 64 },
    model: { type: "string", maxLength: 200 },
    aspect: { type: "string", maxLength: 16 },
    resolution: { type: "string", enum: ["0.5k", "1k", "2k", "4k"] },
    count: { type: "integer", minimum: 1, maximum: 8 },
  },
} as const;

const SECRET_VALUE_BODY = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: { value: { type: "string", minLength: 1, maxLength: 4096 } },
} as const;

export function makeMediaProviderRoutes(): ApiRoute[] {
  const routes: ApiRoute[] = [
    {
      spec: {
        method: "GET",
        url: "/media/providers",
        operationId: "list_media_providers",
        summary: "Installed, enabled media acquisition providers (safe metadata, no credentials).",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
      },
      handle: (app, ctx) => handle(app, ctx, () => listMediaProvidersOp(app, ctx)),
    },
    {
      spec: {
        method: "GET",
        url: "/media/providers/:providerId",
        operationId: "get_media_provider",
        summary:
          "One media provider: safe state, config schema (secret slots included as schema), non-secret config, secret slot names.",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
        paramsSchema: PROVIDER_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          getMediaProviderOp(app, ctx, {
            provider_id: String((request.params as Record<string, unknown>).providerId),
          }),
        ),
    },
    {
      spec: {
        method: "GET",
        url: "/media/providers/:providerId/config",
        operationId: "get_media_provider_config",
        summary:
          "Provider settings surface: manifest config schema + public config (secret refs stripped) + secret-slot presence.",
        tag: "media",
        auth: "authenticated",
        permission: "media.providers.manage",
        paramsSchema: PROVIDER_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          getMediaProviderConfigOp(app, ctx, {
            provider_id: String((request.params as Record<string, unknown>).providerId),
          }),
        ),
    },
    {
      spec: {
        method: "PUT",
        url: "/media/providers/:providerId/config",
        operationId: "update_media_provider_config",
        summary:
          "Replace the non-secret provider configuration (secret slots keep their references).",
        tag: "media",
        auth: "authenticated",
        csrf: true,
        permission: "media.providers.manage",
        paramsSchema: PROVIDER_ID_PARAM,
        bodySchema: CONFIG_BODY,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          updateMediaProviderConfigOp(app, ctx, {
            provider_id: String((request.params as Record<string, unknown>).providerId),
            config: jsonBody(request).config as Record<string, unknown>,
          }),
        ),
    },
    {
      spec: {
        method: "PUT",
        url: "/media/providers/:providerId/secrets/:slot",
        operationId: "set_media_provider_secret",
        summary:
          "Store a provider credential VALUE (write-only, encrypted at rest, audited, never returned). Requires media.providers.manage.",
        tag: "media",
        auth: "authenticated",
        csrf: true,
        permission: "media.providers.manage",
        paramsSchema: SLOT_PARAM,
        bodySchema: SECRET_VALUE_BODY,
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        return handle(app, ctx, () =>
          setMediaProviderSecretOp(app, ctx, {
            provider_id: String(params.providerId),
            slot: String(params.slot),
            value: String(jsonBody(request).value ?? ""),
          }),
        );
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/media/providers/:providerId/secrets/:slot",
        operationId: "clear_media_provider_secret",
        summary: "Delete a stored provider credential (provider becomes unconfigured). Audited.",
        tag: "media",
        auth: "authenticated",
        csrf: true,
        permission: "media.providers.manage",
        paramsSchema: SLOT_PARAM,
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        return handle(app, ctx, () =>
          clearMediaProviderSecretOp(app, ctx, {
            provider_id: String(params.providerId),
            slot: String(params.slot),
          }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/media/providers/:providerId/test",
        operationId: "test_media_provider",
        summary:
          "Run the provider connection test with the stored credentials (typed safe outcome, no raw provider errors).",
        tag: "media",
        auth: "authenticated",
        csrf: true,
        permission: "media.providers.manage",
        paramsSchema: PROVIDER_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          testMediaProviderOp(app, ctx, {
            provider_id: String((request.params as Record<string, unknown>).providerId),
          }),
        ),
    },
    // ---- Model catalog + contracts (Image Generation v2, plan T2.2/T2.5) ----
    {
      spec: {
        method: "GET",
        url: "/media/providers/:providerId/models",
        operationId: "list_media_provider_models",
        summary:
          "Search the provider's native model catalog (setup-time discovery; touches the provider API).",
        tag: "media",
        auth: "authenticated",
        permission: "media.providers.manage",
        paramsSchema: PROVIDER_ID_PARAM,
        querySchema: PROVIDER_MODELS_QUERY,
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        const query = (request.query ?? {}) as Record<string, unknown>;
        return handle(app, ctx, () =>
          listProviderModelsOp(app, ctx, {
            provider_id: String(params.providerId),
            ...(query.search === undefined ? {} : { search: String(query.search) }),
            ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
          }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/media/providers/:providerId/models/:modelId",
        operationId: "get_media_provider_model",
        summary:
          "One model's capability contract: stored snapshot with stale flag, or a live re-sync with ?sync=1.",
        tag: "media",
        auth: "authenticated",
        permission: "media.providers.manage",
        paramsSchema: PROVIDER_MODEL_PARAM,
        querySchema: PROVIDER_MODEL_QUERY,
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        const query = (request.query ?? {}) as Record<string, unknown>;
        return handle(app, ctx, () =>
          getProviderModelOp(app, ctx, {
            provider_id: String(params.providerId),
            model_id: String(params.modelId),
            ...(query.sync === undefined
              ? {}
              : { sync: query.sync === true || query.sync === "true" }),
          }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/media/providers/:providerId/capabilities",
        operationId: "get_media_provider_capabilities",
        summary:
          "Runtime capability surface: configured models with size options, tiers, limits and prices (agent-safe; no credentials).",
        tag: "media",
        auth: "authenticated",
        permission: "media.read",
        paramsSchema: PROVIDER_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          getMediaProviderCapabilitiesV2Op(app, ctx, {
            provider_id: String((request.params as Record<string, unknown>).providerId),
          }),
        ),
    },
    {
      spec: {
        method: "POST",
        url: "/media/generations/estimate",
        operationId: "estimate_media_generation",
        summary:
          "Approximate generation cost for the given settings before any cost-bearing call (token-priced models return an honest refusal).",
        tag: "media",
        auth: "authenticated",
        permission: "media.generate",
        bodySchema: ESTIMATE_BODY,
      },
      handle: (app, ctx, request) => {
        const body = jsonBody(request) as Record<string, unknown>;
        return handle(app, ctx, () =>
          estimateMediaGenerationOp(app, ctx, {
            ...(body.provider_id === undefined ? {} : { provider_id: String(body.provider_id) }),
            ...(body.model === undefined ? {} : { model: String(body.model) }),
            ...(body.aspect === undefined ? {} : { aspect: String(body.aspect) }),
            ...(body.resolution === undefined ? {} : { resolution: String(body.resolution) }),
            ...(body.count === undefined ? {} : { count: Number(body.count) }),
          }),
        );
      },
    },
    // ---- Provider-neutral acquisition (ADR-0013 §8, Media spec §71) ----
    {
      spec: {
        method: "POST",
        url: "/media/stock/search",
        operationId: "search_stock_media",
        summary:
          "Search enabled stock providers (provider-neutral; tolerates partial provider failure; candidates are opaque signed references).",
        tag: "media",
        auth: "authenticated",
        permission: "media.stock.search",
        bodySchema: STOCK_SEARCH_BODY,
      },
      handle: (app, ctx, request) => {
        const body = jsonBody(request) as Record<string, unknown>;
        return handle(app, ctx, () =>
          searchStockMediaOp(app, ctx, {
            query: String(body.query),
            ...(body.provider_id === undefined ? {} : { provider_id: String(body.provider_id) }),
            ...(body.orientation === undefined
              ? {}
              : { orientation: body.orientation as "landscape" | "portrait" | "square" }),
            ...(body.min_width === undefined ? {} : { min_width: Number(body.min_width) }),
            ...(body.min_height === undefined ? {} : { min_height: Number(body.min_height) }),
            ...(body.limit === undefined ? {} : { limit: Number(body.limit) }),
            ...(body.cursor === undefined ? {} : { cursor: String(body.cursor) }),
          }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/media/stock/import",
        operationId: "import_stock_candidate",
        summary:
          "Import a stock candidate through the canonical ingest pipeline; duplicate-safe per provider asset (re-import returns the existing asset).",
        tag: "media",
        auth: "authenticated",
        permission: "media.stock.import",
        idempotency: "supported",
        bodySchema: STOCK_IMPORT_BODY,
      },
      handle: (app, ctx, request) => {
        const body = jsonBody(request) as Record<string, unknown>;
        return handle(app, ctx, () =>
          importStockCandidateOp(app, ctx, {
            candidate_ref: String(body.candidate_ref),
            ...(body.folder_id === undefined ? {} : { folder_id: String(body.folder_id) }),
          }),
        );
      },
    },
    {
      spec: {
        method: "POST",
        url: "/media/generations",
        operationId: "create_media_generation",
        summary:
          "Start an image generation run (provider-neutral; does not block on the provider — poll get_media_generation).",
        tag: "media",
        auth: "authenticated",
        permission: "media.generate",
        idempotency: "supported",
        bodySchema: GENERATION_BODY,
      },
      handle: (app, ctx, request) => {
        const body = jsonBody(request) as Record<string, unknown>;
        return handle(app, ctx, () =>
          createMediaGenerationOp(app, ctx, {
            prompt: String(body.prompt),
            ...(body.provider_id === undefined ? {} : { provider_id: String(body.provider_id) }),
            ...(body.negative_prompt === undefined
              ? {}
              : { negative_prompt: String(body.negative_prompt) }),
            ...(body.aspect === undefined ? {} : { aspect: String(body.aspect) }),
            ...(body.resolution === undefined ? {} : { resolution: String(body.resolution) }),
            ...(body.width === undefined ? {} : { width: Number(body.width) }),
            ...(body.height === undefined ? {} : { height: Number(body.height) }),
            ...(body.count === undefined ? {} : { count: Number(body.count) }),
            ...(body.model === undefined ? {} : { model: String(body.model) }),
            ...(body.seed === undefined ? {} : { seed: Number(body.seed) }),
            ...(body.reference_media_ids === undefined
              ? {}
              : { reference_media_ids: (body.reference_media_ids as unknown[]).map(String) }),
          }),
        );
      },
    },
    {
      spec: {
        method: "GET",
        url: "/media/generations/:generationId",
        operationId: "get_media_generation",
        summary:
          "Generation run status and candidates (server-side references only; download URLs never leave the server).",
        tag: "media",
        auth: "authenticated",
        permission: "media.generate",
        paramsSchema: GENERATION_ID_PARAM,
      },
      handle: (app, ctx, request) =>
        handle(app, ctx, () =>
          getMediaGenerationOp(app, ctx, {
            generation_id: String((request.params as Record<string, unknown>).generationId),
          }),
        ),
    },
    {
      spec: {
        method: "POST",
        url: "/media/generations/:generationId/candidates/:candidateIndex/accept",
        operationId: "accept_generated_media",
        summary:
          "Accept a generated candidate: ingests through the canonical pipeline into a MediaAsset; replay returns the original asset.",
        tag: "media",
        auth: "authenticated",
        csrf: true,
        permission: "media.generate",
        idempotency: "supported",
        paramsSchema: ACCEPT_PARAMS,
      },
      handle: (app, ctx, request) => {
        const params = request.params as Record<string, unknown>;
        return handle(app, ctx, () =>
          acceptGeneratedMediaOp(app, ctx, {
            generation_id: String(params.generationId),
            candidate_index: Number(params.candidateIndex),
          }),
        );
      },
    },
  ];
  return routes;
}
