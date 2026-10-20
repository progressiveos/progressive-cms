// Manual release upload (owner 2026-10-08): works on ANY instance — the
// registry does NOT have to be configured or bound. Binding only enables
// AUTOMATIC updates; the upload's version gate and orchestrator are local.
// This instance has NO registry.baseUrl at all (registryClient === null).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ApplicationServices } from "@pcms/api";
import { createApiFastify, createApiV1, makeRegistryRoutes } from "@pcms/api";
import { createLogger } from "@pcms/core";
import type { FastifyInstance } from "fastify";
import yazl from "yazl";
import { createApiFixture } from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

function buildArtifactZip(manifest: unknown): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "update-manifest.json");
    // Stored uncompressed and seeded pseudo-randomly: the route refuses
    // bodies under 1000 bytes, so the fixture zip must clear that bar.
    const filler = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 17) % 256));
    zip.addBuffer(filler, "payload.bin", { compress: false });
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
    zip.outputStream.on("error", reject);
  });
}

const manifest = (version: string) => ({
  manifest_version: "1",
  version,
  required_runtime: { node: ">=24 <25", postgres: ">=14 <19" },
  supports_extension_contracts: ["2.0"],
  backup_required: false,
  rollback_policy: "rollback_safe",
});

test("release-upload applies without any registry configuration (unbound instance)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const incoming = mkdtempSync(join(tmpdir(), "pcms-incoming-"));
  t.after(() => {
    rmSync(incoming, { recursive: true, force: true });
  });
  const { app } = await createApiFixture(t, { registryIncomingDir: incoming });
  const fastify: FastifyInstance = createApiFastify(() => "req_release_upload");
  await fastify.register(createApiV1([...makeRegistryRoutes()]), {
    application: app,
    logger: createLogger({ level: "error", sink: () => {} }),
    cookieSecure: false,
  });
  await fastify.ready();

  // The instance is deliberately UNBOUND: no registry.baseUrl, no token —
  // registryClient === null. Only extensions.manage is required.
  const account = await app.machineIdentity.createServiceAccount({
    name: `upload-sa-${Math.random().toString(36).slice(2, 8)}`,
    purpose: "manual release upload test",
    allowedScopes: ["extensions.manage"],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["extensions.manage"],
    ttlMilliseconds: 3_600_000,
  });
  const headers = {
    authorization: `Bearer ${token.rawSecret}`,
    "content-type": "application/octet-stream",
  };

  // A newer artifact passes the LOCAL version gate, stages, and reaches the
  // orchestrator — which fails CLOSED in the test composition (no M15
  // deployment adapters). The failure is typed and registry-free: the
  // upload itself works on an unbound instance.
  const newer = await fastify.inject({
    method: "POST",
    url: "/api/v1/registry/release-upload",
    headers,
    payload: await buildArtifactZip(manifest("99.0.0")),
  });
  // The orchestrator fails closed (no M15 adapters in the test composition):
  // a TYPED 409 — never a registry error — and the FAILED attempt lands in
  // pcms_update_history (the admin «история обновлений» surface).
  assert.equal(newer.statusCode, 409, newer.body);
  assert.equal(JSON.parse(newer.body).error.code, "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE");
  const history = await app.pool.query<{ status: string; to_version: string }>(
    `SELECT status, to_version FROM pcms_update_history ORDER BY started_at DESC LIMIT 1`,
  );
  assert.equal(history.rows[0]?.status, "FAILED");
  assert.equal(history.rows[0]?.to_version, "99.0.0");
});
