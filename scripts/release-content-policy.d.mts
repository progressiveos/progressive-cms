export interface ReleasePolicyContext {
  readonly packageNames: ReadonlySet<string>;
  readonly extensionDirs: ReadonlySet<string>;
  readonly themeDirs: ReadonlySet<string>;
  /** CORE-RC19: set when the accepted documentation folder was staged. */
  readonly docsIncluded?: boolean;
  /** Accepted, version-prepared Docs directory; mandatory for the ZIP gate. */
  readonly preparedDocsDir?: string;
}

export function isAllowedReleasePath(path: string, context: ReleasePolicyContext): boolean;
export function checkReleaseZipEntries(
  entries: readonly string[],
  releaseId: string,
  context: ReleasePolicyContext,
): string[];
export function findInternalReleaseReferences(content: string): string[];
export function readReleaseZipEntries(zipPath: string): string[];
export const releaseTestDirectoryNames: ReadonlySet<string>;

export const OFFICIAL_DOCS_SKILL_FILES: readonly string[];
export const PUBLIC_LICENSE_FILES: readonly string[];
