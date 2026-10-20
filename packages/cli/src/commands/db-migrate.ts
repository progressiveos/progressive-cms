// `cms db migrate [--check]` (PCMS-OPS-T005, Operations spec §12).
// Migrations run explicitly during deploy/update — never automatically from
// the web process. Exit codes: 0 ok/up-to-date, 1 pending-or-failed, 2 usage.
import { isAbsolute, join } from "node:path";
import {
  buildDbConnectionInfo,
  createDbPool,
  createLogger,
  type Logger,
  loadConfig,
  loadMigrations,
  loadSecrets,
  migrateDatabase,
  migrationStatus,
} from "@pcms/core";

export interface DbMigrateInvocation {
  readonly args: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  /** Injected by tests; defaults to a stdout JSON logger. */
  readonly logger?: Logger;
}

export interface DbMigrateResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export async function dbMigrate(invocation: DbMigrateInvocation): Promise<DbMigrateResult> {
  const parsed = parseArgs(invocation.args);
  if (!parsed) return usage();
  const { check, json, file } = parsed;
  const env = invocation.env ?? process.env;
  const cwd = invocation.cwd ?? process.cwd();
  const stderrSink = (line: string): void => {
    process.stderr.write(line);
  };
  const log =
    invocation.logger ??
    createLogger({
      level: "info",
      base: { process: "cms" },
      // Machine-readable mode keeps stdout pure JSON; logs go to stderr.
      ...(json ? { sink: stderrSink } : {}),
    });

  try {
    const config = loadConfig(file === undefined ? { env, cwd } : { file, env, cwd });
    const secrets = loadSecrets(config.secrets, env);
    const connectionInfo = buildDbConnectionInfo(config.db, secrets);
    const migrationsDir = isAbsolute(config.db.migrationsDir)
      ? config.db.migrationsDir
      : join(cwd, config.db.migrationsDir);
    const migrations = loadMigrations(migrationsDir);
    const pool = createDbPool({
      connectionInfo,
      max: 1,
      connectionTimeoutMilliseconds: config.db.pool.connectionTimeoutMilliseconds,
    });
    try {
      if (check) {
        const status = await migrationStatus(pool, migrations);
        const upToDate = status.pending.length === 0 && status.drifted.length === 0;
        const payload = {
          ok: upToDate,
          current: status.current,
          pending: status.pending,
          drifted: status.drifted,
        };
        if (json)
          return {
            exitCode: upToDate ? 0 : 1,
            stdout: `${JSON.stringify(payload, null, 2)}\n`,
            stderr: "",
          };
        const human = upToDate
          ? [`result: UP-TO-DATE (current: ${status.current ?? "none"})`, ""]
          : [
              `result: PENDING (current: ${status.current ?? "none"})`,
              ...status.pending.map((name) => `  pending: ${name}`),
              ...status.drifted.map((name) => `  drifted: ${name}`),
              "",
            ];
        return { exitCode: upToDate ? 0 : 1, stdout: human.join("\n"), stderr: "" };
      }

      const result = await migrateDatabase(pool, migrations, log);
      const status = await migrationStatus(pool, migrations);
      const payload = {
        ok: true,
        applied: result.applied,
        current: status.current,
        pending: status.pending,
        drifted: status.drifted,
      };
      if (json) return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: "" };
      const human = [
        "result: MIGRATED",
        ...result.applied.map((name) => `  applied: ${name}`),
        `current: ${status.current ?? "none"}`,
        ...(result.applied.length === 0 ? ["(nothing to do)"] : []),
        "",
      ];
      return { exitCode: 0, stdout: human.join("\n"), stderr: "" };
    } finally {
      await pool.end();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("db migrate failed", { err: error, operation: "db.migrate" });
    if (json) {
      return {
        exitCode: 1,
        stdout: `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`,
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `error: ${message}\n` };
  }
}

function parseArgs(
  args: readonly string[],
): { check: boolean; json: boolean; file: string | undefined } | undefined {
  let check = false;
  let json = false;
  let file: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--check") check = true;
    else if (arg === "--json") json = true;
    else if (arg === "--config") {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      file = value;
      i += 1;
    } else return undefined;
  }
  return { check, json, file };
}

function usage(): DbMigrateResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      "usage: cms db migrate [--check] [--json] [--config <path>]",
      "",
      "Applies pending migrations explicitly (Operations spec §12). --check exits 1",
      "when migrations are pending or drifted, without changing the database.",
      "",
    ].join("\n"),
  };
}
