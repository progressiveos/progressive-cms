// Async apply-update contract (owner 2026-10-07): POST wait=false returns
// RUNNING immediately while the heavy part (download → stage → orchestrator)
// continues detached, and pre-orchestrator failures still land in
// pcms_update_history — a status poller must always converge.
// Arbitration surface: GET /registry/update-status.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { ApplicationServices } from "@pcms/api";
import { createApiFastify, createApiV1, makeRegistryRoutes } from "@pcms/api";
import { createLogger } from "@pcms/core";
import type { FastifyInstance } from "fastify";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

async function makeApp(
  t: { after: (fn: () => void) => void },
  registryBaseUrl: string,
): Promise<{ app: ApplicationServices; fastify: FastifyInstance }> {
  const { app } = await createApiFixture(t, { registryBaseUrl });
  const fastify: FastifyInstance = createApiFastify(() => "req_registry_async");
  await fastify.register(createApiV1([...makeRegistryRoutes()]), {
    application: app,
    logger: createLogger({ level: "error", sink: () => {} }),
    cookieSecure: false,
  });
  await fastify.ready();
  return { app, fastify };
}

async function bearerFor(app: ApplicationServices, scopes: readonly string[]): Promise<string> {
  const account = await app.machineIdentity.createServiceAccount({
    name: `registry-sa-${Math.random().toString(36).slice(2, 8)}`,
    purpose: "registry async apply test",
    allowedScopes: [...scopes],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [...scopes],
    ttlMilliseconds: 3_600_000,
  });
  return token.rawSecret;
}

test("apply-update wait=false returns RUNNING; pre-orchestrator failure reaches update-status", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");

  // Fake registry: serves a newer release whose artifact 404s — the detached
  // download fails and the failure must be recorded for pollers.
  const server: Server = createServer((request, response) => {
    if ((request.url ?? "").includes("/api/v1/index.json")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          releases: [
            {
              version: "99.0.0",
              artifact: "progressive-cms-99.0.0.zip",
              sha256: "0".repeat(64),
              notes: "async contract test",
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  t.after(() => server.close());

  const { app, fastify } = await makeApp(t, baseUrl);

  const token = await bearerFor(app, ["extensions.manage"]);
  const started = await fastify.inject({
    method: "POST",
    url: "/api/v1/registry/apply-update",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: { version: "99.0.0", wait: false },
  });
  assert.equal(started.statusCode, 200, started.body);
  const startedBody = started.json() as {
    staged: string | null;
    update: { status: string; to_version: string | null };
  };
  // Single-wrapped contract: update sits at the TOP level (0.1.192 regression).
  assert.equal(startedBody.update.status, "RUNNING");
  assert.equal(startedBody.update.to_version, "99.0.0");
  assert.equal(startedBody.staged, null);

  // The detached download 404s; the failure must reach the history so a
  // poller converges instead of waiting forever.
  let outcome: { status: string; failure_code: string | null } | null = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const polled = await fastify.inject({
      method: "GET",
      url: "/api/v1/registry/update-status",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(polled.statusCode, 200, polled.body);
    const body = polled.json() as {
      current_version: string;
      update: { status: string; to_version: string | null; failure_code: string | null } | null;
    };
    assert.equal(typeof body.current_version, "string");
    if (
      body.update !== null &&
      body.update.to_version === "99.0.0" &&
      body.update.status !== "RUNNING"
    ) {
      outcome = { status: body.update.status, failure_code: body.update.failure_code };
      break;
    }
  }
  assert.ok(outcome !== null, "update-status never showed a terminal record");
  assert.equal(outcome.status, "FAILED");
  assert.ok(outcome.failure_code !== null && outcome.failure_code !== "");
});
