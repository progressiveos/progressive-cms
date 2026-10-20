// PCMS-MEDIA-T004 — MIME/signature validation: sniffing wins over declared
// MIME and filename; executables/scripts/archives are denied; SVG is
// privileged-only; OOXML documents are distinguished from bare archives.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTypeRegistry,
  DEFAULT_TYPE_REGISTRY,
  filenameExtension,
  MediaError,
  sniffMimeType,
  validateUploadType,
} from "@pcms/media";

// Minimal stored (uncompressed) ZIP with an OOXML content-types entry.
function ooxmlBytes(marker: string): Buffer {
  const contentTypes = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;
  const document = `<?xml version="1.0"?><${marker}/>`;
  const entries: [string, string][] = [
    ["[Content_Types].xml", contentTypes],
    [`${marker}/document.xml`, document],
  ];
  const chunks: Buffer[] = [];
  let offset = 0;
  const central: Buffer[] = [];
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const dataBytes = Buffer.from(data, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // stored
    local.writeUInt32LE(dataBytes.length, 18);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, dataBytes);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += local.length + nameBytes.length + dataBytes.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 0),
]);
const WEBP = Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 "), Buffer.alloc(32)]);
const GIF = Buffer.from("GIF89a" + "\x00".repeat(32));
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32)]);
const TEXT = Buffer.from("ordinary text content\nwith two lines\n");
const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0)]);
const PHP = Buffer.from("<?php system($_GET['c']); ?>\n");
const HTML = Buffer.from("<!DOCTYPE html><html><body>hi</body></html>\n");
const SVG = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
);
const BARE_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
const AVIF = Buffer.concat([
  Buffer.from("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00"),
  Buffer.alloc(32),
]);
const RANDOM = Buffer.from([0x12, 0x00, 0x07, 0xfe, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
const MP4 = Buffer.concat([
  Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2"),
  Buffer.alloc(32),
]);
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]),
  Buffer.from("\x42\x82\x18\x53\x80\x67\x77\x65\x62\x6d"), // EBML DocType "webm"
  Buffer.alloc(16),
]);
const MKV = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]),
  Buffer.from("\x42\x82\x28\x53\x80\x67\x6d\x61\x74\x72\x6f\x73\x6b\x61"), // DocType "matroska"
  Buffer.alloc(16),
]);
const MP3_ID3 = Buffer.concat([
  Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00"),
  Buffer.alloc(32, 0),
]);
const MP3_SYNC = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(32)]);
const UTF16LE = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("text\x00")]);
const M4A = Buffer.concat([
  Buffer.from("\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00M4A mp42isom"),
  Buffer.alloc(32),
]);
const OGG = Buffer.concat([Buffer.from("OggS\x00\x02"), Buffer.alloc(32)]);
const WAV = Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt "), Buffer.alloc(32)]);
const FLAC = Buffer.concat([Buffer.from("fLaC\x00\x00\x00\x22"), Buffer.alloc(32)]);
const JSON_DOC = Buffer.from('{\n  "price": 125000\n}\n');

function expectError(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof MediaError && error.code === code, code);
}

test("sniffer detects signatures from bytes alone", () => {
  assert.equal(sniffMimeType(JPEG).mimeType, "image/jpeg");
  assert.equal(sniffMimeType(PNG).mimeType, "image/png");
  assert.equal(sniffMimeType(WEBP).mimeType, "image/webp");
  assert.equal(sniffMimeType(GIF).mimeType, "image/gif");
  assert.equal(sniffMimeType(AVIF).mimeType, "image/avif");
  assert.equal(sniffMimeType(PDF).mimeType, "application/pdf");
  assert.equal(sniffMimeType(TEXT).mimeType, "text/plain");
  assert.equal(sniffMimeType(SVG).mimeType, "image/svg+xml");
  assert.match(sniffMimeType(ooxmlBytes("word")).mimeType ?? "", /wordprocessingml/);
  assert.equal(sniffMimeType(BARE_ZIP).mimeType, null);
  assert.equal(sniffMimeType(RANDOM).mimeType, null);
  // video/audio signatures (2026-10-01)
  assert.equal(sniffMimeType(MP4).mimeType, "video/mp4");
  assert.equal(sniffMimeType(WEBM).mimeType, "video/webm");
  assert.equal(sniffMimeType(MKV).mimeType, null); // matroska stays unregistered
  assert.equal(sniffMimeType(MP3_ID3).mimeType, "audio/mpeg");
  assert.equal(sniffMimeType(MP3_SYNC).mimeType, "audio/mpeg");
  assert.equal(sniffMimeType(UTF16LE).mimeType, null); // BOM is not an mp3 frame
  assert.equal(sniffMimeType(M4A).mimeType, "audio/mp4");
  assert.equal(sniffMimeType(OGG).mimeType, "audio/ogg");
  assert.equal(sniffMimeType(WAV).mimeType, "audio/wav");
  assert.equal(sniffMimeType(FLAC).mimeType, "audio/flac");
  assert.equal(sniffMimeType(JSON_DOC).mimeType, "application/json");
  assert.equal(sniffMimeType(EXE).dangerous, true);
  assert.equal(sniffMimeType(PHP).dangerous, true);
  assert.equal(sniffMimeType(HTML).dangerous, true);
});

test("declared MIME and extension are cross-checked against the sniff", () => {
  const ok = validateUploadType({
    bytes: JPEG,
    filename: "photo.jpg",
    declaredMimeType: "image/jpeg",
  });
  assert.equal(ok.mimeType, "image/jpeg");
  assert.equal(ok.kind, "image");
  // alias spelling is tolerated
  assert.equal(
    validateUploadType({ bytes: JPEG, filename: "photo.jpeg", declaredMimeType: "image/pjpeg" })
      .mimeType,
    "image/jpeg",
  );
  // spoofed declaration
  expectError(
    () => validateUploadType({ bytes: PNG, filename: "photo.png", declaredMimeType: "image/gif" }),
    "MEDIA_MIME_MISMATCH",
  );
  // spoofed extension
  expectError(
    () => validateUploadType({ bytes: PNG, filename: "photo.jpg" }),
    "MEDIA_MIME_MISMATCH",
  );
  // missing extension is fine
  assert.equal(validateUploadType({ bytes: PDF, filename: "price" }).mimeType, "application/pdf");
  // junk extension is a mismatch, never a path authority
  expectError(
    () => validateUploadType({ bytes: PDF, filename: "price.pdf. .php" }),
    "MEDIA_MIME_MISMATCH",
  );
});

test("executables, scripts, HTML and archives are never allowed", () => {
  expectError(
    () => validateUploadType({ bytes: EXE, filename: "tool.exe" }),
    "MEDIA_TYPE_NOT_ALLOWED",
  );
  expectError(
    () => validateUploadType({ bytes: PHP, filename: "shell.php" }),
    "MEDIA_TYPE_NOT_ALLOWED",
  );
  expectError(
    () => validateUploadType({ bytes: HTML, filename: "page.html" }),
    "MEDIA_TYPE_NOT_ALLOWED",
  );
  expectError(
    () => validateUploadType({ bytes: RANDOM, filename: "blob.bin" }),
    "MEDIA_TYPE_NOT_ALLOWED",
  );
  expectError(
    () => validateUploadType({ bytes: BARE_ZIP, filename: "bundle.zip" }),
    "MEDIA_TYPE_NOT_ALLOWED",
  );
});

test("OOXML documents pass; SVG requires the privileged path", () => {
  const docx = validateUploadType({ bytes: ooxmlBytes("word"), filename: "brief.docx" });
  assert.match(docx.mimeType, /wordprocessingml/);
  assert.equal(docx.kind, "document");
  assert.match(
    validateUploadType({ bytes: ooxmlBytes("xl"), filename: "t.xlsx" }).mimeType,
    /spreadsheetml/,
  );
  assert.match(
    validateUploadType({ bytes: ooxmlBytes("ppt"), filename: "t.pptx" }).mimeType,
    /presentationml/,
  );
  expectError(
    () => validateUploadType({ bytes: SVG, filename: "logo.svg" }),
    "MEDIA_SVG_NOT_ALLOWED",
  );
  const privileged = validateUploadType({ bytes: SVG, filename: "logo.svg", privileged: true });
  assert.equal(privileged.mimeType, "image/svg+xml");
  assert.equal(privileged.privilegedRequired, true);
});

test("native video/audio uploads validate and keep their kind", () => {
  assert.equal(validateUploadType({ bytes: MP4, filename: "clip.mp4" }).kind, "video");
  assert.equal(validateUploadType({ bytes: WEBM, filename: "clip.webm" }).kind, "video");
  assert.equal(validateUploadType({ bytes: MP3_ID3, filename: "episode.mp3" }).kind, "audio");
  assert.equal(validateUploadType({ bytes: OGG, filename: "episode.ogg" }).kind, "audio");
  assert.equal(validateUploadType({ bytes: WAV, filename: "tone.wav" }).kind, "audio");
  // spoofed extension on a video is still a mismatch
  expectError(
    () => validateUploadType({ bytes: MP4, filename: "clip.mp4.exe" }),
    "MEDIA_MIME_MISMATCH",
  );
  expectError(
    () => validateUploadType({ bytes: MKV, filename: "movie.mkv" }),
    "MEDIA_TYPE_NOT_ALLOWED",
  );
});

test("instance disabledTypes narrow the registry (sniff-safe)", () => {
  // baseline minus mp4: the sniff still identifies the content, the
  // registry refuses it — narrowing can never enable a dangerous type.
  // (The registry param is the full map — ingest narrows the same way.)
  const registry = new Map(
    DEFAULT_TYPE_REGISTRY.filter((entry) => entry.mimeType !== "video/mp4").map((entry) => [
      entry.mimeType,
      entry,
    ]),
  );
  expectError(
    () => validateUploadType({ bytes: MP4, filename: "clip.mp4", registry }),
    "MEDIA_TYPE_NOT_ALLOWED",
  );
  assert.equal(validateUploadType({ bytes: WEBM, filename: "clip.webm", registry }).kind, "video");
});

test("registry is closed and extension-based for CSV; extension helper is safe", () => {
  const registry = createTypeRegistry();
  assert.equal(registry.size, DEFAULT_SIZE);
  expectError(
    () => createTypeRegistry([{ mimeType: "image/png", kind: "image", extensions: ["png"] }]),
    "MEDIA_TYPE_REGISTRY_CONFLICT",
  );
  assert.equal(
    validateUploadType({ bytes: TEXT, filename: "data.csv", declaredMimeType: "text/csv" })
      .mimeType,
    "text/csv",
  );
  assert.equal(validateUploadType({ bytes: TEXT, filename: "notes.txt" }).kind, "document");
  assert.equal(filenameExtension("report.PDF"), "pdf");
  assert.equal(filenameExtension("no-extension"), null);
  assert.equal(filenameExtension("../../etc/passwd"), null);
  assert.equal(filenameExtension("weird file!"), null);
});

const DEFAULT_SIZE = createTypeRegistry().size;
