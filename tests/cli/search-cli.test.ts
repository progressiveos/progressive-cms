import assert from "node:assert/strict";
import { test } from "node:test";
import { searchCommand } from "../../packages/cli/src/commands/search.js";

test("search CLI sends query, locale, and limit to the REST endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ total: 0, items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await searchCommand({
      args: ["query", "two words", "--locale", "en-US", "--limit", "7"],
      options: { json: true, yes: false },
      env: {
        PCMS_API_URL: "https://cms.test",
        PCMS_API_TOKEN: "test-token",
        PCMS_SITE_KEY: "site-a",
        PCMS_ENVIRONMENT: "production",
      },
    });

    assert.equal(requestedUrl, "https://cms.test/api/v1/search?q=two+words&locale=en-US&limit=7");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, total: 0, items: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("search CLI rejects an invalid limit before making an API request", async () => {
  const originalFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = (async () => {
    requested = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const result = await searchCommand({
      args: ["query", "control", "--limit", "0"],
      options: { json: true, yes: false },
      env: {
        PCMS_API_URL: "https://cms.test",
        PCMS_API_TOKEN: "test-token",
        PCMS_SITE_KEY: "site-a",
        PCMS_ENVIRONMENT: "production",
      },
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /positive integer/);
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
