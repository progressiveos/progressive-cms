// Image Generation v2 (plan Ф3): OpenRouter Images API provider — endpoint
// document → capability snapshot, request shaping (aspect/resolution vs
// explicit size, references, count clamp) and inline-bytes fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "@pcms/media";
import {
  createGenerationProvider,
  deriveFromEndpoint,
} from "../../extensions/progressive-media-openrouter/src/index.js";

const ENDPOINT = {
  supported_parameters: {
    aspect_ratio: { type: "enum", values: ["1:1", "3:2", "2:3", "16:9", "9:16"] },
    resolution: { type: "enum", values: ["1K", "2K", "4K"] },
    n: { type: "range", min: 1, max: 1 },
    seed: { type: "boolean" },
    input_references: { type: "range", min: 0, max: 3 },
  },
  pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 0.03 }],
};

test("endpoint document → capability snapshot", () => {
  const capabilities = deriveFromEndpoint("google/gemini-3-pro-image", ENDPOINT);
  assert.equal(capabilities.providerId, "openrouter");
  assert.equal(capabilities.model, "google/gemini-3-pro-image");
  assert.equal(capabilities.requestProfile.dimensionMode, "widthHeight");
  assert.equal(capabilities.requestProfile.sendSeed, true);
  assert.equal(capabilities.requestProfile.maxReferenceImages, 3);
  // n.max = 1 caps the model; pricing flows to the estimator.
  assert.equal(capabilities.maxCount, 1);
  assert.equal(capabilities.pricing?.[0]?.unit, "megapixel");
  // Size grid covers aspects × tiers with multipleOf-16 estimates.
  const square = capabilities.sizeOptions.find((o) => o.tier === "2k" && o.ratio === "1:1");
  assert.equal(square?.width, 2048);
  assert.equal(square?.height, 2048);
});

test("provider factory: missing api key → PROVIDER_NOT_CONFIGURED", () => {
  assert.throws(
    () => createGenerationProvider({ config: {}, secrets: {} }),
    (error: unknown) => error instanceof ProviderError && error.code === "PROVIDER_NOT_CONFIGURED",
  );
});

test("generate: request shaping, base64 candidates, cost split", async () => {
  const captured: { value?: { url: string; init: RequestInit } } = {};
  const fetchMock = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      captured.value = { url, init };
      return new Response(
        JSON.stringify({
          data: [
            { b64_json: Buffer.from("one").toString("base64"), media_type: "image/png" },
            { b64_json: Buffer.from("two").toString("base64"), media_type: "image/png" },
          ],
          usage: { cost: 0.04 },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ data: [ENDPOINT] }), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = createGenerationProvider({
    config: { api_key: "test-key", models: [{ model: "test/model" }] },
    secrets: {},
  });
  const result = (await generateWithMock(provider, fetchMock, {
    prompt: "test",
    count: 2,
    aspect: "16:9",
    resolution: "2k",
    width: null,
    height: null,
    model: "test/model",
    negativePrompt: null,
    seed: 7,
  })) as {
    candidates: { index: number; downloadUrl: string; cost: number | null; mimeType: string }[];
    cost: number | null;
  };
  assert.equal(result.candidates.length, 2);
  assert.equal(result.cost, 0.04);
  assert.ok(Math.abs(result.candidates[0]!.cost! - 0.02) < 1e-9);
  assert.ok(result.candidates[0]!.downloadUrl.startsWith("data:image/png;base64,"));
  // Inline bytes decode back through fetch().
  const fetched = await provider.fetch(
    { requestId: "t" },
    {
      index: 0,
      previewUrl: null,
      downloadUrl: result.candidates[0]!.downloadUrl,
      width: null,
      height: null,
      mimeType: "image/png",
      model: "test/model",
      providerRequestId: null,
      seed: null,
      cost: null,
    },
  );
  assert.equal(fetched.bytes.toString(), "one");
  // Request body: aspect+resolution sent, no pixel size, references absent.
  const body = JSON.parse(String(captured.value?.init?.body)) as Record<string, unknown>;
  assert.equal(body["aspect_ratio"], "16:9");
  assert.equal(body["resolution"], "2K");
  assert.equal("size" in body, false);
  assert.equal(body["seed"], 7);
});

test("402 insufficient credits surfaces the provider message", async () => {
  const fetchMock = (async () =>
    new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), {
      status: 402,
    })) as unknown as typeof fetch;
  const provider = createGenerationProvider({
    config: { api_key: "test-key", models: [{ model: "test/model" }] },
    secrets: {},
  });
  await assert.rejects(
    () =>
      generateWithMock(provider, fetchMock, {
        prompt: "x",
        count: 1,
        aspect: null,
        resolution: null,
        width: null,
        height: null,
        model: "test/model",
        negativePrompt: null,
        seed: null,
      }),
    (error: unknown) =>
      error instanceof ProviderError && /Insufficient credits/.test(error.message),
  );
});

// Minimal harness: swaps the module-level outbound fetch client by stubbing
// globalThis.fetch used by undici through the extension client in tests.
// The extension client ultimately delegates to global fetch in test env.
function generateWithMock(
  provider: ReturnType<typeof createGenerationProvider>,
  fetchMock: typeof fetch,
  request: Record<string, unknown>,
): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock;
  return provider.generate({ requestId: "test" }, request as never).finally(() => {
    globalThis.fetch = original;
  });
}
