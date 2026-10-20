import type { ReleasePolicyContext } from "./release-content-policy.mjs";
export function readPreparedOfficialSkillFiles(docsDir: string): Map<string, Buffer>;
export function checkReleaseZip(
  zipPath: string,
  releaseId: string,
  context: ReleasePolicyContext,
): string[];
export function assertReleaseZipClean(
  zipPath: string,
  releaseId: string,
  context: ReleasePolicyContext,
): number;
