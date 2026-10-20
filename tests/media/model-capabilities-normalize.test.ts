// Model capabilities snapshot normalization (2026-09-29 prod incident): the
// Admin persists the WIRE shape (snake_case, flat request profile), adapters
// used to cast stored snapshots blindly — `sizeOptions.map` crashed and
// configured generation models never appeared in /capabilities until a
// restart, and the model contract endpoint 500'd.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeModelCapabilities } from "@pcms/media";
import { pickFallbackDimensions } from "../../extensions/progressive-media-runware/src/index.js";

const WIRE_SNAPSHOT = {
  model: "runware:z-image@turbo",
  display_name: "Z-Image-Turbo",
  stale: false,
  source: "schema",
  size_options: [{ ratio: "1:1", width: 1024, height: 1024, tier: "1k" }],
  dimension_mode: "resolutionOrWidthHeight",
  resolution_map: { "1k": "1K" },
  send_steps: false,
  send_cfg_scale: false,
  send_scheduler: false,
  send_seed: true,
  send_strength: false,
  max_reference_images: 2,
  provider_settings: { promptExtend: true },
  settings: null,
  max_count: 8,
  supports_negative_prompt: true,
  pricing: [{ unit: "image", costUsd: 0.04, variant: "1K output image" }],
  schema_sha256: "abc123",
  last_synced_at: "2026-09-29T05:00:00.000Z",
};

test("normalize: wire snapshot (snake_case, flat profile) → ModelCapabilities", () => {
  const caps = normalizeModelCapabilities(WIRE_SNAPSHOT, "runware");
  assert.ok(caps !== null);
  assert.equal(caps.model, "runware:z-image@turbo");
  assert.equal(caps.displayName, "Z-Image-Turbo");
  assert.equal(caps.sizeOptions.length, 1);
  assert.equal(caps.sizeOptions[0]?.ratio, "1:1");
  assert.equal(caps.requestProfile.dimensionMode, "resolutionOrWidthHeight");
  assert.equal(caps.requestProfile.sendSeed, true);
  assert.equal(caps.requestProfile.maxReferenceImages, 2);
  assert.equal(caps.maxCount, 8);
  assert.equal(caps.supportsNegativePrompt, true);
  assert.equal(caps.schemaSha256, "abc123");
  assert.equal(caps.pricing?.[0]?.costUsd, 0.04);
});

test("normalize: runtime snapshot (camelCase, nested profile) passes through", () => {
  const caps = normalizeModelCapabilities(
    {
      providerId: "runware",
      model: "m",
      displayName: "M",
      sizeOptions: [{ ratio: "4:3", width: 800, height: 600, tier: null }],
      requestProfile: {
        dimensionMode: "widthHeight",
        sendSteps: true,
        sendCfgScale: false,
        sendScheduler: false,
        sendSeed: false,
        sendStrength: false,
        maxReferenceImages: 0,
      },
      maxCount: 2,
      supportsNegativePrompt: false,
      schemaSha256: "ff",
      lastSyncedAt: "2026-09-29T00:00:00.000Z",
    },
    "runware",
  );
  assert.ok(caps !== null);
  assert.equal(caps.sizeOptions[0]?.width, 800);
  assert.equal(caps.requestProfile.sendSteps, true);
  assert.equal(caps.providerId, "runware");
});

test("normalize: garbage → null (adapter degrades to live resolution)", () => {
  assert.equal(normalizeModelCapabilities(null, "runware"), null);
  assert.equal(normalizeModelCapabilities("nope", "runware"), null);
  assert.equal(normalizeModelCapabilities({ display_name: "no model key" }, "runware"), null);
});

test("generate-side fallback dimensions survive an Admin-wire snapshot (0.1.200 report)", () => {
  // Blind-casting the wire shape crashed generate() on
  // snapshot.sizeOptions.length (arenaofstars: every generation failed with
  // PROVIDER_FAILED while the stored snapshot was perfectly valid).
  assert.throws(() => pickFallbackDimensions(WIRE_SNAPSHOT as never, "1:1"));

  const caps = normalizeModelCapabilities(WIRE_SNAPSHOT, "runware");
  assert.ok(caps !== null);
  assert.deepEqual(pickFallbackDimensions(caps, "1:1"), { width: 1024, height: 1024 });
  // No aspect match → falls back to the first configured size, not a crash.
  assert.deepEqual(pickFallbackDimensions(caps, "9:16"), { width: 1024, height: 1024 });
});
