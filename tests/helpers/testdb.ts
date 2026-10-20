// PCMS-OPS-T003 — disposable PostgreSQL integration environment.
//
// The base connection comes from PCMS_TEST_DATABASE_URL (e.g. loaded from a
// gitignored .env): postgres://user:password@host:port/baseDatabase. Tests
// receive a uniquely named, freshly created database and it is dropped again
// afterwards — no test ever writes into the base database.
//
// Skip/fail semantics: without PCMS_TEST_DATABASE_URL the integration tests
// are skipped (no DB on the machine); with it set but unreachable, they fail
// — a misconfigured environment must not look like a passing gate.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface TestDatabase {
  readonly name: string;
  /** Connection URL for the disposable database. */
  readonly url: string;
  /** Parts for drivers that do not take URLs. */
  readonly connection: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string | undefined;
  };
}

interface BaseConnection {
  host: string;
  port: string;
  user: string;
  password: string | undefined;
  database: string;
}

export function testDatabaseConfigured(): boolean {
  return Boolean(process.env.PCMS_TEST_DATABASE_URL);
}

function parseBase(url: string): BaseConnection {
  const parsed = new URL(url);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `PCMS_TEST_DATABASE_URL must be a postgres:// URL, got protocol "${parsed.protocol}"`,
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("PCMS_TEST_DATABASE_URL must include a database path");
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port || "5432",
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database,
  };
}

function psqlArgs(base: BaseConnection, database: string): string[] {
  return [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    base.host,
    "-p",
    base.port,
    "-U",
    base.user,
    "-d",
    database,
  ];
}

function psqlEnv(base: BaseConnection): NodeJS.ProcessEnv {
  // Password via environment, never via argv (visible in process listings).
  return base.password === undefined ? process.env : { ...process.env, PGPASSWORD: base.password };
}

export function runPsql(base: BaseConnection, database: string, sql: string): string {
  return execFileSync("psql", [...psqlArgs(base, database), "-c", sql], {
    env: psqlEnv(base),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function baseFromEnv(): BaseConnection {
  const url = process.env.PCMS_TEST_DATABASE_URL;
  if (!url) throw new Error("PCMS_TEST_DATABASE_URL is not set");
  return parseBase(url);
}

/** Verifies the base connection early so a wrong URL fails loudly, not at teardown. */
export function assertBaseReachable(): void {
  const base = baseFromEnv();
  runPsql(base, base.database, "SELECT 1");
}

/**
 * Creates a disposable database for the duration of the test; it is dropped
 * (idempotently) when the test finishes. Call as
 * `const db = await createTestDatabase(t)` at the start of a test.
 */
export async function createTestDatabase(t: {
  after: (fn: () => void) => void;
}): Promise<TestDatabase> {
  const base = baseFromEnv();
  const name = `pcms_t_${process.pid}_${randomUUID().slice(0, 8)}`;
  runPsql(base, base.database, `CREATE DATABASE "${name}"`);
  t.after(() => {
    try {
      runPsql(base, base.database, `DROP DATABASE "${name}" WITH (FORCE)`);
    } catch {
      // already dropped (e.g. by an explicit dropTestDatabase) — teardown is best-effort
    }
  });
  const url =
    `postgres://${encodeURIComponent(base.user)}:${base.password === undefined ? "" : encodeURIComponent(base.password)}` +
    `@${base.host}:${base.port}/${name}`;
  return {
    name,
    url,
    connection: {
      host: base.host,
      port: Number.parseInt(base.port, 10),
      database: name,
      user: base.user,
      password: base.password,
    },
  };
}

/** Drops the disposable database explicitly (idempotent, race-tolerant). */
export function dropTestDatabase(db: TestDatabase): void {
  const base = baseFromEnv();
  // Under heavy parallel corpus load, `WITH (FORCE)` can terminate a backend
  // whose PID was just recycled to a process owned by another role —
  // PostgreSQL then answers "no permission to terminate process". The
  // disposable DB teardown is best-effort bookkeeping: retry briefly before
  // giving up so a PID race does not fail an otherwise green run.
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      runPsql(base, base.database, `DROP DATABASE "${db.name}" WITH (FORCE)`);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/завершения процесса|terminate|terminat/i.test(message)) throw error;
      execFileSync("sleep", ["0.3"]);
    }
  }
  throw lastError;
}

/** Ready-to-use DbConnectionInfo-shaped object for the disposable database. */
export function connectionInfo(
  db: TestDatabase,
  port = db.connection.port,
): {
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: "disable";
  password?: string;
} {
  const info = {
    host: db.connection.host,
    port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}
