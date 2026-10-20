// Versioned forward-only migration runner (PCMS-OPS-T005, Operations spec §12).
//
// Guarantees:
//   - empty database → migrate zero → current, schema version recorded;
//   - each migration applies inside its own transaction (transactional DDL);
//   - a PostgreSQL advisory lock serializes concurrent invocations, so web
//     processes never race migrations at startup (they never migrate at all);
//   - checksums of applied files are verified — editing an already-applied
//     migration is drift and fails `migrate --check`/migrate (update preflight
//     signal, see ADR-0002). Extension-owned migrations (M13) will extend this
//     runner without changing the file format.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbPool } from "./pool.js";

export const MIGRATIONS_TABLE = "pcms_schema_migrations";

/** Session-scoped advisory lock keys (arbitrary fixed constants). */
const LOCK_KEY_1 = 180519;
const LOCK_KEY_2 = 1;

export interface Migration {
  /** File stem, e.g. "0001_public_baseline". */
  name: string;
  /** sha256 of the SQL content. */
  checksum: string;
  sql: string;
}

export interface MigrationStatus {
  applied: { name: string; appliedAt: Date }[];
  pending: string[];
  /** Applied rows whose file checksum changed or whose file disappeared. */
  drifted: string[];
  current: string | null;
}

const NAME_PATTERN = /^\d{4}_[a-z0-9_]+$/;

/** Loads ordered *.sql migrations from a directory; fail-secure on naming/duplicates. */
export function loadMigrations(dir: string): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new Error(
      `cannot read migrations directory "${dir}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const seen = new Map<string, string>();
  const migrations: Migration[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".sql")) continue;
    const name = entry.slice(0, -".sql".length);
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`migration file "${entry}" does not match NNNN_name.sql naming`);
    }
    const path = join(dir, entry);
    if (seen.has(name)) {
      throw new Error(`duplicate migration name "${name}"`);
    }
    seen.set(name, path);
    const sql = readFileSync(path, "utf8");
    migrations.push({ name, checksum: createHash("sha256").update(sql).digest("hex"), sql });
  }
  return migrations;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

interface AppliedRow {
  name: string;
  checksum: string;
  applied_at: Date;
  [column: string]: unknown;
}

export async function migrationStatus(
  pool: DbPool,
  migrations: Migration[],
): Promise<MigrationStatus> {
  await pool.query(CREATE_TABLE_SQL);
  const result = await pool.query<AppliedRow>(
    `SELECT name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  const fileByName = new Map(migrations.map((migration) => [migration.name, migration]));
  const applied: { name: string; appliedAt: Date }[] = [];
  const drifted: string[] = [];
  for (const row of result.rows) {
    applied.push({ name: row.name, appliedAt: new Date(row.applied_at) });
    const file = fileByName.get(row.name);
    if (!file || file.checksum !== row.checksum) drifted.push(row.name);
  }
  const appliedNames = new Set(applied.map((entry) => entry.name));
  const pending = migrations
    .filter((migration) => !appliedNames.has(migration.name))
    .map((migration) => migration.name);
  return {
    applied,
    pending,
    drifted,
    current: applied.length === 0 ? null : (applied[applied.length - 1]?.name ?? null),
  };
}

export interface MigrateResult {
  applied: string[];
  current: string | null;
}

/**
 * Applies all pending migrations. The whole run holds one session-scoped
 * advisory lock; each migration runs in its own transaction together with
 * its bookkeeping row.
 */
export async function migrateDatabase(
  pool: DbPool,
  migrations: Migration[],
  log: { info(message: string, fields?: Record<string, unknown>): void } | undefined,
): Promise<MigrateResult> {
  return pool.withClient(async (client) => {
    await client.query("SELECT pg_advisory_lock($1, $2)", [LOCK_KEY_1, LOCK_KEY_2]);
    try {
      await client.query(CREATE_TABLE_SQL);
      const rows = await client.query<AppliedRow>(
        `SELECT name, checksum, applied_at FROM ${MIGRATIONS_TABLE}`,
      );
      const appliedRows = new Map(rows.rows.map((row) => [row.name, row.checksum]));
      const fileByName = new Map(migrations.map((migration) => [migration.name, migration]));

      for (const [name, checksum] of appliedRows) {
        const file = fileByName.get(name);
        if (!file) {
          throw new Error(
            `applied migration "${name}" has no corresponding migration file (removed?)`,
          );
        }
        if (file.checksum !== checksum) {
          throw new Error(
            `applied migration "${name}" changed on disk (checksum drift) — refusing to continue`,
          );
        }
      }

      const appliedNow: string[] = [];
      for (const migration of migrations) {
        if (appliedRows.has(migration.name)) continue;
        const started = Date.now();
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES ($1, $2)`, [
            migration.name,
            migration.checksum,
          ]);
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // broken connection — release() will discard the client
          }
          throw new Error(
            `migration "${migration.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        appliedNow.push(migration.name);
        log?.info("migration applied", {
          operation: "db.migrate",
          migration: migration.name,
          duration_ms: Date.now() - started,
        });
      }

      const allApplied = new Set<string>([...appliedRows.keys(), ...appliedNow]);
      const current =
        migrations
          .filter((migration) => allApplied.has(migration.name))
          .map((migration) => migration.name)
          .at(-1) ?? null;
      return { applied: appliedNow, current };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_KEY_1, LOCK_KEY_2]);
    }
  });
}
