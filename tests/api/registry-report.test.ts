// Agent update report (REGISTRY-INSTANCES-V2 §4) — contract regressions:
// the report POSTs to /api/v1/instances/report (the instance is identified
// by the Bearer token, no code in the URL — a per-code path 404s on the
// registry and the best-effort caller would silently drop the report), and
// the observations file lives at the instance state root, matching the
// site-builder SKILL.md instruction.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  __normalizeObservations,
  __observationsFileOf,
} from "../../packages/api/src/http/routes/registry.js";
import {
  createRegistryClient,
  type RegistryClient,
} from "../../packages/api/src/registry-client.js";

interface Captured {
  readonly url: string;
  readonly init?: RequestInit;
}

async function withCapturingFetch(run: (captured: Captured[]) => Promise<void>): Promise<void> {
  const captured: Captured[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push(init === undefined ? { url: String(url) } : { url: String(url), init });
    return new Response(JSON.stringify({ received: true, id: "test" }), { status: 201 });
  }) as typeof fetch;
  try {
    await run(captured);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function client(): RegistryClient {
  return createRegistryClient({
    baseUrl: "https://registry.example",
    resolveInstanceToken: async () => "instance-token",
  });
}

test("report() posts markdown to /api/v1/instances/report with the instance token", async () => {
  await withCapturingFetch(async (captured) => {
    await client().report("PCMS-73Z53-HS7KW-1EAGD", "# PCMS update report\n");
    const first = captured[0];
    assert.ok(first !== undefined, "no request captured");
    assert.equal(captured.length, 1);
    assert.equal(first.url, "https://registry.example/api/v1/instances/report");
    assert.equal(first.init?.method, "POST");
    const headers = new Headers(first.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer instance-token");
    assert.match(String(headers.get("content-type")), /^text\/markdown/);
    assert.equal(first.init?.body, "# PCMS update report\n");
  });
});

test("report() URL does not carry the instance code (registry resolves it from the token)", async () => {
  await withCapturingFetch(async (captured) => {
    await client().report("PCMS-00000-00000-00000", "x");
    const first = captured[0];
    assert.ok(first !== undefined, "no request captured");
    assert.ok(!first.url.includes("PCMS-"), first.url);
  });
});

test("observations normalize: agents' own heading is stripped, content kept (0.1.134 double-header)", () => {
  // Live 0.1.134 report shipped "## Agent observations" twice: the engine
  // adds its own heading and the file carried the agents' "# Agent
  // observations" title verbatim.
  const raw = [
    "# Agent observations",
    "",
    "- 2026-10-01: backup gate defaulted to the wrong DB host",
    "",
    "## Agent observations",
    "- duplicated section from an earlier append",
  ].join("\n");
  const notes = __normalizeObservations(raw);
  assert.ok(!notes.toLowerCase().includes("# agent observations"), notes);
  assert.match(notes, /backup gate defaulted/);
  assert.match(notes, /duplicated section/);
  // Empty heading-only files ship nothing and get consumed.
  assert.equal(__normalizeObservations("# Agent observations\n"), "");
  // Long files keep the 32 KiB ship cap.
  assert.equal(__normalizeObservations("x".repeat(40_000)).length <= 32_768, true);
});

test("observations file resolves to the state root, matching the SKILL.md path", () => {
  assert.equal(
    __observationsFileOf({ themeDir: "/var/lib/progressive-cms/themes/pcms-site" }),
    "/var/lib/progressive-cms/agent-observations.md",
  );
  assert.equal(__observationsFileOf({}), null);
});
