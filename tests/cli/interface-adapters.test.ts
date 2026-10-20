import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "@pcms/cli";
import yazl from "yazl";

async function skillZip(): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        id: "community.cli-test",
        version: "1.0.0",
        description: "CLI regression fixture",
        requires: { cms: ">=1.0.0-rc.1 <2.0.0" },
        recommended_scopes: ["content.read"],
        optional_scopes: [],
        dangerous_optional_scopes: [],
        entry_workflow: ["discovery"],
        safety_levels: ["READ"],
        attribution: { author: "Test", source: "https://example.invalid/skill" },
      }),
    ),
    "manifest.json",
  );
  zip.addBuffer(Buffer.from("# Fixture\nRead only."), "SKILL.md");
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test("actual CLI adapters preserve flags, reject dangerous input and report offline failures", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-cli-interface-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("PCMS_")) delete process.env[key];
  Object.assign(process.env, {
    PCMS_API_URL: "https://probe.invalid",
    PCMS_API_TOKEN: "synthetic",
    PCMS_SITE_KEY: "site-a",
    PCMS_ENVIRONMENT: "test",
  });
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (key.startsWith("PCMS_")) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const calls: { url: string; method: string; body: unknown; headers: Headers }[] = [];
  let responseStatus = 200;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const body =
      init?.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body,
      headers: new Headers(init?.headers),
    });
    return new Response(
      JSON.stringify(
        responseStatus === 200
          ? { items: [], ok: true }
          : { error: { code: "THEME_INSTALL_RENDER_TARGET", message: "active theme protected" } },
      ),
      { status: responseStatus, headers: { "content-type": "application/json" } },
    );
  });
  const command = async (words: string[]) => {
    calls.length = 0;
    return runCli([...words, "--json"]);
  };

  await t.test(
    "refund rejects invalid amounts before HTTP; omitted and positive amounts retain meaning",
    async () => {
      for (const amount of ["bad-amount", "NaN", "Infinity", "-Infinity", "0", "-1", "", " "]) {
        const result = await command(["payments", "refund", "payment", amount]);
        assert.notEqual(result.exitCode, 0, amount);
        assert.equal(JSON.parse(result.stdout).error.code, "PAYMENT_REQUEST_INVALID");
        assert.equal(calls.length, 0);
      }
      assert.equal((await command(["payments", "refund", "payment"])).exitCode, 0);
      assert.deepEqual(calls[0]?.body, {});
      assert.equal((await command(["payments", "refund", "payment", "12.34"])).exitCode, 0);
      assert.deepEqual(calls[0]?.body, { amount: 12.34 });
    },
  );
  await t.test("search and list filters reach their documented wire fields", async () => {
    assert.equal(
      (await command(["search", "reindex", "--resume", "--environment", "test", "--yes"])).exitCode,
      0,
    );
    assert.deepEqual(calls[0]?.body, { resume: true });
    for (const family of ["forms", "quizzes"]) {
      assert.equal((await command([family, "list", "--status", "ARCHIVED"])).exitCode, 0);
      assert.equal(calls[0]?.url, `https://probe.invalid/api/v1/${family}?status=ARCHIVED`);
    }
    assert.equal((await command(["interactions", "submissions", "--limit", "1"])).exitCode, 0);
    assert.match(calls[0]?.url ?? "", /submissions\?limit=1$/);
    assert.notEqual((await command(["interactions", "submissions", "--limit", "bad"])).exitCode, 0);
    assert.equal(calls.length, 0);
    for (const words of [
      ["forms", "list", "--status"],
      ["quizzes", "list", "--status", "--invalid"],
      ["interactions", "submissions", "--limit"],
      ["interactions", "runs", "--limit", "--invalid"],
    ]) {
      assert.notEqual((await command(words)).exitCode, 0);
      assert.equal(calls.length, 0);
    }
  });
  await t.test(
    "domain scope/primary and redirect confirmation survive global parsing",
    async () => {
      assert.equal(
        (
          await command([
            "domains",
            "add",
            "--hostname",
            "example.invalid",
            "--site",
            "site-b",
            "--primary",
          ])
        ).exitCode,
        0,
      );
      assert.deepEqual(calls[0]?.body, { hostname: "example.invalid", is_primary: true });
      assert.match(calls[0]?.url ?? "", /site\/domains\?site=site-b$/);
      assert.equal(calls[0]?.headers.get("x-pcms-site"), "site-b");
      const csv = join(dir, "redirects.csv");
      writeFileSync(csv, "source,target\n/old/,/new/\n");
      assert.notEqual((await command(["redirects", "apply", "--csv", csv])).exitCode, 0);
      assert.equal(calls.length, 0);
      assert.equal(
        (await command(["redirects", "apply", "--csv", csv, "--yes", "--site", "site-b"])).exitCode,
        0,
      );
      assert.match(calls[0]?.url ?? "", /routing\/redirect-imports\/apply$/);
      assert.equal((calls[0]!.body as unknown as { site: string }).site, "site-b");
    },
  );
  await t.test(
    "extension JSON config is explicit; legacy JSON and global file config remain usable",
    async () => {
      for (const flag of ["--extension-config", "--config"]) {
        assert.equal(
          (await command(["extensions", "install", "example", flag, '{"enabled":true}'])).exitCode,
          0,
        );
        assert.deepEqual(calls[0]?.body, { config: { enabled: true } });
      }
      assert.equal(
        (
          await command([
            "--config",
            "/not-read.json",
            "extensions",
            "install",
            "example",
            "--extension-config",
            '{"enabled":true}',
          ])
        ).exitCode,
        0,
      );
      assert.deepEqual(calls[0]?.body, { config: { enabled: true } });
      for (const invalid of ["bad", "[]", "null"]) {
        assert.notEqual(
          (await command(["extensions", "install", "example", "--extension-config", invalid]))
            .exitCode,
          0,
        );
        assert.equal(calls.length, 0);
      }
    },
  );
  await t.test(
    "theme install/uninstall use lifecycle-protected API instead of unsafe offline mutation",
    async () => {
      const file = join(dir, "theme.pcTheme");
      writeFileSync(file, "synthetic-theme-bytes");
      assert.equal(
        (await command(["theme", "install", file, "--environment", "test", "--yes"])).exitCode,
        0,
      );
      assert.match(calls[0]?.url ?? "", /themes\/install$/);
      assert.deepEqual(calls[0]?.body, readFileSync(file));
      assert.equal(
        (await command(["theme", "uninstall", "candidate", "--environment", "test", "--yes"]))
          .exitCode,
        0,
      );
      assert.equal(calls[0]?.method, "DELETE");
      assert.match(calls[0]?.url ?? "", /themes\/installed\/candidate$/);
      responseStatus = 409;
      const protectedResult = await command([
        "theme",
        "uninstall",
        "active",
        "--environment",
        "test",
        "--yes",
      ]);
      assert.notEqual(protectedResult.exitCode, 0);
      assert.equal(JSON.parse(protectedResult.stdout).error.code, "THEME_INSTALL_RENDER_TARGET");
      responseStatus = 200;
    },
  );
  await t.test(
    "nav/route honor explicit missing config without touching the database; nav rejects unsupported site",
    async () => {
      const missing = join(dir, "explicit-missing.json");
      for (const family of ["nav", "route"]) {
        const result = await command(["--config", missing, family, "inspect"]);
        assert.notEqual(result.exitCode, 0);
        assert.ok((result.stderr + result.stdout).includes(missing), result.stderr + result.stdout);
      }
      const nav = await command(["nav", "inspect", "--site", "site-b"]);
      assert.equal(nav.exitCode, 2);
      assert.match(nav.stderr, /installation-scoped/);
      assert.equal(calls.length, 0);
    },
  );
  await t.test(
    "community Skills use --dir/config, reject invalid packages and remove only requested root",
    async () => {
      const first = join(dir, "skills-a");
      const second = join(dir, "skills-b");
      const file = join(dir, "skill.zip");
      writeFileSync(file, await skillZip());
      const config = join(dir, "pcms.json");
      writeFileSync(
        config,
        JSON.stringify({
          nodeEnv: "test",
          db: {
            host: "127.0.0.1",
            port: 5432,
            database: "unused",
            user: "unused",
            sslMode: "disable",
          },
          skills: { communityDir: first },
        }),
      );
      assert.equal((await command(["skills", "install", file, "--config", config])).exitCode, 0);
      assert.ok(existsSync(join(first, "community.cli-test")));
      assert.equal((await command(["skills", "install", file, "--dir", second])).exitCode, 0);
      assert.ok(existsSync(join(second, "community.cli-test")));
      assert.equal(
        (await command(["skills", "uninstall", "community.cli-test", "--dir", second])).exitCode,
        0,
      );
      assert.equal(existsSync(join(second, "community.cli-test")), false);
      assert.ok(existsSync(join(first, "community.cli-test")));
      const bad = join(dir, "bad.zip");
      writeFileSync(bad, "not-a-zip");
      const result = await command(["skills", "validate", bad, "--dir", second]);
      assert.notEqual(result.exitCode, 0);
      assert.equal(JSON.parse(result.stdout).ok, false);
      assert.equal(calls.length, 0);
    },
  );
  await t.test("invalid pcpub JSON validation is not a success exit", async () => {
    const archive = join(dir, "invalid.pcpub");
    writeFileSync(archive, "not-a-zip");
    const result = await command(["bundle", "validate", archive]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(calls.length, 0);
  });
});
