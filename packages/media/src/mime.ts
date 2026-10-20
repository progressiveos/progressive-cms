// Allowed type registry + content-signature sniffing
// (PCMS-MEDIA-T004; Media spec §27/§28/§29/§30).
//
// Upload type is decided by three independent signals — declared MIME
// (untrusted), filename extension (untrusted) and the content signature —
// and rejected on any dangerous mismatch. The registry is closed by
// default: executables, scripts, HTML and archives have no entry and are
// therefore never allowed (§29/§30).
import { MediaError } from "./errors.js";
import type { MediaKind } from "./model.js";

export interface TypeDescriptor {
  /** Canonical MIME type stored on the asset. */
  readonly mimeType: string;
  readonly kind: MediaKind;
  readonly extensions: readonly string[];
  /** True for active-content types (SVG) — privileged path only (§24). */
  readonly privileged?: boolean;
}

/** v1 baseline registry (Media spec §4/§27). */
export const DEFAULT_TYPE_REGISTRY: readonly TypeDescriptor[] = [
  { mimeType: "image/jpeg", kind: "image", extensions: ["jpg", "jpeg"] },
  { mimeType: "image/png", kind: "image", extensions: ["png"] },
  { mimeType: "image/webp", kind: "image", extensions: ["webp"] },
  { mimeType: "image/avif", kind: "image", extensions: ["avif"] },
  { mimeType: "image/gif", kind: "image", extensions: ["gif"] },
  { mimeType: "image/svg+xml", kind: "image", extensions: ["svg"], privileged: true },
  { mimeType: "video/mp4", kind: "video", extensions: ["mp4", "m4v"] },
  { mimeType: "video/webm", kind: "video", extensions: ["webm"] },
  { mimeType: "audio/mpeg", kind: "audio", extensions: ["mp3"] },
  { mimeType: "audio/mp4", kind: "audio", extensions: ["m4a"] },
  { mimeType: "audio/ogg", kind: "audio", extensions: ["ogg", "oga", "opus"] },
  { mimeType: "audio/wav", kind: "audio", extensions: ["wav"] },
  { mimeType: "audio/flac", kind: "audio", extensions: ["flac"] },
  { mimeType: "application/pdf", kind: "document", extensions: ["pdf"] },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "document",
    extensions: ["docx"],
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "document",
    extensions: ["xlsx"],
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    kind: "document",
    extensions: ["pptx"],
  },
  { mimeType: "application/json", kind: "document", extensions: ["json"] },
  { mimeType: "text/plain", kind: "document", extensions: ["txt", "md", "log"] },
  { mimeType: "text/csv", kind: "document", extensions: ["csv"] },
];

export type TypeRegistry = ReadonlyMap<string, TypeDescriptor>;

export function createTypeRegistry(additional?: readonly TypeDescriptor[]): TypeRegistry {
  const map = new Map<string, TypeDescriptor>();
  const add = (descriptor: TypeDescriptor): void => {
    if (map.has(descriptor.mimeType)) {
      throw new MediaError(
        "MEDIA_TYPE_REGISTRY_CONFLICT",
        `duplicate registry entry for ${descriptor.mimeType}`,
      );
    }
    map.set(descriptor.mimeType, descriptor);
  };
  for (const descriptor of DEFAULT_TYPE_REGISTRY) add(descriptor);
  for (const descriptor of additional ?? []) add(descriptor);
  return map;
}

export interface SniffResult {
  /** Canonical MIME detected from bytes; null when the format is unknown. */
  readonly mimeType: string | null;
  /** Executable/script/active-content signature — always denied (§29). */
  readonly dangerous: boolean;
}

const DANGEROUS_PREFIXES: readonly number[][] = [
  [0x4d, 0x5a], // PE / .exe
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat
  [0xfe, 0xed, 0xfa], // Mach-O 32/64
  [0xce, 0xfa, 0xed],
];

function hasPrefix(bytes: Buffer, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function looksTextual(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) controls += 1;
  }
  return controls / Math.max(sample.length, 1) < 0.01;
}

const ACTIVE_CONTENT_MARKERS = ["<html", "<!doctype html", "<script", "<?php", "<%"];

/**
 * Content-signature sniffing over the leading bytes (Media spec §28).
 * Never trusts the declared MIME or the filename.
 */
export function sniffMimeType(bytes: Buffer): SniffResult {
  for (const prefix of DANGEROUS_PREFIXES) {
    if (hasPrefix(bytes, prefix)) return { mimeType: null, dangerous: true };
  }
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", dangerous: false };
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", dangerous: false };
  }
  if (hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) {
    return { mimeType: "image/gif", dangerous: false };
  }
  if (hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return { mimeType: "image/gif", dangerous: false };
  }
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mimeType: "image/webp", dangerous: false };
  }
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes, [0x57, 0x41, 0x56, 0x45], 8)) {
    return { mimeType: "audio/wav", dangerous: false };
  }
  if (hasPrefix(bytes, [0x66, 0x4c, 0x61, 0x43]))
    return { mimeType: "audio/flac", dangerous: false };
  if (hasPrefix(bytes, [0x4f, 0x67, 0x67, 0x53]))
    return { mimeType: "audio/ogg", dangerous: false };
  // MP3: ID3v2 tag or a raw MPEG audio frame sync. FF FE / FF FF are excluded
  // — those are UTF-16 byte-order marks, not frames.
  if (hasPrefix(bytes, [0x49, 0x44, 0x33])) return { mimeType: "audio/mpeg", dangerous: false };
  const second = bytes[1];
  if (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    second !== undefined &&
    (second & 0xe0) === 0xe0 &&
    second !== 0xfe &&
    second !== 0xff
  ) {
    return { mimeType: "audio/mpeg", dangerous: false };
  }
  // EBML: WebM is allowed; generic Matroska (.mkv) stays unregistered.
  if (hasPrefix(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = bytes.subarray(0, 64).toString("latin1");
    return head.includes("webm")
      ? { mimeType: "video/webm", dangerous: false }
      : { mimeType: null, dangerous: false };
  }
  // ISO-BMFF: "ftyp" box brands — AVIF images, MP4 video, M4A audio.
  if (hasPrefix(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis" || brand === "av01") {
      return { mimeType: "image/avif", dangerous: false };
    }
    if (brand === "M4A ") return { mimeType: "audio/mp4", dangerous: false };
    if (
      ["isom", "iso2", "mp41", "mp42", "m4v ", "dash", "msdh", "msix", "avc1", "M4V "].includes(
        brand,
      )
    ) {
      return { mimeType: "video/mp4", dangerous: false };
    }
    return { mimeType: null, dangerous: false };
  }
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { mimeType: "application/pdf", dangerous: false };
  }
  if (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    // OOXML only: a bare ZIP is an archive and archives are disabled (§30).
    const head = bytes.subarray(0, Math.min(bytes.length, 65536)).toString("latin1");
    if (head.includes("[Content_Types].xml")) {
      if (head.includes("word/")) {
        return {
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          dangerous: false,
        };
      }
      if (head.includes("xl/")) {
        return {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          dangerous: false,
        };
      }
      if (head.includes("ppt/")) {
        return {
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          dangerous: false,
        };
      }
    }
    return { mimeType: null, dangerous: false };
  }
  if (looksTextual(bytes)) {
    const head = bytes.subarray(0, 8192).toString("utf8").toLowerCase();
    if (head.startsWith("#!")) {
      // shebang → script, never an uploadable media type (§29)
      return { mimeType: null, dangerous: true };
    }
    if (head.includes("<svg") || head.includes("<?xml")) {
      return { mimeType: "image/svg+xml", dangerous: false };
    }
    if (ACTIVE_CONTENT_MARKERS.some((marker) => head.includes(marker))) {
      return { mimeType: null, dangerous: true };
    }
    if (/^[[{]/.test(head.trimStart())) {
      return { mimeType: "application/json", dangerous: false };
    }
    return { mimeType: "text/plain", dangerous: false };
  }
  return { mimeType: null, dangerous: false };
}

export function filenameExtension(filename: string): string | null {
  const base = filename.replaceAll("\\", "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[\w-]{1,16}$/.test(ext) ? ext : null;
}

/** Normalizes alias MIME spellings (image/jpg → image/jpeg) for comparison. */
function canonicalDeclared(mime: string): string {
  const value = mime.trim().toLowerCase();
  if (value === "image/jpg" || value === "image/pjpeg") return "image/jpeg";
  if (value === "text/xml" || value === "application/svg+xml") return "image/svg+xml";
  return value;
}

export interface TypeValidationInput {
  readonly bytes: Buffer;
  readonly filename: string;
  /** Declared MIME from the transport; optional and untrusted. */
  readonly declaredMimeType?: string;
  /** Privileged upload path (SVG policy, Media spec §24). */
  readonly privileged?: boolean;
  readonly registry?: TypeRegistry;
}

export interface TypeValidationResult {
  readonly mimeType: string;
  readonly kind: MediaKind;
  readonly extension: string | null;
  readonly privilegedRequired: boolean;
}

/**
 * Decides the canonical type of an upload from the content signature and
 * cross-checks the untrusted signals. Throws stable MediaError codes:
 * MEDIA_TYPE_NOT_ALLOWED, MEDIA_MIME_MISMATCH, MEDIA_SVG_NOT_ALLOWED.
 */
export function validateUploadType(input: TypeValidationInput): TypeValidationResult {
  const registry = input.registry ?? createTypeRegistry();
  const sniffed = sniffMimeType(input.bytes);
  if (sniffed.dangerous) {
    throw new MediaError(
      "MEDIA_TYPE_NOT_ALLOWED",
      "content signature indicates an executable, script or active-content format",
    );
  }
  if (sniffed.mimeType === null) {
    throw new MediaError(
      "MEDIA_TYPE_NOT_ALLOWED",
      "content signature does not match any allowed media type",
    );
  }
  // CSV rides on the text sniff via its extension/declaration.
  const ext = filenameExtension(input.filename);
  const mimeType =
    sniffed.mimeType === "text/plain" && (ext === "csv" || input.declaredMimeType === "text/csv")
      ? "text/csv"
      : sniffed.mimeType;
  const descriptor = registry.get(mimeType);
  if (descriptor === undefined) {
    throw new MediaError("MEDIA_TYPE_NOT_ALLOWED", `type "${mimeType}" is not allowed`);
  }
  if (descriptor.privileged === true && input.privileged !== true) {
    throw new MediaError(
      "MEDIA_SVG_NOT_ALLOWED",
      "SVG uploads are privileged operations and require the trusted path",
    );
  }
  if (
    input.declaredMimeType !== undefined &&
    canonicalDeclared(input.declaredMimeType) !== descriptor.mimeType
  ) {
    throw new MediaError(
      "MEDIA_MIME_MISMATCH",
      `declared MIME "${input.declaredMimeType}" does not match the detected content type "${descriptor.mimeType}"`,
    );
  }
  if (ext !== null && !descriptor.extensions.includes(ext)) {
    throw new MediaError(
      "MEDIA_MIME_MISMATCH",
      `filename extension "${ext}" does not match the detected content type "${descriptor.mimeType}"`,
    );
  }
  return {
    mimeType: descriptor.mimeType,
    kind: descriptor.kind,
    extension: ext,
    privilegedRequired: descriptor.privileged === true,
  };
}
