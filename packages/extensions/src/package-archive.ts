import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yauzl from "yauzl";
import {
  assertExtensionAssetPath,
  type ExtensionPackageTrust,
  type VerifiedExtensionPackage,
  verifyExtensionPackage,
} from "./package-delivery.js";

/** Bounded, exact ZIP inventory; executable bytes are not imported here. */
export function readExtensionPackageArchive(bytes: Buffer): Promise<ReadonlyMap<string, Buffer>> {
  if (bytes.length > 64 * 1024 * 1024)
    return Promise.reject(new Error("extension archive is too large"));
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) {
        reject(new Error("invalid extension ZIP"));
        return;
      }
      const files = new Map<string, Buffer>();
      const names = new Set<string>();
      let total = 0;
      let prefix: string | undefined;
      const fail = (error: Error): void => {
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("entry", (entry: yauzl.Entry) => {
        try {
          const parts = entry.fileName.replace(/\/$/, "").split("/");
          const top = parts.shift();
          if (!top) throw new Error("empty extension ZIP root");
          assertExtensionAssetPath(top);
          prefix ??= top;
          if (
            top !== prefix ||
            names.has(entry.fileName) ||
            names.size >= 4096 ||
            entry.generalPurposeBitFlag & 1
          )
            throw new Error("invalid extension ZIP inventory");
          names.add(entry.fileName);
          const path = parts.join("/");
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (entry.fileName.endsWith("/")) {
            if (path) assertExtensionAssetPath(path);
            if (mode !== 0 && mode !== 0o040000)
              throw new Error("extension ZIP directory is a link");
            zip.readEntry();
            return;
          }
          assertExtensionAssetPath(path);
          if (mode !== 0 && mode !== 0o100000)
            throw new Error("extension ZIP links/special files are forbidden");
          total += entry.uncompressedSize;
          if (total > 64 * 1024 * 1024 || files.has(path))
            throw new Error("extension ZIP exceeds limits or repeats a file");
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
              fail(new Error("unreadable extension ZIP member"));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("error", fail);
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > entry.uncompressedSize) {
                stream.destroy();
                fail(new Error("extension ZIP member exceeds its declared size"));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("end", () => {
              files.set(path, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        } catch (error) {
          fail(error instanceof Error ? error : new Error("invalid extension ZIP"));
        }
      });
      zip.on("end", () => {
        try {
          const descriptor = JSON.parse(
            files.get("extension-package.json")?.toString("utf8") ?? "null",
          ) as { id: string; version: string } | null;
          if (!descriptor || prefix !== `${descriptor.id}-${descriptor.version}`)
            throw new Error("extension ZIP root does not match package identity");
          resolve(files);
        } catch {
          reject(new Error("extension ZIP has no valid package identity"));
        }
      });
      zip.readEntry();
    });
  });
}

/** Untrusted bytes stay in a private stage until signature, policy and every file pass. */
export async function stageIndependentExtensionPackage(input: {
  readonly bytes: Buffer;
  readonly stagingDir: string;
  readonly trust: ExtensionPackageTrust;
  readonly coreVersion: string;
  readonly allowDev?: boolean;
}): Promise<VerifiedExtensionPackage> {
  const files = await readExtensionPackageArchive(input.bytes);
  mkdirSync(input.stagingDir, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(input.stagingDir, ".package-"));
  try {
    for (const [path, bytes] of files) {
      mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o755 });
      writeFileSync(join(directory, path), bytes, { mode: 0o644, flag: "wx" });
    }
    return verifyExtensionPackage({
      directory,
      trust: input.trust,
      coreVersion: input.coreVersion,
      ...(input.allowDev === undefined ? {} : { allowDev: input.allowDev }),
    });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
