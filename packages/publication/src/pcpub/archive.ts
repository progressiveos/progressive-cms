// .pcpub physical container (ADR-0014 §2/§7/§18): ZIP, hardened.
//
// Reader: yauzl (strict central-directory parsing, per-entry size validation,
// CRC checks). On top of it we fail closed on: directory entries, encrypted
// entries, non Store/Deflate methods, unsafe paths, duplicates, ASCII
// case-collisions, per-entry size bounds, and (via assertExactSet)
// undeclared/missing entries. Entries are read as BYTES ONLY — they are
// never extracted to the filesystem, so archive-level symlink/device
// semantics have no target here; media content security happens in the
// canonical ingest pipeline.
//
// Writer: yazl with fixed mtime + mode 0644 + sorted entry order +
// fixed-serialization manifest ⇒ byte-stable packs for identical inputs.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import yauzl from "yauzl";
import yazl from "yazl";
import { PcpubError } from "./diagnostics.js";
import { hasCaseCollision, type PcpubLimits } from "./limits.js";
import { artifactKindOf, assertValidEntryPath, isAllowedEntryPath } from "./paths.js";

export interface PcpubArchiveEntry {
  readonly path: string;
  readonly size: number;
}

export interface OpenedPcpubArchive {
  readonly entries: readonly PcpubArchiveEntry[];
  readBytes(path: string): Promise<Buffer>;
  assertExactSet(declared: ReadonlySet<string>): void;
  close(): Promise<void>;
}

function archiveFail(
  code: ConstructorParameters<typeof PcpubError>[0],
  message: string,
  path?: string,
): never {
  throw new PcpubError(code, message, path === undefined ? {} : { path });
}

function openYauzl(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (error, result) => {
      if (error || result === undefined) reject(error ?? new Error("yauzl open failed"));
      else resolve(result);
    });
  });
}

function nextEntry(zipfile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    // yauzl signals the end of the central directory with `end`, not a null entry.
    const onEntry = (entry: yauzl.Entry): void => {
      cleanup();
      resolve(entry);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      zipfile.removeListener("entry", onEntry);
      zipfile.removeListener("end", onEnd);
      zipfile.removeListener("error", onError);
    };
    zipfile.once("entry", onEntry);
    zipfile.once("end", onEnd);
    zipfile.once("error", onError);
    zipfile.readEntry();
  });
}

function openStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || stream === undefined) reject(error ?? new Error("openReadStream failed"));
      else resolve(stream);
    });
  });
}

/** Opens + validates archive structure (including the total/per-category
 * size budgets, F-13); the caller parses the manifest and asserts the exact
 * set against its declared paths. The budgets mirror pack.ts pack-time
 * limits over the actual central directory, so server-side verification
 * (verifyPcpub) enforces them even for hand-crafted bundles. */
export async function openPcpubArchive(
  zipPath: string,
  limits: PcpubLimits,
): Promise<OpenedPcpubArchive> {
  const { stat } = await import("node:fs/promises");
  const stats = await stat(zipPath).catch(() => null);
  if (stats === null) archiveFail("PCPUB_ARCHIVE_UNREADABLE", "bundle file does not exist");
  if (stats.size > limits.maxCompressedBytes) {
    archiveFail("PCPUB_ARCHIVE_TOO_LARGE", "bundle exceeds the compressed size limit");
  }
  const zipfile = await openYauzl(zipPath).catch((cause: unknown) => {
    throw new PcpubError("PCPUB_ARCHIVE_UNREADABLE", "bundle is not a readable ZIP archive", {
      cause,
    });
  });

  const original = new Map<string, yauzl.Entry>();
  const entries: PcpubArchiveEntry[] = [];
  // F-13 total-budget accounting (ADR-0014 §2/§8): sums of the declared
  // uncompressed entry sizes, checked against the same limits pack.ts
  // applies at pack time. readBytes() fails any entry whose actual bytes
  // exceed its declared size, so these sums bound real decompression too.
  let totalUncompressed = 0;
  let totalAssetBytes = 0;
  let totalArtifactBytes = 0;
  try {
    for (;;) {
      const entry = await nextEntry(zipfile);
      if (entry === null) break;
      original.set(entry.fileName, entry);
      if (original.size > limits.maxEntries) {
        archiveFail("PCPUB_ARCHIVE_TOO_LARGE", `more than ${limits.maxEntries} entries`);
      }
      const path = entry.fileName;
      if (path.endsWith("/")) {
        archiveFail("PCPUB_ARCHIVE_NONREGULAR_ENTRY", "directory entries are not allowed", path);
      }
      assertValidEntryPath(path);
      if (!isAllowedEntryPath(path)) {
        archiveFail(
          "PCPUB_ARCHIVE_UNDECLARED_ENTRY",
          `path "${path}" is outside the bundle allowlist`,
          path,
        );
      }
      if (entries.some((existing) => existing.path === path)) {
        archiveFail("PCPUB_ARCHIVE_DUPLICATE_PATH", `duplicate archive entry "${path}"`, path);
      }
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        archiveFail("PCPUB_ARCHIVE_ENCRYPTED_ENTRY", "encrypted entries are not allowed", path);
      }
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        archiveFail(
          "PCPUB_ARCHIVE_UNSUPPORTED_COMPRESSION",
          "only Store/Deflate are allowed",
          path,
        );
      }
      if (entry.uncompressedSize < 0 || entry.uncompressedSize > limits.maxAssetBytes) {
        archiveFail(
          "PCPUB_ARCHIVE_ENTRY_TOO_LARGE",
          "entry exceeds the per-entry size limit",
          path,
        );
      }
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > limits.maxUncompressedBytes) {
        archiveFail("PCPUB_ARCHIVE_TOO_LARGE", "bundle exceeds the uncompressed size limit");
      }
      // Category budgets follow the manifest's path classes (manifest.ts):
      // content/*.pcmd documents, assets/ payloads, research|review/notes
      // artifacts; manifest.json itself is bounded by maxManifestBytes at
      // parse time.
      if (path.startsWith("content/") && path.endsWith(".pcmd")) {
        if (entry.uncompressedSize > limits.maxDocumentBytes) {
          archiveFail(
            "PCPUB_ARCHIVE_ENTRY_TOO_LARGE",
            "document exceeds the per-document size limit",
            path,
          );
        }
      } else if (path.startsWith("assets/")) {
        totalAssetBytes += entry.uncompressedSize;
        if (totalAssetBytes > limits.maxTotalAssetBytes) {
          archiveFail("PCPUB_ARCHIVE_TOO_LARGE", "total asset size exceeds the limit", path);
        }
      } else if (artifactKindOf(path) !== null) {
        totalArtifactBytes += entry.uncompressedSize;
        if (totalArtifactBytes > limits.maxTotalArtifactBytes) {
          archiveFail("PCPUB_ARCHIVE_TOO_LARGE", "total artifact size exceeds the limit", path);
        }
      }
      entries.push({ path, size: entry.uncompressedSize });
    }
    const collision = hasCaseCollision(entries.map((entry) => entry.path));
    if (collision !== null) {
      archiveFail("PCPUB_ARCHIVE_UNSAFE_PATH", `case-insensitive path collision: ${collision}`);
    }
  } catch (cause) {
    zipfile.close();
    throw cause;
  }

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return {
    entries,
    async readBytes(path: string): Promise<Buffer> {
      const entry = byPath.get(path);
      if (entry === undefined) {
        archiveFail("PCPUB_ARCHIVE_MISSING_ENTRY", `entry "${path}" is not in the archive`, path);
      }
      const declared = entry.size;
      const stream = await openStream(zipfile, original.get(path)!);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += bytes.length;
        if (total > declared) {
          archiveFail("PCPUB_ARCHIVE_ENTRY_TOO_LARGE", "entry grew beyond its declared size", path);
        }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    },
    assertExactSet: (declared) => {
      for (const path of byPath.keys()) {
        if (!declared.has(path)) {
          archiveFail("PCPUB_ARCHIVE_UNDECLARED_ENTRY", `undeclared archive entry "${path}"`, path);
        }
      }
      for (const path of declared) {
        if (!byPath.has(path)) {
          archiveFail(
            "PCPUB_ARCHIVE_MISSING_ENTRY",
            `manifest declares missing entry "${path}"`,
            path,
          );
        }
      }
    },
    close: () => {
      zipfile.close();
      return Promise.resolve();
    },
  };
}

/** SHA-256 helper shared by packer and ingest. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const ARCHIVE_FIXED_TIME = new Date(Date.UTC(2026, 0, 1));

/** Writes a deterministic archive: sorted order, fixed mtime, mode 0644. */
export async function writePcpubArchive(
  outputPath: string,
  entries: readonly { readonly path: string; readonly data: Buffer }[],
): Promise<void> {
  const zipfile = new yazl.ZipFile();
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    zipfile.addBuffer(entry.data, entry.path, {
      mtime: ARCHIVE_FIXED_TIME,
      mode: 0o644,
      compress: true,
    });
  }
  zipfile.end();
  const chunks: Buffer[] = [];
  const collected = new Promise<void>((resolve, reject) => {
    zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zipfile.outputStream.on("end", resolve);
    zipfile.outputStream.on("error", reject);
  });
  await collected;
  await writeFile(outputPath, Buffer.concat(chunks));
}
