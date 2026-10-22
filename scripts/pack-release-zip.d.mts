export function packReleaseZip(
  outRoot: string,
  releaseId: string,
  artifactPath: string,
): Promise<void>;
export function assertReleaseZipPermissions(artifactPath: string): void;
