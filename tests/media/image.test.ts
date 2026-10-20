// PCMS-MEDIA-T006 — image decode metadata extraction: dimensions with EXIF
// orientation applied, format/alpha/animation facts, bounded decode
// (decompression-bomb headers rejected as MEDIA_PIXEL_LIMIT), corrupt input
// as MEDIA_DECODE_FAILED.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaError, readImageMetadata } from "@pcms/media";
import sharp from "sharp";
import { twoFrameGif } from "./gif-fixture.js";

async function createPng(width: number, height: number, alpha = false): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 10, g: 200, b: 30, alpha: 0.5 } : { r: 200, g: 10, b: 30 },
    },
  })
    .png()
    .toBuffer();
}

test("portrait and landscape dimensions are extracted (fixtures)", async () => {
  const portrait = await readImageMetadata(await createPng(100, 200));
  assert.equal(portrait.width, 100);
  assert.equal(portrait.height, 200);
  assert.equal(portrait.format, "png");
  assert.equal(portrait.orientation, 1);

  const landscape = await readImageMetadata(await createJpeg(640, 480));
  assert.equal(landscape.width, 640);
  assert.equal(landscape.height, 480);
  assert.equal(landscape.format, "jpeg");
});

async function createJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 90, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

test("PNG transparency is reported (fixture)", async () => {
  const transparent = await readImageMetadata(await createPng(64, 64, true));
  assert.equal(transparent.hasAlpha, true);
  const opaque = await readImageMetadata(await createPng(64, 64, false));
  assert.equal(opaque.hasAlpha, false);
});

test("EXIF orientation is reported and display dimensions swap for 90° turns", async () => {
  // Portrait pixels stored with orientation 6 (rotate 90° to display).
  const stored = await sharp({
    create: { width: 100, height: 300, channels: 3, background: { r: 10, g: 90, b: 200 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const check = await sharp(stored).metadata();
  assert.equal(check.orientation, 6, "fixture must carry orientation 6");
  const metadata = await readImageMetadata(stored);
  assert.equal(metadata.orientation, 6);
  assert.equal(metadata.width, 300, "display width is the stored height");
  assert.equal(metadata.height, 100, "display height is the stored width");
});

test("animated GIF is detected without exploding resource usage", async () => {
  const animatedBuffer = twoFrameGif();
  const check = await sharp(animatedBuffer, { animated: true }).metadata();
  assert.equal(check.pages, 2, "fixture must be a real two-frame GIF");
  const metadata = await readImageMetadata(animatedBuffer);
  assert.equal(metadata.animated, true);
});

test("decompression-bomb headers are rejected as MEDIA_PIXEL_LIMIT", async () => {
  // Hand-crafted PNG header declaring 40000×40000 (1.6 GP) — no pixel data.
  const ihdr = Buffer.alloc(17);
  ihdr.write("IHDR", 0, "latin1");
  ihdr.writeUInt32BE(40000, 4);
  ihdr.writeUInt32BE(40000, 8);
  ihdr.writeUInt8(8, 12); // bit depth
  ihdr.writeUInt8(2, 13); // color type RGB
  ihdr.writeUInt8(0, 14); // compression
  ihdr.writeUInt8(0, 15); // filter
  ihdr.writeUInt8(0, 16); // interlace
  const { crc32 } = (await import("node:zlib")) as { crc32: (buf: Buffer) => number };
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(ihdr) >>> 0, 0);
  // PNG header parsing stops at the first IDAT; the chunk structure up to
  // there must be valid for the bomb to be recognized as a PNG at all.
  const idatHeader = Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54]); // zero-length IDAT
  const idatCrc = Buffer.alloc(4);
  idatCrc.writeUInt32BE(crc32(idatHeader.subarray(4)) >>> 0, 0);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const bomb = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    length,
    ihdr,
    crc,
    idatHeader,
    idatCrc,
    iend,
  ]);
  await assert.rejects(
    readImageMetadata(bomb),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_PIXEL_LIMIT",
  );
});

test("dimensions above the axis limit are rejected before decode work", async () => {
  const wide = await createPng(20000, 50);
  await assert.rejects(
    readImageMetadata(wide, { maxPixels: 64_000_000, maxDimension: 16_384 }),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_PIXEL_LIMIT",
  );
});

test("corrupt image input is MEDIA_DECODE_FAILED, not a crash", async () => {
  const corrupt = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("this is not a real PNG payload"),
  ]);
  await assert.rejects(
    readImageMetadata(corrupt),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_DECODE_FAILED",
  );
});
