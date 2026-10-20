// Image Generation v2 (plan T1.2): model capabilities derived from the
// published Runware schemas — no per-model hardcode. Fixtures are slimmed
// copies of the live runware.ai/docs/models/<slug>/schema.json documents.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deriveModelCapabilities } from "../../extensions/progressive-media-runware/src/capabilities.js";
import type { RunwareModelSchema } from "../../extensions/progressive-media-runware/src/model-schema.js";

function derive(name: string) {
  const schema = JSON.parse(
    readFileSync(`fixtures/media/runware/${name}.json`, "utf8"),
  ) as RunwareModelSchema;
  return deriveModelCapabilities({
    schema,
    sha256: "deadbeef",
    fetchedAt: "2026-09-28T00:00:00Z",
    providerId: "runware",
  });
}

test("z-image-turbo: bounded dimensions → derived sizeOptions, classic knobs", () => {
  const capabilities = derive("z-image-turbo");
  assert.ok(capabilities !== null);
  assert.equal(capabilities.model, "runware:z-image@turbo");
  assert.equal(capabilities.displayName, "Z-Image-Turbo");
  assert.equal(capabilities.requestProfile.dimensionMode, "widthHeight");
  assert.equal(capabilities.requestProfile.sendSteps, true);
  assert.equal(capabilities.requestProfile.sendCfgScale, true);
  assert.equal(capabilities.requestProfile.sendScheduler, true);
  assert.equal(capabilities.requestProfile.sendSeed, true);
  assert.equal(capabilities.requestProfile.sendStrength, true);
  assert.equal(capabilities.supportsNegativePrompt, true);
  // inputs.seedImage present → single reference, no referenceImages array.
  assert.equal(capabilities.requestProfile.maxReferenceImages, 1);
  // Schema allows 20 results per call; the count ladder applies at REST/MCP.
  assert.equal(capabilities.maxCount, 20);
  // 1k sizes land on multipleOf 16 within 128..2048 for every ratio.
  const oneK = capabilities.sizeOptions.filter((option) => option.tier === "1k");
  assert.ok(oneK.length >= 6);
  for (const option of oneK) {
    assert.equal(option.width % 16, 0, `${option.ratio} width ${option.width}`);
    assert.equal(option.height % 16, 0, `${option.ratio} height ${option.height}`);
    assert.ok(option.width >= 128 && option.width <= 2048);
    assert.ok(option.height >= 128 && option.height <= 2048);
  }
  // 4k tier is clamped to the schema maximum (2048), so 1:1 4k == 2k bound.
  const square4k = capabilities.sizeOptions.find((o) => o.tier === "4k" && o.ratio === "1:1");
  assert.equal(square4k?.width, 2048);
  assert.ok(capabilities.pricing !== undefined);
  assert.equal(capabilities.schemaSha256, "deadbeef");
});

test("flux-2-pro: providerSettings.bfl defaults, no negativePrompt, 9 references", () => {
  const capabilities = derive("flux-2-pro");
  assert.ok(capabilities !== null);
  assert.equal(capabilities.model, "bfl:5@1");
  assert.equal(capabilities.requestProfile.sendSteps, false);
  assert.equal(capabilities.requestProfile.sendCfgScale, false);
  assert.equal(capabilities.requestProfile.sendSeed, true);
  assert.equal(capabilities.supportsNegativePrompt, false);
  assert.equal(capabilities.requestProfile.maxReferenceImages, 9);
  assert.deepEqual(capabilities.requestProfile.providerSettings, {
    bfl: { safetyTolerance: 2 },
  });
});

test("gpt-image-flare: wide bounds (16..3840), settings defaults, no seed", () => {
  const capabilities = derive("gpt-image-flare");
  assert.ok(capabilities !== null);
  assert.equal(capabilities.requestProfile.sendSeed, false);
  assert.equal(capabilities.supportsNegativePrompt, false);
  const square4k = capabilities.sizeOptions.find((o) => o.tier === "4k" && o.ratio === "1:1");
  // Bounds 16..3840 let the 4k tier reach 3840 (the old hardcode could not).
  assert.equal(square4k?.width, 3840);
  assert.ok(capabilities.requestProfile.settings !== undefined);
});

test("google-nano-banana-pro: explicit oneOf presets + resolutionMap + google settings", () => {
  const capabilities = derive("google-nano-banana-pro");
  assert.ok(capabilities !== null);
  assert.equal(capabilities.model, "google:4@2");
  assert.equal(capabilities.requestProfile.dimensionMode, "resolutionOrWidthHeight");
  assert.deepEqual(capabilities.requestProfile.resolutionMap, {
    // Schema truth: nano-banana-pro publishes 1K/2K/4K only (no 0.5K).
    "1k": "1K",
    "2k": "2K",
    "4k": "4K",
  });
  assert.equal(capabilities.supportsNegativePrompt, false);
  assert.equal(capabilities.requestProfile.maxReferenceImages, 14);
  // Presets come from the schema verbatim — "1K (3:2)" → 1264x848.
  const preset = capabilities.sizeOptions.find((o) => o.tier === "1k" && o.ratio === "3:2");
  assert.deepEqual({ width: preset?.width, height: preset?.height }, { width: 1264, height: 848 });
  assert.ok(capabilities.sizeOptions.length >= 30);
  assert.deepEqual(capabilities.requestProfile.providerSettings, {
    google: { safetyTolerance: "none" },
  });
  // x-pricing.rates (per-tier output rates) → image price lines for the
  // cost estimator; "1K"/"2K" variants ride along.
  assert.ok(capabilities.pricing !== undefined && capabilities.pricing.length > 0);
  assert.equal(capabilities.pricing![0]!.unit, "image");
  assert.equal(capabilities.pricing![0]!.variant, "1K");
  assert.ok(Math.abs(capabilities.pricing![0]!.costUsd - 0.138) < 1e-9);
});

test("non-schema document → null (defensive)", () => {
  assert.equal(
    deriveModelCapabilities({
      schema: { info: {} },
      sha256: null,
      fetchedAt: "2026-09-28T00:00:00Z",
      providerId: "runware",
    }),
    null,
  );
});
