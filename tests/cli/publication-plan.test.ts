import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "@pcms/cli";

test("publication plan CLI previews and schedules the same JSON request through REST", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-plan-cli-"));
  const requestPath = join(dir, "request.json");
  const request = {
    spec: {
      startAt: "2030-01-01T10:00:00Z",
      batchSize: 1,
      interval: { unit: "days", value: 1 },
    },
    overrides: [
      {
        changeset_item_id: "01900000-0000-7000-8000-000000000001",
        publish_at: "2030-01-03T10:00:00Z",
      },
    ],
  };
  writeFileSync(requestPath, JSON.stringify(request));
  const savedEnv = {
    url: process.env["PCMS_API_URL"],
    token: process.env["PCMS_API_TOKEN"],
    environment: process.env["PCMS_ENVIRONMENT"],
    site: process.env["PCMS_SITE_KEY"],
  };
  process.env["PCMS_ENVIRONMENT"] = "production";
  process.env["PCMS_API_URL"] = "http://plan-cli.test";
  process.env["PCMS_API_TOKEN"] = "fixture-token";
  process.env["PCMS_SITE_KEY"] = "default";
  const calls: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (savedEnv.environment === undefined) delete process.env["PCMS_ENVIRONMENT"];
    else process.env["PCMS_ENVIRONMENT"] = savedEnv.environment;
    if (savedEnv.url === undefined) delete process.env["PCMS_API_URL"];
    else process.env["PCMS_API_URL"] = savedEnv.url;
    if (savedEnv.token === undefined) delete process.env["PCMS_API_TOKEN"];
    else process.env["PCMS_API_TOKEN"] = savedEnv.token;
    if (savedEnv.site === undefined) delete process.env["PCMS_SITE_KEY"];
    else process.env["PCMS_SITE_KEY"] = savedEnv.site;
    rmSync(dir, { recursive: true, force: true });
  });

  const preview = await runCli([
    "publication",
    "plan",
    "preview",
    "01900000-0000-7000-8000-000000000002",
    "--request",
    requestPath,
    "--json",
  ]);
  assert.equal(preview.exitCode, 0, preview.stderr);
  assert.match(calls[0]!.url, /\/plans\/01900000-0000-7000-8000-000000000002\/preview$/);
  assert.deepEqual(calls[0]!.body, request);

  const refusedSchedule = await runCli([
    "publication",
    "plan",
    "schedule",
    "01900000-0000-7000-8000-000000000002",
    "--request",
    requestPath,
  ]);
  assert.equal(refusedSchedule.exitCode, 2);
  assert.equal(calls.length, 1, "schedule requires target confirmation before network activity");

  const scheduled = await runCli([
    "publication",
    "plan",
    "schedule",
    "01900000-0000-7000-8000-000000000002",
    "--request",
    requestPath,
    "--environment",
    "production",
    "--yes",
    "--json",
  ]);
  assert.equal(scheduled.exitCode, 0, scheduled.stderr);
  assert.match(calls[1]!.url, /\/plans\/01900000-0000-7000-8000-000000000002\/schedule$/);
  assert.equal(calls[1]!.headers.get("x-pcms-environment"), "production");
  assert.deepEqual(calls[1]!.body, request);
});
