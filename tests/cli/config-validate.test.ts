// PCMS-OPS-T002 — `cms config validate`: JSON/human output, exit codes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configValidate, runCli } from "@pcms/cli";
import { cmsProcessEnv } from "../helpers/process-env.js";

const VALID = {
  nodeEnv: "production",
  db: { host: "127.0.0.1", port: 5432, database: "pcms", user: "pcms", sslMode: "disable" },
};

const INVALID = {
  nodeEnv: "production",
  db: { host: "127.0.0.1", port: 5432, database: "pcms", user: "pcms", sslMode: "sometimes" },
};

function withConfigDir(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pcms-cli-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "pcms.json"), JSON.stringify(doc), "utf8");
  return dir;
}

test("valid config: exit 0, human output names file and summary", () => {
  const dir = withConfigDir(VALID);
  try {
    const result = configValidate({ args: [], cwd: dir, env: {} });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /result: VALID/);
    assert.match(result.stdout, new RegExp(`file: ${join(dir, "config", "pcms.json")}`));
    assert.match(result.stdout, /db=pcms@127\.0\.0\.1:5432\/pcms/);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid config: exit 1, human output lists issue paths", () => {
  const dir = withConfigDir(INVALID);
  try {
    const result = configValidate({ args: [], cwd: dir, env: {} });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /result: INVALID \(1 issue\(s\)\)/);
    assert.match(result.stdout, /- db\.sslMode:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json valid output is deterministic machine-readable JSON", () => {
  const dir = withConfigDir(VALID);
  try {
    const result = configValidate({ args: ["--json"], cwd: dir, env: {} });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      file: string;
      config: { http: { port: number } };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.config.http.port, 3000);
    assert.equal(parsed.file, join(dir, "config", "pcms.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json invalid output carries all issues with stable paths", () => {
  const dir = withConfigDir(INVALID);
  try {
    const result = configValidate({ args: ["--json"], cwd: dir, env: {} });
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      issues: { path: string; message: string }[];
    };
    assert.equal(parsed.ok, false);
    assert.deepEqual(
      parsed.issues.map((issue) => issue.path),
      ["db.sslMode"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--config selects an explicit file; unknown flags are usage errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-cli-"));
  try {
    const file = join(dir, "other.json");
    writeFileSync(file, JSON.stringify(VALID), "utf8");
    const explicit = configValidate({ args: ["--config", file, "--json"], cwd: dir, env: {} });
    assert.equal(explicit.exitCode, 0);

    const badFlag = configValidate({ args: ["--verbose"], cwd: dir, env: {} });
    assert.equal(badFlag.exitCode, 2);
    assert.match(badFlag.stderr, /usage: cms config validate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown commands print top-level usage with exit 2", async () => {
  const result = await runCli(["nope"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /usage: cms <command>/);
  for (const family of [
    "bundle validate|pack|inspect|submit|status",
    "migrate modx3|wordpress|tilda|bitrix",
    "redirects validate|apply",
    "figma pull",
    "nav inspect|check | route inspect|check",
    "mail test",
    "theme list",
    "theme install|uninstall",
  ]) {
    assert.ok(result.stderr.includes(family), `top-level help omits ${family}`);
  }
});

test("bin entrypoint works end-to-end via tsx", () => {
  const dir = withConfigDir(VALID);
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "packages/cli/src/bin/cms.ts", "config", "validate", "--json"],
      {
        cwd: process.cwd(),
        // Controlled environment: the runner may carry PCMS_* harness
        // variables (e.g. PCMS_TEST_DATABASE_URL from .env) which the CMS
        // fail-secure loader would rightly reject.
        env: cmsProcessEnv({ PCMS_CONFIG_FILE: join(dir, "config", "pcms.json") }),
      },
    ).toString();
    const parsed = JSON.parse(stdout) as { ok: boolean };
    assert.equal(parsed.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
