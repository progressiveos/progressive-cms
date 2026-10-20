import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFastify, createApiV1, makeRegistryRoutes } from "@pcms/api";
import { createLogger, loadMigrations } from "@pcms/core";
import { createContractVersionRegistry } from "@pcms/extensions/internal";
import yazl from "yazl";
import type { RegistryClient } from "../../packages/api/src/registry-client.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

async function zip(version: string): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  archive.addBuffer(
    Buffer.from(
      JSON.stringify({
        manifest_version: "1",
        version,
        core_db_migrations: loadMigrations("db/migrations").map((migration) => migration.name),
        required_runtime: { node: ">=24 <26", postgres: ">=14 <19" },
        supports_extension_contracts: ["2.0"],
        backup_required: false,
        rollback_policy: "rollback_safe",
      }),
    ),
    "update-manifest.json",
  );
  archive.addBuffer(Buffer.alloc(1500), "payload.bin", { compress: false });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  archive.end();
  return result;
}

test("RC update: Registry/upload/status retain runtime prerelease and fail closed", {
  skip: testDatabaseConfigured() ? false : "PCMS_TEST_DATABASE_URL unset",
}, async (t) => {
  const incoming = mkdtempSync(join(tmpdir(), "pcms-rc-gate-"));
  t.after(() => rmSync(incoming, { recursive: true, force: true }));
  const { app: base } = await rollbackApiFixture(t, {
    cmsVersion: "1.0.0-rc.23",
    releaseId: "v1.0.0-rc.23-20261018T000000Z-abcdef0",
    registryIncomingDir: incoming,
  });
  let downloads = 0;
  let report = "";
  const artifact = await zip("1.0.0-rc.24");
  const registryClient: RegistryClient = {
    baseUrl: "https://registry.invalid",
    configured: true,
    index: async () => ({
      packages: [],
      releases: [
        {
          version: "1.0.0-rc.24",
          artifact: "rc24.zip",
          sha256: createHash("sha256").update(artifact).digest("hex"),
          notes: "test",
        },
        { version: "1.0.0-rc.23", artifact: "rc23.zip", sha256: "0".repeat(64), notes: "test" },
        { version: "1.0.0-rc.22", artifact: "rc22.zip", sha256: "0".repeat(64), notes: "test" },
      ],
    }),
    downloadRelease: async () => {
      downloads++;
      return artifact;
    },
    packageCard: async () => ({}),
    download: async () => artifact,
    confirmInstance: async () => ({ token: "unused", account_email: "test@example.invalid" }),
    confirmStatus: async () => ({ status: "unused" }),
    report: async (_code, markdown) => {
      report = markdown;
    },
    noticeDownload: async () => {},
  };
  const app = {
    ...base,
    registryClient,
    registryReportUpdates: true,
    registryInstanceCode: { ...base.registryInstanceCode, read: async () => "PCMS-TEST" },
  };
  const server = createApiFastify(() => "req_rc_update");
  t.after(async () => {
    await server.close();
  });
  await server.register(createApiV1(makeRegistryRoutes()), {
    application: app,
    logger: createLogger({ level: "error", sink: () => {} }),
    cookieSecure: false,
  });
  await server.ready();
  const account = await app.machineIdentity.createServiceAccount({
    name: "rc-update-test",
    purpose: "test",
    allowedScopes: ["extensions.manage"],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["extensions.manage"],
    ttlMilliseconds: 60_000,
  });
  const authorization = `Bearer ${token.rawSecret}`;
  const status = await server.inject({
    method: "GET",
    url: "/api/v1/registry/update-status",
    headers: { authorization },
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().current_version, "1.0.0-rc.23");

  for (const version of ["1.0.0-rc.23", "1.0.0-rc.22"]) {
    for (const upload of [false, true]) {
      const response = await server.inject({
        method: "POST",
        url: upload ? "/api/v1/registry/release-upload" : "/api/v1/registry/apply-update",
        headers: {
          authorization,
          "content-type": upload ? "application/octet-stream" : "application/json",
        },
        payload: upload ? await zip(version) : { version },
      });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, "UPDATE_NOT_AN_UPGRADE");
    }
  }
  assert.equal(downloads, 0);
  assert.deepEqual(readdirSync(incoming), []);

  for (const upload of [false, true]) {
    const response = await server.inject({
      method: "POST",
      url: upload ? "/api/v1/registry/release-upload" : "/api/v1/registry/apply-update",
      headers: {
        authorization,
        "content-type": upload ? "application/octet-stream" : "application/json",
      },
      payload: upload ? artifact : { version: "1.0.0-rc.24" },
    });
    // The real orchestrator is reached, but deployment adapters are deliberately absent.
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, "UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE");
  }
  assert.equal(downloads, 1);
  const history = await app.pool.query<{ from_version: string; to_version: string }>(
    "SELECT from_version, to_version FROM pcms_update_history",
  );
  assert.equal(history.rows.length, 2);
  for (const row of history.rows)
    assert.deepEqual(row, { from_version: "1.0.0-rc.23", to_version: "1.0.0-rc.24" });

  // Success is simulated only through no-op deployment ports, never a real install.
  Object.defineProperty(app, "updateOrchestrationPorts", {
    value: {
      backupGate: { confirm: async () => {} },
      maintenance: { enter: async () => {}, exit: async () => {} },
      releaseDeployment: { deploy: async () => {} },
      serviceRestart: { restart: async () => {} },
      postflightDoctor: { run: async () => ({ ok: true }) },
      migrations: { applyCore: async () => [], applyExtensionMigrations: async () => [] },
    },
  });
  const success = await server.inject({
    method: "POST",
    url: "/api/v1/registry/apply-update",
    headers: { authorization, "content-type": "application/json" },
    payload: { version: "1.0.0-rc.24" },
  });
  assert.equal(success.statusCode, 200, success.body);
  assert.equal(success.json().update.status, "SUCCEEDED");
  assert.match(report, /\| previous_version \| 1\.0\.0-rc\.23 \|/);

  const versions = createContractVersionRegistry();
  Object.defineProperty(app.extensions, "contractVersions", { value: versions });
  const unknown = await server.inject({
    method: "GET",
    url: "/api/v1/registry/update-status",
    headers: { authorization },
  });
  assert.equal(unknown.statusCode, 409, unknown.body);
  assert.equal(unknown.json().error.code, "UPDATE_RUNTIME_VERSION_INVALID");
});
