export interface ExtensionPackageAssets {
  readonly runtime: readonly string[];
  readonly build_inputs: readonly string[];
}
export interface LockedExtensionPackage {
  readonly dir: string;
  readonly assets?: Partial<ExtensionPackageAssets>;
}
export function assertPackagePath(path: unknown): void;
export function assertPackageDirectory(path: unknown): void;
export function packageFiles(dir: string): string[];
export function packageContentDigest(dir: string): string;
export function validateExtensionAssets(
  root: string,
  pkg: LockedExtensionPackage,
): ExtensionPackageAssets;
export function stageExtensionAssets(
  root: string,
  stage: string,
  pkg: LockedExtensionPackage,
): ExtensionPackageAssets;

export function validateSupplyArchive(archive: string, strip: number): void;
