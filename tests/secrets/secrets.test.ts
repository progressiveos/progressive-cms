// PCMS-OPS-T009 — secret loading strategy: env/file sources, permission
// enforcement (0600), fail-secure missing/empty secrets, values stay opaque.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDbConnectionInfo, loadSecrets, SecretError } from "@pcms/core";

function secretDir(): string {
  return mkdtempSync(join(tmpdir(), "pcms-secrets-"));
}

test("env-sourced secret resolves; values are opaque (never enumerable)", () => {
  const secrets = loadSecrets(
    { "db.password": { env: "PCMS_TEST_SECRET" } },
    { PCMS_TEST_SECRET: "s3cr3t" },
  );
  assert.equal(secrets.get("db.password"), "s3cr3t");
  assert.equal(secrets.require("db.password"), "s3cr3t");
  assert.deepEqual(secrets.names(), ["db.password"]);
  // No enumerable value material — a dump/inspect of the object shows nothing.
  assert.equal(JSON.stringify(secrets), "{}");
});

test("missing or empty env secret fails securely with the variable named", () => {
  assert.throws(
    () => loadSecrets({ "db.password": { env: "PCMS_ABSENT_SECRET" } }, {}),
    (error: unknown) => {
      assert.ok(error instanceof SecretError);
      assert.match(error.issues[0]?.message ?? "", /PCMS_ABSENT_SECRET/);
      return true;
    },
  );
  assert.throws(
    () => loadSecrets({ "db.password": { env: "PCMS_EMPTY_SECRET" } }, { PCMS_EMPTY_SECRET: "" }),
    SecretError,
  );
});

test("file-sourced secret resolves with a single trailing newline stripped", () => {
  const dir = secretDir();
  try {
    const file = join(dir, "db_password");
    writeFileSync(file, "from-file\n", "utf8");
    chmodSync(file, 0o600);
    const secrets = loadSecrets({ "db.password": { file } }, {});
    assert.equal(secrets.get("db.password"), "from-file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("group/world readable secret file is rejected (permissions acceptance)", () => {
  const dir = secretDir();
  try {
    const file = join(dir, "db_password");
    writeFileSync(file, "leaky", "utf8");
    for (const mode of [0o644, 0o664, 0o640, 0o777]) {
      chmodSync(file, mode);
      assert.throws(
        () => loadSecrets({ "db.password": { file } }, {}),
        (error: unknown) => {
          assert.ok(error instanceof SecretError);
          assert.match(error.issues[0]?.message ?? "", /0600 required|permissive mode/);
          return true;
        },
        `mode ${mode.toString(8)} must be rejected`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing file and directory-as-secret are rejected; all issues collected", () => {
  const dir = secretDir();
  try {
    const okFile = join(dir, "ok");
    writeFileSync(okFile, "fine", "utf8");
    chmodSync(okFile, 0o600);
    assert.throws(
      () =>
        loadSecrets(
          {
            "a.absent": { file: join(dir, "absent") },
            "b.dir": { file: dir },
            "c.env": { env: "PCMS_NOPE" },
            "d.ok": { file: okFile },
          },
          {},
        ),
      (error: unknown) => {
        assert.ok(error instanceof SecretError);
        assert.equal(error.issues.length, 3);
        const names = error.issues.map((issue) => issue.name);
        assert.deepEqual(names.sort(), ["a.absent", "b.dir", "c.env"]);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDbConnectionInfo merges config + secrets; absent ref means no password", () => {
  const dir = secretDir();
  try {
    const caFile = join(dir, "ca.crt");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\n…", "utf8");
    const secrets = loadSecrets(
      { "db.password": { env: "PCMS_TEST_SECRET" } },
      { PCMS_TEST_SECRET: "pw-1" },
    );

    const withPassword = buildDbConnectionInfo(
      {
        host: "db.internal",
        port: 5432,
        database: "pcms",
        user: "pcms_app",
        passwordSecretRef: "db.password",
        sslMode: "verify-full",
        sslCaFile: caFile,
        migrationsDir: "db/migrations",
        pool: {
          webMax: 10,
          workerMax: 5,
          connectionTimeoutMilliseconds: 5000,
          idleTimeoutMilliseconds: 30000,
        },
      },
      secrets,
    );
    assert.equal(withPassword.password, "pw-1");
    assert.match(withPassword.sslCa ?? "", /BEGIN CERTIFICATE/);
    assert.equal(withPassword.sslMode, "verify-full");

    const withoutPassword = buildDbConnectionInfo(
      {
        host: "db.internal",
        port: 5432,
        database: "pcms",
        user: "pcms_app",
        sslMode: "disable",
        migrationsDir: "db/migrations",
        pool: {
          webMax: 10,
          workerMax: 5,
          connectionTimeoutMilliseconds: 5000,
          idleTimeoutMilliseconds: 30000,
        },
      },
      loadSecrets({}, {}),
    );
    assert.equal("password" in withoutPassword, false);

    // referencing an unloaded secret is a hard error
    assert.throws(
      () =>
        buildDbConnectionInfo(
          {
            host: "db.internal",
            port: 5432,
            database: "pcms",
            user: "pcms_app",
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
          loadSecrets({}, {}),
        ),
      SecretError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("require() throws for unknown secrets; mkdir absent-dir does not create secrets", () => {
  const secrets = loadSecrets({}, {});
  assert.throws(() => secrets.require("nope"), SecretError);
  const dir = secretDir();
  try {
    mkdirSync(join(dir, "sub"));
    // file creation path checked: reading a directory fails cleanly
    assert.throws(() => loadSecrets({ x: { file: join(dir, "sub") } }, {}), SecretError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
