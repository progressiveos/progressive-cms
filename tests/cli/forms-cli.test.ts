// CLI golden path: forms/quizzes/interactions run through the M09 command
// tree when global flags are present. Regression: the new-tree dispatcher
// used to drop the family argument, so `cms forms list --json` fell through
// to USAGE while the same command without flags worked (legacy raw-args
// path) — the exact "works only sometimes" split a clean model cannot guess.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "@pcms/cli";

function withApiEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    url: process.env["PCMS_API_URL"],
    token: process.env["PCMS_API_TOKEN"],
    environment: process.env["PCMS_ENVIRONMENT"],
    site: process.env["PCMS_SITE_KEY"],
  };
  process.env["PCMS_ENVIRONMENT"] = "production";
  process.env["PCMS_SITE_KEY"] = "site-a";
  process.env["PCMS_API_URL"] = "http://cli-test.invalid";
  process.env["PCMS_API_TOKEN"] = "pcms_test_token";
  return fn().finally(() => {
    if (saved.environment === undefined) delete process.env["PCMS_ENVIRONMENT"];
    else process.env["PCMS_ENVIRONMENT"] = saved.environment;
    if (saved.site === undefined) delete process.env["PCMS_SITE_KEY"];
    else process.env["PCMS_SITE_KEY"] = saved.site;
    if (saved.url === undefined) delete process.env["PCMS_API_URL"];
    else process.env["PCMS_API_URL"] = saved.url;
    if (saved.token === undefined) delete process.env["PCMS_API_TOKEN"];
    else process.env["PCMS_API_TOKEN"] = saved.token;
  });
}

test("forms list --json reaches the API with the family argument intact", async () => {
  await withApiEnv(async () => {
    const calls: { method: string; path: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", path: String(input) });
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "01JFORM0000000000000000000",
              key: "contact",
              title: "Оставить заявку",
              schema_version: 2,
              status: "ACTIVE",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const result = await runCli(["forms", "list", "--json"]);
      assert.equal(result.exitCode, 0, result.stderr);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        total: number;
        items: { key: string }[];
      };
      assert.equal(payload.ok, true);
      assert.equal(payload.total, 1);
      assert.equal(payload.items[0]?.key, "contact");
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.path, /\/api\/v1\/forms$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("interactions submissions --json hits the interactions route (family preserved)", async () => {
  await withApiEnv(async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await runCli(["interactions", "submissions", "--json"]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(calls[0] ?? "", /\/api\/v1\/interactions\/submissions$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("forms list without API env fails with the typed unconfigured hint", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env["PCMS_API_URL"];
  const originalToken = process.env["PCMS_API_TOKEN"];
  delete process.env["PCMS_API_URL"];
  delete process.env["PCMS_API_TOKEN"];
  try {
    const result = await runCli(["forms", "list"]);
    assert.equal(result.exitCode, 2); // API_CLIENT_UNCONFIGURED = operator setup
    assert.match(result.stderr, /PCMS_API_URL/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl !== undefined) process.env["PCMS_API_URL"] = originalUrl;
    if (originalToken !== undefined) process.env["PCMS_API_TOKEN"] = originalToken;
  }
});
