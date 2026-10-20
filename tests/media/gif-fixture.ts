// Test fixture builder: a real two-frame animated GIF (8-bit LZW with
// clear-code-per-literal packing keeps the code size constant). Shared by
// the image metadata and EXIF-policy suites; self-verifying at call sites.
export function twoFrameGif(size = 8, delayCs = 10): Buffer {
  const colorTable = Buffer.from([0xff, 0, 0, 0, 0xff, 0, 0, 0, 0, 0xff, 0xff, 0xff]);
  const header = Buffer.from("GIF89a", "latin1");
  const lsd = Buffer.from([
    size & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
    (size >> 8) & 0xff,
    0x81,
    0x00,
    0x00,
  ]); // 16-bit LE width/height + GCT with 4 colors
  const frame = (colorIndex: number): Buffer => {
    const gce = Buffer.from([
      0x21,
      0xf9,
      0x04,
      0x04,
      delayCs & 0xff,
      (delayCs >> 8) & 0xff,
      0x00,
      0x00,
    ]);
    const descriptor = Buffer.from([
      0x2c,
      0,
      0, // left (16-bit LE)
      0,
      0, // top (16-bit LE)
      size & 0xff,
      (size >> 8) & 0xff, // width
      size & 0xff,
      (size >> 8) & 0xff, // height
      0x00,
    ]);
    const minCodeSize = Buffer.from([0x02]);
    const CLEAR = 4;
    const EOI = 5;
    const codes: number[] = [];
    for (let i = 0; i < size * size; i += 1) codes.push(CLEAR, colorIndex);
    codes.push(CLEAR, EOI);
    // LSB-first bit packing at a constant 3-bit code size.
    const bytes: number[] = [];
    let accumulator = 0;
    let bitCount = 0;
    for (const code of codes) {
      accumulator |= code << bitCount;
      bitCount += 3;
      while (bitCount >= 8) {
        bytes.push(accumulator & 0xff);
        accumulator >>= 8;
        bitCount -= 8;
      }
    }
    if (bitCount > 0) bytes.push(accumulator & 0xff);
    const data = Buffer.from(bytes);
    const subBlock = Buffer.concat([Buffer.from([data.length]), data, Buffer.from([0x00])]);
    return Buffer.concat([gce, descriptor, minCodeSize, subBlock]);
  };
  return Buffer.concat([header, lsd, colorTable, frame(0), frame(1), Buffer.from([0x3b])]);
}
