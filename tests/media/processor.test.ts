// PCMS-MEDIA-T008 — Sharp processor adapter/versioning: transforms are
// deterministic (same bytes + instruction + processor version ⇒ identical
// output), the processor identity is exposed for variant cache keys, and
// outputs honor requested formats/quality.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ImageDecodeLimits,
  PROCESSOR_ID,
  processorVersion,
  readImageMetadata,
  transformImage,
} from "@pcms/media";
import sharp from "sharp";

const LIMITS: ImageDecodeLimits = { maxPixels: 64_000_000, maxDimension: 16_384 };

async function photoJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 40, g: 120, b: 200 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: 80, height: 80, channels: 3, background: { r: 250, g: 200, b: 40 } },
        })
          .png()
          .toBuffer(),
        left: 20,
        top: 20,
      },
    ])
    .jpeg()
    .toBuffer();
}

test("processor identity is a stable versioned string", () => {
  assert.equal(PROCESSOR_ID, "sharp");
  assert.equal(sharp.versions.sharp, "0.35.5");
  assert.equal(sharp.versions.rsvg, "2.63.2");
  const version = processorVersion();
  assert.match(version, /^\d/, version);
  assert.match(version, /vips\d/, version);
  assert.equal(version, processorVersion(), "version string is stable within a process");
});

test("identical transforms produce byte-identical output (determinism fixtures)", async () => {
  const source = await photoJpeg();
  const instruction = {
    width: 160,
    height: 100,
    fit: "cover" as const,
    format: "webp" as const,
    quality: 80,
  };
  const first = await transformImage(source, instruction, LIMITS);
  const second = await transformImage(source, instruction, LIMITS);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.width, 160);
  assert.equal(first.height, 100);
  // same run-to-run determinism for AVIF and JPEG fallback
  for (const format of ["avif", "jpeg", "png"] as const) {
    const a = await transformImage(source, { ...instruction, format }, LIMITS);
    const b = await transformImage(source, { ...instruction, format }, LIMITS);
    assert.deepEqual(a.bytes, b.bytes, `deterministic ${format}`);
  }
});

test("different parameters yield different outputs and honest dimensions", async () => {
  const source = await photoJpeg();
  const base = { width: 120, height: 120, format: "webp" as const };
  const q80 = await transformImage(source, { ...base, fit: "cover", quality: 80 }, LIMITS);
  const q40 = await transformImage(source, { ...base, fit: "cover", quality: 40 }, LIMITS);
  assert.notDeepEqual(q80.bytes, q40.bytes, "quality changes the output");
  const inside = await transformImage(source, { ...base, fit: "inside", quality: 80 }, LIMITS);
  assert.ok(inside.width <= 120 && inside.height <= 120, "inside never upscales beyond target");
  const dims = await readImageMetadata(q80.bytes);
  assert.equal(dims.format, "webp");
});

test("AVIF/WebP/fallback outputs really are those formats", async () => {
  const source = await photoJpeg();
  for (const format of ["avif", "webp", "jpeg", "png"] as const) {
    const out = await transformImage(source, { fit: "inside", format, quality: 75 }, LIMITS);
    assert.equal((await readImageMetadata(out.bytes)).format, format, format);
  }
});

test("JPEG, PNG, WebP, and AVIF sources decode, report metadata, and resize", async () => {
  const source = await photoJpeg();
  for (const format of ["jpeg", "png", "webp", "avif"] as const) {
    const encoded = await sharp(source).toFormat(format).toBuffer();
    assert.equal((await readImageMetadata(encoded)).format, format, `${format} metadata`);

    const resized = await transformImage(
      encoded,
      { width: 80, height: 50, fit: "inside", format: "webp", quality: 75 },
      LIMITS,
    );
    assert.deepEqual([resized.width, resized.height], [80, 50], `${format} resize dimensions`);
    assert.equal((await readImageMetadata(resized.bytes)).format, "webp", `${format} resize`);
  }
});

test("safe SVG sources decode through librsvg and resize to raster output", async () => {
  const source = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#2878c8"/></svg>',
  );
  assert.deepEqual(await readImageMetadata(source), {
    width: 320,
    height: 200,
    format: "svg",
    orientation: 1,
    animated: false,
    hasAlpha: true,
    colorSpace: "srgb",
  });

  const resized = await transformImage(
    source,
    { width: 80, height: 50, fit: "inside", format: "webp", quality: 75 },
    LIMITS,
  );
  assert.deepEqual([resized.width, resized.height, resized.format], [80, 50, "webp"]);
  assert.equal((await readImageMetadata(resized.bytes)).format, "webp");
});
