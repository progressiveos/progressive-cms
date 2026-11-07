import type { DbPool } from "@pcms/core";
import type { ExtensionCatalog } from "./catalog.js";
import { canonicalPackageJson, extensionFileSha256 } from "./package-delivery.js";

export function independentGenerationDigest(
  packages: readonly { readonly id: string; readonly digest: string }[],
): string {
  return extensionFileSha256(
    canonicalPackageJson([...packages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))),
  );
}

/** The updater checks what both running processes actually verified at boot. */
export async function recordIndependentGeneration(
  pool: DbPool,
  component: "web" | "worker",
  catalog: ExtensionCatalog,
  coreVersion: string,
): Promise<void> {
  const packages = catalog
    .list()
    .flatMap((artifact) =>
      artifact.independentPackage
        ? [{ id: artifact.manifest.id, digest: artifact.independentPackage.digest }]
        : [],
    );
  await pool.query(
    "INSERT INTO pcms_kernel_metadata (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [
      `extension.delivery.loaded:${component}`,
      JSON.stringify({
        digest: independentGenerationDigest(packages),
        core_version: coreVersion,
        loaded_at: new Date().toISOString(),
      }),
    ],
  );
}
