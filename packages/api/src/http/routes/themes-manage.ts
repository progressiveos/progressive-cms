// Theme lifecycle routes (owner directive 2026-09-29: themes join the
// registry/artifact lifecycle). Installed themes = subdirectories of the
// themes root (parent of themes.renderDir).
//
// `themes.renderDir` is the themes DIRECTORY and its theme is only the boot
// seed for `admin_theme_state`; the persisted ACTIVATION (see activateTheme)
// overrides it at request time, and `active` in these responses is that row.
// So switching the active theme does NOT mean switching themes.renderDir, and
// package install/uninstall refuses to touch it regardless.
// Mirrors the skills surface: octet-stream bytes or a registry download_url.
import { basename, dirname, join } from "node:path";
import { assertTokenConstraints } from "@pcms/auth";
import {
  installThemePackage,
  listInstalledThemes,
  ThemeInstallError,
  uninstallThemePackage,
} from "@pcms/themes";
import {
  type ApplicationServices,
  extendThemeBlockVariants,
  readCmsVersionFromRelease,
} from "../../context.js";
import { ApiError } from "../../errors.js";
import {
  changeTheme,
  cleanupThemeRevisions,
  listThemeRevisions,
  rollbackTheme,
  type ThemeCleanupInput,
} from "../../theme-lifecycle.js";
import type { ApiRoute } from "../registry.js";

function themesRootOf(app: ApplicationServices): { root: string; renderDirId: string } {
  if (app.themeDir === undefined) {
    throw new ApiError("API_NOT_FOUND", "no theme source is configured (themes.renderDir)", {
      status: 404,
    });
  }
  const renderDirId = app.themeDiscovery?.getThemeId() ?? basename(app.themeDir);
  return { root: dirname(app.themeRuntime.configuredDir ?? app.themeDir), renderDirId };
}

function activeThemeKey(app: ApplicationServices): Promise<string | null> {
  return app.pool
    .query<{ theme_key: string | null }>(
      "SELECT theme_key FROM admin_theme_state WHERE site_key = $1",
      [app.defaultSiteKey],
    )
    .then((result) => result.rows[0]?.theme_key ?? null)
    .catch(() => null);
}

function registryOf(app: ApplicationServices): NonNullable<ApplicationServices["registryClient"]> {
  if (app.registryClient === null) {
    throw new ApiError(
      "REGISTRY_NOT_CONFIGURED",
      "registry is not configured: set registry.baseUrl and the registry.token secret slot",
      { status: 409 },
    );
  }
  return app.registryClient;
}

function mapInstallError(error: unknown): never {
  if (error instanceof ThemeInstallError) {
    throw new ApiError(error.code, error.message, {
      status: error.code === "THEME_NOT_INSTALLED" ? 404 : 409,
    });
  }
  throw error as Error;
}

const SERVED_THEME_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    version: { type: "string" },
    settings_generation: { type: "integer" },
    revision_id: { type: ["string", "null"], format: "uuid" },
    theme_generation: { type: "integer" },
  },
};

export function makeThemeManageRoutes(): ApiRoute[] {
  return [
    {
      spec: {
        method: "POST",
        url: "/themes/revisions/cleanup",
        operationId: "cleanup_theme_revisions",
        summary:
          "Preview old snapshots (theme.read) or remove explicit candidates (theme.write); preserves active, last-good, newest five and recovery revisions",
        tag: "themes",
        auth: "authenticated",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            dry_run: { type: "boolean", default: true },
            keep_last: { type: "integer", minimum: 5, maximum: 100, default: 5 },
            older_than_days: { type: "integer", minimum: 1, maximum: 36500, default: 1 },
            expected_generation: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            revision_ids: {
              type: "array",
              maxItems: 100,
              uniqueItems: true,
              items: { type: "string", format: "uuid" },
            },
          },
        },
        responseSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            dry_run: { type: "boolean" },
            theme_generation: { type: "integer" },
            keep_last: { type: "integer" },
            older_than_days: { type: "integer" },
            retained_count: { type: "integer" },
            has_more: { type: "boolean" },
            candidates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  revision_id: { type: "string", format: "uuid" },
                  theme_id: { type: "string" },
                  package_version: { type: "string" },
                  last_used_at: { type: "string", format: "date-time" },
                  pending_cleanup: { type: "boolean" },
                },
              },
            },
            removed: { type: "array", items: { type: "string", format: "uuid" } },
            pending: { type: "array", items: { type: "string", format: "uuid" } },
          },
        },
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await cleanupThemeRevisions(app, ctx, request.body as ThemeCleanupInput),
        };
      },
    },
    {
      spec: {
        method: "GET",
        url: "/themes/revisions",
        operationId: "list_theme_revisions",
        summary:
          "Retained confirmed theme revisions for this site (active plus newest, at most 100)",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.read",
        responseSchema: {
          type: "object",
          properties: {
            theme_generation: { type: "integer" },
            active_revision_id: { type: ["string", "null"], format: "uuid" },
            revisions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  revision_id: { type: "string", format: "uuid" },
                  theme_id: { type: "string" },
                  package_version: { type: "string" },
                  sha256: { type: "string" },
                  created_at: { type: "string", format: "date-time" },
                  activated_at: { type: ["string", "null"], format: "date-time" },
                  active: { type: "boolean" },
                },
              },
            },
          },
        },
      },
      async handle(app, ctx) {
        return { status: 200, body: await listThemeRevisions(app, ctx) };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/themes/rollback",
        operationId: "rollback_theme_revision",
        summary:
          "Live activation of a retained revision, with lifecycle CAS (theme.write + theme.activate)",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.write",
        csrf: true,
        bodySchema: {
          type: "object",
          additionalProperties: false,
          required: ["revision_id", "expected_generation"],
          properties: {
            revision_id: { type: "string", format: "uuid" },
            expected_generation: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
        responseSchema: {
          type: "object",
          properties: { ok: { type: "boolean" }, served: SERVED_THEME_SCHEMA },
        },
      },
      async handle(app, ctx, request) {
        return {
          status: 200,
          body: await rollbackTheme(
            app,
            ctx,
            request.body as { revision_id: string; expected_generation: number },
          ),
        };
      },
    },

    {
      spec: {
        method: "GET",
        url: "/themes/active",
        operationId: "get_served_theme",
        summary: "Actual in-memory theme id/version used by the public renderer (theme.read)",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.read",
        responseSchema: SERVED_THEME_SCHEMA,
      },
      async handle(app, ctx) {
        assertTokenConstraints(ctx.actor, {
          siteKey: app.defaultSiteKey,
          environment: ctx.actor.environment,
        });
        if (app.themeRuntime.served === null) {
          throw new ApiError(
            "THEME_RUNTIME_UNAVAILABLE",
            "public theme renderer is not registered",
            { status: 409 },
          );
        }
        return { status: 200, body: app.themeRuntime.served() };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/themes/active/update",
        operationId: "update_active_theme",
        summary:
          "Replace the active theme with a newer package of the same id and refresh rendering without restart (theme.write + theme.activate)",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.write",
        csrf: true,
        bodyLimit: 64 * 1024 * 1024 + 64 * 1024,
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "theme.activate");
        if (app.themeDir === undefined || app.themeRuntime.prepareUpdate === null) {
          throw new ApiError(
            "THEME_RUNTIME_UNAVAILABLE",
            "public theme renderer is not registered",
            { status: 409 },
          );
        }
        if (!Buffer.isBuffer(request.body)) {
          throw new ApiError(
            "API_REQUEST_INVALID",
            "send the theme package as application/octet-stream",
            { status: 400 },
          );
        }
        try {
          assertTokenConstraints(ctx.actor, {
            siteKey: app.defaultSiteKey,
            environment: ctx.actor.environment,
          });
          const result = await changeTheme(app, ctx, {
            kind: "UPDATE",
            packageBytes: request.body,
          });
          const info = result.info!;
          try {
            extendThemeBlockVariants(app.blocks, app.themeDir!);
          } catch (error) {
            request.log.warn(
              { theme: info.id, error: String(error) },
              "theme.variants.extend_failed",
            );
          }
          return { status: 200, body: { ...info, served: app.themeRuntime.served?.() } };
        } catch (error) {
          mapInstallError(error);
        }
      },
    },
    {
      spec: {
        method: "GET",
        url: "/themes/installed",
        operationId: "list_themes_installed",
        summary:
          "Installed themes in the themes root (theme.read). active = admin_theme_state row; isRenderTarget = the theme themes.renderDir actually serves.",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.read",
      },
      async handle(app) {
        const { root, renderDirId } = themesRootOf(app);
        const active = await activeThemeKey(app);
        return {
          status: 200,
          body: {
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
          },
        };
      },
    },
    {
      spec: {
        method: "POST",
        url: "/themes/install",
        operationId: "install_theme",
        summary:
          "Install a .pcTheme package (theme.write). Body: JSON {download_url} (repository artifact) or the raw package as application/octet-stream. The renderDir theme can never be overwritten.",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.write",
        csrf: true,
        bodyLimit: 64 * 1024 * 1024 + 64 * 1024,
      },
      async handle(app, ctx, request) {
        app.authorize(ctx.actor, "theme.write");
        assertTokenConstraints(ctx.actor, {
          siteKey: app.defaultSiteKey,
          environment: ctx.actor.environment,
        });
        const { root, renderDirId } = themesRootOf(app);
        const raw = request.body;
        let bytes: Buffer;
        let source: string | undefined;
        if (Buffer.isBuffer(raw)) {
          bytes = raw;
          const disposition = request.headers["content-disposition"];
          if (typeof disposition === "string") source = disposition;
        } else {
          const body = (raw ?? {}) as { download_url?: unknown };
          const url = typeof body.download_url === "string" ? body.download_url : "";
          if (url.length === 0) {
            throw new ApiError(
              "API_REQUEST_INVALID",
              "body must be {download_url} JSON or the raw package as application/octet-stream",
              { status: 400 },
            );
          }
          bytes = await registryOf(app).download(url);
          source = url;
        }
        try {
          const options: Parameters<typeof installThemePackage>[1] & {
            source?: string;
          } = {
            themesRoot: root,
            renderDirThemeId: renderDirId,
            cmsVersion: readCmsVersionFromRelease(),
          };
          if (source !== undefined) {
            (options as { source?: string }).source = source;
          }
          const info = await installThemePackage(bytes, options);
          // Candidate variants must validate immediately after install —
          // before any restart (2026-10-01 site-developer report). Same
          // contract as the composition-time themes-root scan (context.ts).
          try {
            extendThemeBlockVariants(app.blocks, join(root, info.id));
          } catch (error) {
            request.log.warn(
              { theme: info.id, error: String(error) },
              "theme.variants.extend_failed",
            );
          }
          void ctx;
          return { status: 201, body: { id: info.id, version: info.version, sha256: info.sha256 } };
        } catch (error) {
          mapInstallError(error);
        }
      },
    },
    {
      spec: {
        method: "DELETE",
        url: "/themes/installed/:name",
        operationId: "uninstall_theme",
        summary:
          "Uninstall an installed theme (theme.write). The renderDir theme is refused — switch themes.renderDir first.",
        tag: "themes",
        auth: "authenticated",
        permission: "theme.write",
        csrf: true,
      },
      async handle(app, _ctx, request) {
        const { root, renderDirId } = themesRootOf(app);
        const params = request.params as { name?: string };
        const name = String(params.name ?? "");
        if (name.length === 0) {
          throw new ApiError("API_REQUEST_INVALID", "theme name is required", { status: 400 });
        }
        try {
          uninstallThemePackage(root, name, renderDirId);
        } catch (error) {
          mapInstallError(error);
        }
        return { status: 200, body: { uninstalled: name } };
      },
    },
  ];
}
