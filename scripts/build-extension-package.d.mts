import type { ExtensionPackageDescriptor } from "@pcms/extensions/internal";
import type { ExtensionPackageAssets } from "./extension-package-assets.mjs";

export function buildExtensionPackage(input: {
  readonly sourceDir: string;
  readonly sourceContentSha256: string;
  readonly sourceCommit: string;
  readonly supplySha256: string;
  readonly channel: "stable" | "beta" | "dev";
  readonly keyId: string;
  readonly signingKeyFile: string;
  readonly assets: ExtensionPackageAssets;
  readonly output: string;
}): Promise<{
  readonly output: string;
  readonly sha256: string;
  readonly packageDigest: string;
  readonly descriptor: ExtensionPackageDescriptor;
}>;
