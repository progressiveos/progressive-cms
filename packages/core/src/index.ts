// CMS Core owns identity, lifecycle, transactions, invariants, versioning,
// authorization, publication state, audit and extension boundaries
// (Architecture Baseline v0.2 §7). M01 adds the generic runtime kernel:
// typed configuration, and in later tasks DB pool/transactions, migration
// runner, structured logging and secret loading.
export const PACKAGE_NAME = "@pcms/core";

export { type Clock, fixedClock, systemClock } from "./clock.js";
export {
  ConfigError,
  type ConfigIssue,
  type ConfigValidation,
  type LoadConfigOptions,
  loadConfig,
  resolveConfigFile,
  validateConfigDocument,
} from "./config/loader.js";
export {
  type AppConfig,
  CONFIG_SCHEMA,
  CONFIG_SCHEMA_VERSION,
  type DbSslMode,
  type LogLevel,
  type NodeEnv,
  type SecretRef,
} from "./config/schema.js";
export { buildDbConnectionInfo } from "./db/connection.js";
export {
  loadMigrations,
  MIGRATIONS_TABLE,
  type MigrateResult,
  type Migration,
  type MigrationStatus,
  migrateDatabase,
  migrationStatus,
} from "./db/migrator.js";
export {
  createDbPool,
  type DbClient,
  type DbConnectionInfo,
  type DbPool,
  type DbPoolOptions,
  type DbQueryResult,
  type TransactionIsolation,
} from "./db/pool.js";
export { escapeHtmlString, injectAfterOpeningTag } from "./html.js";
export { isStableId, newStableId, type StableId } from "./ids/stable-id.js";
export { type GracefulShutdownOptions, installSignalHandlers } from "./lifecycle.js";
export {
  createLogger,
  currentLogContext,
  type LogContext,
  type LogFields,
  type Logger,
  type LoggerOptions,
  newRequestId,
  redactFields,
  runWithLogContext,
  serializeError,
} from "./logging/logger.js";
export {
  loadSecrets,
  type ResolvedSecrets,
  SecretError,
  type SecretIssue,
} from "./secrets/secrets.js";
