// Runware model-driven generation (PCMS-PRE-RESEARCH A3): the three shipped
// model contracts must build imageInference tasks from their published
// schemas — no per-model hardcode. Fixtures are slimmed copies of the real
// runware.ai/docs/models/<slug>/schema.json documents.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { GenerationRequest } from "@pcms/media";
import { ProviderError } from "@pcms/media";
import {
  buildImageInferenceTask,
  resolutionFor,
  validateParamValue,
} from "../../extensions/progressive-media-runware/src/build-task.js";
import {
  expireModelSchemaCacheForTests,
  modelSchemaUrl,
  resetModelSchemaCacheForTests,
  resolveModelSchema,
  schemaRequestProperties,
} from "../../extensions/progressive-media-runware/src/model-schema.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`fixtures/media/runware/${name}.json`, "utf8"));
}

const BASE_REQUEST: GenerationRequest = {
  prompt: "test",
  count: 1,
  aspect: null,
  width: null,
  height: null,
  model: null,
  negativePrompt: null,
  seed: null,
};

test("model schema URL mapping covers the three shipped contracts", () => {
  assert.equal(
    modelSchemaUrl("runware:z-image@turbo", null),
    "https://runware.ai/docs/models/alibaba-z-image-turbo/schema.json",
  );
  assert.equal(
    modelSchemaUrl("bfl:5@1", null),
    "https://runware.ai/docs/models/bfl-flux-2-pro/schema.json",
  );
  assert.equal(
    modelSchemaUrl("openai:gpt-image@2.5-flare", null),
    "https://runware.ai/docs/models/openai-gpt-image-2-5-flare/schema.json",
  );
  assert.equal(modelSchemaUrl("totally:unknown@9", null), null);
});

test("resolver: fetched → cache; failure without cache degrades to none, with cache to last-known-good", async () => {
  resetModelSchemaCacheForTests();
  let calls = 0;
  const good = async () => {
    calls += 1;
    return fixture("z-image-turbo");
  };
  const first = await resolveModelSchema("alibaba-z-image-turbo", good);
  assert.equal(first.source, "fetched");
  const second = await resolveModelSchema("alibaba-z-image-turbo", good);
  assert.equal(second.source, "cache");
  assert.equal(calls, 1);

  const fail = async () => {
    throw new Error("docs endpoint down");
  };
  expireModelSchemaCacheForTests(); // TTL elapsed: refetch, docs endpoint down
  const lkg = await resolveModelSchema("alibaba-z-image-turbo", fail);
  assert.equal(lkg.source, "last-known-good");
  assert.ok(lkg.schema !== null);

  resetModelSchemaCacheForTests();
  const none = await resolveModelSchema("alibaba-z-image-turbo", fail);
  assert.equal(none.source, "none");
  assert.equal(none.schema, null);
});

test("z-image@turbo: common + negativePrompt + seed + steps passthrough, dimensions clamped to schema", () => {
  const resolved = {
    schema: fixture("z-image-turbo") as never,
    source: "cache" as const,
    fetchedAt: "2026-09-25T00:00:00Z",
    sha256: null,
  };
  const properties = schemaRequestProperties(resolved);
  assert.ok(properties !== null);
  const built = buildImageInferenceTask({
    request: { ...BASE_REQUEST, negativePrompt: "blur", seed: 42, width: 9999, count: 8 },
    model: "runware:z-image@turbo",
    modelParams: { steps: 8 },
    properties,
    schemaSource: resolved.source,
    schemaFetchedAt: resolved.fetchedAt,
    maxCount: 4,
  });
  assert.equal(built.task["model"], "runware:z-image@turbo");
  assert.equal(built.task["negativePrompt"], "blur");
  assert.equal(built.task["seed"], 42);
  assert.equal(built.task["steps"], 8);
  assert.equal(built.task["width"], 2048); // clamped by schema maximum
  assert.equal(built.count, 4); // schema allows 20, provider caps at 4
  assert.equal(built.task["taskType"], "imageInference");
});

test("z-image@turbo: no model_params means no steps/CFGScale/scheduler — provider defaults apply", () => {
  // Few-step turbo models degrade when a generic CFG fallback is forced on
  // them (the Runware reference request sends steps only). The builder must
  // never invent scalar defaults: without explicit model_params the task
  // carries no steps/CFGScale/scheduler at all.
  const resolved = {
    schema: fixture("z-image-turbo") as never,
    source: "cache" as const,
    fetchedAt: "2026-09-25T00:00:00Z",
    sha256: null,
  };
  const properties = schemaRequestProperties(resolved);
  assert.ok(properties !== null);
  const built = buildImageInferenceTask({
    request: { ...BASE_REQUEST, width: 1024, count: 1 },
    model: "runware:z-image@turbo",
    modelParams: {},
    properties,
    schemaSource: resolved.source,
    schemaFetchedAt: resolved.fetchedAt,
    maxCount: 4,
  });
  assert.equal("steps" in built.task, false);
  assert.equal("CFGScale" in built.task, false);
  assert.equal("scheduler" in built.task, false);
});

test("flux-2-pro: negativePrompt is not a model field; providerSettings passthrough; unknown model_params rejected", () => {
  const resolved = {
    schema: fixture("flux-2-pro") as never,
    source: "cache" as const,
    fetchedAt: null,
    sha256: null,
  };
  const properties = schemaRequestProperties(resolved);
  const built = buildImageInferenceTask({
    request: { ...BASE_REQUEST, negativePrompt: "blur", seed: 7 },
    model: "bfl:5@1",
    modelParams: { providerSettings: { bfl: { safetyTolerance: 2 } } },
    properties,
    schemaSource: resolved.source,
    schemaFetchedAt: null,
    maxCount: 4,
  });
  assert.equal("negativePrompt" in built.task, false);
  assert.deepEqual(built.task["providerSettings"], { bfl: { safetyTolerance: 2 } });
  assert.equal(built.task["seed"], 7); // flux schema declares seed
  assert.equal(built.width, 1024); // schema min 256 → common 1024 stays

  assert.throws(
    () =>
      buildImageInferenceTask({
        request: BASE_REQUEST,
        model: "bfl:5@1",
        modelParams: { steps: 8 }, // z-image field, not a flux field
        properties,
        schemaSource: resolved.source,
        schemaFetchedAt: null,
        maxCount: 4,
      }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "PROVIDER_INVALID_REQUEST" &&
      /model_params key "steps"/.test(error.message),
  );
});

test("gpt-image flare: no seed field; schema dimensions (16..3840) replace the common bounds", () => {
  const resolved = {
    schema: fixture("gpt-image-flare") as never,
    source: "cache" as const,
    fetchedAt: null,
    sha256: null,
  };
  const properties = schemaRequestProperties(resolved);
  const built = buildImageInferenceTask({
    request: { ...BASE_REQUEST, seed: 9, width: 3840 },
    model: "openai:gpt-image@2.5-flare",
    modelParams: {},
    properties,
    schemaSource: resolved.source,
    schemaFetchedAt: null,
    maxCount: 4,
  });
  assert.equal("seed" in built.task, false);
  assert.equal("negativePrompt" in built.task, false);
  assert.equal(built.width, 3840); // common 2048 cap must NOT clamp flare
});

test("no schema available: common-contract fallback keeps working (backward compat)", () => {
  const built = buildImageInferenceTask({
    request: { ...BASE_REQUEST, negativePrompt: "x", seed: 1, width: 8192 },
    model: "runware:z-image@turbo",
    modelParams: {},
    properties: null,
    schemaSource: "none",
    schemaFetchedAt: null,
    maxCount: 4,
  });
  assert.equal(built.task["negativePrompt"], "x");
  assert.equal(built.task["seed"], 1);
  assert.equal(built.width, 2048); // common fallback bound
});

// ---- v2 (Image Generation v2 plan T1.3) ------------------------------------

function fixtureProperties(name: string): Record<string, unknown> {
  const schema = fixture(name) as {
    components?: {
      schemas?: { RequestBody?: { items?: { properties?: Record<string, unknown> } } };
    };
  };
  return schema.components?.schemas?.RequestBody?.items?.properties ?? {};
}

test("v2: width/height snap to schema multipleOf (683 → 672)", () => {
  const built = buildImageInferenceTask({
    request: BASE_REQUEST,
    model: "runware:z-image@turbo",
    modelParams: {},
    properties: fixtureProperties("z-image-turbo"),
    schemaSource: "cache",
    schemaFetchedAt: null,
    fallbackDimensions: { width: 1536, height: 683 },
    maxCount: 4,
  });
  assert.equal(built.width, 1536);
  assert.equal(built.height, 672); // 683 snapped down to multipleOf 16
  assert.equal(built.task["height"], 672);
});

test("v2: resolution mode sends the mapped preset and omits width/height", () => {
  const properties = fixtureProperties("google-nano-banana-pro");
  const profile = {
    dimensionMode: "resolutionOrWidthHeight",
    resolutionMap: { "1k": "1K", "2k": "2K", "4k": "4K" },
    sendSteps: false,
    sendCfgScale: false,
    sendScheduler: false,
    sendSeed: true,
    sendStrength: false,
    maxReferenceImages: 14,
  } as const;
  const built = buildImageInferenceTask({
    request: { ...BASE_REQUEST, resolution: "2k" },
    model: "google:4@2",
    modelParams: {},
    properties,
    schemaSource: "cache",
    schemaFetchedAt: null,
    profile,
    maxCount: 4,
  });
  assert.equal(built.task["resolution"], "2K");
  assert.equal("width" in built.task, false);
  assert.equal("height" in built.task, false);
  assert.equal(built.width, null);

  // widthHeight-mode models never emit a resolution field.
  const zImage = buildImageInferenceTask({
    request: { ...BASE_REQUEST, resolution: "2k" },
    model: "runware:z-image@turbo",
    modelParams: {},
    properties: fixtureProperties("z-image-turbo"),
    schemaSource: "cache",
    schemaFetchedAt: null,
    maxCount: 4,
  });
  assert.equal("resolution" in zImage.task, false);
  assert.equal("width" in zImage.task, true);
});

test("v2: resolutionFor gating (mode, schema field, map lookup)", () => {
  const google = fixtureProperties("google-nano-banana-pro");
  const profile = {
    dimensionMode: "resolutionOrWidthHeight",
    resolutionMap: { "1k": "1K" },
    sendSteps: false,
    sendCfgScale: false,
    sendScheduler: false,
    sendSeed: true,
    sendStrength: false,
    maxReferenceImages: 14,
  } as const;
  assert.equal(resolutionFor({ ...BASE_REQUEST, resolution: "1k" }, profile, google), "1K");
  // Unknown tier → null (width/height path).
  assert.equal(resolutionFor({ ...BASE_REQUEST, resolution: "8k" }, profile, google), null);
  // widthHeight mode → null even with a map.
  assert.equal(
    resolutionFor(
      { ...BASE_REQUEST, resolution: "1k" },
      { ...profile, dimensionMode: "widthHeight" },
      google,
    ),
    null,
  );
});

test("v2: typed model_params validation (enum, bounds, nested unknown)", () => {
  const zImage = fixtureProperties("z-image-turbo");
  assert.throws(
    () =>
      buildImageInferenceTask({
        request: BASE_REQUEST,
        model: "runware:z-image@turbo",
        modelParams: { scheduler: "NOT_A_SCHEDULER" },
        properties: zImage,
        schemaSource: "cache",
        schemaFetchedAt: null,
        maxCount: 4,
      }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "PROVIDER_INVALID_REQUEST" &&
      /must be one of/.test(error.message),
  );
  assert.throws(
    () =>
      buildImageInferenceTask({
        request: BASE_REQUEST,
        model: "runware:z-image@turbo",
        modelParams: { steps: 999 },
        properties: zImage,
        schemaSource: "cache",
        schemaFetchedAt: null,
        maxCount: 4,
      }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === "PROVIDER_INVALID_REQUEST" &&
      /≤ 50/.test(error.message),
  );
  // Nested objects: known child passes, unknown child names the full path.
  const flux = fixtureProperties("flux-2-pro");
  const fluxBuilt = buildImageInferenceTask({
    request: BASE_REQUEST,
    model: "bfl:5@1",
    modelParams: { providerSettings: { bfl: { safetyTolerance: 4 } } },
    properties: flux,
    schemaSource: "cache",
    schemaFetchedAt: null,
    maxCount: 4,
  });
  assert.deepEqual(fluxBuilt.task["providerSettings"], { bfl: { safetyTolerance: 4 } });
  assert.throws(
    () =>
      validateParamValue(
        "providerSettings",
        { bfl: { bogus: 1 } },
        flux["providerSettings"],
        "providerSettings",
      ),
    (error: unknown) =>
      error instanceof ProviderError && /providerSettings\.bfl\.bogus/.test(error.message),
  );
});

test("v2: providerSettings/settings defaults from the profile; model_params win", () => {
  const properties = fixtureProperties("google-nano-banana-pro");
  const profile = {
    dimensionMode: "resolutionOrWidthHeight",
    resolutionMap: { "1k": "1K" },
    sendSteps: false,
    sendCfgScale: false,
    sendScheduler: false,
    sendSeed: true,
    sendStrength: false,
    maxReferenceImages: 14,
    providerSettings: { google: { safetyTolerance: "none" } },
    settings: { temperature: 1 },
  } as const;
  const built = buildImageInferenceTask({
    request: BASE_REQUEST,
    model: "google:4@2",
    modelParams: { providerSettings: { google: { safetyTolerance: "low" } } },
    properties,
    schemaSource: "cache",
    schemaFetchedAt: null,
    profile,
    maxCount: 4,
  });
  // Operator override survives, untouched default applies.
  assert.deepEqual(built.task["providerSettings"], { google: { safetyTolerance: "low" } });
  assert.deepEqual(built.task["settings"], { temperature: 1 });
});

test("slug for a known model resolves to the docs page slug, not 'models' (2026-09-29)", async () => {
  // The sync path derives the slug from modelSchemaUrl; a positional split
  // used to yield "models" and request /docs/models/models/schema.json.
  const requested: string[] = [];
  const resolved = await resolveModelSchema("alibaba-z-image-turbo", async (url) => {
    requested.push(url);
    return fixture("z-image-turbo");
  });
  assert.ok(resolved.schema !== null);
  assert.deepEqual(requested, ["https://runware.ai/docs/models/alibaba-z-image-turbo/schema.json"]);
});

test("unknown runware model degrades to a labeled preset contract (0.1.200 report)", async () => {
  const { createGenerationProvider } = await import(
    "../../extensions/progressive-media-runware/src/index.js"
  );
  const provider = createGenerationProvider({
    config: { api_key: "test-key" },
    secrets: {},
  });
  const ctx = { requestId: "test-fallback" } as never;
  // An air id that exists in NEITHER the known map nor the provider docs
  // catalog: slug resolution degrades to null on any network state, and the
  // provider must return a usable "preset" contract instead of null (which
  // surfaced as MEDIA_MODEL_UNKNOWN and blocked the studio).
  const resolve = provider.resolveModelCapabilities;
  assert.ok(resolve !== undefined, "provider exposes live model resolution");
  const resolved = await resolve.call(provider, ctx, "test:no-such-model@1");
  assert.ok(
    resolved !== null && resolved !== undefined,
    "unknown model must not 404 behind MEDIA_MODEL_UNKNOWN",
  );
  assert.equal(resolved.source, "preset");
  assert.equal(resolved.model, "test:no-such-model@1");
  assert.ok(resolved.sizeOptions.length >= 1);
  assert.equal(resolved.requestProfile.dimensionMode, "widthHeight");

  // Generation planning stays consistent with the fallback contract: the
  // task builds schema-less (properties: null) on the fallback dimensions.
  const task = buildImageInferenceTask({
    request: { prompt: "test", count: 1 } as GenerationRequest,
    model: "test:no-such-model@1",
    modelParams: {},
    properties: null,
    schemaSource: "none",
    schemaFetchedAt: null,
    profile: resolved.requestProfile,
    fallbackDimensions: {
      width: resolved.sizeOptions[0]!.width,
      height: resolved.sizeOptions[0]!.height,
    },
    maxCount: 4,
  });
  assert.equal(task.model, "test:no-such-model@1");
});
