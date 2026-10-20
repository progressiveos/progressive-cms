// Schema version migration registry (PCMS-CONT-T022; Content spec §69).
//
// Every breaking schema revision registers an explicit, deterministic
// migration (v1 → v2). Migrations are pure field-payload transforms, applied
// along the single registered chain, idempotent-or-guarded by version
// checking and testable on fixtures. Mass application is a traceable
// operation for the Publication subsystem (M07) — this registry only owns
// the canonical transform.
import { ContentError } from "../errors.js";

export interface SchemaMigration {
  /** ContentType key the migration belongs to. */
  readonly contentTypeKey: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Pure deterministic payload transform — no I/O. */
  readonly migrate: (fields: Record<string, unknown>) => Record<string, unknown>;
}

export interface SchemaMigrationRegistry {
  registerSchemaMigration(migration: SchemaMigration): void;
  /** Latest known version for a key (0 when nothing registered beyond creation). */
  latestVersion(contentTypeKey: string): number | null;
  /**
   * Applies the migration chain from `fromVersion` up to `toVersion`
   * (default: the latest registered). Deterministic: one path, same input →
   * same output. Guarded: applying requires the payload to be at fromVersion.
   */
  migrateFields(
    contentTypeKey: string,
    fromVersion: number,
    fields: Record<string, unknown>,
    toVersion?: number,
  ): { readonly toVersion: number; readonly fields: Record<string, unknown> };
}

export function createSchemaMigrationRegistry(): SchemaMigrationRegistry {
  const byKey = new Map<string, SchemaMigration[]>();

  return {
    registerSchemaMigration(migration: SchemaMigration): void {
      const { contentTypeKey, fromVersion, toVersion } = migration;
      if (!Number.isInteger(fromVersion) || fromVersion < 1) {
        throw new ContentError(
          "SCHEMA_MIGRATION_INVALID",
          `fromVersion must be a positive integer for "${contentTypeKey}"`,
        );
      }
      if (!Number.isInteger(toVersion) || toVersion !== fromVersion + 1) {
        throw new ContentError(
          "SCHEMA_MIGRATION_INVALID",
          `migration "${contentTypeKey}" must step exactly one version (${fromVersion} → ${fromVersion + 1})`,
        );
      }
      const list = byKey.get(contentTypeKey) ?? [];
      if (list.some((existing) => existing.fromVersion === fromVersion)) {
        throw new ContentError(
          "SCHEMA_MIGRATION_EXISTS",
          `a migration for ${contentTypeKey}@${fromVersion} is already registered`,
        );
      }
      list.push(migration);
      byKey.set(contentTypeKey, list);
    },

    latestVersion(contentTypeKey: string): number | null {
      const list = byKey.get(contentTypeKey);
      if (list === undefined || list.length === 0) return null;
      const last = list[list.length - 1];
      return last?.toVersion ?? null;
    },

    migrateFields(contentTypeKey, fromVersion, fields, toVersion) {
      const list = byKey.get(contentTypeKey);
      const target = toVersion ?? (list === undefined ? null : this.latestVersion(contentTypeKey));
      if (list === undefined || list.length === 0) {
        throw new ContentError(
          "SCHEMA_MIGRATION_MISSING",
          `no migration path registered for "${contentTypeKey}"`,
        );
      }
      if (target === null || target < fromVersion) {
        throw new ContentError(
          "SCHEMA_MIGRATION_TARGET_INVALID",
          `target version ${String(target)} is below the payload version ${fromVersion}`,
        );
      }
      let currentVersion = fromVersion;
      let currentFields: Record<string, unknown> = { ...fields };
      while (currentVersion < target) {
        const step = list.find((candidate) => candidate.fromVersion === currentVersion);
        if (step === undefined) {
          throw new ContentError(
            "SCHEMA_MIGRATION_MISSING",
            `no migration from ${contentTypeKey}@${currentVersion}`,
          );
        }
        currentFields = step.migrate(currentFields);
        currentVersion = step.toVersion;
      }
      return { toVersion: currentVersion, fields: currentFields };
    },
  };
}
