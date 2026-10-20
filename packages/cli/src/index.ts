// CLI transport (L2). M01 hosts the minimal `cms` binary: config validate
// (PCMS-OPS-T002) and db migrate (PCMS-OPS-T005). The full CLI framework
// lands in M09 (PCMS-API-T022).
export {
  configLoadOptions,
  exitCodeForError,
  failureResult,
  type GlobalOptions,
  jsonPayload,
  parseGlobalOptions,
  requireTargetSafety,
} from "./framework.js";

export const PACKAGE_NAME = "@pcms/cli";

export { type ConfigValidateResult, configValidate } from "./commands/config-validate.js";
export { type DbMigrateResult, dbMigrate } from "./commands/db-migrate.js";
export { navCommand, routeCommand } from "./commands/nav-route.js";
export { siteValidate } from "./commands/site-validate.js";
export { themeValidate } from "./commands/theme-validate.js";
export { runCli } from "./main.js";
