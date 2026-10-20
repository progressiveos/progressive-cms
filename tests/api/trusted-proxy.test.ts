// PCMS-OPS-T105 — trusted reverse proxy handling (Operations spec §19/§20):
// X-Forwarded-Proto/For are honored only from configured proxy networks;
// any other peer's forwarded headers are ignored, so scheme/IP spoofing and
// canonical-URL poisoning fail closed. Real Fastify injection tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";

function probeApp(trustProxy?: readonly string[]) {
  const app = createApiFastify(() => "req-1", trustProxy === undefined ? {} : { trustProxy });
  app.get("/probe", async (request) => ({
    protocol: request.protocol,
    ip: request.ip,
    ips: request.ips,
    hostname: request.hostname,
  }));
  return app;
}

test("trusted proxy: forwarded scheme and client IP are honored", async () => {
  const app = probeApp(["127.0.0.1"]);
  const reply = await app.inject({
    method: "GET",
    url: "/probe",
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" },
  });
  assert.equal(reply.statusCode, 200);
  const body = reply.json() as { protocol: string; ip: string; ips: string[] };
  // The external RP terminated TLS: the canonical scheme must be https and
  // the client address the forwarded one, not the proxy loopback.
  assert.equal(body.protocol, "https");
  assert.equal(body.ip, "203.0.113.7");
  assert.ok(body.ips.includes("203.0.113.7"));
  await app.close();
});

test("default (no trustedProxies): forwarded headers are ignored", async () => {
  const app = probeApp();
  const reply = await app.inject({
    method: "GET",
    url: "/probe",
    remoteAddress: "10.1.2.3",
    headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" },
  });
  const body = reply.json() as { protocol: string; ip: string; ips: string[] };
  assert.equal(body.protocol, "http");
  assert.equal(body.ip, "10.1.2.3");
  // Without trusted proxies Fastify leaves the forwarded chain empty/absent.
  assert.deepEqual(body.ips ?? [], []);
  await app.close();
});

test("untrusted peer: forwarded headers ignored even when proxies configured", async () => {
  const app = probeApp(["198.51.100.20"]); // TEST-NET-2: neutral fixture
  const reply = await app.inject({
    method: "GET",
    url: "/probe",
    remoteAddress: "192.0.2.99",
    headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" },
  });
  const body = reply.json() as { protocol: string; ip: string };
  assert.equal(body.protocol, "http");
  assert.equal(body.ip, "192.0.2.99");
  await app.close();
});

test("loadConfig defaults to an empty trusted-proxy list", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadConfig } = await import("@pcms/core");
  const dir = mkdtempSync(join(tmpdir(), "pcms-config-"));
  const file = join(dir, "pcms.json");
  writeFileSync(
    file,
    JSON.stringify({
      nodeEnv: "production",
      db: { host: "127.0.0.1", port: 5432, database: "pcms", user: "pcms", sslMode: "disable" },
    }),
  );
  const config = loadConfig({ file, env: {} });
  assert.deepEqual(config.http.trustedProxies, []);
});
