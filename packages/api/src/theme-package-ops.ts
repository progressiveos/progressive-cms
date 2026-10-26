// Remote theme package cycle — shared application operations.
//
// REST, MCP and CLI all run THESE functions; none of them implements file
// replacement on its own (API/MCP/CLI spec §0). The cycle is: export the
// served source → edit locally → upload a package → validate it → apply it
// with a lifecycle CAS.

import { join } from "node:path";
import { assertTokenConstraints } from "@pcms/auth";
import {
  installThemePackage,
  listInstalledThemes,
  stageThemePackage,
  ThemeInstallError,
} from "@pcms/themes";
import {
  type ApplicationServices,
  extendThemeBlockVariants,
  type OperationContext,
  readCmsVersionFromRelease,
  requirePermission,
} from "./context.js";
import { ApiError } from "./errors.js";
import { changeTheme } from "./theme-lifecycle.js";
import {
  readStagedThemePackage,
  stageThemePackageUpload,
  themesRootOf,
} from "./theme-package-store.js";
import { describeThemeSource, resolveServedThemeSource } from "./theme-source.js";

function packageInput(input: { readonly package_ref: string }): { readonly package_ref: string } {
  if (typeof input.package_ref !== "string" || input.package_ref.length === 0) {
    throw new ApiError("API_REQUEST_INVALID", "package_ref is required", { status: 400 });
  }
  return { package_ref: input.package_ref };
}

function requireThemesRoot(app: ApplicationServices): string {
  const root = themesRootOf(app.themeRuntime.configuredDir ?? app.themeDir);
  if (root === null) {
    throw new ApiError("API_NOT_FOUND", "no theme source is configured (themes.renderDir)", {
      status: 404,
    });
  }
  return root;
}

function mapInstallError(error: unknown): never {
  if (error instanceof ThemeInstallError) {
    throw new ApiError(error.code, error.message, {
      status: error.code === "THEME_NOT_INSTALLED" ? 404 : 409,
    });
  }
  throw error as Error;
}

function bindActor(app: ApplicationServices, ctx: OperationContext): void {
  assertTokenConstraints(ctx.actor, {
    siteKey: app.defaultSiteKey,
    environment: ctx.actor.environment,
  });
}

/** Descriptor of the served theme's package (no bytes — the MCP-safe half). */
export async function getThemeSourceOp(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "theme.read");
  bindActor(app, ctx);
  const { descriptor } = await describeThemeSource(resolveServedThemeSource(app));
  return descriptor;
}

/** Bytes of the served theme's package, pinned to the caller's generation. */
export async function downloadThemeSourceOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly expected_generation: number },
): Promise<{ bytes: Buffer; filename: string; sha256: string; size_bytes: number }> {
  requirePermission(app, ctx, "theme.read");
  bindActor(app, ctx);
  const source = resolveServedThemeSource(app);
  // A stale basis must fail, never hand back an archive of a different theme
  // under the digest the caller already has.
  if (source.themeGeneration !== input.expected_generation) {
    throw new ApiError(
      "THEME_REVISION_STALE",
      `theme generation is ${source.themeGeneration}, not ${input.expected_generation}; read /themes/source again`,
      { status: 409 },
    );
  }
  const { descriptor, bytes } = await describeThemeSource(source);
  return {
    bytes,
    filename: `${descriptor.theme_id}-${descriptor.served_version}.pcTheme`,
    sha256: descriptor.package_sha256,
    size_bytes: descriptor.size_bytes,
  };
}

/** Stages an uploaded package; returns the opaque reference (not a capability). */
export async function uploadThemePackageOp(
  app: ApplicationServices,
  ctx: OperationContext,
  bytes: Buffer,
) {
  requirePermission(app, ctx, "theme.write");
  bindActor(app, ctx);
  if (bytes.length === 0) {
    throw new ApiError("API_REQUEST_INVALID", "the package body is empty", { status: 400 });
  }
  return await stageThemePackageUpload({
    themesRoot: requireThemesRoot(app),
    bytes,
    ctx,
    siteKey: app.defaultSiteKey,
  });
}

/**
 * Validates a staged package WITHOUT touching the site: no apply closure, no
 * confirmed revision, no catalog or settings write. The candidate render stack
 * is built when the process exposes that port (proves Liquid/tokens actually
 * compile), then discarded.
 */
export async function validateThemePackageOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly package_ref: string },
) {
  requirePermission(app, ctx, "theme.validate");
  bindActor(app, ctx);
  const staged = await readStagedThemePackage({
    themesRoot: requireThemesRoot(app),
    ref: packageInput(input).package_ref,
    ctx,
    siteKey: app.defaultSiteKey,
  });
  const cmsVersion = readCmsVersionFromRelease();
  const stage = await stageThemePackage(staged.bytes, cmsVersion);
  try {
    let render: "ok" | "unavailable" = "unavailable";
    if (app.themeRuntime.prepareUpdate !== null) {
      // Building the candidate stack validates Liquid/tokens; the returned
      // closure is deliberately discarded — nothing is activated here.
      await app.themeRuntime.prepareUpdate(stage.dir);
      render = "ok";
    }
    return {
      ok: true,
      package_ref: staged.package_ref,
      package_sha256: staged.sha256,
      size_bytes: staged.size_bytes,
      expires_at: staged.expires_at,
      theme: {
        id: stage.info.id,
        name: stage.info.name,
        version: stage.info.version,
      },
      render_stack: render,
      active_theme_unchanged: true,
    };
  } catch (error) {
    mapInstallError(error);
  } finally {
    stage.cleanup();
  }
}

/** Installs a staged package as a catalog candidate; never activates it. */
export async function installThemePackageOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly package_ref: string },
) {
  requirePermission(app, ctx, "theme.write");
  bindActor(app, ctx);
  const root = requireThemesRoot(app);
  const staged = await readStagedThemePackage({
    themesRoot: root,
    ref: packageInput(input).package_ref,
    ctx,
    siteKey: app.defaultSiteKey,
  });
  const renderDirId = app.themeDiscovery?.getThemeId() ?? "";
  try {
    const info = await installThemePackage(staged.bytes, {
      themesRoot: root,
      renderDirThemeId: renderDirId,
      cmsVersion: readCmsVersionFromRelease(),
      source: `package_ref:${staged.package_ref}`,
    });
    try {
      extendThemeBlockVariants(app.blocks, join(root, info.id));
    } catch {
      // Variant admission is best-effort here; activation re-extends.
    }
    return {
      id: info.id,
      version: info.version,
      sha256: info.sha256,
      package_ref: staged.package_ref,
      activated: false,
    };
  } catch (error) {
    mapInstallError(error);
  }
}

/**
 * Replaces the active theme with a staged package, under a lifecycle CAS.
 * Version/id guards, settings resolution, journal, recovery and the live
 * switch stay exactly those of the normal update path.
 */
export async function updateActiveThemeOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly package_ref: string; readonly expected_generation: number },
) {
  requirePermission(app, ctx, "theme.write");
  requirePermission(app, ctx, "theme.activate");
  bindActor(app, ctx);
  if (app.themeDir === undefined || app.themeRuntime.prepareUpdate === null) {
    throw new ApiError("THEME_RUNTIME_UNAVAILABLE", "public theme renderer is not registered", {
      status: 409,
    });
  }
  if (!Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0) {
    throw new ApiError(
      "API_REQUEST_INVALID",
      "expected_generation must be a nonnegative safe integer",
      { status: 400 },
    );
  }
  const staged = await readStagedThemePackage({
    themesRoot: requireThemesRoot(app),
    ref: packageInput(input).package_ref,
    ctx,
    siteKey: app.defaultSiteKey,
  });
  try {
    const result = await changeTheme(app, ctx, {
      kind: "UPDATE",
      packageBytes: staged.bytes,
      expectedGeneration: input.expected_generation,
    });
    const info = result.info!;
    try {
      extendThemeBlockVariants(app.blocks, app.themeDir);
    } catch {
      // Variant admission is best-effort; the render itself already switched.
    }
    return {
      ok: true,
      package_ref: staged.package_ref,
      package_sha256: staged.sha256,
      theme: info,
      served: app.themeRuntime.served?.(),
    };
  } catch (error) {
    mapInstallError(error);
  }
}

/** Served theme identity + generations (the MCP/REST "what am I editing" read). */
export async function getActiveThemeOp(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "theme.read");
  bindActor(app, ctx);
  if (app.themeRuntime.served === null) {
    throw new ApiError("THEME_RUNTIME_UNAVAILABLE", "public theme renderer is not registered", {
      status: 409,
    });
  }
  const served = app.themeRuntime.served();
  return {
    ...served,
    installed_head_version: resolveServedThemeSource(app).installedHeadVersion,
  };
}

/** Installed catalog candidates (same view as GET /themes/installed). */
export async function listInstalledThemesOp(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "theme.read");
  bindActor(app, ctx);
  const root = requireThemesRoot(app);
  const renderDirId = app.themeDiscovery?.getThemeId() ?? "";
  const active = await app.pool
    .query<{ theme_key: string | null }>(
      "SELECT theme_key FROM admin_theme_state WHERE site_key = $1",
      [app.defaultSiteKey],
    )
    .then((result) => result.rows[0]?.theme_key ?? null)
    .catch(() => null);
  return {
    themes: listInstalledThemes(root, renderDirId).map((theme) => ({
      id: theme.id,
      name: theme.name,
      version: theme.version,
      is_render_target: theme.isRenderTarget,
      active: theme.id === active,
      installed_at: theme.installedAt,
      source: theme.source,
      broken: theme.broken,
    })),
  };
}
