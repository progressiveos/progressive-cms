// Extension-owned migration ownership (PCMS-EXT-T005, Extensions spec §10–§11).
//
// Extension migrations live in a ledger of their own, namespaced per
// extension — they never enter the core `pcms_schema_migrations` ledger and
// never occupy its numbered range. Semantics mirror the core runner:
// forward-only, one transaction per migration together with its bookkeeping
// row, checksum drift detection, session advisory lock, rerun no-op.
import type { DbPool } from "@pcms/core";
import { loadMigrations, type Migration } from "@pcms/core";
import { ExtensionError } from "./errors.js";

export const EXTENSION_MIGRATIONS_TABLE = "pcms_extension_migrations";

/** Separate advisory lock key from the core runner (core uses 180519/1). */
const LOCK_KEY_2 = 3;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${EXTENSION_MIGRATIONS_TABLE} (
  extension_id      text        NOT NULL,
  extension_version text        NOT NULL,
  name              text        NOT NULL,
  checksum          text        NOT NULL,
  applied_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (extension_id, name)
)`;

export type { Migration };
export { loadMigrations };

interface LedgerRow {
  name: string;
  checksum: string;
  extension_version: string;
  applied_at: Date;
  [column: string]: unknown;
}

export interface ExtensionMigrationStatus {
  readonly applied: {
    readonly name: string;
    readonly appliedAt: Date;
    readonly extensionVersion: string;
  }[];
  readonly pending: readonly string[];
  /** Applied rows whose file checksum changed or whose file disappeared. */
  readonly drifted: readonly string[];
}

/** Read-only check mode: what is applied, pending, or drifted for one extension. */
export async function extensionMigrationStatus(
  pool: DbPool,
  extensionId: string,
  migrations: readonly Migration[],
): Promise<ExtensionMigrationStatus> {
  const result = await pool.query<LedgerRow>(
    `SELECT name, checksum, extension_version, applied_at
     FROM ${EXTENSION_MIGRATIONS_TABLE} WHERE extension_id = $1 ORDER BY name`,
    [extensionId],
  );
  const fileByName = new Map(migrations.map((migration) => [migration.name, migration]));
  const applied: ExtensionMigrationStatus["applied"] = [];
  const drifted: string[] = [];
  for (const row of result.rows) {
    const file = fileByName.get(row.name);
    applied.push({
      name: row.name,
      appliedAt: new Date(row.applied_at),
      extensionVersion: row.extension_version,
    });
    if (file === undefined || file.checksum !== row.checksum) drifted.push(row.name);
  }
  const appliedNames = new Set(applied.map((entry) => entry.name));
  return {
    applied,
    pending: migrations
      .filter((migration) => !appliedNames.has(migration.name))
      .map((migration) => migration.name),
    drifted,
  };
}

export interface ExtensionMigrateResult {
  readonly applied: readonly string[];
}

/**
 * Applies all pending migrations of one extension, in file order. Each
 * migration runs in its own transaction together with its ledger row, so a
 * failure never marks a migration applied. Drift (an applied file changed on
 * disk or vanished) refuses the whole run before anything executes.
 */
export async function applyExtensionMigrations(
  pool: DbPool,
  input: {
    readonly extensionId: string;
    readonly extensionVersion: string;
    readonly migrations: readonly Migration[];
    readonly log?: undefined | { info(message: string, fields?: Record<string, unknown>): void };
  },
): Promise<ExtensionMigrateResult> {
  const { extensionId, extensionVersion, migrations, log } = input;
  return pool.withClient(async (client) => {
    await client.query("SELECT pg_advisory_lock($1, $2)", [180519, LOCK_KEY_2]);
    try {
      await client.query(CREATE_TABLE_SQL);
      const rows = await client.query<LedgerRow>(
        `SELECT name, checksum, extension_version, applied_at
         FROM ${EXTENSION_MIGRATIONS_TABLE} WHERE extension_id = $1`,
        [extensionId],
      );
      const appliedRows = new Map(rows.rows.map((row) => [row.name, row.checksum]));
      const fileByName = new Map(migrations.map((migration) => [migration.name, migration]));
      for (const [name, checksum] of appliedRows) {
        const file = fileByName.get(name);
        if (file === undefined) {
          throw new ExtensionError(
            "EXTENSION_MIGRATION_DRIFT",
            `applied extension migration "${name}" of "${extensionId}" has no corresponding migration file (removed?)`,
            { details: { extension_id: extensionId, migration: name } },
          );
        }
        if (file.checksum !== checksum) {
          throw new ExtensionError(
            "EXTENSION_MIGRATION_DRIFT",
            `applied extension migration "${name}" of "${extensionId}" changed on disk (checksum drift) — refusing to continue`,
            { details: { extension_id: extensionId, migration: name } },
          );
        }
      }
      const appliedNow: string[] = [];
      for (const migration of migrations) {
        if (appliedRows.has(migration.name)) continue;
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO ${EXTENSION_MIGRATIONS_TABLE}
             (extension_id, extension_version, name, checksum)
             VALUES ($1, $2, $3, $4)`,
            [extensionId, extensionVersion, migration.name, migration.checksum],
          );
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // broken connection — release() discards the client
          }
          throw new ExtensionError(
            "EXTENSION_MIGRATION_FAILED",
            `extension migration "${extensionId}/${migration.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
            { details: { extension_id: extensionId, migration: migration.name }, cause: error },
          );
        }
        appliedNow.push(migration.name);
        log?.info("extension migration applied", {
          operation: "extensions.migrate",
          extension_id: extensionId,
          migration: migration.name,
        });
      }
      return { applied: appliedNow };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [180519, LOCK_KEY_2]);
    }
  });
}

/**
 * Applies the migrations of many extensions in deterministic order
 * (extension id ascending, then file order). A single extension's run is
 * transactional per migration; extensions are independent namespaces.
 */
export async function applyAllExtensionMigrations(
  pool: DbPool,
  entries: readonly {
    readonly extensionId: string;
    readonly extensionVersion: string;
    readonly migrations: readonly Migration[];
  }[],
  log?: undefined | { info(message: string, fields?: Record<string, unknown>): void },
): Promise<ReadonlyMap<string, ExtensionMigrateResult>> {
  const results = new Map<string, ExtensionMigrateResult>();
  for (const entry of [...entries].sort((a, b) => (a.extensionId < b.extensionId ? -1 : 1))) {
    results.set(entry.extensionId, await applyExtensionMigrations(pool, { ...entry, log }));
  }
  return results;
}
