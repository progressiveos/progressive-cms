// Extension route mounts (CORE-SHOP-01 P0-b; ADR-0018).
//
// Core Routing owns extension public URLs: the operator assigns ONE active
// mount per extension (site-level), and the composition joins mounts with
// the enabled extensions' manifest http_routes. Collision preflight is
// fail-closed and checks, in order: reserved prefixes ("/x" included),
// active canonical ENTRY routes (prefix crossing both ways), other active
// mounts. Entry publication re-checks the same crossing through the
// extensions publication validator (see context.ts).
import { type DbPool, isStableId } from "@pcms/core";
import type { createReservedRouteRegistry } from "@pcms/routing";
import { ApiError } from "./errors.js";

export interface ExtensionRouteMount {
  readonly extensionId: string;
  readonly mountPath: string;
  readonly createdAt: Date;
}

interface MountRow extends Record<string, unknown> {
  extension_id: string;
  mount_path: string;
  created_at: Date;
}

export interface ExtensionRouteDeps {
  readonly pool: DbPool;
  readonly reserved: ReturnType<typeof createReservedRouteRegistry>;
  /** Active canonical entry routes (path list) for prefix-crossing checks. */
  readonly activeEntryRoutes: () => Promise<readonly string[]>;
}

const MOUNT_PATTERN = /^\/[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

export function normalizeMountPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const lower = withSlash.toLowerCase();
  const noTrailing = lower.endsWith("/") ? lower.slice(0, -1) : lower;
  if (!MOUNT_PATTERN.test(noTrailing)) {
    throw new ApiError(
      "EXTENSION_MOUNT_PATH_INVALID",
      `mount path must look like "/shop" or "/shop/catalog" (lowercase segments)`,
      { status: 422 },
    );
  }
  return noTrailing;
}

/** True when either path is a prefix of the other (segment-aligned). */
export function pathsCross(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  if (short === "/") return true; // root mount crosses everything
  return long.startsWith(`${short}/`);
}

export function createExtensionRouteService(deps: ExtensionRouteDeps) {
  const { pool } = deps;

  async function listActive(): Promise<readonly ExtensionRouteMount[]> {
    const result = await pool.query<MountRow>(
      `SELECT extension_id, mount_path, created_at FROM pcms_extension_route_mounts
       WHERE retired_at IS NULL ORDER BY mount_path`,
    );
    return result.rows.map((row) => ({
      extensionId: row.extension_id,
      mountPath: row.mount_path,
      createdAt: row.created_at,
    }));
  }

  async function activeFor(extensionId: string): Promise<ExtensionRouteMount | null> {
    const result = await pool.query<MountRow>(
      `SELECT extension_id, mount_path, created_at FROM pcms_extension_route_mounts
       WHERE extension_id = $1 AND retired_at IS NULL LIMIT 1`,
      [extensionId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { extensionId: row.extension_id, mountPath: row.mount_path, createdAt: row.created_at };
  }

  /** Fail-closed preflight: reserved prefixes, other mounts, ENTRY routes. */
  async function assertMountActivatable(extensionId: string, mountPath: string): Promise<void> {
    if (mountPath === "/x" || deps.reserved.isReserved(`${mountPath}/`)) {
      throw new ApiError(
        "EXTENSION_MOUNT_COLLISION",
        `mount "${mountPath}" claims a reserved namespace`,
        { status: 409 },
      );
    }
    for (const mount of await listActive()) {
      if (mount.extensionId === extensionId) continue;
      if (pathsCross(mount.mountPath, mountPath)) {
        throw new ApiError(
          "EXTENSION_MOUNT_COLLISION",
          `mount "${mountPath}" crosses the active mount "${mount.mountPath}" of "${mount.extensionId}"`,
          { status: 409, details: [mount.extensionId] },
        );
      }
    }
    for (const entryPath of await deps.activeEntryRoutes()) {
      if (pathsCross(entryPath, mountPath)) {
        throw new ApiError(
          "EXTENSION_MOUNT_COLLISION",
          `mount "${mountPath}" crosses the active entry route "${entryPath}"`,
          { status: 409, details: [entryPath] },
        );
      }
    }
  }

  return {
    listActive,

    activeFor,

    /** All active redirect source paths (any extension) — transport-level
     * prefix probing (CORE-SHOP-SEO-01). */
    async listRedirects(): Promise<
      readonly { readonly extensionId: string; readonly fromPath: string }[]
    > {
      const result = await pool.query<{ extension_id: string; from_path: string }>(
        `SELECT extension_id, from_path FROM pcms_extension_mount_redirects
         WHERE retired_at IS NULL`,
      );
      return result.rows.map((row) => ({
        extensionId: row.extension_id,
        fromPath: row.from_path,
      }));
    },

    /** Active (unretired) redirect sources of one extension. */
    async redirectSources(extensionId: string): Promise<readonly string[]> {
      const result = await pool.query<{ from_path: string }>(
        `SELECT from_path FROM pcms_extension_mount_redirects
         WHERE extension_id = $1 AND retired_at IS NULL`,
        [extensionId],
      );
      return result.rows.map((row) => row.from_path);
    },

    /** Resolve a request path against redirect sources (longest prefix).
     * Returns the extension and the path suffix under its ACTIVE mount —
     * dispatch builds exactly one 308 hop, chains are structurally
     * impossible (the target is always the live mount). */
    async resolveRedirect(path: string): Promise<{
      readonly extensionId: string;
      readonly mount: string;
      readonly rest: string;
    } | null> {
      const redirects = await pool.query<{ extension_id: string; from_path: string }>(
        `SELECT extension_id, from_path FROM pcms_extension_mount_redirects
         WHERE retired_at IS NULL ORDER BY length(from_path) DESC`,
      );
      for (const redirect of redirects.rows) {
        if (path === redirect.from_path || path.startsWith(`${redirect.from_path}/`)) {
          const mount = await activeFor(redirect.extension_id);
          if (mount === null || mount.mountPath === redirect.from_path) continue; // loop guard
          const rest = path.slice(redirect.from_path.length);
          return {
            extensionId: redirect.extension_id,
            mount: mount.mountPath,
            rest: rest === "" ? "/" : rest,
          };
        }
      }
      return null;
    },

    /** Resolve a request path to (extensionId, mount, sub-path) or null. */
    async resolve(path: string): Promise<{
      readonly extensionId: string;
      readonly mount: string;
      readonly rest: string;
    } | null> {
      for (const mount of await listActive()) {
        if (mount.mountPath === "/") {
          return { extensionId: mount.extensionId, mount: "/", rest: path };
        }
        if (path === mount.mountPath || path.startsWith(`${mount.mountPath}/`)) {
          return {
            extensionId: mount.extensionId,
            mount: mount.mountPath,
            rest: path.slice(mount.mountPath.length),
          };
        }
      }
      return null;
    },

    /** Assign (or move) the extension's site mount. Audited by the caller. */
    async setMount(
      siteId: string,
      extensionId: string,
      rawPath: string,
    ): Promise<ExtensionRouteMount> {
      if (!isStableId(siteId)) {
        throw new ApiError("API_REQUEST_INVALID", "site id is invalid", { status: 422 });
      }
      const mountPath = normalizeMountPath(rawPath);
      await deps.pool.withTransaction(async (tx) => {
        await assertMountActivatable(extensionId, mountPath);
        // Canonical URL policy (CORE-SHOP-SEO-01): the replaced mount's
        // published URLs answer 308 toward the new mount. Redirect sources
        // that would collide with (or sit under) the new mount retire —
        // the live path wins, chains cannot form.
        const previousMounts = await tx.query<{ mount_path: string }>(
          `SELECT mount_path FROM pcms_extension_route_mounts
           WHERE extension_id = $1::text AND retired_at IS NULL AND mount_path <> $2::text`,
          [extensionId, mountPath],
        );
        await tx.query(
          `UPDATE pcms_extension_mount_redirects SET retired_at = now()
           WHERE retired_at IS NULL
             AND (from_path = $1::text OR from_path LIKE $1::text || '/%')`,
          [mountPath],
        );
        for (const previous of previousMounts.rows) {
          if (pathsCross(previous.mount_path, mountPath)) continue;
          await tx.query(
            `INSERT INTO pcms_extension_mount_redirects (id, site_id, extension_id, from_path)
             VALUES (gen_random_uuid(), $1::uuid, $2::text, $3::text)`,
            [siteId, extensionId, previous.mount_path],
          );
        }
        await tx.query(
          `UPDATE pcms_extension_route_mounts SET retired_at = now()
           WHERE extension_id = $1 AND retired_at IS NULL`,
          [extensionId],
        );
        // Same mount → keep history, just reactivate; new mount → insert.
        const previous = await tx.query<{ id: string }>(
          `SELECT id FROM pcms_extension_route_mounts
           WHERE extension_id = $1 AND mount_path = $2 ORDER BY created_at DESC LIMIT 1`,
          [extensionId, mountPath],
        );
        if (previous.rows[0] !== undefined) {
          await tx.query(`UPDATE pcms_extension_route_mounts SET retired_at = NULL WHERE id = $1`, [
            previous.rows[0].id,
          ]);
        } else {
          await tx.query(
            `INSERT INTO pcms_extension_route_mounts (id, site_id, extension_id, mount_path)
             VALUES (gen_random_uuid(), $1, $2, $3)`,
            [siteId, extensionId, mountPath],
          );
        }
      });
      const mount = await activeFor(extensionId);
      if (mount === null)
        throw new ApiError("UPDATE_FAILED", "mount activation failed", { status: 500 });
      return mount;
    },

    /** Entry-publication preflight: an entry route must not cross an active mount. */
    async assertEntryRouteActivatable(entryPath: string): Promise<void> {
      for (const mount of await listActive()) {
        if (pathsCross(entryPath, mount.mountPath)) {
          throw new ApiError(
            "EXTENSION_MOUNT_COLLISION",
            `entry route "${entryPath}" crosses the extension mount "${mount.mountPath}" (${mount.extensionId})`,
            { status: 409, details: [mount.extensionId] },
          );
        }
      }
    },

    assertMountActivatable,
  };
}

export type ExtensionRouteService = ReturnType<typeof createExtensionRouteService>;
