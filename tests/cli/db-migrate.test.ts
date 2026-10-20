// PCMS-OPS-T005 — `cms db migrate` CLI: applies migrations via config +
// secret channel, --check semantics, exit codes, JSON output.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DbMigrateResult, dbMigrate } from "@pcms/cli";
import type { Logger } from "@pcms/core";
import { cmsProcessEnv } from "../helpers/process-env.js";
import {
  connectionInfo,
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

interface CliFixture {
  db: TestDatabase;
  configPath: string;
  migrationsDir: string;
  dir: string;
}

function silentLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    withContext: () => logger,
  };
  return logger;
}

async function fixtureWith(
  t: { after: (fn: () => void) => void },
  migrations: Record<string, string>,
): Promise<CliFixture> {
  const db = await createTestDatabase(t);
  const dir = mkdtempSync(join(tmpdir(), "pcms-migrate-cli-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const migrationsDir = join(dir, "migrations");
  mkdirSync(migrationsDir);
  for (const [name, sql] of Object.entries(migrations)) {
    writeFileSync(join(migrationsDir, name), sql, "utf8");
  }
  const configPath = join(dir, "pcms.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      nodeEnv: "test",
      db: {
        // No password value in the config file — only the named secret ref.
        host: db.connection.host,
        port: db.connection.port,
        database: db.name,
        user: db.connection.user,
        sslMode: "disable",
        migrationsDir,
        passwordSecretRef: "db.password",
        pool: { connectionTimeoutMilliseconds: 3000 },
      },
      secrets: { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
    }),
    "utf8",
  );
  return { db, configPath, migrationsDir, dir };
}

function childEnv(fixture: CliFixture): NodeJS.ProcessEnv {
  const password = fixture.db.connection.password;
  return cmsProcessEnv({
    PCMS_SECRET_DB_PASSWORD: password ?? "",
    PCMS_CONFIG_FILE: fixture.configPath,
  });
}

function expectOk(result: DbMigrateResult, code: 0 | 1 = 0): Record<string, unknown> {
  assert.equal(result.exitCode, code, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("cms db migrate applies pending migrations and reports current version", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await fixtureWith(t, { "0001_first.sql": "CREATE TABLE cli_t (id int);" });

  // --check before migrating: pending → exit 1
  const checkPending = await dbMigrate({
    args: ["--check", "--json"],
    env: childEnv(fixture),
    cwd: fixture.dir,
    logger: silentLogger(),
  });
  assert.deepEqual(expectOk(checkPending, 1).pending, ["0001_first"]);

  const migrate = await dbMigrate({
    args: ["--json"],
    env: childEnv(fixture),
    cwd: fixture.dir,
    logger: silentLogger(),
  });
  const migratePayload = expectOk(migrate, 0);
  assert.deepEqual(migratePayload.applied, ["0001_first"]);
  assert.equal(migratePayload.current, "0001_first");

  const again = await dbMigrate({
    args: ["--json"],
    env: childEnv(fixture),
    cwd: fixture.dir,
    logger: silentLogger(),
  });
  assert.deepEqual(expectOk(again, 0).applied, []);
  const checkClean = await dbMigrate({
    args: ["--check", "--json"],
    env: childEnv(fixture),
    cwd: fixture.dir,
    logger: silentLogger(),
  });
  assert.equal(expectOk(checkClean, 0).ok, true);

  const human = await dbMigrate({
    args: [],
    env: childEnv(fixture),
    cwd: fixture.dir,
    logger: silentLogger(),
  });
  assert.equal(human.exitCode, 0);
  assert.match(human.stdout, /result: MIGRATED/);
  assert.match(human.stdout, /\(nothing to do\)/);
});

test("cms db migrate fails securely on an unresolvable secret", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixture = await fixtureWith(t, { "0001_first.sql": "CREATE TABLE x (id int);" });
  const result = await dbMigrate({
    args: ["--json"],
    env: cmsProcessEnv({ PCMS_CONFIG_FILE: fixture.configPath }), // secret env missing
    cwd: fixture.dir,
    logger: silentLogger(),
  });
  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as { ok: boolean; error: string };
  assert.equal(payload.ok, false);
  assert.match(payload.error, /PCMS_SECRET_DB_PASSWORD/);
});

test("cms db migrate reports configuration problems and usage errors", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-migrate-cli-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  // bad config: sslMode missing → invalid
  const badConfig = join(dir, "bad.json");
  writeFileSync(
    badConfig,
    JSON.stringify({
      nodeEnv: "test",
      db: { host: "127.0.0.1", port: 5432, database: "x", user: "y" },
    }),
    "utf8",
  );
  const bad = await dbMigrate({
    args: ["--json", "--config", badConfig],
    env: cmsProcessEnv(),
    cwd: dir,
    logger: silentLogger(),
  });
  assert.equal(bad.exitCode, 1);

  // migrations dir absent → clear error
  const noDirConfig = join(dir, "nodir.json");
  writeFileSync(
    noDirConfig,
    JSON.stringify({
      nodeEnv: "test",
      db: {
        host: "127.0.0.1",
        port: 1,
        database: "x",
        user: "y",
        sslMode: "disable",
        migrationsDir: "absent",
      },
    }),
    "utf8",
  );
  const noDir = await dbMigrate({
    args: ["--json", "--config", noDirConfig],
    env: cmsProcessEnv(),
    cwd: dir,
    logger: silentLogger(),
  });
  assert.equal(noDir.exitCode, 1);
  assert.match((JSON.parse(noDir.stdout) as { error: string }).error, /migrations directory/);

  // usage error
  const usage = await dbMigrate({
    args: ["--bogus"],
    env: cmsProcessEnv(),
    cwd: dir,
    logger: silentLogger(),
  });
  assert.equal(usage.exitCode, 2);
  assert.match(usage.stderr, /usage: cms db migrate/);
});
