// Public theme asset delivery (M17-T007; ADR-0011). The external-RP profile
// has no in-container nginx, so the application itself serves the theme's
// public assets under the URL contract the renderer already emits:
// `/themes/<theme-name>/assets/...` → `<themes.renderDir>/assets/...`.
//
// Security contract (task brief §19): only files under the ACTIVE theme's
// `assets/` subtree are served; traversal, encoded traversal, dotfiles,
// absolute paths, symlink escapes and directory listing are all rejected.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { type ApplicationServices, getConfirmedThemeRevision } from "@pcms/api";
import { themeRevisionDirectory } from "@pcms/themes";
import type { FastifyInstance } from "fastify";

export interface ThemeFilesRouteOptions {
  /** Active theme source directory (config themes.renderDir). */
  readonly renderDir: string | undefined;
  readonly application?: ApplicationServices;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/** Hard bound: theme assets are small static files, not media originals. */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export function registerThemeFilesRoute(
  fastify: FastifyInstance,
  options: ThemeFilesRouteOptions,
): void {
  const renderDir = options.renderDir;
  if (renderDir === undefined) return; // API-only deployment: nothing to serve

  // URL contract: `/themes/<themeId>/assets/<path>`. The ACTIVE theme keeps
  // working exactly as before; any OTHER installed theme (sibling directory
  // of the active renderDir) is served too — candidate-theme previews render
  // pages whose assets must load from the candidate (2026-10-01 site
  // developer request). Containment root is always the per-theme `assets/`
  // subtree — the only public part of a theme — so a symlink out of assets/
  // cannot reach templates or elsewhere.
  const themesRoot = realpathSync(dirname(renderDir));

  fastify.get("/themes/*", async (request, reply) => {
    const raw = (request.params as { "*": string })["*"] ?? "";
    const parts = raw.split("/");
    const versioned = parts[1] === "revisions";
    if (
      versioned
        ? parts.length < 5 || parts[3] !== "assets"
        : parts.length < 3 || parts[1] !== "assets"
    )
      return reply.status(404).send();
    const themeId = parts[0] ?? "";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(themeId)) return reply.status(404).send();
    let themeDir: string;
    if (versioned) {
      const app = options.application;
      if (!app) return reply.status(404).send();
      const revision = await getConfirmedThemeRevision(
        app.pool,
        app.defaultSiteKey,
        parts[2] ?? "",
      );
      if (!revision || revision.theme_key !== themeId) return reply.status(404).send();
      themeDir = themeRevisionDirectory(renderDir, revision.storage_key);
    } else {
      const pinned = options.application?.themeRuntime.requestSnapshot?.();
      themeDir = pinned?.theme_key === themeId ? pinned.directory : resolve(themesRoot, themeId);
    }
    let themeReal: string;
    try {
      themeReal = realpathSync(themeDir);
    } catch {
      return reply.status(404).send();
    }
    if (!themeReal.startsWith(themesRoot + sep)) return reply.status(404).send();
    const assetsRoot = join(themeReal, "assets");
    const relative = parts.slice(versioned ? 4 : 2);
    for (const segment of relative) {
      // Rejects "..", "."-prefixed dotfiles, empty (//) and absolute segments;
      // find-my-way already percent-decodes, so %2e%2e lands here as "..".
      if (segment === "" || segment.startsWith(".") || segment.includes("\\")) {
        return reply.status(404).send();
      }
    }
    const filePath = resolve(assetsRoot, join(...relative));
    // Symlink/path-trick containment: the real path must stay inside assets/.
    let real: string;
    try {
      real = realpathSync(filePath);
    } catch {
      return reply.status(404).send();
    }
    if (!real.startsWith(assetsRoot + sep)) return reply.status(404).send();
    let stats: Stats;
    try {
      stats = lstatSync(real);
    } catch {
      return reply.status(404).send();
    }
    if (!stats.isFile()) return reply.status(404).send(); // no directory listing
    if (stats.size > MAX_ASSET_BYTES) return reply.status(404).send();

    const ext = real.split(".").pop()?.toLowerCase() ?? "";
    const bytes = readFileSync(real);
    const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
    void reply.header(
      "cache-control",
      versioned ? "public, max-age=31536000, immutable" : "no-cache",
    );
    void reply.header("etag", etag);
    void reply.header("last-modified", stats.mtime.toUTCString());
    void reply.header("x-content-type-options", "nosniff");
    if (request.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }
    void reply.header("content-type", CONTENT_TYPES[ext] ?? "application/octet-stream");
    void reply.header("content-length", String(stats.size));
    return reply.send(bytes);
  });
}
