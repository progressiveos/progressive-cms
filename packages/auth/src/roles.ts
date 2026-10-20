// Role management & permission resolution (PCMS-AUTH-T015/T016/T017/T018;
// Auth spec §38–§47).
//
// Roles are permission bundles. Built-in roles are code-defined immutable
// templates (permissions.ts); custom roles store their explicit permission
// set in the database and can only grant registered keys. Effective user
// permissions are the union over assigned roles, intersected with the
// registry at resolution time — an unknown key can never leak through, and
// a registry append never silently broadens a stored custom role (§47).
import type { DbClient, DbPool } from "@pcms/core";
import { AuthError } from "./errors.js";
import { assertNotLastActiveOwner } from "./owner-invariant.js";
import {
  assertAllRegistered,
  BUILTIN_ROLE_KEYS,
  type BuiltinRoleKey,
  builtinRolePermissions,
  isRegisteredPermission,
} from "./permissions.js";

export interface RoleRecord {
  readonly key: string;
  readonly name: string;
  readonly builtin: boolean;
  readonly immutable: boolean;
  readonly createdAt: Date;
  readonly permissions: readonly string[];
}

export interface CreateCustomRoleData {
  /** Short machine key, e.g. "REVIEWER" (1–64 chars, A–Z/0-9/_). */
  key: string;
  name: string;
  permissions: readonly string[];
}

export interface RoleService {
  listRoles(): Promise<RoleRecord[]>;
  findRole(roleKey: string): Promise<RoleRecord | null>;
  userRoleKeys(userId: string): Promise<string[]>;
  /** Union of all assigned role bundles; registry-checked (default deny). */
  userPermissions(userId: string): Promise<ReadonlySet<string>>;
  assignRole(userId: string, roleKey: string, grantedBy: string | null): Promise<void>;
  removeRole(userId: string, roleKey: string, revokedBy: string | null): Promise<void>;
  createCustomRole(data: CreateCustomRoleData, createdBy: string | null): Promise<RoleRecord>;
  updateCustomRole(
    roleKey: string,
    patch: { name?: string; permissions?: readonly string[] },
    updatedBy: string | null,
  ): Promise<RoleRecord>;
  deleteCustomRole(roleKey: string, deletedBy: string | null): Promise<void>;
}

const ROLE_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

type RoleRow = {
  key: string;
  name: string;
  builtin: boolean;
  immutable: boolean;
  created_at: Date;
  created_by: string | null;
};

type RolePermissionRow = { permission_key: string };

async function customPermissions(db: DbClient, roleKey: string): Promise<string[]> {
  const result = await db.query<RolePermissionRow>(
    "SELECT permission_key FROM auth_role_permissions WHERE role_key = $1 ORDER BY permission_key",
    [roleKey],
  );
  return result.rows.map((row) => row.permission_key);
}

export function createRoleService(pool: DbPool): RoleService {
  /** True when the key exists in auth_roles (built-in rows are seeded by migration). */
  async function roleExists(roleKey: string): Promise<boolean> {
    const result = await pool.query("SELECT 1 FROM auth_roles WHERE key = $1", [roleKey]);
    return result.rows.length > 0;
  }

  const service: RoleService = {
    async listRoles(): Promise<RoleRecord[]> {
      const rows = await pool.query<RoleRow>(
        "SELECT * FROM auth_roles ORDER BY builtin DESC, key ASC",
      );
      const roles: RoleRecord[] = [];
      for (const row of rows.rows) {
        roles.push({
          key: row.key,
          name: row.name,
          builtin: row.builtin,
          immutable: row.immutable,
          createdAt: row.created_at,
          permissions: row.builtin
            ? builtinRolePermissions(row.key as BuiltinRoleKey)
            : await customPermissions(pool, row.key),
        });
      }
      return roles;
    },

    async findRole(roleKey: string): Promise<RoleRecord | null> {
      const result = await pool.query<RoleRow>("SELECT * FROM auth_roles WHERE key = $1", [
        roleKey,
      ]);
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        key: row.key,
        name: row.name,
        builtin: row.builtin,
        immutable: row.immutable,
        createdAt: row.created_at,
        permissions: row.builtin
          ? builtinRolePermissions(row.key as BuiltinRoleKey)
          : await customPermissions(pool, row.key),
      };
    },

    async userRoleKeys(userId: string): Promise<string[]> {
      const result = await pool.query<{ role_key: string }>(
        "SELECT role_key FROM auth_user_roles WHERE user_id = $1 ORDER BY role_key",
        [userId],
      );
      return result.rows.map((row) => row.role_key);
    },

    async userPermissions(userId: string): Promise<ReadonlySet<string>> {
      const roleKeys = await service.userRoleKeys(userId);
      const effective = new Set<string>();
      for (const roleKey of roleKeys) {
        if ((BUILTIN_ROLE_KEYS as readonly string[]).includes(roleKey)) {
          for (const key of builtinRolePermissions(roleKey as BuiltinRoleKey)) {
            effective.add(key);
          }
        } else {
          for (const key of await customPermissions(pool, roleKey)) {
            // Registry intersection at resolution time: a key that was later
            // unregistered (or forged directly in the DB) resolves to nothing.
            if (isRegisteredPermission(key)) effective.add(key);
          }
        }
      }
      return effective;
    },

    async assignRole(userId: string, roleKey: string, grantedBy: string | null): Promise<void> {
      if (!(await roleExists(roleKey))) {
        throw new AuthError("AUTH_VALIDATION", `unknown role "${roleKey}"`, 404);
      }
      await pool.query(
        `INSERT INTO auth_user_roles (user_id, role_key, granted_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, role_key) DO NOTHING`,
        [userId, roleKey, grantedBy],
      );
    },

    async removeRole(userId: string, roleKey: string, _revokedBy: string | null): Promise<void> {
      void _revokedBy;
      if (!(await roleExists(roleKey))) {
        throw new AuthError("AUTH_VALIDATION", `unknown role "${roleKey}"`, 404);
      }
      await pool.withTransaction(async (tx) => {
        if (roleKey === "OWNER") {
          await assertNotLastActiveOwner(tx, userId);
        }
        const result = await tx.query(
          "DELETE FROM auth_user_roles WHERE user_id = $1 AND role_key = $2",
          [userId, roleKey],
        );
        if (result.rowCount === 0) {
          throw new AuthError("AUTH_VALIDATION", "role assignment not found", 404);
        }
      });
    },

    async createCustomRole(
      data: CreateCustomRoleData,
      createdBy: string | null,
    ): Promise<RoleRecord> {
      const key = data.key.trim();
      if (!ROLE_KEY_RE.test(key)) {
        throw new AuthError("AUTH_VALIDATION", "role key must match [A-Z][A-Z0-9_]{0,63}");
      }
      if ((BUILTIN_ROLE_KEYS as readonly string[]).includes(key)) {
        throw new AuthError("AUTH_VALIDATION", `"${key}" is a reserved built-in role`);
      }
      const name = data.name.trim();
      if (name.length === 0 || name.length > 200) {
        throw new AuthError("AUTH_VALIDATION", "role name must be 1–200 characters");
      }
      assertAllRegistered(data.permissions); // fail-secure against forged keys

      await pool.withTransaction(async (tx) => {
        await tx.query(
          "INSERT INTO auth_roles (key, name, builtin, immutable, created_by) VALUES ($1, $2, false, false, $3)",
          [key, name, createdBy],
        );
        for (const permission of new Set(data.permissions)) {
          await tx.query(
            "INSERT INTO auth_role_permissions (role_key, permission_key) VALUES ($1, $2)",
            [key, permission],
          );
        }
      });
      const created = await service.findRole(key);
      if (created === null) throw new AuthError("AUTH_VALIDATION", "role creation failed");
      return created;
    },

    async updateCustomRole(roleKey, patch, _updatedBy): Promise<RoleRecord> {
      void _updatedBy;
      await pool.withTransaction(async (tx) => {
        const existing = await tx.query<RoleRow>("SELECT * FROM auth_roles WHERE key = $1", [
          roleKey,
        ]);
        const row = existing.rows[0];
        if (row === undefined) throw new AuthError("AUTH_VALIDATION", "role not found", 404);
        if (row.builtin || row.immutable) {
          throw new AuthError("AUTH_VALIDATION", "built-in roles are immutable", 409);
        }
        if (patch.name !== undefined) {
          const name = patch.name.trim();
          if (name.length === 0 || name.length > 200) {
            throw new AuthError("AUTH_VALIDATION", "role name must be 1–200 characters");
          }
          await tx.query("UPDATE auth_roles SET name = $2 WHERE key = $1", [roleKey, name]);
        }
        if (patch.permissions !== undefined) {
          assertAllRegistered(patch.permissions);
          await tx.query("DELETE FROM auth_role_permissions WHERE role_key = $1", [roleKey]);
          for (const permission of new Set(patch.permissions)) {
            await tx.query(
              "INSERT INTO auth_role_permissions (role_key, permission_key) VALUES ($1, $2)",
              [roleKey, permission],
            );
          }
        }
      });
      const updated = await service.findRole(roleKey);
      if (updated === null) throw new AuthError("AUTH_VALIDATION", "role not found", 404);
      return updated;
    },

    async deleteCustomRole(roleKey: string, _deletedBy: string | null): Promise<void> {
      void _deletedBy;
      await pool.withTransaction(async (tx) => {
        const existing = await tx.query<RoleRow>("SELECT * FROM auth_roles WHERE key = $1", [
          roleKey,
        ]);
        const row = existing.rows[0];
        if (row === undefined) throw new AuthError("AUTH_VALIDATION", "role not found", 404);
        if (row.builtin || row.immutable) {
          throw new AuthError("AUTH_VALIDATION", "built-in roles are immutable", 409);
        }
        const assigned = await tx.query(
          "SELECT 1 FROM auth_user_roles WHERE role_key = $1 LIMIT 1",
          [roleKey],
        );
        if (assigned.rows.length > 0) {
          throw new AuthError(
            "AUTH_VALIDATION",
            "role is still assigned to users; unassign it first",
            409,
          );
        }
        await tx.query("DELETE FROM auth_roles WHERE key = $1", [roleKey]);
      });
    },
  };

  return service;
}
