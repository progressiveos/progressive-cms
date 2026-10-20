import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  bindOperations,
  cleanupThemeRevisions,
  createApiFastify,
  createApiV1,
  getConfirmedThemeRevision,
  makeThemeManageRoutes,
  withThemeLifecycleLock,
} from "@pcms/api";
import { runCli } from "@pcms/cli";
import { createLogger, type DbPool } from "@pcms/core";
import { createMcpServer, type McpOperations } from "@pcms/mcp";
import { snapshotThemeFiles } from "@pcms/themes";
import { registerThemeFilesRoute } from "../../apps/web/src/theme-files.js";
import { rollbackTheme } from "../../packages/api/src/theme-lifecycle.js";
import { apiContextOf, ownerActor, scopedActor } from "../helpers/api-composition.js";
import { rollbackApiFixture } from "../helpers/rollback-api-fixture.js";

test("theme cleanup: real SQL, protected history, durable failures, REST/CLI/MCP and asset isolation", {
  skip: !process.env.PCMS_TEST_DATABASE_URL,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pcms-theme-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const themeDir = join(root, "themes", "reference-theme-v1");
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });
  const { app, pool } = await rollbackApiFixture(t, { themeDir }, { transactionMode: "committed" });
  const ctx = apiContextOf(ownerActor());
  const rows: { id: string; dir: string; key: string }[] = [];
  async function seed(days: number, site = "default", confirmed = true) {
    const id = randomUUID();
    const files = snapshotThemeFiles(themeDir, themeDir);
    await pool.query(
      `INSERT INTO theme_revisions(id,site_key,theme_key,package_version,file_sha256,storage_key,settings,created_at)
      VALUES($1,$2,'reference-theme-v1','1.0.0',$3,$4,'{}',now()-make_interval(days => $5::int))`,
      [id, site, files.sha256, files.storageKey, days],
    );
    if (confirmed)
      await pool.query(
        `INSERT INTO theme_operations(id,site_key,kind,from_revision_id,target_revision_id,expected_generation,phase,created_at,finished_at)
      VALUES($1,$2,'SETTINGS',$3,$3,0,'COMMITTED',now()-make_interval(days => $4::int),now()-make_interval(days => $4::int))`,
        [randomUUID(), site, id, days],
      );
    return { id, dir: files.dir, key: files.storageKey };
  }
  for (let i = 0; i < 9; i++) rows.push(await seed(12 - i));
  const active = rows[8]!;
  await pool.query(
    "INSERT INTO admin_theme_state(site_key,theme_key,theme_version,settings,active_revision_id,theme_generation) VALUES('default','reference-theme-v1','1.0.0','{}',$1,20)",
    [active.id],
  );
  const recent = await seed(0, "default", false);
  const other = await seed(30, "other-site");
  const lastGoodProbe = randomUUID();
  await pool.query(
    `INSERT INTO theme_operations(id,site_key,kind,from_revision_id,target_revision_id,expected_generation,phase,created_at,finished_at)
    VALUES($1,'default','ROLLBACK',$2,$3,19,'COMMITTED',now()-interval '2 days',now()-interval '2 days')`,
    [lastGoodProbe, rows[0]!.id, active.id],
  );
  assert.equal(
    (await cleanupThemeRevisions(app, ctx, {})).candidates.some(
      (r) => r.revision_id === rows[0]!.id,
    ),
    false,
    "last-good remains protected even outside the newest five",
  );
  await pool.query("DELETE FROM theme_operations WHERE id=$1", [lastGoodProbe]);
  const pendingId = randomUUID();
  await pool.query(
    `INSERT INTO theme_operations(id,site_key,kind,from_revision_id,target_revision_id,catalog_before_revision_id,expected_generation,phase,created_at)
    VALUES($1,'default','UPDATE',$2,$3,$2,20,'PREPARED',now()-interval '20 days')`,
    [pendingId, rows[1]!.id, active.id],
  );
  const plan = await cleanupThemeRevisions(app, ctx, {});
  assert.equal(plan.dry_run, true);
  assert.deepEqual(
    new Set(plan.candidates.map((r) => r.revision_id)),
    new Set([rows[0]!.id, rows[2]!.id, rows[3]!.id]),
  );
  assert.equal(plan.retained_count, 10);
  assert.equal(
    rows.every((r) => existsSync(r.dir)),
    true,
  );
  const applyInput = {
    dry_run: false,
    expected_generation: 20,
    revision_ids: plan.candidates.map((r) => r.revision_id),
  };
  const countAudit = async () =>
    (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM auth_security_events"))
      .rows[0]!.n;
  const audits = await countAudit();
  await assert.rejects(
    cleanupThemeRevisions(app, apiContextOf(scopedActor(["theme.read"])), applyInput),
    { code: "AUTH_PERMISSION_DENIED" },
  );
  await assert.rejects(
    cleanupThemeRevisions(app, { ...ctx, actor: { ...ctx.actor, siteKey: "other-site" } }, {}),
    { code: "AUTH_TOKEN_SITE_DENIED" },
  );
  await assert.rejects(
    cleanupThemeRevisions(app, ctx, { ...applyInput, expected_generation: 19 }),
    { code: "THEME_REVISION_STALE" },
  );
  for (const id of [active.id, rows[1]!.id, rows[7]!.id, recent.id])
    await assert.rejects(cleanupThemeRevisions(app, ctx, { ...applyInput, revision_ids: [id] }), {
      code: "THEME_REVISION_PROTECTED",
    });
  await assert.rejects(
    cleanupThemeRevisions(app, ctx, { ...applyInput, revision_ids: [other.id] }),
    { code: "THEME_REVISION_NOT_FOUND" },
  );
  for (const invalid of [
    { keep_last: 4 },
    { keep_last: 0 },
    { older_than_days: 0 },
    { dry_run: false },
    { ...applyInput, revision_ids: [active.id, active.id] },
  ])
    await assert.rejects(cleanupThemeRevisions(app, ctx, invalid), { code: "API_REQUEST_INVALID" });
  await withThemeLifecycleLock({ pool, configuredDir: themeDir, siteKey: "default" }, async () => {
    await assert.rejects(cleanupThemeRevisions(app, ctx, applyInput), {
      code: "THEME_CHANGE_BUSY",
    });
  });
  const guardedPool: DbPool = {
    ...pool,
    withClient: (work) =>
      pool.withClient((db) =>
        work({
          ...db,
          async query(sql, params) {
            if (sql.includes("INSERT INTO auth_security_events"))
              throw new Error("audit storage unavailable");
            return db.query(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    cleanupThemeRevisions({ ...app, pool: guardedPool }, ctx, applyInput),
    /audit storage unavailable/,
  );
  assert.equal(
    (await pool.query("SELECT id FROM theme_revisions WHERE pruned_at IS NOT NULL")).rows.length,
    0,
  );
  assert.equal(await countAudit(), audits);

  const account = await app.machineIdentity.createServiceAccount({
    name: "cleanup-test",
    purpose: "test",
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["theme.read", "theme.write"],
    ttlMilliseconds: 60000,
    siteKey: "default",
    environment: "production",
  });
  const headers = {
    authorization: `Bearer ${token.rawSecret}`,
    "x-pcms-site": "default",
    "x-pcms-environment": "production",
  };
  const server = createApiFastify(() => "cleanup-regression");
  t.after(() => server.close());
  await server.register(createApiV1(makeThemeManageRoutes()), {
    application: app,
    logger: createLogger({ level: "error", base: {} }),
    cookieSecure: false,
  });
  registerThemeFilesRoute(server, { renderDir: themeDir, application: app });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const assetUrl = (id: string) =>
    `/themes/reference-theme-v1/revisions/${id}/assets/css/theme.css`;
  const activeCss = await server.inject({ method: "GET", url: assetUrl(active.id) });
  assert.equal(activeCss.statusCode, 200);
  assert.equal(
    (
      await server.inject({
        method: "POST",
        url: "/api/v1/themes/revisions/cleanup",
        headers,
        payload: { dry_run: "false" },
      })
    ).statusCode,
    400,
  );
  const preview = await server.inject({
    method: "POST",
    url: "/api/v1/themes/revisions/cleanup",
    headers,
    payload: { dry_run: true },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().candidates.length, 3);

  // A replaced store must never make cleanup follow a symlink outside its root.
  const store = dirname(active.dir);
  const held = `${store}.held`;
  const outside = join(root, "outside");
  cpSync(themeDir, outside, { recursive: true });
  writeFileSync(join(outside, "sentinel"), "keep");
  renameSync(store, held);
  symlinkSync(outside, store);
  try {
    const failed = await cleanupThemeRevisions(app, ctx, applyInput);
    assert.equal(failed.ok, false);
    assert.equal(failed.pending.length, 3);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
  } finally {
    rmSync(store);
    renameSync(held, store);
  }
  assert.equal(await getConfirmedThemeRevision(pool, "default", rows[0]!.id), null);
  assert.equal(existsSync(rows[0]!.dir), true);
  const cleanupAudits = await countAudit();

  const savedEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  Object.assign(process.env, {
    PCMS_API_URL: server.listeningOrigin,
    PCMS_API_TOKEN: token.rawSecret,
    PCMS_SITE_KEY: "default",
    PCMS_ENVIRONMENT: "production",
  });
  const cli = await runCli([
    "theme",
    "cleanup",
    "--apply",
    "--environment",
    "production",
    "--yes",
    "--json",
  ]);
  assert.equal(cli.exitCode, 0, cli.stdout + cli.stderr);
  assert.equal(JSON.parse(cli.stdout).removed.length, 3);
  assert.equal(await countAudit(), cleanupAudits, "retry must not duplicate retirement audit");
  const repeated = await cleanupThemeRevisions(app, ctx, applyInput);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.removed.length, 3);
  assert.equal(await countAudit(), cleanupAudits);
  for (const id of applyInput.revision_ids)
    assert.equal(existsSync(rows.find((r) => r.id === id)!.dir), false);
  assert.equal(existsSync(active.dir), true);
  assert.equal(existsSync(other.dir), true);
  assert.equal(existsSync(recent.dir), true);
  assert.equal(
    (await server.inject({ method: "GET", url: assetUrl(rows[0]!.id) })).statusCode,
    404,
  );
  assert.equal(
    (await server.inject({ method: "GET", url: assetUrl(active.id) })).body,
    activeCss.body,
  );
  const history = (
    await server.inject({ method: "GET", url: "/api/v1/themes/revisions", headers })
  ).json();
  assert.equal(
    history.revisions.some((r: { revision_id: string }) =>
      applyInput.revision_ids.includes(r.revision_id),
    ),
    false,
  );
  assert.equal(history.active_revision_id, active.id);
  assert.equal(history.theme_generation, 20);
  await assert.rejects(
    rollbackTheme(app, ctx, { revision_id: rows[0]!.id, expected_generation: 20 }),
    { code: "THEME_REVISION_NOT_FOUND" },
  );
  const mcp = createMcpServer({
    operations: bindOperations(app) as unknown as McpOperations,
    serverInfo: { name: "test", version: "1" },
  });
  const reply = await mcp.handleRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cms_cleanup_theme_revisions", arguments: {} },
    },
    () => ctx,
  );
  assert.equal((reply as { result: { isError: boolean } }).result.isError, false);
  const constraints = await pool.query("SELECT id FROM theme_operations WHERE id=$1", [pendingId]);
  assert.equal(constraints.rows.length, 1);
  await pool.query(`INSERT INTO theme_revisions(id,site_key,theme_key,package_version,file_sha256,storage_key,settings,created_at)
    SELECT gen_random_uuid(),'default','reference-theme-v1','1.0.0',repeat('a',64),gen_random_uuid()::text,'{}',now()-interval '90 days' FROM generate_series(1,105)`);
  const batch = await cleanupThemeRevisions(app, ctx, {});
  assert.equal(batch.candidates.length, 100);
  assert.equal(batch.has_more, true);
  const privateCleanup = {
    dry_run: false,
    expected_generation: 20,
    revision_ids: [batch.candidates[0]!.revision_id],
  };
  assert.equal((await cleanupThemeRevisions(app, ctx, privateCleanup)).ok, true);
  // An unrelated mutation's orphan GC must not erase explicit cleanup receipts.
  await assert.rejects(
    rollbackTheme(app, ctx, { revision_id: rows[0]!.id, expected_generation: 20 }),
    { code: "THEME_REVISION_NOT_FOUND" },
  );
  assert.equal((await cleanupThemeRevisions(app, ctx, privateCleanup)).ok, true);
});
