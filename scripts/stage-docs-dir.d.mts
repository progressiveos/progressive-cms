export interface DocsStagingSummary {
  readonly files: readonly string[];
  readonly bytes: number;
  /** Digest of the copied tree, recorded for traceability only (not a gate). */
  readonly contentHash: string;
}

/**
 * Returns the files to ship from the accepted documentation folder, as paths
 * relative to it. Throws on an unsafe or unsupported entry.
 */
export function collectDocsFiles(sourceDir: string): readonly string[];

/** Copies the accepted documentation folder (byte-for-byte) into `destinationRoot`. */
export function stageDocsDirectory(sourceDir: string, destinationRoot: string): DocsStagingSummary;

export const DOCS_RELEASE_DIR: string;

export function docsRelativePath(sourceDir: string, absolutePath: string): string;
