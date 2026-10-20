// PCMS-MEDIA-T007 — EXIF orientation/privacy policy for public derivatives:
// orientation applied before stripping, GPS/camera metadata never survives,
// color normalized to sRGB, animated sources render a static preview.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DERIVATIVE_METADATA_POLICY,
  type ImageDecodeLimits,
  readImageMetadata,
  transformImage,
} from "@pcms/media";
import sharp from "sharp";

const SMALL: ImageDecodeLimits = { maxPixels: 64_000_000, maxDimension: 16_384 };

async function gpsJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 300, channels: 3, background: { r: 10, g: 90, b: 200 } },
  })
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Copyright: "TestCorp", UserComment: "secret location" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "52/1,18/1,0/1",
        GPSLongitudeRef: "E",
        GPSLongitude: "21/1,0/1,0/1",
      },
    })
    .jpeg()
    .toBuffer();
}

test("GPS and private metadata are absent from public derivatives", async () => {
  const original = await gpsJpeg();
  const inputMeta = await sharp(original).metadata();
  assert.ok(inputMeta.exif !== undefined, "fixture must carry EXIF");
  assert.equal(
    inputMeta.exif!.includes(Buffer.from([0x25, 0x88])),
    true,
    "fixture must carry the GPS IFD pointer",
  );

  const derivative = await transformImage(
    original,
    { fit: "inside", format: "webp", quality: 80 },
    SMALL,
  );
  const outMeta = await sharp(derivative.bytes).metadata();
  assert.equal(outMeta.exif, undefined, "derivative must carry no EXIF at all");
  assert.notDeepEqual(derivative.bytes, original);
});

test("orientation is applied before stripping: display dimensions, no rotation flag", async () => {
  const original = await gpsJpeg();
  const stored = await readImageMetadata(original);
  assert.equal(stored.orientation, 6);
  assert.equal(stored.width, 300);
  assert.equal(stored.height, 100);

  const derivative = await transformImage(
    original,
    { fit: "inside", format: "png", quality: 90 },
    SMALL,
  );
  assert.equal(derivative.width, 300);
  assert.equal(derivative.height, 100);
  const outMeta = await sharp(derivative.bytes).metadata();
  assert.equal(outMeta.orientation, undefined, "orientation flag must not survive");
});

test("non-sRGB profiles are normalized so color does not drift", async () => {
  const cmyk = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 90, b: 10 } },
  })
    .toColourspace("cmyk")
    .jpeg()
    .toBuffer();
  const inputMeta = await sharp(cmyk).metadata();
  assert.equal(inputMeta.space, "cmyk");
  const derivative = await transformImage(
    cmyk,
    { fit: "inside", format: "png", quality: 90 },
    SMALL,
  );
  const outMeta = await sharp(derivative.bytes).metadata();
  assert.equal(outMeta.space, DERIVATIVE_METADATA_POLICY.outputColorspace);
  assert.equal(outMeta.space, "srgb");
});

test("animated sources produce a static preview; the original stays intact", async () => {
  // Reuse the two-frame GIF builder from the image test suite.
  const { twoFrameGif } = await import("./gif-fixture.js");
  const animated = twoFrameGif();
  assert.equal((await readImageMetadata(animated)).animated, true);
  const derivative = await transformImage(
    animated,
    { fit: "inside", format: "png", quality: 90 },
    SMALL,
  );
  const outMeta = await sharp(derivative.bytes).metadata();
  assert.equal(outMeta.pages, undefined, "derivative is a static preview (first frame)");
  assert.equal((await readImageMetadata(animated)).animated, true, "original untouched");
});
