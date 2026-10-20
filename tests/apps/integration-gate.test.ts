// PCMS-OPS-T010 — M01 integration gate. The full vertical slice, executed
// against real processes and a disposable PostgreSQL database:
//
//   typed config → config validation → cms db migrate (zero→current)
//   → web process (bounded pool, request IDs) → worker process
//   → health live/ready → readiness honesty when the DB disappears
//   → secrets never appear in any process output → graceful shutdown
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadMigrations } from "@pcms/core";
import { cmsProcessEnv } from "../helpers/process-env.js";
import { spawnPcmsProcess } from "../helpers/spawn-pcms.js";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const GATE_TIMEOUT_MS = 30_000;

async function gateSetup(t: {
  after: (fn: () => void) => void;
}): Promise<{ db: TestDatabase; configPath: string; dir: string }> {
  const db = await createTestDatabase(t);
  const dir = mkdtempSync(join(tmpdir(), "pcms-gate-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, "pcms.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      nodeEnv: "test",
      http: { port: 0, shutdownTimeoutMilliseconds: 5000 },
      db: {
        host: db.connection.host,
        port: db.connection.port,
        database: db.name,
        user: db.connection.user,
        sslMode: "disable",
        passwordSecretRef: "db.password",
        pool: { connectionTimeoutMilliseconds: 3000 },
      },
      log: { level: "info" },
      secrets: { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
    }),
    "utf8",
  );
  return { db, configPath, dir };
}

function gateEnv(configPath: string, db: TestDatabase): NodeJS.ProcessEnv {
  return cmsProcessEnv({
    PCMS_CONFIG_FILE: configPath,
    PCMS_SECRET_DB_PASSWORD: db.connection.password ?? "",
  });
}

test("M01 gate: migrate zero→current, web+worker+DB green, honest readiness, clean shutdown", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { db, configPath, dir } = await gateSetup(t);
  const env = gateEnv(configPath, db);

  // 1. Explicit migrations during "deploy" (Operations §12): zero → current.
  const migrateOutput = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/cli/src/bin/cms.ts",
      "db",
      "migrate",
      "--json",
      "--config",
      configPath,
    ],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );
  const migrate = JSON.parse(migrateOutput) as {
    ok: boolean;
    applied: string[];
    current: string | null;
  };
  assert.equal(migrate.ok, true);
  // Public installs apply the single canonical schema baseline.
  assert.deepEqual(
    migrate.applied,
    loadMigrations("db/migrations").map((migration) => migration.name),
  );
  assert.equal(migrate.current, migrate.applied[migrate.applied.length - 1] ?? null);
  // second run is a no-op (idempotent deploy step)
  const migrateAgain = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "packages/cli/src/bin/cms.ts",
        "db",
        "migrate",
        "--json",
        "--config",
        configPath,
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    ),
  ) as { applied: string[] };
  assert.deepEqual(migrateAgain.applied, []);

  // 2. Both processes start against the migrated database (independent units).
  const web = spawnPcmsProcess("apps/web/src/main.ts", ["--config", configPath], env);
  const worker = spawnPcmsProcess("apps/worker/src/main.ts", ["--config", configPath], env);
  t.after(() => {
    web.child.kill("SIGKILL");
    worker.child.kill("SIGKILL");
  });
  const webReady = await web.waitFor("web.ready", GATE_TIMEOUT_MS);
  await worker.waitFor("worker.ready", GATE_TIMEOUT_MS);
  await worker.waitFor("worker.db.available", GATE_TIMEOUT_MS);
  const address = String(webReady.address);
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);

  // 3. Health: live and ready agree with reality.
  const live = await fetch(`${address}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });
  const ready = await fetch(`${address}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  // 4. Request IDs flow through the web process logs (structured logging).
  const unknown = await fetch(`${address}/no-such-route`);
  assert.equal(unknown.status, 404);
  // onResponse logging happens as the response completes — poll briefly.
  let requestLine: Record<string, unknown> | undefined;
  for (let waited = 0; waited < 2000 && !requestLine; waited += 50) {
    requestLine = web.lines.find(
      (line) => line.msg === "http.request" && line.url === "/no-such-route",
    ) as Record<string, unknown> | undefined;
    if (!requestLine) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(requestLine, "http.request line for the 404 must exist");
  assert.match(String(requestLine.request_id), /^[0-9a-f-]{36}$/);
  assert.equal(requestLine.status_code, 404);
  assert.equal(requestLine.process, "pcms-web");

  // 5. Readiness honesty: destroy the dependency while everything is running.
  execFileSync(
    "psql",
    [
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      db.connection.host,
      "-p",
      String(db.connection.port),
      "-U",
      db.connection.user,
      "-d",
      "postgres",
      "-c",
      `DROP DATABASE "${db.name}" WITH (FORCE)`,
    ],
    {
      env:
        db.connection.password === undefined
          ? process.env
          : { ...process.env, PGPASSWORD: db.connection.password },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const readyAfterDrop = await fetch(`${address}/health/ready`);
  assert.equal(readyAfterDrop.status, 503, "readiness must report the broken dependency");
  assert.deepEqual(await readyAfterDrop.json(), { status: "not_ready" });
  const liveAfterDrop = await fetch(`${address}/health/live`);
  assert.equal(liveAfterDrop.status, 200, "liveness is independent of the database");
  await worker.waitFor("worker.db.unavailable", GATE_TIMEOUT_MS);

  // 6. Secrets never reach any process output (redaction + secret-bag design).
  const password = db.connection.password ?? "";
  if (password !== "") {
    for (const [name, proc] of [
      ["web", web],
      ["worker", worker],
    ] as const) {
      const dump = JSON.stringify(proc.lines);
      assert.equal(
        dump.includes(password),
        false,
        `${name} output must not contain the DB password`,
      );
    }
  }

  // 7. Graceful shutdown: both processes exit 0 on SIGTERM.
  web.stop();
  worker.stop();
  assert.equal(await web.exited, 0, "web exits 0 after SIGTERM");
  assert.equal(await worker.exited, 0, "worker exits 0 after SIGTERM");
});
