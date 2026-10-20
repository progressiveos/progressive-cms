export interface PrunedReleaseTestPayloads {
  readonly removedDirs: number;
  readonly removedFiles: number;
  readonly removedBytes: number;
}

export function pruneReleaseDependencyTests(releaseRoot: string): PrunedReleaseTestPayloads;
