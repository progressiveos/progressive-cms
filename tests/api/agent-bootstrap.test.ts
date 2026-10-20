// M16 agent bootstrap surface (task brief §19–§23): one authenticated
// discovery read answering site/environment/actor/contracts/capabilities/
// skills — the surface whose absence forced M15 content agents into source
// archaeology (spangar gap G1). Secret-free by construction.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createApiFastify, createApiV1, makeAgentRoutes } from "@pcms/api";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

async function startAgentApi(
  t: { after: (fn: () => void) => void },
  scopes: string[],
  options: { previewSecret?: string | null } = {},
) {
  const { app } = await createApiFixture(t, options);
  await app.routes.ensureSite("default", "Bootstrap Test Site");
  const account = await app.machineIdentity.createServiceAccount({
    name: "m16-bootstrap-test",
    purpose: "agent bootstrap integration tests",
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes,
    ttlMilliseconds: 3_600_000,
  });
  const fastify = createApiFastify(() => "req_agent_bootstrap");
  await fastify.register(createApiV1(makeAgentRoutes()), {
    application: app,
    logger: silentLogger,
    cookieSecure: false,
  });
  return { app, fastify, bearer: token.rawSecret };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("anonymous callers are rejected", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify } = await startAgentApi(t, []);
  const response = await fastify.inject({ method: "GET", url: "/api/v1/agent/bootstrap" });
  assert.equal(response.statusCode, 401);
});

test("bootstrap answers site/environment/actor/contracts/skills for a scoped agent", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, bearer } = await startAgentApi(t, ["content.read", "publication.read"]);
  // SEO identity «Название сайта» — the operator-facing name; the routing
  // row's title ("Bootstrap Test Site") must lose to it (owner 2026-10-08).
  await app.pool.query(
    `INSERT INTO seo_site_settings (site_id, payload)
     SELECT id, '{"site_name":"Мой сайт"}'::jsonb FROM sites WHERE key = 'default'`,
  );
  const response = await fastify.inject({
    method: "GET",
    url: "/api/v1/agent/bootstrap",
    headers: auth(bearer),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    site: { key: string; title: string } | null;
    environment: { classification: string };
    actor: { type: string; permissions: readonly string[] };
    server: { cms_version: string | null };
    contracts: Record<string, string>;
    skills: {
      installed: readonly {
        id: string;
        version: string;
        compatibility: { result: string };
      }[];
    };
    publication: { preview: { available: boolean; reason_code?: string } };
    routing: { primary_domain: string | null; domains: readonly unknown[] };
    media: { import_available: boolean };
    safety: { environment: string };
  };

  assert.equal(body.site?.key, "default");
  // Identity site_name wins over the routing title; without identity the
  // routing title is the fallback.
  assert.equal((body.site as { title?: string } | null)?.title, "Мой сайт");
  // Fail-safe default: a composition that does not declare production is
  // reported as development.
  assert.equal(body.environment.classification, "development");
  assert.equal(body.actor.type, "SERVICE_ACCOUNT");
  assert.deepEqual([...body.actor.permissions].sort(), ["content.read", "publication.read"]);
  assert.ok(body.server.cms_version);
  assert.ok(body.contracts.rest_api);
  assert.ok(body.contracts.block_document);

  // The repo checkout ships both first-party skills; the scoped agent cannot
  // publish, so the content manifest's required publish capability must NOT
  // be reported satisfied — but compatibility reads on contracts/capabilities.
  const ids = body.skills.installed.map((skill) => skill.id).sort();
  const expected = [
    "progressive-cms-content-agent",
    "progressive-cms-extension-developer",
    "progressive-cms-operator",
    "progressive-cms-theme-developer",
    "progressive-cms-web-research",
  ];
  // Public Docs adds three root Skills; the final ZIP gate requires their exact resources.
  if (existsSync("skills/progressive-cms-site-builder/manifest.json"))
    expected.push("progressive-cms-152fz", "progressive-cms-seo", "progressive-cms-site-builder");
  assert.deepEqual(ids, expected.sort());
  for (const skill of body.skills.installed) {
    assert.match(skill.version, /^\d+\.\d+\.\d+$/);
    assert.ok(
      ["compatible", "warning", "incompatible"].includes(skill.compatibility.result),
      `${skill.id}: ${skill.compatibility.result}`,
    );
  }

  // Preview readiness is reported (default fixture configures a secret).
  assert.equal(body.publication.preview.available, true);
  assert.equal(body.publication.preview.reason_code, undefined);
  // The fixture wires a local media storage → import exists server-side;
  // actor-level availability comes from the capabilities section instead.
  assert.equal(typeof body.media.import_available, "boolean");
  assert.equal(body.safety.environment, "development");
});

test("unconfigured preview reports PREVIEW_NOT_CONFIGURED (task brief §22)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify, bearer } = await startAgentApi(t, ["content.read"], { previewSecret: null });
  const response = await fastify.inject({
    method: "GET",
    url: "/api/v1/agent/bootstrap",
    headers: auth(bearer),
  });
  const preview = (
    response.json() as {
      publication: { preview: { available: boolean; reason_code?: string } };
    }
  ).publication.preview;
  assert.equal(preview.available, false);
  assert.equal(preview.reason_code, "PREVIEW_NOT_CONFIGURED");
});

test("bootstrap never leaks secret material", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { fastify, bearer } = await startAgentApi(t, ["content.read"]);
  const response = await fastify.inject({
    method: "GET",
    url: "/api/v1/agent/bootstrap",
    headers: auth(bearer),
  });
  const text = response.body;
  // The bearer token itself must never be echoed back.
  assert.equal(text.includes(bearer), false);
  for (const forbidden of ["password", "secret_value", "token=", "postgres://"]) {
    assert.equal(text.toLowerCase().includes(forbidden), false, forbidden);
  }
});
