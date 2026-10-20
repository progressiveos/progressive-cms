// DB pool and transaction foundation (PCMS-OPS-T004, Operations spec §11/§13).
//
// Deliberately thin over the `pg` driver: a bounded pool plus a real
// transaction helper. No ORM, no query builder, no repository abstraction —
// PostgreSQL semantics stay visible (ADR-0002).
import { Pool, type PoolClient } from "pg";
import type { DbSslMode } from "../config/schema.js";

/** Connection parameters resolved from config + secrets by the composition root. */
export interface DbConnectionInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  sslMode: DbSslMode;
  /** CA certificate content for verify-full against private CAs. */
  sslCa?: string;
}

export interface DbPoolOptions {
  connectionInfo: DbConnectionInfo;
  /** Hard upper bound for open connections (Operations spec §13: bounded pool). */
  max: number;
  connectionTimeoutMilliseconds?: number;
  idleTimeoutMilliseconds?: number;
  /** Applied per connection via the PostgreSQL startup packet. */
  statementTimeoutMilliseconds?: number;
  /** Idle-client backend errors surface here; unhandled, they would crash the process. */
  onIdleClientError?: (error: Error) => void;
}

export interface DbQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface DbClient {
  /** Discard a leased session when cleanup cannot release session-scoped resources. */
  discard?(reason?: Error): void;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>>;
}

export type TransactionIsolation = "read committed" | "repeatable read" | "serializable";

export interface DbPool {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<DbQueryResult<Row>>;
  withClient<Out>(work: (client: DbClient) => Promise<Out>): Promise<Out>;
  /**
   * Runs `work` inside BEGIN … COMMIT. Any error rolls the transaction back
   * and rethrows; the pool client is always released.
   */
  withTransaction<Out>(
    work: (tx: DbClient) => Promise<Out>,
    options?: { isolation?: TransactionIsolation },
  ): Promise<Out>;
  /** Cheap liveness probe for readiness checks; resolves false on timeout/unavailability. */
  check(timeoutMilliseconds?: number): Promise<boolean>;
  stats(): { totalCount: number; idleCount: number; waitingCount: number };
  end(): Promise<void>;
}

const ISOLATION_SQL: Record<TransactionIsolation, string> = {
  "read committed": "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED",
  "repeatable read": "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  serializable: "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE",
};

function pgSsl(mode: DbSslMode, ca: string | undefined): object | undefined {
  if (mode === "disable") return undefined;
  if (mode === "require") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) };
}

function toPgConfig(options: DbPoolOptions): {
  max: number;
  connectionTimeoutMillis: number | undefined;
  idleTimeoutMillis: number | undefined;
  options: string | undefined;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | undefined;
  ssl: object | undefined;
} {
  const info = options.connectionInfo;
  return {
    max: options.max,
    connectionTimeoutMillis: options.connectionTimeoutMilliseconds,
    idleTimeoutMillis: options.idleTimeoutMilliseconds,
    options:
      options.statementTimeoutMilliseconds === undefined
        ? undefined
        : `-c statement_timeout=${options.statementTimeoutMilliseconds}`,
    host: info.host,
    port: info.port,
    database: info.database,
    user: info.user,
    password: info.password,
    ssl: pgSsl(info.sslMode, info.sslCa),
  };
}

function clientOf(poolClient: PoolClient): DbClient {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<DbQueryResult<Row>> {
      const result = await poolClient.query<Row>(sql, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export function createDbPool(options: DbPoolOptions): DbPool {
  if (!Number.isInteger(options.max) || options.max < 1) {
    throw new Error(`pool max must be a positive integer, got ${options.max}`);
  }
  const pool = new Pool(toPgConfig(options));
  pool.on("error", (error) => {
    // Idle-client backend errors (restarts, network drops) must not become
    // uncaught exceptions; production wiring forwards this to the logger.
    if (options.onIdleClientError) options.onIdleClientError(error);
    else console.error("[pcms:db] idle client error", error.message);
  });

  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<DbQueryResult<Row>> {
      const result = await pool.query<Row>(sql, params as unknown[]);
      return { rows: result.rows, rowCount: result.rowCount };
    },

    async withClient<Out>(work: (client: DbClient) => Promise<Out>): Promise<Out> {
      const poolClient = await pool.connect();
      let discarded: Error | boolean | undefined;
      const client = clientOf(poolClient);
      client.discard = (reason) => {
        discarded = reason ?? true;
      };
      try {
        return await work(client);
      } finally {
        poolClient.release(discarded);
      }
    },

    async withTransaction<Out>(
      work: (tx: DbClient) => Promise<Out>,
      txOptions?: { isolation?: TransactionIsolation },
    ): Promise<Out> {
      const poolClient = await pool.connect();
      try {
        const begin =
          txOptions?.isolation === undefined
            ? "BEGIN"
            : (ISOLATION_SQL[txOptions.isolation] ?? "BEGIN");
        await poolClient.query(begin);
        let out: Out;
        try {
          out = await work(clientOf(poolClient));
        } catch (workError) {
          // Roll back and surface the ORIGINAL error; a failed rollback must
          // not mask it.
          try {
            await poolClient.query("ROLLBACK");
          } catch {
            // connection is broken — release() below returns it to be destroyed
          }
          throw workError;
        }
        await poolClient.query("COMMIT");
        return out;
      } finally {
        poolClient.release();
      }
    },

    async check(timeoutMilliseconds = 2000): Promise<boolean> {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolveFalse) => {
        timer = setTimeout(() => resolveFalse(false), timeoutMilliseconds);
      });
      const answered = this.query("SELECT 1").then(
        () => true,
        () => false,
      );
      try {
        return await Promise.race([answered, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },

    stats() {
      return {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      };
    },

    end() {
      return pool.end();
    },
  };
}
