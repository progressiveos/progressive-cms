// Composition helper: config + resolved secrets → driver connection info.
// The config never carried the password; this is the only place the pieces
// meet (Operations spec §9/§11).

import { readFileSync } from "node:fs";
import type { AppConfig } from "../config/schema.js";
import { type ResolvedSecrets, SecretError } from "../secrets/secrets.js";
import type { DbConnectionInfo } from "./pool.js";

export function buildDbConnectionInfo(
  db: AppConfig["db"],
  secrets: ResolvedSecrets,
): DbConnectionInfo {
  let password: string | undefined;
  if (db.passwordSecretRef !== undefined) {
    password = secrets.get(db.passwordSecretRef);
    if (password === undefined) {
      throw new SecretError(`db password secret "${db.passwordSecretRef}" is not loaded`, [
        {
          name: db.passwordSecretRef,
          message: "referenced by db.passwordSecretRef but not loaded",
        },
      ]);
    }
  }
  let sslCa: string | undefined;
  if (db.sslCaFile !== undefined) {
    try {
      sslCa = readFileSync(db.sslCaFile, "utf8");
    } catch (error) {
      throw new SecretError(`cannot read db.sslCaFile "${db.sslCaFile}"`, [
        { name: "db.sslCaFile", message: error instanceof Error ? error.message : String(error) },
      ]);
    }
  }
  const info: DbConnectionInfo = {
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    sslMode: db.sslMode,
    ...(password === undefined ? {} : { password }),
    ...(sslCa === undefined ? {} : { sslCa }),
  };
  return info;
}
