// Admin browser-acceptance server (PCMS-ADMIN-T026..T028; Admin spec §64).
// Dev/test-only: boots a disposable PostgreSQL database, applies migrations,
// seeds the owner, and serves the production Admin bundle + /api/v1 on :8788
// for Playwright. Run via the Playwright webServer entry, not manually:
//   node --import tsx scripts/admin-e2e-server.mts --port 8788
//
// Without PCMS_TEST_DATABASE_URL the script serves a healthy-but-empty
// fallback so Playwright can start; the specs themselves skip when the env
// is absent (same skip-honesty contract as the node integration tests).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvisioningService, createRoleService } from "@pcms/auth";
import { createDbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { buildWebRuntime } from "../apps/web/src/main.js";

const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] ?? "8788");
const DB_NAME = `pcms_admin_e2e_${randomUUID().replaceAll("-", "")}`;
const BASE_URL = process.env.PCMS_TEST_DATABASE_URL;

function fallback(): never {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "e2e-database-not-configured" }));
    void request;
  });
  server.listen(PORT, "127.0.0.1");
  console.log(JSON.stringify({ msg: "admin.e2e.fallback", port: PORT }));
  // Playwright specs skip without the env; keep the server until killed.
  setInterval(() => undefined, 60_000).unref();
  throw new Error("unreachable");
}

if (BASE_URL === undefined || BASE_URL === "") {
  fallback();
}

interface BaseConnection {
  host: string;
  port: string;
  user: string;
  password: string | undefined;
  database: string;
}

function parseBase(url: string): BaseConnection {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port || "5432",
    user: decodeURIComponent(parsed.username),
    password: parsed.password === "" ? undefined : decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

const base = parseBase(BASE_URL as string);
const psql = (database: string, sql: string): void => {
  execFileSync(
    "psql",
    [
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
      "-c",
      sql,
    ],
    {
      env:
        base.password === undefined ? process.env : { ...process.env, PGPASSWORD: base.password },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
};

// A unique name ensures this run never drops another test or user database.
psql(base.database, `CREATE DATABASE "${DB_NAME}"`);

const workDir = mkdtempSync(join(tmpdir(), "pcms-admin-e2e-"));
const corpus = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: readonly unknown[] };
const typesFile = join(workDir, "content-types.json");
writeFileSync(typesFile, JSON.stringify(corpus.contentTypes));
const mediaDir = join(workDir, "media");
const quarantineDir = join(workDir, "quarantine");

const ownerPassword = process.env.PCMS_ADMIN_E2E_OWNER_PASSWORD ?? "e2e-Owner-Pass-2026!";
const config = {
  nodeEnv: "development",
  // The entire browser corpus shares one loopback IP and drives API setup at
  // machine speed; retain the limiter with a corpus-sized budget. Production
  // continues to use its normal configured/default budget.
  http: {
    host: "127.0.0.1",
    port: PORT,
    shutdownTimeoutMilliseconds: 5000,
    apiRateLimitPerMinute: 10000,
  },
  db: {
    host: base.host,
    port: Number.parseInt(base.port, 10),
    database: DB_NAME,
    user: base.user,
    passwordSecretRef: "db.password",
    sslMode: "disable",
    migrationsDir: "db/migrations",
    pool: {
      webMax: 10,
      workerMax: 5,
      connectionTimeoutMilliseconds: 5000,
      idleTimeoutMilliseconds: 30000,
    },
  },
  log: { level: "info" },
  media: {
    storageDir: mediaDir,
    quarantineDir,
    maxUploadBytes: 33_554_432,
    maxImagePixels: 100_000_000,
    maxImageDimension: 12000,
  },
  themes: { renderDir: "themes/reference-theme-v1" },
  content: { typesFile },
  publication: { previewSecretRef: "publication.preview" },
  auth: { mfa: { totpEncryptionKeySecretRef: "auth.totp" } },
  secrets: {
    "db.password": { env: "PCMS_SECRET_DB_PASSWORD" },
    "publication.preview": { env: "PCMS_SECRET_E2E_PREVIEW" },
    "auth.totp": { env: "PCMS_SECRET_E2E_TOTP" },
  },
};
const configFile = join(workDir, "pcms-e2e.json");
writeFileSync(configFile, JSON.stringify(config));

// The production web composition reads theme state while registering public
// routes, so migrate the disposable database before constructing the runtime.
const migrationPool = createDbPool({
  connectionInfo: {
    host: base.host,
    port: Number.parseInt(base.port, 10),
    database: DB_NAME,
    user: base.user,
    ...(base.password === undefined ? {} : { password: base.password }),
    sslMode: "disable",
  },
  max: 1,
  connectionTimeoutMilliseconds: 5000,
});
try {
  await migrateDatabase(migrationPool, loadMigrations("db/migrations"), undefined);
} finally {
  await migrationPool.end();
}

const runtime = await buildWebRuntime({
  file: configFile,
  // Only the secret values the config references — extra PCMS_* vars are
  // rejected by the fail-secure config loader (ADR-0004).
  env: {
    PCMS_SECRET_DB_PASSWORD: base.password ?? "",
    PCMS_SECRET_E2E_PREVIEW: "e2e-preview-secret-0123456789abcdef0123",
    PCMS_SECRET_E2E_TOTP: "0123456789abcdef0123456789abcdef",
  },
});

const provisioning = createProvisioningService(runtime.pool, {
  users: runtime.application.users,
  passwords: runtime.application.passwords,
  policy: runtime.application.passwordPolicy,
  roles: createRoleService(runtime.pool),
});
await runtime.application.routes.ensureSite("default");
const owner = await provisioning.bootstrapOwner({
  displayName: "E2E Owner",
  email: "owner@example.com",
  password: ownerPassword,
});

const address = await runtime.fastify.listen({ port: PORT, host: "127.0.0.1" });
runtime.logger.info("admin.e2e.ready", {
  operation: "admin.e2e",
  address,
  owner_email: "owner@example.com",
  owner_id: owner.id,
});

const shutdown = async () => {
  await runtime.fastify.close();
  await runtime.pool.end();
  psql(base.database, `DROP DATABASE "${DB_NAME}" WITH (FORCE)`);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
