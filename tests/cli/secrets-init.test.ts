// `cms integrations secrets init` (owner task §33/§34): idempotent local
// provisioning of the Integration Hub runtime secret store. Pins the three
// owner-critical behaviors: absent → generate + wire config; present →
// no-op; never regenerate (a new key would destroy encrypted values).
// The key value itself is never printed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "@pcms/cli";
import { loadConfig } from "@pcms/core";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pcms-secrets-init-"));
}

/** PCMS_ env vars (e.g. from .env) are config overrides for loadConfig —
 * strip them like the other CLI tests do. */
function sanitizeEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PCMS_") && key !== "PCMS_SECRET_DB_PASSWORD") {
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

const BASE_CONFIG = {
  nodeEnv: "test",
  http: { host: "127.0.0.1", port: 3000 },
  db: { host: "127.0.0.1", port: 5432, database: "x", user: "x", sslMode: "disable" },
  secrets: {},
};

test("secrets init: absent → generates 0600 key, wires config, validates READY", async () => {
  const savedEnv = sanitizeEnv();
  try {
    const dir = makeTempDir();
    try {
      const configFile = join(dir, "pcms.json");
      writeFileSync(configFile, JSON.stringify(BASE_CONFIG));
      const result = await runCli([
        "integrations",
        "secrets",
        "init",
        "--config",
        configFile,
        "--secret-dir",
        dir,
      ]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /status: READY/);
      assert.match(result.stdout, /action: generated/);

      const secretPath = join(dir, "integrations.runtimeSecretsEncryptionKey");
      assert.equal(statSync(secretPath).mode & 0o777, 0o600, "key file must be 0600");
      assert.ok(readFileSync(secretPath, "utf8").trim().length > 0);
      // base64 32 bytes → 44 chars; hex would be 64 — either way not printed:
      assert.ok(!result.stdout.includes(readFileSync(secretPath, "utf8").trim()));

      const config = loadConfig({ file: configFile, env: process.env });
      assert.equal(
        config.integrations?.runtimeSecretsEncryptionKeySecretRef,
        "integrations.runtimeSecretsEncryptionKey",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restoreEnv(savedEnv);
  }
});

test("secrets init: present → verifies and no-ops; never regenerates", async () => {
  const savedEnv = sanitizeEnv();
  try {
    const dir = makeTempDir();
    try {
      const configFile = join(dir, "pcms.json");
      writeFileSync(configFile, JSON.stringify(BASE_CONFIG));
      const first = await runCli([
        "integrations",
        "secrets",
        "init",
        "--config",
        configFile,
        "--secret-dir",
        dir,
      ]);
      assert.equal(first.exitCode, 0, first.stderr);
      const keyBefore = readFileSync(join(dir, "integrations.runtimeSecretsEncryptionKey"), "utf8");

      const second = await runCli([
        "integrations",
        "secrets",
        "init",
        "--config",
        configFile,
        "--secret-dir",
        dir,
      ]);
      assert.equal(second.exitCode, 0, second.stderr);
      assert.match(second.stdout, /action: none \(already configured\)/);
      assert.equal(
        readFileSync(join(dir, "integrations.runtimeSecretsEncryptionKey"), "utf8"),
        keyBefore,
        "an existing key must never be regenerated",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restoreEnv(savedEnv);
  }
});

test("secrets init: orphan key file → refuses instead of overwriting", async () => {
  const savedEnv = sanitizeEnv();
  try {
    const dir = makeTempDir();
    try {
      const configFile = join(dir, "pcms.json");
      writeFileSync(configFile, JSON.stringify(BASE_CONFIG));
      writeFileSync(join(dir, "integrations.runtimeSecretsEncryptionKey"), "cHJlc2VydC1rZXk=\n");
      const result = await runCli([
        "integrations",
        "secrets",
        "init",
        "--config",
        configFile,
        "--secret-dir",
        dir,
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /already exists but is not referenced/);
      assert.equal(
        readFileSync(join(dir, "integrations.runtimeSecretsEncryptionKey"), "utf8"),
        "cHJlc2VydC1rZXk=\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    restoreEnv(savedEnv);
  }
});
