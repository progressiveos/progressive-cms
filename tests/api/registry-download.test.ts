import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRegistryClient,
  RELEASE_ARTIFACT_MAX_BYTES,
  RegistryError,
} from "../../packages/api/src/registry-client.js";

const release = { version: "0.1.138", artifact: "/release.zip", sha256: "", notes: "" };

test("registry release budget includes body reading; JSON keeps the short budget", async (t) => {
  const budgets: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    budgets.push(ms);
    return new AbortController().signal;
  });
  const client = createRegistryClient({ baseUrl: "https://registry.example" });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    return new Response("{}");
  });
  await client.index();
  assert.equal((await client.downloadRelease(release)).toString(), "{}");
  assert.deepEqual(budgets, [15_000, 300_000]);

  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException("body timeout", "TimeoutError"));
          },
        }),
      ),
  );
  for (const read of [() => client.index(), () => client.downloadRelease(release)]) {
    await assert.rejects(
      read,
      (error: unknown) => error instanceof RegistryError && error.code === "REGISTRY_UNREACHABLE",
    );
  }
});

test("release download still refuses redirects and declared oversized archives", async (t) => {
  const client = createRegistryClient({ baseUrl: "https://registry.example" });
  for (const [response, code] of [
    [new Response(null, { status: 302 }), "REGISTRY_REDIRECT_REFUSED"],
    [
      new Response(null, {
        headers: { "content-length": String(RELEASE_ARTIFACT_MAX_BYTES + 1) },
      }),
      "REGISTRY_PACKAGE_TOO_LARGE",
    ],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(
      () => client.downloadRelease(release),
      (error: unknown) => error instanceof RegistryError && error.code === code,
    );
  }
});

test("release cap tracks the registry publish limit (128 MB) — an artifact the registry accepts must download", async (t) => {
  assert.equal(RELEASE_ARTIFACT_MAX_BYTES, 128 * 1024 * 1024);
  const client = createRegistryClient({ baseUrl: "https://registry.example" });
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{}", {
        headers: { "content-length": String(RELEASE_ARTIFACT_MAX_BYTES) },
      }),
  );
  assert.equal((await client.downloadRelease(release)).toString(), "{}");
});
