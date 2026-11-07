// First-party Shop-Creator credential issuance. The auth service owns the
// bootstrap-principal marker and atomic grant lifecycle; this layer verifies
// the deployed package and target site before delegating.
import { provisionShopCreatorAccess } from "@pcms/auth";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export async function provisionShopCreatorTokenOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { site_key: string; environment: string; rotate?: boolean },
) {
  requirePermission(app, ctx, "extensions.manage");

  const artifact = app.extensions.catalog.get("progressive.shop");
  const installation = await app.extensions.lifecycle.getInstallation("progressive.shop");
  const packageDigest = artifact?.independentPackage?.digest;
  if (
    artifact?.manifest.id !== "progressive.shop" ||
    !artifact.independentPackage ||
    !/^[a-f0-9]{64}$/.test(packageDigest ?? "") ||
    installation?.state !== "ENABLED" ||
    installation.version !== artifact.manifest.version ||
    installation.artifactDigest !== packageDigest ||
    artifact.contentSha256 !== packageDigest
  ) {
    throw new ApiError(
      "SHOP_CREATOR_PACKAGE_NOT_TRUSTED",
      "Shop-Creator access requires the enabled, current trusted independent Shop package",
      { status: 409 },
    );
  }

  if (!(await app.routes.findSiteByKey(input.site_key))) {
    throw new ApiError("SITE_NOT_FOUND", "site_key does not identify an installed site", {
      status: 404,
    });
  }

  return provisionShopCreatorAccess(app.pool, {
    actor: ctx.actor,
    manifest: artifact.manifest,
    packageDigest,
    siteKey: input.site_key,
    environment: input.environment,
    ...(input.rotate === undefined ? {} : { rotate: input.rotate }),
  });
}
