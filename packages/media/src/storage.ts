// Media storage adapter boundary (PCMS-MEDIA-T001; Media spec §5/§6/§49).
//
// Physical bytes live behind `MediaStorage`; everything above (domain,
// services, Theme) knows logical keys and digests only. The adapter — never
// the caller — generates object keys: the original filename is human
// metadata, not filesystem authority (Media spec §49), and no user-controlled
// string ever reaches a path (§ filesystem safety). Baseline adapter: local
// filesystem with content-addressed keys; a future S3 adapter implements the
// same interface without touching the Media domain.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MediaError } from "./errors.js";

export interface StoredBlob {
  /** Adapter-generated object key (content-addressed for the local adapter). */
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface MediaStorage {
  /** Persists bytes under an adapter-generated key; dedupes by digest. */
  put(source: Buffer | Readable): Promise<StoredBlob>;
  getStream(key: string): Promise<Readable>;
  /** Bounded read — refuses to buffer more than maxBytes (decompression-bomb guard). */
  getBuffer(key: string, maxBytes: number): Promise<Buffer>;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  /** Best-effort removal of a provably unreachable object; false when absent. */
  delete(key: string): Promise<boolean>;
}

/** Only adapter-generated keys ever hit the filesystem — enforced defensively. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,255}$/;

export function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..")) {
    throw new MediaError("MEDIA_STORAGE_KEY_INVALID", `refusing unsafe storage key "${key}"`);
  }
}

function toReadable(source: Buffer | Readable): Readable {
  return Buffer.isBuffer(source) ? Readable.from(source) : source;
}

export class LocalMediaStorage implements MediaStorage {
  readonly #root: string;
  readonly #tmpDir: string;

  constructor(options: { root: string }) {
    if (!options.root.trim()) {
      throw new MediaError("MEDIA_STORAGE_CONFIG", "local storage root must be a non-empty path");
    }
    this.#root = resolve(options.root);
    this.#tmpDir = join(this.#root, "tmp");
  }

  /** Creates the directory layout; idempotent. */
  async init(): Promise<void> {
    await mkdir(this.#tmpDir, { recursive: true });
  }

  #pathForKey(key: string): string {
    assertSafeKey(key);
    const path = resolve(this.#root, key);
    // Defense in depth: a validated key cannot escape, but resolve-and-check
    // keeps the invariant local to the adapter.
    if (!path.startsWith(`${this.#root}/`)) {
      throw new MediaError("MEDIA_STORAGE_KEY_INVALID", `storage key "${key}" escapes the root`);
    }
    return path;
  }

  async put(source: Buffer | Readable): Promise<StoredBlob> {
    await this.init();
    const tmpPath = join(this.#tmpDir, `${process.pid}-${randomUUID()}`);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const input = toReadable(source);
    input.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.length;
      hash.update(chunk);
    });
    try {
      await pipeline(input, createWriteStream(tmpPath));
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
    const sha256 = hash.digest("hex");
    const key = `blobs/${sha256.slice(0, 2)}/${sha256}`;
    const targetPath = this.#pathForKey(key);
    await mkdir(join(this.#root, "blobs", sha256.slice(0, 2)), { recursive: true });
    try {
      // POSIX rename is atomic; an existing content-addressed object is by
      // definition the same bytes — the duplicate temp file is dropped.
      await rename(tmpPath, targetPath);
    } catch {
      await unlink(tmpPath).catch(() => {});
      const existing = await stat(targetPath).catch(() => null);
      if (existing === null || existing.size !== sizeBytes) {
        throw new MediaError("MEDIA_STORAGE_WRITE_FAILED", `could not persist blob ${sha256}`);
      }
    }
    return { key, sha256, sizeBytes };
  }

  async getStream(key: string): Promise<Readable> {
    const path = this.#pathForKey(key);
    await stat(path).catch(() => {
      throw new MediaError("MEDIA_BLOB_NOT_FOUND", `storage object "${key}" does not exist`);
    });
    return createReadStream(path);
  }

  async getBuffer(key: string, maxBytes: number): Promise<Buffer> {
    const info = await this.stat(key);
    if (info === null) {
      throw new MediaError("MEDIA_BLOB_NOT_FOUND", `storage object "${key}" does not exist`);
    }
    if (info.sizeBytes > maxBytes) {
      throw new MediaError(
        "MEDIA_TOO_LARGE",
        `object "${key}" exceeds the ${maxBytes}-byte read bound`,
      );
    }
    return readFile(this.#pathForKey(key));
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    const path = this.#pathForKey(key);
    const info = await stat(path).catch(() => null);
    return info === null ? null : { sizeBytes: info.size };
  }

  async delete(key: string): Promise<boolean> {
    const path = this.#pathForKey(key);
    const info = await stat(path).catch(() => null);
    if (info === null) return false;
    await unlink(path);
    return true;
  }
}

/** Test-only in-memory adapter; keeps storage-boundary tests OS-independent. */
export class InMemoryMediaStorage implements MediaStorage {
  readonly #objects = new Map<string, StoredBlob & { bytes: Buffer }>();

  async put(source: Buffer | Readable): Promise<StoredBlob> {
    const chunks: Buffer[] = [];
    for await (const chunk of toReadable(source)) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const key = `blobs/${sha256.slice(0, 2)}/${sha256}`;
    const stored = { key, sha256, sizeBytes: bytes.length, bytes };
    this.#objects.set(key, stored);
    const { bytes: _bytes, ...info } = stored;
    return info;
  }

  async getStream(key: string): Promise<Readable> {
    const object = this.#objects.get(key);
    if (object === undefined) {
      throw new MediaError("MEDIA_BLOB_NOT_FOUND", `storage object "${key}" does not exist`);
    }
    return Readable.from(object.bytes);
  }

  async getBuffer(key: string, maxBytes: number): Promise<Buffer> {
    const object = this.#objects.get(key);
    if (object === undefined) {
      throw new MediaError("MEDIA_BLOB_NOT_FOUND", `storage object "${key}" does not exist`);
    }
    if (object.bytes.length > maxBytes) {
      throw new MediaError(
        "MEDIA_TOO_LARGE",
        `object "${key}" exceeds the ${maxBytes}-byte read bound`,
      );
    }
    return object.bytes;
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    const object = this.#objects.get(key);
    return object === undefined ? null : { sizeBytes: object.sizeBytes };
  }

  async delete(key: string): Promise<boolean> {
    return this.#objects.delete(key);
  }
}
