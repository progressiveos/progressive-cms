// PCMS-OPS-T001 — typed config schema/loader.
// Acceptance: invalid secure config is rejected (unknown options, bad DB
// config, unknown environment overrides) instead of silently defaulted.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AppConfig, ConfigError, loadConfig, validateConfigDocument } from "@pcms/core";

const MINIMAL = {
  nodeEnv: "production",
  db: { host: "127.0.0.1", port: 5432, database: "pcms", user: "pcms", sslMode: "disable" },
};

test("http.cookieSecure: carried through normalization; absent = nodeEnv default", () => {
  // Audit 2026-09-27 regression: the loader rebuilds `http` explicitly, so an
  // optional key MUST be carried by name or it silently disappears downstream
  // (0.1.110 shipped without this — plain-HTTP logins stayed broken).
  const explicit = loadConfigWithDoc(
    { ...MINIMAL, http: { cookieSecure: false } },
    { PCMS_NODE_ENV: "production" },
  );
  assert.equal(explicit.http.cookieSecure, false);

  const defaulted = loadConfigWithDoc(MINIMAL, { PCMS_NODE_ENV: "production" });
  assert.equal(defaulted.http.cookieSecure, undefined);

  const devDefault = loadConfigWithDoc(MINIMAL, { PCMS_NODE_ENV: "development" });
  assert.equal(devDefault.http.cookieSecure, undefined);
});

test("minimal valid config passes and documented defaults are applied", () => {
  const result = validateConfigDocument(MINIMAL);
  assert.ok(result.ok);
  const config = result.config;
  assert.equal(config.http.port, 3000);
  assert.equal(config.http.host, "127.0.0.1");
  assert.equal(config.http.shutdownTimeoutMilliseconds, 10000);
  assert.equal(config.db.migrationsDir, "db/migrations");
  assert.equal(config.db.pool.webMax, 10);
  assert.equal(config.db.pool.workerMax, 5);
  assert.equal(config.log.level, "info");
  assert.deepEqual(config.secrets, {});
});

test("full config passes without defaults overriding explicit values", () => {
  const result = validateConfigDocument({
    ...MINIMAL,
    nodeEnv: "development",
    http: { host: "0.0.0.0", port: 8080, shutdownTimeoutMilliseconds: 20000 },
    db: {
      ...MINIMAL.db,
      sslMode: "require",
      migrationsDir: "custom/migrations",
      pool: {
        webMax: 3,
        workerMax: 2,
        connectionTimeoutMilliseconds: 1000,
        idleTimeoutMilliseconds: 5000,
      },
    },
    log: { level: "debug" },
    secrets: { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
  });
  assert.ok(result.ok);
  assert.equal(result.config.db.pool.webMax, 3);
  assert.equal(result.config.db.sslMode, "require");
  assert.equal(result.config.http.port, 8080);
});

test("invalid DB config is rejected with a stable path", () => {
  const result = validateConfigDocument({
    nodeEnv: "production",
    db: { host: "127.0.0.1", port: 99999, database: "pcms", user: "pcms", sslMode: "sometimes" },
  });
  assert.ok(!result.ok);
  const paths = result.issues.map((issue) => issue.path);
  assert.ok(paths.includes("db.sslMode"), JSON.stringify(result.issues));
  assert.ok(paths.includes("db.port"), JSON.stringify(result.issues));
});

test("unknown security-critical option is rejected, not silently ignored", () => {
  for (const doc of [
    { ...MINIMAL, adminTokenInConfig: "nope" },
    { ...MINIMAL, db: { ...MINIMAL.db, autoMigrateOnStartup: true } },
    { ...MINIMAL, log: { level: "info", destination: "/tmp/x" } },
  ]) {
    const result = validateConfigDocument(doc);
    assert.ok(!result.ok, `expected rejection of ${JSON.stringify(doc)}`);
  }
});

test("sslMode has no insecure default — missing value is rejected", () => {
  const result = validateConfigDocument({
    nodeEnv: "production",
    db: { host: "127.0.0.1", port: 5432, database: "pcms", user: "pcms" },
  });
  assert.ok(!result.ok);
  assert.ok(result.issues.some((issue) => issue.path === "db.sslMode"));
});

test("secret refs must have exactly one source", () => {
  const both = validateConfigDocument({
    ...MINIMAL,
    secrets: { "db.password": { env: "PCMS_SECRET_A", file: "/tmp/x" } },
  });
  assert.ok(!both.ok);
  const neither = validateConfigDocument({
    ...MINIMAL,
    secrets: { "db.password": {} },
  });
  assert.ok(!neither.ok);
  const lowercaseEnv = validateConfigDocument({
    ...MINIMAL,
    secrets: { "db.password": { env: "pcms_secret_a" } },
  });
  assert.ok(!lowercaseEnv.ok);
});

test("passwordSecretRef must point at a declared secret", () => {
  const result = validateConfigDocument({
    ...MINIMAL,
    db: { ...MINIMAL.db, passwordSecretRef: "db.password" },
  });
  assert.ok(!result.ok);
  assert.ok(result.issues.some((issue) => issue.path === "db.passwordSecretRef"));
  const ok = validateConfigDocument({
    ...MINIMAL,
    db: { ...MINIMAL.db, passwordSecretRef: "db.password" },
    secrets: { "db.password": { env: "PCMS_SECRET_DB_PASSWORD" } },
  });
  assert.ok(ok.ok);
});

test("unknown PCMS_ environment override aborts; secret channel is exempt", () => {
  const issues = (() => {
    try {
      loadConfigWithDoc(MINIMAL, { PCMS_DB_PORTT: "5432" });
      return [] as string[];
    } catch (error) {
      return (error as ConfigError).issues.map((issue) => issue.path);
    }
  })();
  assert.ok(issues.includes("(env) PCMS_DB_PORTT"));

  // PCMS_SECRET_* and PCMS_CONFIG_FILE never reach the override machinery.
  const config = loadConfigWithDoc(MINIMAL, {
    PCMS_SECRET_DB_PASSWORD: "irrelevant-here",
    PCMS_CONFIG_FILE: "/somewhere/else.json",
  });
  assert.equal(config.db.port, 5432);
});

test("test database URL does not participate in CMS config overrides", () => {
  const config = loadConfigWithDoc(MINIMAL, { PCMS_TEST_DATABASE_URL: "postgres://test-db" });
  assert.equal(config.db.host, "127.0.0.1");
  assert.equal(config.db.database, "pcms");
});

test("PCMS_ADMIN_UI_TEST is a process flag, not a config override (ADR-0018)", () => {
  // A systemd drop-in with PCMS_ADMIN_UI_TEST=1 must not abort web startup
  // (found on the pcms-test1 runtime acceptance: the strict whitelist
  // rejected the harness flag and crash-looped web).
  const config = loadConfigWithDoc(MINIMAL, { PCMS_ADMIN_UI_TEST: "1" });
  assert.equal(config.db.host, "127.0.0.1");
});

test("non-PCMS_ environment variables never enter the override scanner", () => {
  const config = loadConfigWithDoc(MINIMAL, {
    PATH: "/usr/bin",
    SHELL: "/bin/bash",
    HTTP_PROXY: "http://proxy:3128",
    PCMS_HTTP_PORT: "3101",
  });
  assert.equal(config.http.port, 3101);
});

test("environment overrides take precedence over the file and are validated", () => {
  const config = loadConfigWithDoc(MINIMAL, { PCMS_HTTP_PORT: "3100", PCMS_LOG_LEVEL: "warn" });
  assert.equal(config.http.port, 3100);
  assert.equal(config.log.level, "warn");

  const bad = (() => {
    try {
      loadConfigWithDoc(MINIMAL, { PCMS_HTTP_PORT: "http" });
      return null;
    } catch (error) {
      return error as ConfigError;
    }
  })();
  assert.ok(bad);
  assert.ok(bad.issues.some((issue) => issue.path === "(env) PCMS_HTTP_PORT"));

  const outOfRange = (() => {
    try {
      loadConfigWithDoc(MINIMAL, { PCMS_DB_PORT: "99999" });
      return null;
    } catch (error) {
      return error as ConfigError;
    }
  })();
  assert.ok(outOfRange);
  assert.ok(outOfRange.issues.some((issue) => issue.path === "db.port"));
});

test("loadConfig fails securely on missing file and malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-config-"));
  try {
    assert.throws(() => loadConfig({ file: join(dir, "absent.json") }), ConfigError);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json", "utf8");
    assert.throws(
      () => loadConfig({ file: broken }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.issues[0]?.path ?? "", /\(file\)/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-object documents are rejected", () => {
  for (const doc of [null, [], "config", 42]) {
    const result = validateConfigDocument(doc);
    assert.ok(!result.ok);
  }
});

/** Writes `doc` to a temp file and loads it through loadConfig with `env`. */
function loadConfigWithDoc(doc: unknown, env: Record<string, string | undefined>): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "pcms-config-"));
  try {
    const file = join(dir, "pcms.json");
    writeFileSync(file, JSON.stringify(doc), "utf8");
    return loadConfig({ file, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("media config section (M05): limits default restrictive, dirs are mandatory", () => {
  const withMedia = {
    ...MINIMAL,
    media: { storageDir: "var/media", quarantineDir: "var/quarantine" },
  };
  const result = validateConfigDocument(withMedia);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.config.media?.maxUploadBytes, 26214400);
  assert.equal(result.config.media?.maxImagePixels, 64000000);
  assert.equal(result.config.media?.maxImageDimension, 16384);

  const noDirs = validateConfigDocument({ ...MINIMAL, media: {} });
  assert.equal(noDirs.ok, false);
  assert.ok(
    noDirs.issues.some((issue) => issue.path.includes("storageDir")),
    "storageDir is required when the media section is declared",
  );

  const explicit = validateConfigDocument({
    ...MINIMAL,
    media: {
      storageDir: "/srv/media",
      quarantineDir: "/srv/quarantine",
      maxUploadBytes: 1024,
      maxImagePixels: 2000000,
      maxImageDimension: 4096,
    },
  });
  assert.ok(explicit.ok);
  if (!explicit.ok) return;
  assert.equal(explicit.config.media?.maxUploadBytes, 1024);

  // absent media section stays absent (media-less deployments keep working)
  const absent = validateConfigDocument(MINIMAL);
  assert.ok(absent.ok);
  if (!absent.ok) return;
  assert.equal(absent.config.media, undefined);

  // unknown media keys are rejected like every other unknown option
  const unknown = validateConfigDocument({
    ...MINIMAL,
    media: { storageDir: "v", quarantineDir: "q", s3Bucket: "x" },
  });
  assert.equal(unknown.ok, false);
});

test("pcpub ingest knobs (ADR-0014) validate; unknown keys inside are rejected", () => {
  // The .pcpub quarantine dir is required on deployments where web and worker
  // do not share tmpdir (systemd PrivateTmp) — the documented operator knob
  // must pass the same schema that used to reject it as an unknown root key.
  const explicit = validateConfigDocument({
    ...MINIMAL,
    pcpub: {
      quarantineDir: "/var/lib/pcms/state/tmp/pcpub-quarantine",
      limits: { maxCompressedBytes: 268435456 },
    },
  });
  assert.ok(explicit.ok, JSON.stringify(explicit.ok ? [] : explicit.issues));
  if (!explicit.ok) return;
  assert.equal(explicit.config.pcpub?.quarantineDir, "/var/lib/pcms/state/tmp/pcpub-quarantine");

  const absent = validateConfigDocument(MINIMAL);
  assert.ok(absent.ok);
  if (!absent.ok) return;
  assert.equal(absent.config.pcpub, undefined);

  const unknown = validateConfigDocument({
    ...MINIMAL,
    pcpub: { quarantineDir: "q", storageDir: "x" },
  });
  assert.equal(unknown.ok, false);
});

test("the shipped production config template passes the config schema", () => {
  // M17 clean install: a rendered template must be a VALID config document —
  // every *SecretRef must point at a declared secret and no template
  // placeholder may survive the render step.
  const template = readFileSync(
    join(import.meta.dirname, "..", "..", "deploy", "sites", "pcms.production.template.json"),
    "utf8",
  );
  const rendered = template
    .replace(/__HTTP_HOST__/g, "127.0.0.1")
    .replace(/__DB_ADDRESS__/g, "127.0.0.1")
    .replace(/__DB_NAME__/g, "pcms")
    .replace(/__DB_USER__/g, "pcms")
    .replace(/__TRUSTED_PROXY_EDGE__/g, "10.0.0.1");
  assert.equal(/__[A-Z_]+__/.test(rendered), false, "unknown placeholder in template");
  const result = validateConfigDocument(JSON.parse(rendered));
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.issues));
});
