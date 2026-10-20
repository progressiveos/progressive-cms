// Theme package installer (.pcTheme): zip fail-closed gate, full-contract
// validation on a staged copy, renderDir protection, reinstall-replace,
// uninstall guards, installed listing with broken-theme visibility.
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import yazlWrite from "yazl";
import {
  installThemePackage,
  listInstalledThemes,
  ThemeInstallError,
  uninstallThemePackage,
  updateActiveThemePackage,
  validateThemeEntryNames,
  validateThemePackage,
} from "../../packages/themes/src/install-package.js";

const REFERENCE_THEME = join(process.cwd(), "themes", "reference-theme-v1");

function zipDirOf(dir: string): Promise<Buffer> {
  const zip = new yazlWrite.ZipFile();
  const walk = (prefix: string, absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const childAbsolute = join(absolute, entry.name);
      const childPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(childPath, childAbsolute);
      else zip.addBuffer(readFileSync(childAbsolute), childPath);
    }
  };
  walk("", dir);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

function zipOf(files: Readonly<Record<string, string>>): Promise<Buffer> {
  const zip = new yazlWrite.ZipFile();
  for (const [name, content] of Object.entries(files)) {
    zip.addBuffer(Buffer.from(content, "utf8"), name);
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

/** A guaranteed-valid theme package: the first-party reference theme with a
 * renamed id, so the full contract validator (manifest, assets, fixture
 * render smoke) passes for real. */
async function referenceThemePackage(
  id: string,
  mutate?: (themeDir: string) => void,
): Promise<Buffer> {
  const stage = mkdtempSync(join(tmpdir(), "pcms-theme-test-"));
  const themeDir = join(stage, id);
  cpSync(REFERENCE_THEME, themeDir, { recursive: true });
  const manifestPath = join(themeDir, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.id = id;
  manifest.name = `Test ${id}`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  mutate?.(themeDir);
  return zipDirOf(themeDir).finally(() => rmSync(stage, { recursive: true, force: true }));
}

test("validateThemePackage: reference-based package passes with its own identity", async () => {
  const bytes = await referenceThemePackage("test-dark-v1");
  const info = await validateThemePackage(bytes);
  assert.equal(info.id, "test-dark-v1");
  assert.equal(info.version.length > 0, true);
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
});

test("active update validates identity/version, stages before commit and restores files on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pcms-active-theme-"));
  const active = join(root, "active-theme");
  cpSync(REFERENCE_THEME, active, { recursive: true });
  const manifestPath = join(active, "theme.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.id = "active-theme";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = readFileSync(manifestPath, "utf8");
  const mode = lstatSync(active).mode & 0o777;
  const bytes = await referenceThemePackage("active-theme", (dir) => {
    const path = join(dir, "theme.json");
    const next = JSON.parse(readFileSync(path, "utf8"));
    next.version = "2.10.5";
    writeFileSync(path, JSON.stringify(next));
  });
  const options = { themeDir: active, themeId: "active-theme", cmsVersion: "1.0.0-rc.1" };
  try {
    await assert.rejects(
      () =>
        updateActiveThemePackage(bytes, {
          ...options,
          prepare: async () => () => {
            throw new Error("commit failed");
          },
        }),
      /commit failed/,
    );
    assert.equal(readFileSync(manifestPath, "utf8"), before);
    assert.deepEqual(readdirSync(root), ["active-theme"]);
    await assert.rejects(
      () =>
        updateActiveThemePackage(bytes, {
          ...options,
          themeId: "other-theme",
          prepare: async () => () => {},
        }),
      (error: ThemeInstallError) => {
        assert.equal(error.code, "THEME_UPDATE_ID_INVALID");
        assert.match(error.message, /POST \/api\/v1\/theme\/activate/);
        assert.doesNotMatch(error.message, /point themes.renderDir|restart the web service/);
        return true;
      },
    );
    let committed = false;
    await updateActiveThemePackage(bytes, {
      ...options,
      prepare: async (staged) => {
        assert.equal(
          JSON.parse(readFileSync(join(staged, "theme.json"), "utf8")).version,
          "2.10.5",
        );
        assert.equal(readFileSync(manifestPath, "utf8"), before);
        return () => {
          committed = true;
        };
      },
    });
    assert.equal(committed, true);
    assert.equal(lstatSync(active).mode & 0o777, mode);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).version, "2.10.5");
    await assert.rejects(
      () => updateActiveThemePackage(bytes, { ...options, prepare: async () => () => {} }),
      (error: ThemeInstallError) => error.code === "THEME_UPDATE_VERSION_CONFLICT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI updates the live active theme without restart; rejected packages and permissions preserve site state", async (t) => {
  const { testDatabaseConfigured } = await import("../helpers/testdb.js");
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { apiContextOf, ownerActor } = await import("../helpers/api-composition.js");
  const { rollbackApiFixture } = await import("../helpers/rollback-api-fixture.js");
  const {
    createApiFastify,
    createApiV1,
    makeThemeManageRoutes,
    getThemeState,
    createDraft,
    sealRevision,
    publishRevision,
  } = await import("@pcms/api");
  const { createLogger } = await import("@pcms/core");
  const { runCli } = await import("@pcms/cli");
  const root = mkdtempSync(join(tmpdir(), "pcms-active-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const active = join(root, "reference-theme-v1");
  cpSync(REFERENCE_THEME, active, { recursive: true });
  const definitions = JSON.parse(
    readFileSync("fixtures/content/reference-content-types.json", "utf8"),
  );
  const { app } = await rollbackApiFixture(
    t,
    {
      themeDir: active,
      contentTypeDefinitions: definitions.contentTypes,
    },
    { transactionMode: "committed" },
  );
  await app.pool.query(
    `INSERT INTO admin_theme_state (site_key, theme_key, theme_version, settings, settings_generation)
     VALUES ($1, $2, $3, $4, 7)`,
    [
      app.defaultSiteKey,
      "reference-theme-v1",
      "1.2.2",
      JSON.stringify({ header_variant: "compact", footer_text: "SETTINGS_PRESERVED" }),
    ],
  );
  const fastify = createApiFastify(() => "active-theme-update-test");
  t.after(() => fastify.close());
  await fastify.register(createApiV1(makeThemeManageRoutes()), {
    application: app,
    logger: createLogger({ level: "error", base: {} }),
    cookieSecure: false,
  });
  const { registerSiteRoute } = await import("../../apps/web/src/site.js");
  const { registerThemeFilesRoute } = await import("../../apps/web/src/theme-files.js");
  await registerSiteRoute(fastify, { application: app });
  registerThemeFilesRoute(fastify, { renderDir: active });
  const ctx = apiContextOf(ownerActor());
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Live theme update" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  const site = await app.routes.ensureSite("default");
  await app.routes.activateRoute({
    siteId: site.id,
    path: "/theme-update",
    targetType: "entry",
    targetId: draft.entry_id,
  });
  const scopes = ["theme.read", "theme.write", "theme.activate"];
  const account = await app.machineIdentity.createServiceAccount({
    name: "theme-update-test",
    purpose: "test",
    allowedScopes: scopes,
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes,
    ttlMilliseconds: 3600000,
  });
  const restricted = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: ["theme.read", "theme.write"],
    ttlMilliseconds: 3600000,
  });
  const snapshot = async () =>
    Promise.all(
      ["admin_theme_state", "entries", "revisions", "routes", "publications"].map(
        async (table) =>
          (
            await app.pool.query(
              `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
            )
          ).rows,
      ),
    );
  const before = await snapshot();
  const beforeHtml = await fastify.inject({ method: "GET", url: "/theme-update/" });
  assert.equal(beforeHtml.statusCode, 200, beforeHtml.body);
  assert.ok(!beforeHtml.body.includes("UPDATED_THEME"));
  const bytes = await referenceThemePackage("reference-theme-v1", (dir) => {
    const manifestPath = join(dir, "theme.json");
    const next = JSON.parse(readFileSync(manifestPath, "utf8"));
    next.version = "2.10.5";
    writeFileSync(manifestPath, JSON.stringify(next));
    for (const [file, marker] of [
      ["templates/page-default.liquid", "<span>UPDATED_THEME</span>"],
      ["assets/css/theme.css", "/* UPDATED_CSS */"],
      ["assets/js/theme.js", "/* UPDATED_JS */"],
    ] as const)
      writeFileSync(join(dir, file), `${readFileSync(join(dir, file), "utf8")}\n${marker}`);
  });
  const packagePath = join(root, "theme.pcTheme");
  writeFileSync(packagePath, bytes);
  const ordinary = await fastify.inject({
    method: "POST",
    url: "/api/v1/themes/install",
    headers: {
      authorization: `Bearer ${token.rawSecret}`,
      "content-type": "application/octet-stream",
    },
    payload: bytes,
  });
  assert.equal(ordinary.statusCode, 409);
  assert.equal(ordinary.json().error.code, "THEME_INSTALL_RENDER_TARGET");
  const address = await fastify.listen({ host: "127.0.0.1", port: 0 });
  const envKeys = ["PCMS_API_URL", "PCMS_API_TOKEN", "PCMS_SITE_KEY", "PCMS_ENVIRONMENT"];
  const saved = envKeys.map((key) => process.env[key]);
  t.after(() =>
    envKeys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    }),
  );
  process.env.PCMS_API_URL = address;
  process.env.PCMS_API_TOKEN = restricted.rawSecret;
  process.env.PCMS_SITE_KEY = "default";
  process.env.PCMS_ENVIRONMENT = "dev";
  const command = [
    "theme",
    "update-active",
    packagePath,
    "--environment",
    "dev",
    "--yes",
    "--json",
  ];
  const denied = await runCli(command);
  assert.equal(denied.exitCode, 5, denied.stdout);
  process.env.PCMS_API_TOKEN = token.rawSecret;
  const unconfirmed = await runCli(["theme", "update-active", packagePath, "--json"]);
  assert.equal(unconfirmed.exitCode, 2);
  assert.deepEqual(await snapshot(), before);
  const updated = await runCli(command);
  assert.equal(updated.exitCode, 0, updated.stdout + updated.stderr);
  const served = JSON.parse(updated.stdout).served;
  assert.deepEqual(
    { id: served.id, version: served.version, settings_generation: served.settings_generation },
    {
      id: "reference-theme-v1",
      version: "2.10.5",
      settings_generation: 7,
    },
  );
  const status = await runCli(["theme", "active", "--json"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).version, "2.10.5");
  assert.equal((await getThemeState(app, ctx)).active?.theme_version, "2.10.5");
  assert.equal(app.themeDiscovery?.getManifest().version, "2.10.5");
  const html = await fastify.inject({ method: "GET", url: "/theme-update/" });
  assert.equal(html.statusCode, 200);
  assert.ok(html.body.includes("UPDATED_THEME"));
  assert.ok(html.body.includes("SETTINGS_PRESERVED"));
  for (const [file, marker] of [
    ["css/theme.css", "UPDATED_CSS"],
    ["js/theme.js", "UPDATED_JS"],
  ] as const) {
    const asset = await fastify.inject({
      method: "GET",
      url: `/themes/reference-theme-v1/assets/${file}`,
    });
    assert.equal(asset.statusCode, 200);
    assert.ok(asset.body.includes(marker));
  }
  // The update must move the PERSISTED version too (CORE-FIX theme_version).
  // Before the fix the row kept the last ACTIVATION's version while the disk
  // served the update, and only the read-path compensation hid the drift.
  // Nothing outside the theme-state identity columns may move: no entry,
  // revision, route or publication row.
  const afterUpdate = await snapshot();
  const changedTables = (
    ["admin_theme_state", "entries", "revisions", "routes", "publications"] as const
  ).filter((_, index) => JSON.stringify(afterUpdate[index]) !== JSON.stringify(before[index]));
  assert.deepEqual(changedTables, ["admin_theme_state"]);
  const stateRow = (
    await app.pool.query<{
      theme_key: string;
      theme_version: string;
      settings: Record<string, unknown>;
      settings_generation: number;
    }>(
      "SELECT theme_key, theme_version, settings, settings_generation FROM admin_theme_state WHERE site_key = $1",
      [app.defaultSiteKey],
    )
  ).rows[0];
  assert.equal(stateRow?.theme_version, "2.10.5");
  assert.equal(stateRow?.theme_key, "reference-theme-v1");
  // An update replaces the package, not the operator's settings.
  assert.equal(stateRow?.settings_generation, 7);
  assert.equal(stateRow?.settings.footer_text, "SETTINGS_PRESERVED");
  // The compensating read path agrees with the row now (no masking needed).
  assert.equal((await getThemeState(app, ctx)).active?.theme_version, "2.10.5");
  const incompatible = await referenceThemePackage("reference-theme-v1", (dir) => {
    const path = join(dir, "theme.json");
    const next = JSON.parse(readFileSync(path, "utf8"));
    next.version = "2.10.6";
    next.settings_schema.find((field: { key: string }) => field.key === "header_variant").choices =
      ["default"];
    writeFileSync(path, JSON.stringify(next));
  });
  const coreIncompatible = await referenceThemePackage("reference-theme-v1", (dir) => {
    const path = join(dir, "theme.json");
    const next = JSON.parse(readFileSync(path, "utf8"));
    next.version = "2.10.6";
    next.cms_compatibility = ">=999.0.0";
    writeFileSync(path, JSON.stringify(next));
  });
  for (const [badBytes, code] of [
    [incompatible, "THEME_UPDATE_COMPATIBILITY_INVALID"],
    [coreIncompatible, "THEME_PACKAGE_INVALID"],
    [Buffer.from("not a zip"), "THEME_PACKAGE_INVALID"],
  ] as const) {
    writeFileSync(packagePath, badBytes);
    const rejected = await runCli(command);
    assert.equal(rejected.exitCode, 3, rejected.stdout);
    assert.equal(JSON.parse(rejected.stdout).error.code, code);
    const live = await fastify.inject({ method: "GET", url: "/theme-update/" });
    assert.ok(live.body.includes("UPDATED_THEME"));
    assert.equal(app.themeRuntime.served?.().version, "2.10.5");
    // A REJECTED package must leave site state exactly as the successful update
    // left it (not as it was before — that update legitimately moved the theme
    // row's version, which is the point of the fix).
    assert.deepEqual(await snapshot(), afterUpdate);
  }
  const events = await app.pool.query<{ actor_id: string; metadata: { version: string } }>(
    "SELECT actor_id, metadata FROM auth_security_events WHERE event_type = 'THEME_UPDATED'",
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]?.actor_id, account.id);
  assert.equal(events.rows[0]?.metadata.version, "2.10.5");
});

test("contract §5 optional directories (tests/) install cleanly", async () => {
  // regression 2026-10-01: a valid theme shipping a real tests/ directory
  // (contract §5; the reference theme declares directories:["tests"]) was
  // rejected by the package gate as "unknown package root: tests/".
  validateThemeEntryNames(["tests/smoke.mjs"]);
  const bytes = await referenceThemePackage("test-with-tests-v1", (themeDir) => {
    mkdirSync(join(themeDir, "tests"));
    writeFileSync(join(themeDir, "tests", "smoke.mjs"), "test helper\n");
  });
  const info = await validateThemePackage(bytes);
  assert.equal(info.id, "test-with-tests-v1");
});

test("validateThemePackage: missing theme.json / unknown root / traversal fail", async () => {
  await assert.rejects(
    async () => validateThemePackage(await zipOf({ "not-a-theme.txt": "x" })),
    (error: unknown) =>
      error instanceof ThemeInstallError && error.code === "THEME_PACKAGE_INVALID",
  );
  assert.throws(
    () => validateThemeEntryNames(["../escape/theme.json"]),
    (error: unknown) =>
      error instanceof ThemeInstallError && error.code === "THEME_PACKAGE_INVALID",
  );
  assert.throws(
    () => validateThemeEntryNames(["evil.sh"]),
    (error: unknown) =>
      error instanceof ThemeInstallError && error.code === "THEME_PACKAGE_INVALID",
  );
});

test("install → list → reinstall replaces → uninstall; renderDir theme is protected", async () => {
  const root = mkdtempSync(join(tmpdir(), "pcms-themes-root-"));
  try {
    const bytes = await referenceThemePackage("test-dark-v1");
    const info = await installThemePackage(bytes, {
      themesRoot: root,
      renderDirThemeId: "reference-theme-v1",
      source: "test://registry/test-dark-v1",
    });
    assert.equal(info.id, "test-dark-v1");
    assert.ok(existsSync(join(root, "test-dark-v1", "theme.json")));
    assert.ok(existsSync(join(root, "test-dark-v1", ".pcms-install.json")));

    const themes = listInstalledThemes(root, "reference-theme-v1");
    const installed = themes.find((theme) => theme.id === "test-dark-v1");
    assert.ok(installed !== undefined);
    assert.equal(installed.isRenderTarget, false);
    assert.equal(installed.source, "test://registry/test-dark-v1");
    // The temp root holds only the installed theme — the renderDir theme is
    // never materialised here (it lives in the deployment's state dir).
    assert.equal(themes.length, 1);

    // Reinstall = replace (still exactly one copy).
    await installThemePackage(bytes, {
      themesRoot: root,
      renderDirThemeId: "reference-theme-v1",
    });
    assert.deepEqual(readdirSync(root).filter((name) => name === "test-dark-v1").length, 1);

    // The renderDir theme can neither be overwritten nor uninstalled.
    const live = await referenceThemePackage("reference-theme-v1");
    await assert.rejects(
      async () =>
        installThemePackage(live, { themesRoot: root, renderDirThemeId: "reference-theme-v1" }),
      (error: unknown) =>
        error instanceof ThemeInstallError && error.code === "THEME_INSTALL_RENDER_TARGET",
    );
    assert.throws(
      () => uninstallThemePackage(root, "reference-theme-v1", "reference-theme-v1"),
      (error: unknown) =>
        error instanceof ThemeInstallError && error.code === "THEME_UNINSTALL_RENDER_TARGET",
    );

    uninstallThemePackage(root, "test-dark-v1", "reference-theme-v1");
    assert.ok(!existsSync(join(root, "test-dark-v1")));
    assert.throws(
      () => uninstallThemePackage(root, "test-dark-v1", "reference-theme-v1"),
      (error: unknown) =>
        error instanceof ThemeInstallError && error.code === "THEME_NOT_INSTALLED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
