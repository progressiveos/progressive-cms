// Rec 1 regression (152fz, 0.1.209 follow-up): the doctor
// published-template-coverage check queried a non-existent `content_types`
// table and joined uuid to text — it could never run against a real
// deployment and always skipped as ok. The orphan query must execute
// against the REAL migrated schema (entries.content_type_id is the type
// key as text; routes.target_id is text) and honor the live version:
// typesFile base, overridden by pcms_content_type_overrides.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "@pcms/cli";
import { createDbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import { __publishedOrphanTypes } from "../../packages/cli/src/commands/diagnostics.js";
import { connectionInfoOf } from "../helpers/api-composition.js";
import { createTestDatabase, testDatabaseConfigured } from "../helpers/testdb.js";

async function migratedPool(t: { after: (fn: () => void) => void }) {
  const { createTestDatabase: createDb, testDatabaseConfigured: configured } = await import(
    "../helpers/testdb.js"
  );
  if (!configured()) return null;
  const db = await createDb(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 2,
    connectionTimeoutMilliseconds: 5000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  return pool;
}

async function seedPublishedEntry(
  pool: NonNullable<Awaited<ReturnType<typeof migratedPool>>>,
  options: { key: string; retired?: boolean },
): Promise<void> {
  const siteId = randomUUID();
  const entryId = randomUUID();
  await pool.query("INSERT INTO sites (id, key, title) VALUES ($1, $2, $3)", [
    siteId,
    `site-${siteId.slice(0, 8)}`,
    "coverage test",
  ]);
  await pool.query(
    "INSERT INTO entries (id, content_type_id, created_by) VALUES ($1, $2, 'test')",
    [entryId, options.key],
  );
  await pool.query(
    "INSERT INTO routes (id, site_id, path, target_type, target_id, retired_at) VALUES ($1, $2, $3, 'entry', $4, $5)",
    [
      randomUUID(),
      siteId,
      `/seed/${options.key}/`,
      entryId,
      options.retired === true ? new Date() : null,
    ],
  );
}

test("coverage: accepting template passes; unaccepted and version-bumped types are named orphans", async (t) => {
  const pool = await migratedPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");

  await seedPublishedEntry(pool, { key: "service" });
  await seedPublishedEntry(pool, { key: "case" });
  await seedPublishedEntry(pool, { key: "ghost" });
  await seedPublishedEntry(pool, { key: "retired", retired: true });
  await pool.query(
    "INSERT INTO pcms_content_type_overrides (content_type_id, version, definition, updated_by) VALUES ('service', 2, $1, 'test')",
    [JSON.stringify({ key: "service", version: 2 })],
  );

  const orphans = await __publishedOrphanTypes(
    pool,
    [{ accepts_content_types: ["service@1", "case"] }],
    { service: 1, case: 1 },
  );

  // service: override bumps the live version to 2 — "service@1" no longer
  // covers it. case: plain "case" accepts any version. ghost: no template
  // at all. retired: live routes only. Ordered by type key (ORDER BY 1).
  assert.deepEqual(orphans, ["ghost (published: 1)", "service@2 (published: 1)"]);
});

test("coverage: plain key template accepts the version-bumped live type", async (t) => {
  const pool = await migratedPool(t);
  if (pool === null) return t.skip("PCMS_TEST_DATABASE_URL is not set");

  await seedPublishedEntry(pool, { key: "service" });
  await pool.query(
    "INSERT INTO pcms_content_type_overrides (content_type_id, version, definition, updated_by) VALUES ('service', 3, $1, 'test')",
    [JSON.stringify({ key: "service", version: 3 })],
  );

  const orphans = await __publishedOrphanTypes(pool, [{ accepts_content_types: ["service"] }], {
    service: 1,
  });
  assert.deepEqual(orphans, []);
});

// End-to-end: the actual `cms doctor` wiring (theme.json + typesFile read,
// pool, check rendering) must produce a REAL verdict — never a silent
// "skipped" like the broken 0.1.208 query did.
test("doctor e2e: published-template-coverage names the orphan, not skipped", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 2,
    connectionTimeoutMilliseconds: 5000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await seedPublishedEntry(pool, { key: "service" });
  // API-applied override bumps the live version: "service@1" in the theme
  // no longer covers it.
  await pool.query(
    "INSERT INTO pcms_content_type_overrides (content_type_id, version, definition, updated_by) VALUES ('service', 2, $1, 'test')",
    [JSON.stringify({ key: "service", version: 2 })],
  );

  const dir = mkdtempSync(join(tmpdir(), "pcms-coverage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const typesFile = join(dir, "content-types.json");
  writeFileSync(typesFile, JSON.stringify([{ key: "service", version: 1 }]));
  writeFileSync(
    join(dir, "theme.json"),
    JSON.stringify({
      templates: [{ id: "service-default", accepts_content_types: ["service@1"] }],
    }),
  );
  const info = connectionInfoOf(db);
  const configFile = join(dir, "pcms.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      nodeEnv: "test",
      http: { host: "127.0.0.1", port: 3000 },
      db: {
        host: info.host,
        port: info.port,
        database: info.database,
        user: info.user,
        ...(info.password === undefined ? {} : { passwordSecretRef: "db.password" }),
        sslMode: "disable",
        migrationsDir: "db/migrations",
      },
      log: { level: "info" },
      secrets:
        info.password === undefined ? {} : { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
      themes: { renderDir: dir },
      content: { typesFile },
    }),
  );

  const previousPassword = process.env.PCMS_SECRET_DB_PASSWORD;
  t.after(() => {
    if (previousPassword === undefined) delete process.env.PCMS_SECRET_DB_PASSWORD;
    else process.env.PCMS_SECRET_DB_PASSWORD = previousPassword;
  });
  if (info.password !== undefined) process.env.PCMS_SECRET_DB_PASSWORD = info.password;
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PCMS_") && key !== "PCMS_SECRET_DB_PASSWORD") {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    const doctor = await runCli(["doctor", "--json", "--config", configFile]);
    const body = JSON.parse(doctor.stdout) as {
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    };
    const coverage = body.checks.find((check) => check.name === "published-template-coverage");
    assert.ok(coverage !== undefined, `check missing: ${doctor.stdout}`);
    assert.equal(coverage.ok, false);
    assert.match(coverage.detail, /service@2 \(published: 1\)/);
    assert.doesNotMatch(coverage.detail, /skipped/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});

// Regression (p-cms.ru pilot, 2026-10-17): doctor read the theme manifest from
// `themes.renderDir`, which is only the BOOT seed. Once a different theme is
// activated, `admin_theme_state.theme_key` wins and the renderer serves that
// one — so doctor reported "NO template accepts: article@2" for a type the
// ACTIVE theme accepts, a false DEGRADED. The coverage check must read the
// active theme, exactly as the renderer resolves it.
test("doctor e2e: coverage follows the ACTIVATED theme, not the renderDir seed", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({
    connectionInfo: connectionInfoOf(db),
    max: 2,
    connectionTimeoutMilliseconds: 5000,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  await seedPublishedEntry(pool, { key: "article" });

  const root = mkdtempSync(join(tmpdir(), "pcms-active-theme-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // The boot seed: a minimal theme whose templates do NOT accept `article`.
  const seedDir = join(root, "boot-seed");
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(
    join(seedDir, "theme.json"),
    JSON.stringify({
      id: "boot-seed",
      version: "1.0.0",
      templates: [{ id: "page-default", accepts_content_types: ["page"] }],
    }),
  );

  // The ACTIVATED theme: the real reference theme, which accepts article@1.
  // It needs a native installation receipt because activation only resolves
  // installed packages (resolveInstalledThemeDirectory), and the directory
  // name must equal the activated theme_key.
  const activeDir = join(root, "reference-theme-v1");
  cpSync(join(process.cwd(), "themes", "reference-theme-v1"), activeDir, { recursive: true });
  const activeManifest = JSON.parse(readFileSync(join(activeDir, "theme.json"), "utf8")) as {
    version: string;
  };
  // The pilot's theme declares `cms_compatibility`, exactly like a real
  // installed package. Without the running CMS version the resolver rejects it
  // as THEME_PACKAGE_INVALID ("site reports unknown"), which is how doctor kept
  // falling back to the seed.
  writeFileSync(
    join(activeDir, "theme.json"),
    JSON.stringify({ ...activeManifest, cms_compatibility: ">=1.0.0-rc.1 <2.0.0" }, null, 2),
  );
  writeFileSync(
    join(activeDir, ".pcms-install.json"),
    JSON.stringify({ version: activeManifest.version, sha256: "a".repeat(64) }),
  );

  const typesFile = join(root, "content-types.json");
  writeFileSync(typesFile, JSON.stringify([{ key: "article", version: 1 }]));
  const info = connectionInfoOf(db);
  const configFile = join(root, "pcms.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      nodeEnv: "test",
      http: { host: "127.0.0.1", port: 3000 },
      db: {
        host: info.host,
        port: info.port,
        database: info.database,
        user: info.user,
        ...(info.password === undefined ? {} : { passwordSecretRef: "db.password" }),
        sslMode: "disable",
        migrationsDir: "db/migrations",
      },
      log: { level: "info" },
      secrets:
        info.password === undefined ? {} : { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
      themes: { renderDir: seedDir },
      content: { typesFile },
    }),
  );
  await pool.query(
    "INSERT INTO admin_theme_state (site_key, theme_key, theme_version) VALUES ('default', 'reference-theme-v1', $1)",
    [activeManifest.version],
  );

  const previousPassword = process.env.PCMS_SECRET_DB_PASSWORD;
  t.after(() => {
    if (previousPassword === undefined) delete process.env.PCMS_SECRET_DB_PASSWORD;
    else process.env.PCMS_SECRET_DB_PASSWORD = previousPassword;
  });
  if (info.password !== undefined) process.env.PCMS_SECRET_DB_PASSWORD = info.password;
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PCMS_") && key !== "PCMS_SECRET_DB_PASSWORD") {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    const doctor = await runCli(["doctor", "--json", "--config", configFile]);
    const body = JSON.parse(doctor.stdout) as {
      checks: { name: string; ok: boolean; detail: string }[];
    };
    const coverage = body.checks.find((check) => check.name === "published-template-coverage");
    assert.ok(coverage !== undefined, `check missing: ${doctor.stdout}`);
    assert.equal(coverage.ok, true, `active theme accepts article: ${coverage.detail}`);

    const source = body.checks.find((check) => check.name === "theme-source");
    assert.match(String(source?.detail), /reference-theme-v1/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});
