// PCMS-NAV-T028 — `cms nav|route inspect|check`: deterministic JSON, exit
// codes, real product migrations on a disposable database.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { navCommand, routeCommand } from "@pcms/cli";
import { createDbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { cmsProcessEnv } from "../helpers/process-env.js";
import { createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

interface Fixture {
  configPath: string;
  dir: string;
  password: string | undefined;
}

async function fixture(t: { after: (fn: () => void) => void }): Promise<Fixture> {
  const db = await createTestDatabase(t);
  const dir = mkdtempSync(join(tmpdir(), "pcms-nav-cli-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(dir, { recursive: true });
  // Apply the real product migrations so the commands see the full schema.
  const pool = createDbPool({
    connectionInfo: {
      host: db.connection.host,
      port: db.connection.port,
      database: db.name,
      user: db.connection.user,
      sslMode: "disable",
      ...(db.connection.password === undefined ? {} : { password: db.connection.password }),
    },
    max: 2,
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await pool.end();
  const configPath = join(dir, "pcms.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      nodeEnv: "test",
      db: {
        host: db.connection.host,
        port: db.connection.port,
        database: db.name,
        user: db.connection.user,
        sslMode: "disable",
        migrationsDir: join(process.cwd(), "db/migrations"),
        ...(db.connection.password === undefined ? {} : { passwordSecretRef: "db.password" }),
        pool: { connectionTimeoutMilliseconds: 3000 },
      },
      secrets: {
        ...(db.connection.password === undefined
          ? {}
          : { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } }),
      },
    }),
    "utf8",
  );
  return { configPath, dir, password: db.connection.password };
}

function childEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return cmsProcessEnv({
    PCMS_CONFIG_FILE: fixture.configPath,
    ...(fixture.password === undefined || fixture.password === ""
      ? {}
      : { PCMS_SECRET_DB_PASSWORD: fixture.password }),
  });
}

test("nav check on an empty site reports required placements when a theme is given", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixtureDir = await fixture(t);
  const result = await navCommand({
    args: ["check", "--json", "--theme", "themes/reference-theme-v1"],
    env: childEnv(fixtureDir),
    cwd: process.cwd(),
  });
  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as { ok: boolean; issues: { code: string }[] };
  assert.equal(payload.ok, false);
  assert.ok(payload.issues.some((i) => i.code === "NAV_PLACEMENT_REQUIRED_MISSING"));
  // Deterministic output: same question, same answer.
  const again = await navCommand({
    args: ["check", "--json", "--theme", "themes/reference-theme-v1"],
    env: childEnv(fixtureDir),
    cwd: process.cwd(),
  });
  assert.equal(again.stdout, result.stdout);
});

test("route inspect and check emit deterministic JSON", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const fixtureDir = await fixture(t);
  const inspect = await routeCommand({
    args: ["inspect", "--json"],
    env: childEnv(fixtureDir),
    cwd: process.cwd(),
  });
  assert.equal(inspect.exitCode, 0, inspect.stderr);
  const payload = JSON.parse(inspect.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["domains", "policy", "redirects", "routes"]);
  assert.equal((payload.routes as unknown[]).length, 0);

  const again = await routeCommand({
    args: ["inspect", "--json"],
    env: childEnv(fixtureDir),
    cwd: process.cwd(),
  });
  assert.equal(again.stdout, inspect.stdout);

  const check = await routeCommand({
    args: ["check", "--json"],
    env: childEnv(fixtureDir),
    cwd: process.cwd(),
  });
  assert.equal(check.exitCode, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout), {
    ok: true,
    graphIssues: [],
    policyOk: true,
  });
});

test("usage errors exit 2 with the command synopsis", async () => {
  const empty = { env: process.env, cwd: process.cwd() };
  const badNav = await navCommand({ args: ["wat"], ...empty });
  assert.equal(badNav.exitCode, 2);
  const badRoute = await routeCommand({ args: ["--json"], ...empty });
  assert.equal(badRoute.exitCode, 2);
});
