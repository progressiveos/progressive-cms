// Registry Admin UX regressions (Task 2026-10-05; incident PCMS-ZCC5W-VC93S):
// 1) 401 from the registry NEVER becomes HTTP 401 to the operator (the admin
//    client logs out on any 401) — 502 + REGISTRY_UNAUTHORIZED stays;
// 2) the unauthorized message NAMES the token class (instance → rebind,
//    account → set a fresh token, none → set it);
// 3) the account token is write-only, stored in the runtime secret box,
//    resolved per request (no restart), and its flag rides /registry/instance;
// 4) the dead fetchRegistryReleases helper is gone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import type { RegistryError as RegistryErrorType } from "@pcms/api";
import { createRegistryClient, RegistryError } from "@pcms/api";

describe("registry client token classes", () => {
  const seen: string[] = [];
  let server: ReturnType<typeof createServer>;
  let baseUrl = "";

  before(async () => {
    server = createServer((request, response) => {
      const auth = request.headers.authorization ?? "";
      seen.push(`${request.method} ${request.url} ${auth}`);
      if (request.url === "/api/v1/index.json") {
        // Catalog: account principals only.
        if (auth === "Bearer account-ok") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ packages: [], releases: [] }));
        } else {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unauthorized" }));
        }
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });
  after(() => server.close());

  it("names the missing account token when nothing else is set", async () => {
    const client = createRegistryClient({
      baseUrl,
      resolveInstanceToken: () => Promise.resolve(null),
      resolveAccountToken: () => Promise.resolve(null),
    });
    await assert.rejects(client.index(), (rawError: unknown) => {
      const error = rawError as RegistryErrorType;
      assert.ok(error instanceof RegistryError);
      assert.equal(error.code, "REGISTRY_UNAUTHORIZED");
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /no registry account token/);
      return true;
    });
  });

  it("catalog 401 with an instance token and no account token points to the ACCOUNT token (instance rejection is by design; rebind would be a pointless loop)", async () => {
    const client = createRegistryClient({
      baseUrl,
      resolveInstanceToken: () => Promise.resolve("instance-revoked"),
      resolveAccountToken: () => Promise.resolve(null),
    });
    await assert.rejects(client.index(), (rawError: unknown) => {
      const error = rawError as RegistryErrorType;
      assert.ok(error instanceof RegistryError);
      assert.match(error.message, /no registry account token/);
      assert.doesNotMatch(error.message, /rebind/);
      return true;
    });
  });

  it("names a fresh account token when the stored one is rejected", async () => {
    const client = createRegistryClient({
      baseUrl,
      resolveInstanceToken: () => Promise.resolve(null),
      resolveAccountToken: () => Promise.resolve("account-stale"),
    });
    await assert.rejects(client.index(), (rawError: unknown) => {
      const error = rawError as RegistryErrorType;
      assert.ok(error instanceof RegistryError);
      assert.match(error.message, /account token rejected/);
      return true;
    });
  });

  it("resolves the account token PER REQUEST — saving it in admin revives the catalog without a restart", async () => {
    let stored: string | null = null;
    const client = createRegistryClient({
      baseUrl,
      resolveInstanceToken: () => Promise.resolve("instance-revoked"),
      resolveAccountToken: () => Promise.resolve(stored),
    });
    await assert.rejects(client.index(), /no registry account token/);
    stored = "account-ok"; // the admin "Save" writes the runtime secret
    const index = await client.index();
    assert.deepEqual(index.packages, []);
    // The catalog saw the account credential (instance token was retried first).
    assert.ok(seen.some((row) => row.includes("Bearer instance-revoked")));
    assert.ok(seen.some((row) => row.includes("Bearer account-ok")));
  });
});

describe("registry admin ux surface", () => {
  it("the dead GET /registry/releases helper is gone from the admin client", () => {
    const source = readFileSync("apps/admin/src/api/registry.ts", "utf8");
    assert.ok(!source.includes("registry/releases"), "dead helper removed");
    assert.ok(!source.includes("fetchRegistryReleases"), "helper function removed");
    assert.ok(!source.includes("RegistryReleases"), "helper type removed");
  });
});

describe("account-token HTTP surface (write-only, no-restart resolution)", () => {
  it("POST sets the flag, GET never echoes the value, DELETE clears; registry 401 rides 502", async (t) => {
    if (!process.env.PCMS_TEST_DATABASE_URL) return t.skip("PCMS_TEST_DATABASE_URL is not set");
    const { apiContextOf, createApiFixture, ownerActor } = await import(
      "../helpers/api-composition.js"
    );
    const { createApiV1 } = await import("@pcms/api");
    const { createSecretBox, deriveKeyForTesting } = await import("@pcms/auth");
    const { createApiFastify, makeRegistryRoutes } = await import("@pcms/api");
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // The fake upstream registry: catalog demands exactly "account-good".

    const upstream = createServer((request, response) => {
      if (request.url === "/api/v1/index.json") {
        if (request.headers.authorization === "Bearer account-good-token") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ packages: [], releases: [] }));
        } else {
          response.writeHead(401, { "content-type": "application/json" });
          response.end("{}");
        }
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    const upstreamUrl = `http://127.0.0.1:${typeof upstreamAddress === "object" && upstreamAddress !== null ? upstreamAddress.port : 0}`;
    t.after(() => upstream.close());

    const themeDir = mkdtempSync(join(tmpdir(), "pcms-registry-ux-"));
    writeFileSync(
      join(themeDir, "theme.json"),
      readFileSync("themes/reference-theme-v1/theme.json", "utf8"),
    );
    t.after(() => rmSync(themeDir, { recursive: true, force: true }));

    const { app } = await createApiFixture(t, {
      themeDir,
      registryBaseUrl: upstreamUrl,
      runtimeSecretBox: createSecretBox(deriveKeyForTesting("registry-ux")),
    });
    const fastify = createApiFastify(() => "req_registry_ux");
    await fastify.register(createApiV1([...makeRegistryRoutes()]), {
      application: app,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      cookieSecure: false,
    });
    const ctx = apiContextOf(ownerActor("registry-ux"));
    void ctx;
    const account = await app.machineIdentity.createServiceAccount({
      name: "registry-ux-sa",
      purpose: "registry admin ux test",
      allowedScopes: ["extensions.manage"],
    });
    const bearer = await app.machineIdentity.createAccessToken({
      serviceAccountId: account.id,
      scopes: ["extensions.manage"],
      ttlMilliseconds: 3_600_000,
    });
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${bearer.rawSecret}`,
    } as never;

    // Catalog before any token: REGISTRY_UNAUTHORIZED rides HTTP 502 (never
    // 401 — a 401 would log the operator out of Admin).
    const before = await fastify.inject({ method: "GET", url: "/api/v1/registry/index", headers });
    assert.equal(before.statusCode, 502, before.body);
    assert.equal(
      (before.json() as { error: { code: string } }).error.code,
      "REGISTRY_UNAUTHORIZED",
    );

    // Instance GET: badge off; the value is nowhere in the payload.
    const instance = await fastify.inject({
      method: "GET",
      url: "/api/v1/registry/instance",
      headers,
    });
    void ctx;
    assert.equal(instance.statusCode, 200);
    assert.equal((instance.json() as { account_token_set: boolean }).account_token_set, false);

    // POST the token (write-only): flag flips, response carries no secret.
    const set = await fastify.inject({
      method: "POST",
      url: "/api/v1/registry/account-token",
      headers,
      payload: { token: "account-good-token" },
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.ok(!set.body.includes("account-good-token"), "token value never echoed");
    const instanceAfter = await fastify.inject({
      method: "GET",
      url: "/api/v1/registry/instance",
      headers,
    });
    assert.equal((instanceAfter.json() as { account_token_set: boolean }).account_token_set, true);
    assert.ok(!instanceAfter.body.includes("account-good-token"));

    // The catalog revives WITHOUT a restart (per-request resolution) — and
    // the upstream saw the account credential.
    const revived = await fastify.inject({ method: "GET", url: "/api/v1/registry/index", headers });
    assert.equal(revived.statusCode, 200, revived.body);

    // DELETE clears; the catalog degrades back to the typed 502.
    const cleared = await fastify.inject({
      method: "DELETE",
      url: "/api/v1/registry/account-token",
      headers: { authorization: (headers as Record<string, string>).authorization },
    });
    assert.equal(cleared.statusCode, 200);
    const instanceCleared = await fastify.inject({
      method: "GET",
      url: "/api/v1/registry/instance",
      headers,
    });
    assert.equal(
      (instanceCleared.json() as { account_token_set: boolean }).account_token_set,
      false,
    );
    const after = await fastify.inject({ method: "GET", url: "/api/v1/registry/index", headers });
    assert.equal(after.statusCode, 502);
  });
});
