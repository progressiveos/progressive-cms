// Runware generation provider — download hardening (S-1/S-4, audit
// 2026-09-28): manual-redirect download where every hop re-passes the
// https+host allowlist, body stream-capped, redirect count bounded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "@pcms/media";
import { createGenerationProvider } from "../../extensions/progressive-media-runware/src/index.js";

function provider() {
  return createGenerationProvider({ config: { api_key: "test-key" }, secrets: {} });
}

function candidate(downloadUrl: string) {
  return {
    index: 0,
    previewUrl: null,
    downloadUrl,
    width: null,
    height: null,
    mimeType: "image/jpeg",
    model: "runware:z-image@turbo",
    providerRequestId: null,
    seed: null,
    cost: null,
  };
}

function withFetch(mock: typeof fetch, run: () => Promise<unknown>): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const ALLOWED = "https://aws-us-east-1.runware.net/live/abc.jpg";

test("fetch: allowlisted https host returns bytes, mime and filename", async () => {
  await withFetch(
    (async () =>
      new Response(Buffer.from("jpeg-bytes"), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })) as unknown as typeof fetch,
    async () => {
      const fetched = await provider().fetch({ requestId: "t" }, candidate(ALLOWED));
      assert.equal(fetched.bytes.toString(), "jpeg-bytes");
      assert.equal(fetched.mimeType, "image/jpeg");
      assert.equal(fetched.filename, "abc.jpg");
    },
  );
});

test("fetch: non-allowlisted host rejected before any request", async () => {
  let called = 0;
  await withFetch(
    (async () => {
      called += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => provider().fetch({ requestId: "t" }, candidate("https://evil.example.com/x.jpg")),
        (error: unknown) =>
          error instanceof ProviderError && error.code === "PROVIDER_INVALID_REQUEST",
      );
    },
  );
  assert.equal(called, 0);
});

test("fetch: plain-http allowlisted host rejected (https pinning)", async () => {
  await withFetch(
    (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () =>
          provider().fetch(
            { requestId: "t" },
            candidate("http://aws-us-east-1.runware.net/live/abc.jpg"),
          ),
        (error: unknown) =>
          error instanceof ProviderError && error.code === "PROVIDER_INVALID_REQUEST",
      );
    },
  );
});

test("fetch: redirect is re-validated — hop to non-allowlisted host rejected", async () => {
  await withFetch(
    (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      })) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => provider().fetch({ requestId: "t" }, candidate(ALLOWED)),
        (error: unknown) =>
          error instanceof ProviderError && error.code === "PROVIDER_INVALID_REQUEST",
      );
    },
  );
});

test("fetch: redirect chain that stays on the allowlist is followed", async () => {
  await withFetch(
    (async (url: string) =>
      url.endsWith("/first")
        ? new Response(null, { status: 302, headers: { location: "/second" } })
        : new Response(Buffer.from("final"), {
            status: 200,
            headers: { "content-type": "image/png" },
          })) as unknown as typeof fetch,
    async () => {
      const fetched = await provider().fetch(
        { requestId: "t" },
        candidate("https://cdn.runware.ai/live/first"),
      );
      assert.equal(fetched.bytes.toString(), "final");
      assert.equal(fetched.filename, "second");
    },
  );
});

test("fetch: more than 3 redirects rejected", async () => {
  let hops = 0;
  await withFetch(
    (async () => {
      hops += 1;
      return new Response(null, { status: 302, headers: { location: `/hop${hops}` } });
    }) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => provider().fetch({ requestId: "t" }, candidate(ALLOWED)),
        (error: unknown) => error instanceof ProviderError && error.code === "PROVIDER_FAILED",
      );
    },
  );
  assert.ok(hops <= 5);
});

test("fetch: declared content-length over the cap rejected", async () => {
  await withFetch(
    (async () =>
      new Response(Buffer.from("x"), {
        status: 200,
        headers: { "content-length": String(65 * 1024 * 1024) },
      })) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => provider().fetch({ requestId: "t" }, candidate(ALLOWED)),
        (error: unknown) => error instanceof ProviderError && error.code === "PROVIDER_FAILED",
      );
    },
  );
});
