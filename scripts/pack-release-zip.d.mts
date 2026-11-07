export function packReleaseZip(
  outRoot: string,
  releaseId: string,
  artifactPath: string,
  builtAt?: Date,
): Promise<void>;
export function assertReleaseZipPermissions(artifactPath: string): void;
