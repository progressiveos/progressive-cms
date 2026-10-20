// Public media delivery (composition capability): serves the generated
// variant URLs the Media subsystem already hands to themes
// (`/media/a/<asset>/v<version>/<preset>-<key>.<ext>`, Media spec §33/§34),
// the versioned document download grammar
// (`/media/a/<asset>/v<version>/dl/<file>`, Media spec §32/§34) and the
// logical "current" document URL, which resolves the current version with a
// short cache (versioned URLs are immutable → long cache). Original full-res
// image blobs are deliberately not exposed — image pixels reach the public
// only as generated preset variants.

import { Readable } from "node:stream";
import type { ApplicationServices } from "@pcms/api";
import { getAsset, listVariants, variantPublicUrl } from "@pcms/media";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface MediaFilesRouteOptions {
  readonly application: ApplicationServices;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  json: "application/json",
  md: "text/markdown",
  log: "text/plain",
  txt: "text/plain",
  csv: "text/csv",
};

function contentTypeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Content-Disposition value for document downloads (Media spec §34): the
 * filename comes from the URL path (client-controlled), so quotes,
 * backslashes and control/non-latin1 characters are replaced before it enters
 * the quoted-string grammar. `filename*` is deliberately not used — the
 * generated slug is ASCII by construction (Media spec §33).
 */
function contentDispositionOf(filename: string): string {
  const safe = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${safe}"`;
}

/**
 * Single byte range for media streaming (video/audio seek; Safari refuses to
 * play without it). Returns null for an absent header, "invalid" for a
 * malformed/unsatisfiable one (→ 416). Multi-range requests are not
 * supported — served as the full body instead of failing.
 */
function parseByteRange(
  header: unknown,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (typeof header !== "string" || header.trim() === "" || !header.trim().startsWith("bytes=")) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";
  if (rawStart === "") {
    const length = Math.min(Number(rawEnd), size);
    return length === 0 ? "invalid" : { start: size - length, end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "invalid";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  return end < start ? "invalid" : { start, end };
}

/** Emits the [start..end] window of the source stream (storage-agnostic). */
async function* sliceStream(source: Readable, start: number, end: number): AsyncGenerator<Buffer> {
  let position = 0;
  for await (const chunk of source) {
    const buffer = chunk as Buffer;
    const chunkEnd = position + buffer.length - 1;
    if (chunkEnd < start) {
      position = chunkEnd + 1;
      continue;
    }
    const from = Math.max(0, start - position);
    const to = Math.min(buffer.length - 1, end - position);
    yield buffer.subarray(from, to + 1);
    if (chunkEnd >= end) {
      source.destroy();
      return;
    }
    position = chunkEnd + 1;
  }
}

export function registerMediaFilesRoute(
  fastify: FastifyInstance,
  options: MediaFilesRouteOptions,
): void {
  const { application } = options;

  async function sendBlob(
    reply: FastifyReply,
    blobId: string,
    filename: string,
    immutable: boolean,
    rangeHeader: unknown,
  ): Promise<FastifyReply> {
    const storage = application.mediaStorage;
    if (storage === null) return reply.status(404).send();
    const blob = await application.pool.query<{ storage_key: string }>(
      "SELECT storage_key FROM media_blobs WHERE id = $1",
      [blobId],
    );
    const row = blob.rows[0];
    if (row === undefined) return reply.status(404).send();
    // Media spec §33: stream from storage instead of buffering the whole
    // object in the web process — the bounded read stays a domain-side ingest
    // guard, not the delivery path. content-length comes from the storage
    // stat so the response keeps an exact length without a full read.
    const info = await storage.stat(row.storage_key);
    if (info === null) return reply.status(404).send();
    const contentType = contentTypeFor(filename);
    void reply.header("content-type", contentType);
    void reply.header(
      "cache-control",
      immutable ? "public, max-age=31536000, immutable" : "public, max-age=60",
    );
    // Media bytes are never an executable origin; SVG carries active content,
    // so its policy is additionally sandboxed.
    void reply.header(
      "content-security-policy",
      contentType === "image/svg+xml" ? "default-src 'none'; sandbox" : "default-src 'none'",
    );
    const range = parseByteRange(rangeHeader, info.sizeBytes);
    if (range === "invalid") {
      void reply.header("content-range", `bytes */${info.sizeBytes}`);
      return reply.status(416).send();
    }
    const stream = await storage.getStream(row.storage_key);
    if (range === null) {
      void reply.header("accept-ranges", "bytes");
      void reply.header("content-length", String(info.sizeBytes));
      return reply.send(stream);
    }
    void reply.status(206);
    void reply.header("accept-ranges", "bytes");
    void reply.header("content-range", `bytes ${range.start}-${range.end}/${info.sizeBytes}`);
    void reply.header("content-length", String(range.end - range.start + 1));
    return reply.send(Readable.from(sliceStream(stream, range.start, range.end)));
  }

  // find-my-way has no mid-segment params, so the generated URL grammar is
  // parsed here: /media/a/<assetId>/v<version>/<file>,
  // /media/a/<assetId>/v<version>/dl/<file> (document download, Media spec
  // §34) or /media/a/<assetId>/current/<file>.
  fastify.get("/media/a/*", async (request, reply) => {
    const parts = (request.params as { "*": string })["*"].split("/");
    if (parts.length === 4 && parts[2] === "dl") {
      const [assetId, versionSegment, , filename] = parts as [string, string, string, string];
      if (!ASSET_ID_RE.test(assetId) || !/^v\d+$/.test(versionSegment) || filename.length === 0) {
        return reply.status(404).send();
      }
      const asset = await getAsset(application.pool, assetId as never);
      // Same contract as "current": original image blobs stay unexposed —
      // the download grammar exists for documents/generic files only.
      if (asset === null || asset.kind === "image") return reply.status(404).send();
      const versionNo = Number.parseInt(versionSegment.slice(1), 10);
      const version = await application.pool.query<{ blob_id: string }>(
        "SELECT blob_id FROM media_versions WHERE asset_id = $1 AND version_no = $2",
        [assetId, versionNo],
      );
      const row = version.rows[0];
      if (row === undefined) return reply.status(404).send();
      void reply.header("content-disposition", contentDispositionOf(filename));
      return await sendBlob(reply, row.blob_id, filename, true, request.headers.range);
    }
    if (parts.length !== 3) return reply.status(404).send();
    const [assetId, versionSegment, filename] = parts as [string, string, string];
    if (!ASSET_ID_RE.test(assetId) || filename.length === 0) {
      return reply.status(404).send();
    }
    if (versionSegment === "current") {
      const asset = await getAsset(application.pool, assetId as never);
      // Original full-res image blobs are deliberately not exposed (Media
      // spec §33): the public receives images only as generated variants.
      if (asset === null || asset.kind === "image") return reply.status(404).send();
      const version = await application.pool.query<{ blob_id: string }>(
        "SELECT blob_id FROM media_versions WHERE asset_id = $1 AND version_no = $2",
        [asset.id, asset.currentVersionNo],
      );
      const row = version.rows[0];
      if (row === undefined) return reply.status(404).send();
      return await sendBlob(reply, row.blob_id, filename ?? "", false, request.headers.range);
    }
    if (!/^v\d+$/.test(versionSegment ?? "")) return reply.status(404).send();
    const versionNo = Number.parseInt((versionSegment ?? "v0").slice(1), 10);
    const variants = await listVariants(application.pool, assetId, versionNo);
    const match = variants.find((variant) =>
      variantPublicUrl({
        assetId: variant.assetId,
        versionNo: variant.versionNo,
        presetId: variant.presetId,
        variantKey: variant.variantKey,
        format: variant.format,
      }).endsWith(`/${filename}`),
    );
    if (match === undefined) return reply.status(404).send();
    return await sendBlob(reply, match.blobId, filename ?? "", true, request.headers.range);
  });
}
