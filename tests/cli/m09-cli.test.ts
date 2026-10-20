// PCMS-API-T022..T025 — CLI framework and the M09 command generation:
// --json determinism, §57 exit codes, config profiles, target safety,
// content/media/publication/doctor commands.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "@pcms/cli";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { connectionInfoOf } from "../helpers/api-composition.js";
import { createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

const CONTENT_TYPES = [
  {
    key: "page",
    version: 1,
    title: "Page",
    bodyPolicy: "block_document",
    fields: { title: { id: "title", type: "string", required: true, sortable: true } },
  },
];

/**
 * runCli reads process.env; the owner .env carries stray PCMS_* overrides
 * that a minimal test config must reject (known owner ergonomics debt, #101).
 * Sanitize like tests/helpers/process-env.ts does for spawned processes.
 */
function sanitizeEnv(keep: readonly string[] = []): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PCMS_") && !keep.includes(key)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
  }
}

interface TempDir {
  readonly dir: string;
  readonly typesFile: string;
}

function makeTempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "pcms-cli-"));
  const typesFile = join(dir, "content-types.json");
  writeFileSync(typesFile, JSON.stringify(CONTENT_TYPES));
  return { dir, typesFile };
}

test("CLI: capabilities/info --json are deterministic, usage errors exit 2 (T022)", async () => {
  const first = await runCli(["capabilities", "--json"]);
  const second = await runCli(["capabilities", "--json"]);
  assert.equal(first.exitCode, 0);
  assert.equal(first.stdout, second.stdout, "machine output is deterministic");
  const payload = JSON.parse(first.stdout) as { ok: boolean; permissions: { key: string }[] };
  assert.equal(payload.ok, true);
  assert.ok(payload.permissions.length >= 60);

  const unknown = await runCli(["definitely-not-a-command"]);
  assert.equal(unknown.exitCode, 2);
  assert.ok(unknown.stderr.startsWith("usage: cms"));
});

test("CLI: content schema list/show/validate over a configured types file (T023)", async () => {
  const { dir, typesFile } = makeTempDir();
  const env = { PCMS_SECRET_DB_PASSWORD: undefined };
  const shared = { "--config": join(dir, "pcms.json") };
  writeFileSync(
    shared["--config"]!,
    JSON.stringify({
      nodeEnv: "test",
      http: { host: "127.0.0.1", port: 3000, shutdownTimeoutMilliseconds: 5000 },
      db: {
        host: "127.0.0.1",
        port: 5432,
        database: "pcms",
        user: "pcms",
        sslMode: "disable",
        migrationsDir: "db/migrations",
        pool: {
          webMax: 2,
          workerMax: 1,
          connectionTimeoutMilliseconds: 3000,
          idleTimeoutMilliseconds: 30000,
        },
      },
      log: { level: "info" },
      secrets: {},
      content: { typesFile },
    }),
  );
  void env;
  const global = ["--config", shared["--config"]!];
  const savedEnv = sanitizeEnv();

  try {
    const list = await runCli(["content", "schema", "list", "--json", ...global]);
    assert.equal(list.exitCode, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), {
      ok: true,
      items: [{ key: "page", version: 1, title: "Page", bodyPolicy: "block_document" }],
    });

    const show = await runCli(["content", "schema", "show", "page", "--json", ...global]);
    assert.equal(show.exitCode, 0);
    assert.equal((JSON.parse(show.stdout) as { key: string }).key, "page");

    const payloadFile = join(dir, "payload.json");
    writeFileSync(
      payloadFile,
      JSON.stringify({
        content_type: "page",
        payload: { fields: { title: "CLI page" }, blocks: { schema_version: 1, blocks: [] } },
      }),
    );
    const valid = await runCli(["content", "validate", payloadFile, "--json", ...global]);
    assert.equal(valid.exitCode, 0, valid.stderr);

    writeFileSync(
      payloadFile,
      JSON.stringify({
        content_type: "page",
        payload: { fields: {}, blocks: { schema_version: 1, blocks: [] } },
      }),
    );
    const invalid = await runCli(["content", "validate", payloadFile, "--json", ...global]);
    assert.equal(invalid.exitCode, 3, "validation failure exits 3");
    const report = JSON.parse(invalid.stdout) as { ok: boolean; issues: { code: string }[] };
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === "FIELD_REQUIRED"));
  } finally {
    restoreEnv(savedEnv);
  }

  rmSync(dir, { recursive: true, force: true });
});

test("CLI: dangerous publication commands refuse without explicit target (T024)", async () => {
  const refusal = await runCli(["publication", "apply", "01900000-0000-7000-8000-000000000001"]);
  assert.equal(refusal.exitCode, 2);
  assert.ok(refusal.stderr.includes("--environment"));

  const jsonRefusal = await runCli([
    "publication",
    "publish-now",
    "01900000-0000-7000-8000-000000000001",
    "01900000-0000-7000-8000-000000000002",
    "--json",
  ]);
  assert.equal(jsonRefusal.exitCode, 2);
  const body = JSON.parse(jsonRefusal.stdout) as { error: { code: string } };
  assert.equal(body.error.code, "TARGET_UNCONFIRMED");

  // Without API credentials even an explicit target fails as usage/setup (2).
  const unconfigured = await runCli([
    "publication",
    "apply",
    "01900000-0000-7000-8000-000000000001",
    "--environment",
    "prod",
    "--yes",
  ]);
  assert.equal(unconfigured.exitCode, 2);
});

test("CLI: exit-code mapping for stable codes (spec §57)", async () => {
  const { exitCodeForError } = await import("@pcms/cli");
  const cases: readonly [string, number][] = [
    ["PUBLICATION_CONFLICT", 4],
    ["AUTH_PERMISSION_DENIED", 5],
    ["ENTRY_NOT_FOUND", 6],
    ["AUTH_THROTTLED", 7],
    ["REVISION_VALIDATION_FAILED", 3],
    ["WHATEVER_UNMAPPED", 1],
  ];
  for (const [code, expected] of cases) {
    assert.equal(exitCodeForError(Object.assign(new Error("x"), { code })), expected, code);
  }
});

test("CLI: doctor and media over a real migrated database (T025/T023)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  let pool: DbPool | null = null;
  try {
    pool = createDbPool({
      connectionInfo: connectionInfoOf(db),
      max: 2,
      connectionTimeoutMilliseconds: 5000,
    });
    await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
    void pool;

    const { dir } = makeTempDir();
    const configFile = join(dir, "pcms.json");
    const info = connectionInfoOf(db);
    writeFileSync(
      configFile,
      JSON.stringify({
        nodeEnv: "test",
        http: { host: "127.0.0.1", port: 3000, shutdownTimeoutMilliseconds: 5000 },
        db: {
          host: info.host,
          port: info.port,
          database: info.database,
          user: info.user,
          ...(info.password === undefined ? {} : { passwordSecretRef: "db.password" }),
          sslMode: "disable",
          migrationsDir: "db/migrations",
          pool: {
            webMax: 2,
            workerMax: 1,
            connectionTimeoutMilliseconds: 3000,
            idleTimeoutMilliseconds: 30000,
          },
        },
        log: { level: "info" },
        secrets:
          info.password === undefined ? {} : { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
        themes: {},
      }),
    );

    const savedEnv = sanitizeEnv(["PCMS_SECRET_DB_PASSWORD"]);
    const doctor = await runCli(["doctor", "--json", "--config", configFile]);
    assert.equal(doctor.exitCode, 0, doctor.stdout);
    const doctorBody = JSON.parse(doctor.stdout) as {
      ok: boolean;
      checks: { name: string; ok: boolean }[];
    };
    assert.equal(doctorBody.ok, true);
    assert.ok(doctorBody.checks.some((check) => check.name === "database" && check.ok));

    const media = await runCli(["media", "list", "--json", "--config", configFile]);
    assert.equal(media.exitCode, 0, media.stdout);
    // 0.1.196: the local DB mode shares the paginated envelope of the API mode.
    assert.deepEqual(JSON.parse(media.stdout), {
      ok: true,
      items: [],
      count: 0,
      next_cursor: null,
      has_more: false,
      complete: true,
      total: 0,
    });
    restoreEnv(savedEnv);

    rmSync(dir, { recursive: true, force: true });
  } finally {
    if (pool !== null) void pool.end();
  }
});
