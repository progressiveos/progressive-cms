import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "@pcms/cli";

test("theme cleanup CLI previews by default, confirms exact candidates and reports pending/stale failures", async (t) => {
  const env = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  });
  Object.assign(process.env, {
    PCMS_API_URL: "https://example.invalid",
    PCMS_API_TOKEN: "synthetic",
    PCMS_SITE_KEY: "default",
    PCMS_ENVIRONMENT: "test",
  });
  const calls: Record<string, unknown>[] = [];
  let mode = "ok";
  const id = "01900000-0000-7000-8000-000000000001";
  t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    const input = JSON.parse(String(options?.body));
    calls.push(input);
    if (input.dry_run === false && mode === "stale")
      return Response.json(
        { error: { code: "THEME_REVISION_STALE", message: "theme changed" } },
        { status: 409 },
      );
    return Response.json({
      ok: mode !== "pending" || input.dry_run,
      dry_run: input.dry_run,
      theme_generation: 9,
      candidates: [{ revision_id: id }],
      removed: input.dry_run ? [] : mode === "pending" ? [] : [id],
      pending: !input.dry_run && mode === "pending" ? [id] : [],
      has_more: false,
    });
  });
  const run = (args: string[]) => {
    calls.length = 0;
    return runCli(["theme", "cleanup", ...args, "--json"]);
  };
  assert.equal((await run([])).exitCode, 0);
  assert.deepEqual(calls, [{ dry_run: true, keep_last: 5, older_than_days: 1 }]);
  for (const args of [
    ["--apply"],
    ["--keep-last", "1"],
    ["--keep-last", "4"],
    ["--older-than-days", "0"],
    ["--keep-last"],
    ["--apply", "--dry-run"],
  ]) {
    assert.notEqual((await run(args)).exitCode, 0);
    assert.equal(calls.length, 0);
  }
  const args = [
    "--apply",
    "--environment",
    "test",
    "--yes",
    "--keep-last",
    "7",
    "--older-than-days",
    "7",
  ];
  assert.equal((await run(args)).exitCode, 0);
  assert.deepEqual(calls, [
    { dry_run: true, keep_last: 7, older_than_days: 7 },
    {
      dry_run: false,
      keep_last: 7,
      older_than_days: 7,
      expected_generation: 9,
      revision_ids: [id],
    },
  ]);
  mode = "stale";
  const stale = await run(args);
  assert.notEqual(stale.exitCode, 0);
  assert.equal(JSON.parse(stale.stdout).error.code, "THEME_REVISION_STALE");
  assert.equal(calls.length, 2);
  mode = "pending";
  assert.equal((await run(args)).exitCode, 7);
});
