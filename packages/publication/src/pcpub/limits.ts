// .pcpub v1 limits (ADR-0014 §2/§8; Operations spec §70). Sized for a
// multi-entry CMS (not copied from IncusHub): up to the canonical bundle's
// 50 entries plus generous asset/artifact budgets. Deployment config may
// tighten (never loosen beyond the transport byte cap) via config.

export interface PcpubLimits {
  readonly maxCompressedBytes: number;
  readonly maxUncompressedBytes: number;
  readonly maxEntries: number;
  readonly maxDocuments: number;
  readonly maxDocumentBytes: number;
  readonly maxAssets: number;
  readonly maxAssetBytes: number;
  readonly maxTotalAssetBytes: number;
  readonly maxArtifacts: number;
  readonly maxTotalArtifactBytes: number;
  readonly maxManifestBytes: number;
  readonly maxBlocksPerDocument: number;
}

export const DEFAULT_PCPUB_LIMITS: PcpubLimits = {
  maxCompressedBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxEntries: 512,
  maxDocuments: 50,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxAssets: 200,
  maxAssetBytes: 64 * 1024 * 1024,
  maxTotalAssetBytes: 384 * 1024 * 1024,
  maxArtifacts: 128,
  maxTotalArtifactBytes: 32 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxBlocksPerDocument: 200,
};

/** ASCII case-insensitive path-collision check (zip is case-sensitive). */
export function hasCaseCollision(paths: readonly string[]): string | null {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const folded = path.toLowerCase();
    const existing = seen.get(folded);
    if (existing !== undefined && existing !== path) return `${existing} vs ${path}`;
    seen.set(folded, path);
  }
  return null;
}

/** Asset MIME types a .pcpub v1 may carry (Media spec §71.11); SVG follows
 * the existing SVG security policy at ingest. Declared-vs-sniffed mismatch
 * still rejects — this list only bounds what the packer may declare. */
export const PCPUB_ACCEPTED_ASSET_MIME: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
];
