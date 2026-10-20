// PCMS-MEDIA-T009 — theme preset ingestion/validation: manifest-shaped
// presets validate into typed descriptors, discover deterministically and
// reject malformed input with stable codes.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMediaPresetRegistry,
  MediaError,
  validatePresetInput,
  variantKeyFor,
} from "@pcms/media";

// Structural shape of the reference theme manifest's media_presets entries
// (packages/themes is L1 — media sees plain data, not the manifest type).
const REFERENCE_THEME_PRESETS = [
  {
    id: "hero",
    width: 1600,
    height: 900,
    fit: "cover",
    crop: "entropy",
    formats: ["avif", "webp"],
    quality: 82,
    loading: "eager",
  },
  { id: "card", width: 800, height: 600, fit: "cover", formats: ["webp"], quality: 80 },
  { id: "thumbnail", width: 96, fit: "cover", formats: ["webp"] },
];

test("manifest-shaped presets ingest into a deterministic registry", () => {
  const registry = createMediaPresetRegistry(REFERENCE_THEME_PRESETS);
  const ids = registry.listPresets().map((p) => p.id);
  assert.deepEqual(ids, ["card", "hero", "thumbnail"], "sorted discovery");
  const hero = registry.getPreset("hero");
  assert.equal(hero?.width, 1600);
  assert.equal(hero?.height, 900);
  assert.deepEqual(hero?.formats, ["avif", "webp"]);
  assert.equal(hero?.loading, "eager");
  // defaults materialize for omitted optional fields
  const thumb = registry.getPreset("thumbnail");
  assert.equal(thumb?.height, null);
  assert.equal(thumb?.crop, "center");
  assert.equal(thumb?.quality, 80);
  assert.equal(registry.getPreset("missing"), null);
});

test("malformed presets are rejected with stable codes", () => {
  expectInvalid(null);
  expectInvalid({ id: "Bad ID", width: 800 });
  expectInvalid({ id: "card", width: 8 });
  expectInvalid({ id: "card", width: 800, height: 9000 });
  expectInvalid({ id: "card", width: 800, fit: "zoom" });
  expectInvalid({ id: "card", width: 800, crop: "left-bottom" });
  expectInvalid({ id: "card", width: 800, formats: [] });
  expectInvalid({ id: "card", width: 800, formats: ["bmp"] });
  expectInvalid({ id: "card", width: 800, quality: 0 });
  expectInvalid({ id: "card", width: 800, loading: "instant" });
  expectInvalid({ id: "card", width: 80.5 });
  assert.throws(
    () => createMediaPresetRegistry([REFERENCE_THEME_PRESETS[0], REFERENCE_THEME_PRESETS[0]]),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_PRESET_INVALID",
  );
});

function expectInvalid(raw: unknown): void {
  assert.throws(
    () => validatePresetInput(raw),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_PRESET_INVALID",
    JSON.stringify(raw),
  );
}

test("variant keys depend on source, version, parameters, format and processor", () => {
  const base = {
    sourceSha256: "a".repeat(64),
    versionNo: 1,
    presetId: "card",
    width: 800,
    height: 600,
    fit: "cover",
    crop: "center",
    focalX: null,
    focalY: null,
    quality: 80,
    format: "webp",
  };
  const key = variantKeyFor(base);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(variantKeyFor(base), key, "deterministic");
  // any meaningful change moves the key
  for (const changed of [
    { ...base, sourceSha256: "b".repeat(64) },
    { ...base, versionNo: 2 },
    { ...base, presetId: "hero" },
    { ...base, width: 801 },
    { ...base, height: null },
    { ...base, fit: "contain" },
    { ...base, crop: "entropy" },
    { ...base, focalX: 0.25 },
    { ...base, quality: 79 },
    { ...base, format: "avif" },
  ]) {
    assert.notEqual(variantKeyFor(changed), key, JSON.stringify(changed));
  }
});
