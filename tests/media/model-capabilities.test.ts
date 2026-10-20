// Image Generation v2 (plan T1.1/T1.6): count ladder + cost estimator.
// Pure-function coverage — no network, no DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_COUNT,
  effectiveMaxCount,
  estimateGenerationCost,
  MAX_COUNT_CEILING,
  MAX_COUNT_HUMAN,
  type ModelCapabilities,
  type ModelSizeOption,
} from "@pcms/media";

function size(
  ratio: string,
  width: number,
  height: number,
  tier: ModelSizeOption["tier"],
): ModelSizeOption {
  return { ratio, width, height, tier };
}

const BASE_CAPABILITIES: ModelCapabilities = {
  providerId: "runware",
  model: "runware:test@1",
  displayName: "Test Model",
  sizeOptions: [
    size("1:1", 1024, 1024, "1k"),
    size("3:2", 1536, 1024, "1k"),
    size("1:1", 2048, 2048, "2k"),
    size("1:1", 1024, 1024, "1k"),
  ],
  requestProfile: {
    dimensionMode: "widthHeight",
    sendSteps: false,
    sendCfgScale: false,
    sendScheduler: false,
    sendSeed: true,
    sendStrength: false,
    maxReferenceImages: 0,
  },
  maxCount: 20,
  supportsNegativePrompt: true,
  source: "schema",
  schemaSha256: null,
  lastSyncedAt: "2026-09-28T00:00:00Z",
};

test("count ladder: agent clamps to 1, human to MAX_COUNT_HUMAN, ceiling honored", () => {
  assert.equal(MAX_COUNT_CEILING, 4);
  assert.equal(MAX_COUNT_HUMAN, 2);
  assert.equal(DEFAULT_COUNT, 1);
  // Model ceilings above the ladder are clamped by the surface.
  assert.equal(effectiveMaxCount(20, "agent"), 1);
  assert.equal(effectiveMaxCount(20, "human"), 2);
  // Small models keep their own lower ceiling.
  assert.equal(effectiveMaxCount(1, "human"), 1);
  assert.equal(effectiveMaxCount(3, "human"), 2);
  // Missing model ceiling falls back to the code ceiling, never past it.
  assert.equal(effectiveMaxCount(null, "human"), 2);
  assert.equal(effectiveMaxCount(null, "agent"), 1);
});

test("cost: exact measured configuration is authoritative (approximate: false)", () => {
  const capabilities: ModelCapabilities = {
    ...BASE_CAPABILITIES,
    pricing: [
      { unit: "configuration", costUsd: 0.0032, width: 1024, height: 1024 },
      { unit: "configuration", costUsd: 0.0141, width: 2048, height: 2048 },
    ],
  };
  const estimate = estimateGenerationCost(capabilities, {
    aspect: "1:1",
    resolution: "1k",
    count: 1,
  });
  assert.equal(estimate.basis, "configuration");
  assert.equal(estimate.approximate, false);
  assert.equal(estimate.perImageUsd, 0.0032);
  assert.equal(estimate.totalUsd, 0.0032);
});

test("cost: interpolation between measured configurations is monotonic and clamped", () => {
  const capabilities: ModelCapabilities = {
    ...BASE_CAPABILITIES,
    pricing: [
      { unit: "configuration", costUsd: 0.0013, width: 512, height: 512 },
      { unit: "configuration", costUsd: 0.0032, width: 1024, height: 1024 },
      { unit: "configuration", costUsd: 0.0141, width: 2048, height: 2048 },
    ],
  };
  const at = (width: number, height: number) =>
    estimateGenerationCost(capabilities, { width, height, count: 1 }).perImageUsd!;
  // Monotonic in size.
  assert.ok(at(512, 512) < at(1024, 1024));
  assert.ok(at(1024, 1024) < at(1536, 1024));
  assert.ok(at(1536, 1024) < at(2048, 2048));
  // Clamped at the range ends (no extrapolation beyond measured sizes).
  assert.equal(at(256, 256), 0.0013);
  assert.equal(at(4096, 4096), 0.0141);
  // Interpolated estimate is marked approximate.
  const mid = estimateGenerationCost(capabilities, { width: 1536, height: 1024, count: 2 });
  assert.equal(mid.approximate, true);
  assert.equal(mid.basis, "megapixel");
  assert.ok(Math.abs(mid.totalUsd! - mid.perImageUsd! * 2) < 1e-12);
});

test("cost: flat per-image and per-megapixel units", () => {
  const flat: ModelCapabilities = {
    ...BASE_CAPABILITIES,
    pricing: [{ unit: "image", costUsd: 0.05 }],
  };
  const flatEstimate = estimateGenerationCost(flat, { aspect: "3:2", count: 3 });
  assert.equal(flatEstimate.basis, "image");
  assert.equal(flatEstimate.perImageUsd, 0.05);
  assert.ok(Math.abs(flatEstimate.totalUsd! - 0.15) < 1e-9);

  const perMp: ModelCapabilities = {
    ...BASE_CAPABILITIES,
    pricing: [{ unit: "megapixel", costUsd: 0.03 }],
  };
  const mpEstimate = estimateGenerationCost(perMp, { aspect: "1:1", resolution: "1k", count: 1 });
  assert.equal(mpEstimate.basis, "megapixel");
  assert.ok(Math.abs(mpEstimate.perImageUsd! - 0.03 * 1.048576) < 1e-9);
});

test("cost: token-priced and unpublished models refuse to invent numbers", () => {
  const token: ModelCapabilities = {
    ...BASE_CAPABILITIES,
    pricing: [{ unit: "token", costUsd: 0.00003 }],
  };
  const tokenEstimate = estimateGenerationCost(token, { aspect: "1:1", count: 1 });
  assert.equal(tokenEstimate.perImageUsd, null);
  assert.equal(tokenEstimate.totalUsd, null);
  assert.equal(tokenEstimate.basis, "token");
  assert.ok(tokenEstimate.hint !== null);

  const { pricing: _omitPricing, ...withoutPricing } = BASE_CAPABILITIES;
  const none: ModelCapabilities = { ...withoutPricing };
  const noneEstimate = estimateGenerationCost(none, { aspect: "1:1", count: 1 });
  assert.equal(noneEstimate.perImageUsd, null);
  assert.equal(noneEstimate.basis, "unpublished");
});

test("cost: count multiplies; invalid count falls back to 1", () => {
  const capabilities: ModelCapabilities = {
    ...BASE_CAPABILITIES,
    pricing: [{ unit: "image", costUsd: 0.02 }],
  };
  assert.ok(Math.abs(estimateGenerationCost(capabilities, { count: 4 }).totalUsd! - 0.08) < 1e-9);
  assert.equal(estimateGenerationCost(capabilities, { count: 0 }).totalUsd, 0.02);
});
