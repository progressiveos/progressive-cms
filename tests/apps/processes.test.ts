// PCMS-OPS-T007 — app/worker process skeletons: independent startup with
// real config+secrets+pool, structured ready logs, graceful SIGTERM shutdown,
// fail-secure startup on invalid config.
import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { cmsProcessEnv } from "../helpers/process-env.js";
import {
  connectionInfo,
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const READY_TIMEOUT_MS = 20_000;
type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;

interface ProcessHandle {
  child: SpawnedChild;
  lines: Record<string, unknown>[];
  readyLine: Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
  stop: () => void;
}

function spawnProcess(
  entry: "apps/web/src/main.ts" | "apps/worker/src/main.ts",
  configPath: string,
  db: TestDatabase,
): ProcessHandle {
  const child = spawn(process.execPath, ["--import", "tsx", entry, "--config", configPath], {
    cwd: process.cwd(),
    env: cmsProcessEnv({ PCMS_SECRET_DB_PASSWORD: db.connection.password ?? "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Record<string, unknown>[] = [];
  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer = `${stderrBuffer}${chunk.toString()}`.slice(-4000);
  });
  let stdoutBuffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    for (;;) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        lines.push({ raw: line });
      }
    }
  });
  const readyMsg = entry.startsWith("apps/web") ? "web.ready" : "worker.ready";
  const readyLine = new Promise<Record<string, unknown>>((resolveReady, rejectReady) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    let poll: NodeJS.Timeout;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      callback();
    };
    timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        rejectReady(
          new Error(
            `${readyMsg} not observed within ${READY_TIMEOUT_MS}ms; saw: ${JSON.stringify(lines)}; stderr: ${stderrBuffer.replaceAll(db.connection.password ?? "\0", "[redacted]")}`,
          ),
        );
      });
    }, READY_TIMEOUT_MS);
    poll = setInterval(() => {
      const found = lines.find((line) => line.msg === readyMsg);
      if (found) finish(() => resolveReady(found));
    }, 50);
    child.once("exit", (code, signal) => {
      finish(() =>
        rejectReady(
          new Error(
            `${readyMsg} process exited before readiness (${code ?? signal}); stderr: ${stderrBuffer.replaceAll(db.connection.password ?? "\0", "[redacted]")}`,
          ),
        ),
      );
    });
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => resolveExit(code));
  });
  return { child, lines, readyLine, exited, stop: () => child.kill("SIGTERM") };
}

function waitForLog(handle: ProcessHandle, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      handle.child.off("exit", onExit);
      callback();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() =>
        reject(new Error(`${message} not observed before process exit (${code ?? signal})`)),
      );
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`${message} not observed within ${READY_TIMEOUT_MS}ms`)));
    }, READY_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (handle.lines.some((line) => line.msg === message)) finish(resolve);
    }, 50);
    handle.child.once("exit", onExit);
  });
}

async function writeProcessConfig(
  t: { after: (fn: () => void) => void },
  db: TestDatabase,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pcms-process-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const configPath = join(dir, "pcms.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      nodeEnv: "test",
      http: { port: 0 }, // OS-assigned port; web readiness proven via log line
      db: {
        host: db.connection.host,
        port: db.connection.port,
        database: db.name,
        user: db.connection.user,
        sslMode: "disable",
        passwordSecretRef: "db.password",
      },
      log: { level: "info" },
      secrets: { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
    }),
    "utf8",
  );
  return configPath;
}

test("web and worker start independently on a shared foundation and shut down cleanly", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const configPath = await writeProcessConfig(t, db);

  const web = spawnProcess("apps/web/src/main.ts", configPath, db);
  const worker = spawnProcess("apps/worker/src/main.ts", configPath, db);
  t.after(() => {
    web.child.kill("SIGKILL");
    worker.child.kill("SIGKILL");
  });

  const [webReady, workerReady] = await Promise.all([web.readyLine, worker.readyLine]);
  // structured logs carry process base fields and request/operation context
  assert.equal(webReady.process, "pcms-web");
  assert.equal(webReady.operation, "web.boot");
  assert.equal(workerReady.process, "pcms-worker");
  assert.equal(workerReady.operation, "worker.boot");

  // worker keeps an honest DB probe: available on a live database
  await waitForLog(worker, "worker.db.available");

  web.stop();
  worker.stop();
  assert.equal(await web.exited, 0, "web must exit 0 after SIGTERM");
  assert.equal(await worker.exited, 0, "worker must exit 0 after SIGTERM");

  // shutdown completion is logged, not just silent exit
  assert.ok(web.lines.some((line) => line.msg === "web.shutdown.complete"));
  assert.ok(worker.lines.some((line) => line.msg === "worker.shutdown.complete"));
});

test("processes fail securely on invalid configuration", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const dir = mkdtempSync(join(tmpdir(), "pcms-process-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  // sslMode omitted → invalid config (fail-secure, no insecure default)
  const badConfig = join(dir, "bad.json");
  writeFileSync(
    badConfig,
    JSON.stringify({
      nodeEnv: "test",
      db: {
        host: db.connection.host,
        port: db.connection.port,
        database: db.name,
        user: db.connection.user,
      },
    }),
    "utf8",
  );
  for (const entry of ["apps/web/src/main.ts", "apps/worker/src/main.ts"] as const) {
    const child = spawn(process.execPath, ["--import", "tsx", entry, "--config", badConfig], {
      cwd: process.cwd(),
      env: cmsProcessEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = await new Promise<string>((resolveStderr) => {
      let text = "";
      child.stderr.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      child.on("exit", () => resolveStderr(text));
    });
    assert.equal(child.exitCode, 1, `${entry} must exit 1 on invalid config`);
    assert.match(stderr, /startup failed|sslMode/);
  }
});
