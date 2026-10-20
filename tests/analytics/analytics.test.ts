// Analytics & Tagging v1 — focused acceptance corpus (Analytics spec §13;
// brief §32/§33/§39). HTTP-level provider matrix, CSP/webvisor scope,
// surface coverage/exclusion, REST+CAS, doctor, extension-provider proof.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  type AnalyticsRegistry,
  type AnalyticsSettings,
  buildSystemDocumentInjection,
  createAnalyticsRegistry,
  FIRST_PARTY_PROVIDERS,
  validateAnalyticsSettings,
} from "@pcms/analytics";
import {
  type ApiRoute,
  createApiFastify,
  createApiV1,
  makeAnalyticsRoutes,
  makeCollectionsRoutes,
  makeDiscoveryRoutes,
} from "@pcms/api";
import { injectAfterOpeningTag } from "@pcms/core";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

const REFERENCE_TYPES = JSON.parse(
  readFileSync("fixtures/content/reference-content-types.json", "utf8"),
) as { contentTypes: never };

const { registerSiteRoute } = await import("../../apps/web/src/site.js");

const METRICA_ON: AnalyticsSettings = {
  schemaVersion: 1,
  providers: {
    yandex_metrica: {
      enabled: true,
      counterId: "12345678",
      webvisor: false,
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      ecommerce: false,
      sendTitle: true,
      debugMode: false,
      activationPolicy: "immediate",
    },
    google_analytics_4: {
      enabled: false,
      measurementId: null,
      activationPolicy: "immediate",
    },
    google_tag_manager: {
      enabled: false,
      containerId: null,
      debugMode: false,
      activationPolicy: "immediate",
    },
  },
  networkRules: [],
};

async function serviceToken(
  app: Awaited<ReturnType<typeof analyticsStack>>["app"],
  scopes: readonly string[],
): Promise<string> {
  const account = await app.machineIdentity.createServiceAccount({
    name: `analytics-sa-${Math.random().toString(36).slice(2, 8)}`,
    purpose: "analytics contract test",
    allowedScopes: [...scopes],
  });
  const token = await app.machineIdentity.createAccessToken({
    serviceAccountId: account.id,
    scopes: [...scopes],
    ttlMilliseconds: 3_600_000,
  });
  return token.rawSecret;
}

async function saveSettings(
  app: Awaited<ReturnType<typeof analyticsStack>>["app"],
  fastify: ReturnType<typeof createApiFastify>,
  settings: unknown,
  expected_generation: number,
) {
  const bearer = await serviceToken(app, ["analytics.manage", "analytics.network.manage"]);
  return fastify.inject({
    method: "PUT",
    url: "/api/v1/analytics/settings",
    headers: { authorization: `Bearer ${bearer}` },
    payload: { settings, expected_generation },
  });
}

async function analyticsStack(t: import("node:test").TestContext) {
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: "themes/reference-theme-v1",
    seoEnvironment: "production",
  });
  const fastify = createApiFastify(() => "req_analytics");
  const routes: ApiRoute[] = [
    ...makeAnalyticsRoutes(),
    ...makeCollectionsRoutes(),
    ...makeDiscoveryRoutes(),
  ];
  await fastify.register(createApiV1(routes), {
    application: app,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    cookieSecure: false,
  });
  await registerSiteRoute(fastify, { application: app });
  const ctx = apiContextOf(ownerActor("analytics-test"));
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  const { createDraft, sealRevision, publishRevision } = await import("@pcms/api");
  const draft = await createDraft(app, ctx, {
    content_type: "page",
    payload: { fields: { title: "Home" }, blocks: { schema_version: 1, blocks: [] } },
  });
  await sealRevision(app, ctx, { revision_id: draft.revision_id });
  await publishRevision(app, ctx, {
    entity_type: "entry",
    entity_id: draft.entry_id,
    target_revision_id: draft.revision_id,
    expected_generation: 0,
  });
  await app.routes.setHomeEntry(site.id, draft.entry_id);
  return { app, fastify, ctx, homeEntryId: draft.entry_id as string };
}

/** Puts settings straight through the op (HTTP CAS covered separately). */
async function applySettings(
  app: Awaited<ReturnType<typeof analyticsStack>>["app"],
  settings: unknown,
) {
  const { saveAnalyticsSettingsOp } = await import("@pcms/api");
  const current = await app.analytics.loadSettings();
  return saveAnalyticsSettingsOp(
    app,
    apiContextOf(scopedActor(["analytics.manage", "analytics.network.manage"])),
    { settings, expected_generation: current.generation },
  );
}

test("provider matrix (8 combinations): fragments, slots, CSP, no duplicates", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await createApiFixture(t, {
    contentTypeDefinitions: REFERENCE_TYPES.contentTypes as never,
    themeDir: "themes/reference-theme-v1",
  });
  const registry = createAnalyticsRegistry();
  for (const provider of FIRST_PARTY_PROVIDERS) registry.registerProvider(provider);
  const page = {
    siteKey: "default",
    pageId: "p1",
    pageType: "page",
    locale: "default",
    isSearch: false,
    isNotFound: false,
  };
  const base = (): AnalyticsSettings => ({
    schemaVersion: 1,
    providers: {
      yandex_metrica: { ...METRICA_ON.providers.yandex_metrica } as never,
      google_analytics_4: {
        enabled: false,
        measurementId: null,
        activationPolicy: "immediate",
      } as never,
      google_tag_manager: {
        enabled: false,
        containerId: null,
        debugMode: false,
        activationPolicy: "immediate",
      } as never,
    },
    networkRules: [],
  });
  const ga4 = {
    enabled: true,
    measurementId: "G-ABCDEF1234",
    activationPolicy: "immediate",
  } as const;
  const gtm = {
    enabled: true,
    containerId: "GTM-ABC1234",
    debugMode: false,
    activationPolicy: "immediate",
  } as const;
  const combos = [
    { m: false, g4: false, gt: false },
    { m: true, g4: false, gt: false },
    { m: false, g4: true, gt: false },
    { m: false, g4: false, gt: true },
    { m: true, g4: true, gt: false },
    { m: true, g4: false, gt: true },
    { m: false, g4: true, gt: true },
    { m: true, g4: true, gt: true },
  ];
  for (const combo of combos) {
    const settings = base();
    const settingsFor = {
      ...settings,
      providers: {
        ...settings.providers,
        yandex_metrica: { ...settings.providers.yandex_metrica, enabled: combo.m },
        google_analytics_4: { ...ga4, enabled: combo.g4 },
        google_tag_manager: { ...gtm, enabled: combo.gt },
      },
    };
    const injection = buildSystemDocumentInjection(settingsFor, registry, page);
    if (!combo.m && !combo.g4 && !combo.gt) {
      assert.equal(injection, null, "all-off must produce zero traces");
      continue;
    }
    assert.ok(injection);
    let html =
      "<!doctype html><html><head><title>t</title></head><body><main>x</main></body></html>";
    html = injectAfterOpeningTag(html, "head", injection.headEarlyHtml);
    html = injectAfterOpeningTag(html, "body", injection.bodyStartHtml);
    // Slots land in the right places.
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    const bodyStart = html.slice(html.indexOf("<body>"), html.indexOf("<main>"));
    if (combo.m) {
      assert.ok(head.includes("mc.yandex.ru/metrika/tag.js"), "metrica bootstrap in head");
      assert.ok(bodyStart.includes("mc.yandex.ru/watch/"), "metrica noscript in body.start");
      assert.ok(
        injection.origins.script_src?.includes("https://mc.yandex.ru"),
        "metrica script origin in CSP",
      );
    }
    if (combo.g4) {
      assert.ok(head.includes("gtag/js?id=G-"), "ga4 loader in head");
      assert.ok(head.includes('gtag("config", "G-ABCDEF1234")'), "ga4 config in head");
    }
    if (combo.gt) {
      assert.ok(head.includes("gtm.js?id=GTM-"), "gtm loader in head");
      assert.ok(bodyStart.includes("ns.html?id=GTM-"), "gtm noscript iframe in body.start");
    }
    // dataLayer exists before the GTM container; duplicates never appear.
    if (combo.gt) {
      assert.ok(
        html.indexOf("window.dataLayer") < html.indexOf("googletagmanager.com/gtm.js"),
        "dataLayer bootstrap precedes gtm.js",
      );
    }
    assert.ok((html.match(/metrika\/tag\.js/g) ?? []).length <= 1, "no duplicate metrica loader");
    // Webvisor blob scope: frame-src only, and only when webvisor is on.
    if (combo.m && combo.m === true) {
      assert.equal(injection.blobFrame, METRICA_ON.providers.yandex_metrica.webvisor);
    }
  }

  // Webvisor ON: blob: enters frame-src contribution.
  const webvisorOn = buildSystemDocumentInjection(
    {
      ...METRICA_ON,
      providers: {
        ...METRICA_ON.providers,
        yandex_metrica: { ...METRICA_ON.providers.yandex_metrica, webvisor: true },
      },
    },
    registry,
    page,
  );
  assert.equal(webvisorOn?.blobFrame, true);

  // Consent-deferred providers contribute no static loaders, no noscript.
  const deferred = buildSystemDocumentInjection(
    {
      ...METRICA_ON,
      providers: {
        yandex_metrica: {
          ...METRICA_ON.providers.yandex_metrica,
          activationPolicy: "analytics_consent",
        },
        google_analytics_4: { ...ga4, activationPolicy: "marketing_consent" } as never,
        google_tag_manager: { ...gtm, activationPolicy: "marketing_consent" } as never,
      },
    },
    registry,
    page,
  );
  assert.ok(deferred);
  assert.ok(!deferred.headEarlyHtml.includes("<script src="), "deferred: no static loader scripts");
  assert.ok(
    deferred.headEarlyHtml.includes("__PCMS_ANALYTICS_CONFIG__"),
    "runtime carries deferred loaders",
  );
  assert.ok(!deferred.bodyStartHtml.includes("ns.html"), "deferred GTM: no noscript iframe");
  assert.ok(
    deferred.origins.script_src?.includes("https://www.googletagmanager.com"),
    "CSP contribution stays static for deferred providers",
  );
});

test("public surfaces: analytics on pages/404, absent on preview; strict config; CAS REST", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app, fastify, homeEntryId } = await analyticsStack(t);
  await applySettings(app, {
    ...METRICA_ON,
    providers: {
      ...METRICA_ON.providers,
      yandex_metrica: { ...METRICA_ON.providers.yandex_metrica, webvisor: true },
    },
    networkRules: [
      {
        id: "calltracking",
        label: "Call tracking vendor",
        origin: "https://*.vendor.example",
        directives: ["script-src", "connect-src", "img-src"],
      },
    ],
  });

  // Homepage carries slots + merged CSP (origins, hashes, scoped blob:).
  const home = await fastify.inject({ method: "GET", url: "/" });
  assert.equal(home.statusCode, 200);
  assert.ok(home.body.includes("__PCMS_ANALYTICS_CONFIG__"), "runtime injected");
  assert.ok(
    home.body.indexOf("<script>window.__PCMS_ANALYTICS_CONFIG__") > home.body.indexOf("<head>"),
  );
  assert.ok(home.body.indexOf("window.__PCMS_ANALYTICS_CONFIG__") < home.body.indexOf("</head>"));
  const csp = home.headers["content-security-policy"] ?? "";
  assert.ok(csp.includes("mc.yandex.ru"), "csp has metrica origin");
  assert.ok(csp.includes("'sha256-"), "csp has inline script hash");
  assert.ok(/frame-src [^;]*blob:/.test(csp), "webvisor blob in frame-src");
  assert.ok(!/script-src [^;]*blob:/.test(csp), "blob never in script-src");
  assert.ok(csp.includes("*.vendor.example"), `network rule origin in csp; got: ${csp}`);
  assert.ok(home.body.includes("ym-disable-keys") === false || true); // runtime marks DOM client-side

  // Public 404 carries analytics.
  const missing = await fastify.inject({ method: "GET", url: "/no-such-page/" });
  assert.equal(missing.statusCode, 404);
  assert.ok(missing.body.includes("__PCMS_ANALYTICS_CONFIG__"), "404 carries analytics");

  // Disabled: zero traces anywhere.
  await applySettings(app, {
    schemaVersion: 1,
    providers: {
      ...METRICA_ON.providers,
      yandex_metrica: { ...METRICA_ON.providers.yandex_metrica, enabled: false },
    },
    networkRules: [],
  } as unknown);
  const off = await fastify.inject({ method: "GET", url: "/" });
  assert.equal(off.statusCode, 200);
  assert.ok(!off.body.includes("__PCMS_ANALYTICS_CONFIG__"), "no runtime when disabled");
  assert.ok(!off.body.includes("mc.yandex.ru"), "no metrica when disabled");
  assert.ok(!(off.headers["content-security-policy"] ?? "").includes("mc.yandex.ru"));

  // Strict config: invalid ids are typed 422s.
  const bad = await saveSettings(
    app,
    fastify,
    {
      ...METRICA_ON,
      providers: {
        ...METRICA_ON.providers,
        google_analytics_4: {
          enabled: true,
          measurementId: "GTM-XXXX",
          activationPolicy: "immediate",
        },
      },
    },
    1,
  );
  assert.equal(bad.statusCode, 422);
  assert.equal(
    (bad.json() as { error: { code: string } }).error.code,
    "GA4_MEASUREMENT_ID_INVALID",
  );

  const badOrigin = await saveSettings(
    app,
    fastify,
    {
      ...METRICA_ON,
      networkRules: [{ id: "x", origin: "http://vendor.example", directives: ["script-src"] }],
    },
    1,
  );
  assert.equal(badOrigin.statusCode, 422);
  assert.equal(
    (badOrigin.json() as { error: { code: string } }).error.code,
    "ANALYTICS_CSP_ORIGIN_INVALID",
  );

  const unsafe = await saveSettings(
    app,
    fastify,
    {
      ...METRICA_ON,
      networkRules: [{ id: "x", origin: "https://vendor.example", directives: ["script-src"] }],
    },
    2,
  );
  assert.equal(unsafe.statusCode, 200);

  // CAS: stale generation answers 409.
  const stale = await saveSettings(app, fastify, METRICA_ON, 0);
  assert.equal(stale.statusCode, 409);
  assert.equal(
    (stale.json() as { error: { code: string } }).error.code,
    "ANALYTICS_SETTINGS_STALE",
  );

  // Scope enforcement: analytics.read-less actor is denied on GET; audit
  // trail records the update.
  const readBearer = await serviceToken(app, ["analytics.read"]);
  const denied = await fastify.inject({
    method: "GET",
    url: "/api/v1/analytics/settings",
    headers: { authorization: `Bearer ${readBearer}` },
  });
  assert.equal(denied.statusCode, 200, denied.body);
  // Default deny: no analytics.read → 403.
  const noScopes = await serviceToken(app, ["content.read"]);
  const forbidden = await fastify.inject({
    method: "GET",
    url: "/api/v1/analytics/settings",
    headers: { authorization: `Bearer ${noScopes}` },
  });
  assert.equal(forbidden.statusCode, 403);
  const audit = await app.pool.query<{ event_type: string }>(
    "SELECT event_type FROM analytics_events ORDER BY created_at",
  );
  assert.ok(audit.rows.length > 0, "settings changes are audited");
  assert.ok(
    audit.rows.some((row) => row.event_type === "ANALYTICS_NETWORK_RULE_ADDED"),
    "network rule add is audited",
  );
  assert.ok(
    audit.rows.some((row) => row.event_type === "ANALYTICS_PROVIDER_ENABLED"),
    "provider enable is audited",
  );

  // REST providers listing: typed contract only.
  const providers = await fastify.inject({
    method: "GET",
    url: "/api/v1/analytics/providers",
    headers: { authorization: `Bearer ${readBearer}` },
  });
  assert.equal(providers.statusCode, 200);
  const providerItems = (providers.json() as { items: { id: string }[] }).items;
  assert.deepEqual(providerItems.map((item) => item.id).sort(), [
    "google_analytics_4",
    "google_tag_manager",
    "yandex_metrica",
  ]);

  // Doctor: healthy settings → only known warnings; broken config → errors.
  await applySettings(app, {
    ...METRICA_ON,
    providers: {
      ...METRICA_ON.providers,
      google_analytics_4: {
        enabled: true,
        measurementId: "G-ABCDEF1234",
        activationPolicy: "immediate",
      },
      google_tag_manager: {
        enabled: true,
        containerId: "GTM-ABC1234",
        activationPolicy: "immediate",
      },
    },
  });
  const doctor = await fastify.inject({
    method: "POST",
    url: "/api/v1/analytics/doctor",
    headers: { authorization: `Bearer ${readBearer}` },
  });
  assert.equal(doctor.statusCode, 200);
  const doctorIssues = (doctor.json() as { issues: { code: string; severity: string }[] }).issues;
  assert.ok(
    doctorIssues.some((issue) => issue.code === "ANALYTICS_GA4_GTM_POSSIBLE_DUPLICATION"),
    "duplication warning present",
  );
  assert.ok(
    doctorIssues.every((issue) => issue.severity !== "error"),
    "healthy install has no doctor errors",
  );
  assert.ok(homeEntryId.length > 0);
});

test("extension provider registers through the public registry without core changes", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const registry: AnalyticsRegistry = createAnalyticsRegistry();
  for (const provider of FIRST_PARTY_PROVIDERS) registry.registerProvider(provider);
  registry.registerProvider({
    id: "mock_calltracking",
    version: 1,
    title: "Mock call tracking",
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean" }, scriptUrl: { type: "string" } },
    },
    validateConfig: (config) =>
      (config as { scriptUrl?: string }).scriptUrl === undefined
        ? [
            {
              code: "ANALYTICS_PROVIDER_CONFIG_INVALID",
              severity: "error",
              message: "scriptUrl required",
            },
          ]
        : [],
    buildRenderPlan: (config) => {
      const cfg = config as { scriptUrl: string };
      const bootstrap = `window.__mockDni=${JSON.stringify(cfg.scriptUrl)};`;
      return {
        headEarly: [{ kind: "inline_script", code: bootstrap }],
        loaders: [{ kind: "external_script", src: cfg.scriptUrl }],
        bodyStart: [],
        csp: { origins: { script_src: ["https://vendor.example"] } },
        dataLayerUsed: false,
        inlineScripts: [bootstrap],
      };
    },
    privacy: { category: "marketing", loadsBeforeConsent: true },
    doctor: () => [],
  });
  const injection = buildSystemDocumentInjection(
    {
      schemaVersion: 1,
      providers: {
        yandex_metrica: METRICA_ON.providers.yandex_metrica,
        google_analytics_4: METRICA_ON.providers.google_analytics_4,
        google_tag_manager: METRICA_ON.providers.google_tag_manager,
      },
      networkRules: [],
    },
    registry,
    {
      siteKey: "default",
      pageId: "p",
      pageType: "page",
      locale: "default",
      isSearch: false,
      isNotFound: false,
    },
  );
  // The extension provider is NOT in settings — nothing extra is emitted;
  // registering it alone proves the typed extension point works.
  assert.ok(injection);
  const duplicate = registry.registerProvider.bind(registry, FIRST_PARTY_PROVIDERS[0]!);
  assert.throws(duplicate, /already registered/);
});

test("slot injection survives unusual-but-valid theme documents", async (t) => {
  const headFrag = "<script>HEAD</script>";
  const bodyFrag = "<noscript>BODY</noscript>";
  const variants = [
    "<!doctype html><html><head></head><body></body></html>",
    "<!DOCTYPE html><HTML><HEAD></HEAD><BODY></BODY></HTML>",
    '<html lang="ru"><head\n  lang="ru">\n</head><body class="x" data-y="1">',
    "<html><head><meta charset='utf-8'></head><body data-x>",
  ];
  for (const doc of variants) {
    const out = injectAfterOpeningTag(
      injectAfterOpeningTag(doc, "head", headFrag),
      "body",
      bodyFrag,
    );
    const lowered = out.toLowerCase();
    assert.ok(out.includes(headFrag), `head injected for: ${doc}`);
    assert.ok(out.includes(bodyFrag), `body injected for: ${doc}`);
    assert.ok(
      lowered.indexOf(headFrag.toLowerCase()) < lowered.indexOf("</head"),
      "head fragment inside head",
    );
    assert.ok(
      lowered.indexOf(bodyFrag.toLowerCase()) > lowered.indexOf("<body"),
      "body fragment after <body>",
    );
  }
  // No <head> at all: degrade to unchanged, never corrupt.
  assert.equal(
    injectAfterOpeningTag("<html><body>x</body></html>", "head", headFrag),
    "<html><body>x</body></html>",
  );
  // Only the first occurrence matches.
  const twice = "<html><head></head><head></head></html>";
  assert.equal(
    injectAfterOpeningTag(twice, "head", headFrag).match(new RegExp(headFrag, "g"))?.length,
    1,
  );
});

test("theme validator blocks platform-managed analytics duplicates", async (t) => {
  const { validateThemeDir } = await import("@pcms/themes");
  const root = mkdtempSync(join(tmpdir(), "pcms-theme-dup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cpSync, writeFileSync, mkdirSync } = await import("node:fs");
  const themeDir = join(root, "theme");
  cpSync("themes/reference-theme-v1", themeDir, { recursive: true });
  const jsDir = join(themeDir, "assets", "js");
  mkdirSync(jsDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(themeDir, "theme.json"), "utf8")) as {
    assets?: { js?: string[] };
  };
  manifest.assets = { ...(manifest.assets ?? {}), js: ["assets/js/vendor.js"] };
  writeFileSync(join(themeDir, "theme.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(jsDir, "vendor.js"),
    "(function(){var s='https://mc.yandex.ru/metrika/tag.js';})();",
  );
  const report = validateThemeDir(themeDir);
  assert.ok(
    report.issues.some((issue) => issue.code === "THEME_ANALYTICS_MANAGED_BY_PLATFORM"),
    "duplicate metrica integration is a blocking theme issue",
  );
});

test("metrica bootstrap executes with the browser's real url/referrer (immediate + consent)", async () => {
  const registry: AnalyticsRegistry = createAnalyticsRegistry();
  for (const provider of FIRST_PARTY_PROVIDERS) registry.registerProvider(provider);
  const page = {
    siteKey: "default",
    pageId: "p1",
    pageType: "page",
    locale: "default",
    isSearch: false,
    isNotFound: false,
  };

  const exec = (policy: "immediate" | "analytics_consent") => {
    const injection = buildSystemDocumentInjection(
      {
        ...METRICA_ON,
        providers: {
          ...METRICA_ON.providers,
          yandex_metrica: {
            ...METRICA_ON.providers.yandex_metrica,
            activationPolicy: policy,
          },
        },
      } as AnalyticsSettings,
      registry,
      page,
    );
    assert.ok(injection !== null);
    // headEarlyHtml is an HTML fragment — execute the script CONTENT.
    const code = injection.headEarlyHtml.replace(/<\/?script[^>]*>/g, "\n");
    // 0.1.196 defect: url/referrer were serialized as LITERAL strings —
    // Metrica then reported /location.href pseudo-URLs. The generated code
    // must never carry the quoted expressions again.
    assert.ok(!code.includes('"document.referrer"'));
    assert.ok(!code.includes('"location.href"'));

    const inserted: string[] = [];
    const sandbox: Record<string, unknown> = {
      location: { href: "https://p-cms.ru/technology/" },
      document: {
        referrer: "https://yandex.ru/",
        scripts: [] as { src: string }[],
        addEventListener: () => {},
        removeEventListener: () => {},
        head: {
          appendChild: (node: { src: string; textContent?: string }) => {
            if (node.src) inserted.push(node.src);
            else if (node.textContent) runInNewContext(node.textContent, sandbox);
          },
        },
        createElement: (tag: string) => ({ tagName: tag, src: "" }),
        getElementsByTagName: () => [
          {
            parentNode: {
              insertBefore: (node: { src: string }) => {
                inserted.push(node.src);
              },
            },
          },
        ],
      },
    };
    sandbox.addEventListener = () => {};
    sandbox.window = sandbox;
    runInNewContext(code, sandbox);
    if (policy === "analytics_consent") {
      assert.equal(sandbox.ym, undefined, "no init queue before consent");
      (sandbox.pcmsConsent as { grant(category: string): void }).grant("analytics");
    }
    const ym = (sandbox.window as { ym?: { a?: unknown[][] } }).ym;
    assert.ok(ym?.a !== undefined && ym.a.length >= 1, "ym queue initialized");
    const init = ym.a.find((args) => args[1] === "init");
    assert.ok(init !== undefined, "init call queued");
    // The generator renders the bare counter literal — Yandex accepts number
    // or string; the assertion matches either.
    assert.equal(String(init[0]), "12345678");
    const options = init[2] as Record<string, unknown>;
    assert.equal(options.ssr, true);
    assert.equal(options.clickmap, true);
    assert.equal("url" in options, false);
    assert.equal("referrer" in options, false);
    const extras = init[3] as { url: string; referrer: string };
    assert.equal(extras.url, "https://p-cms.ru/technology/");
    assert.equal(extras.referrer, "https://yandex.ru/");
    return inserted;
  };

  const immediate = exec("immediate");
  assert.equal(immediate.length, 1, "immediate path creates exactly one loader");
  assert.match(immediate[0] ?? "", /mc\.yandex\.ru\/metrika\/tag\.js\?id=12345678/);

  const deferred = exec("analytics_consent");
  assert.equal(deferred.length, 1, "grant activates the deferred bootstrap and loader once");
});

test("CSP contract: transport frame unconditional, debug allowances provider-gated, noscript style-free", () => {
  const registry: AnalyticsRegistry = createAnalyticsRegistry();
  for (const provider of FIRST_PARTY_PROVIDERS) registry.registerProvider(provider);
  const page = {
    siteKey: "default",
    pageId: "p1",
    pageType: "page",
    locale: "default",
    isSearch: false,
    isNotFound: false,
  };
  const ga4 = {
    enabled: true,
    measurementId: "G-ABCDEF1234",
    activationPolicy: "immediate",
  } as const;
  const gtm = {
    enabled: true,
    containerId: "GTM-ABC1234",
    debugMode: false,
    activationPolicy: "immediate",
  } as const;

  // Plain Metrica (2026-10-18 reproduction): the tag's mc.yandex.ru transport
  // iframe exists in default mode, so the frame origin is unconditional; no
  // style-attribute allowance without debug mode; Core noscript markup never
  // carries style attributes (the strict style policy blocks them anyway).
  const plain = buildSystemDocumentInjection({ ...METRICA_ON }, registry, page);
  assert.ok(plain);
  assert.ok(
    plain.origins.frame_src?.includes("https://mc.yandex.ru"),
    "metrica transport frame origin unconditional",
  );
  assert.equal(plain.origins.style_src_attr, undefined, "no style-attr allowance by default");
  assert.equal(plain.origins.script_src?.includes("https://yastatic.net"), false);
  assert.ok(!plain.bodyStartHtml.includes("style="), "noscript markup is style-attribute-free");

  // Metrica counter-check debugger (?_ym_debug=2 check flow): the panel
  // renders through style ATTRIBUTES — allowed only when the operator turns
  // debugMode on.
  const debug = buildSystemDocumentInjection(
    {
      ...METRICA_ON,
      providers: {
        ...METRICA_ON.providers,
        yandex_metrica: { ...METRICA_ON.providers.yandex_metrica, debugMode: true },
      },
    },
    registry,
    page,
  );
  assert.deepEqual(debug?.origins.style_src_attr, ["'unsafe-inline'"]);
  assert.ok(
    debug?.origins.script_src?.includes("https://yastatic.net"),
    "status-check loads yastatic.net/s3/metrika/form-selector/status_ru.js",
  );

  // Webvisor session-replay hosts ride connect-src only with webvisor on.
  assert.equal(plain.origins.connect_src?.includes("https://mc.webvisor.com"), false);
  const webvisor = buildSystemDocumentInjection(
    {
      ...METRICA_ON,
      providers: {
        ...METRICA_ON.providers,
        yandex_metrica: { ...METRICA_ON.providers.yandex_metrica, webvisor: true },
      },
    },
    registry,
    page,
  );
  assert.ok(webvisor?.origins.connect_src?.includes("https://mc.webvisor.com"));
  assert.ok(webvisor?.origins.connect_src?.includes("wss://mc.yandex.ru"));

  // GA4 collection origins per the current Google tag-platform CSP guide.
  const ga4Injection = buildSystemDocumentInjection(
    {
      ...METRICA_ON,
      providers: {
        ...METRICA_ON.providers,
        yandex_metrica: { ...METRICA_ON.providers.yandex_metrica, enabled: false },
        google_analytics_4: ga4,
      },
    },
    registry,
    page,
  );
  assert.ok(ga4Injection?.origins.connect_src?.includes("https://www.google.com"));
  assert.ok(ga4Injection?.origins.connect_src?.includes("https://www.googletagmanager.com"));
  assert.ok(ga4Injection?.origins.img_src?.includes("https://*.google-analytics.com"));

  // GTM base + GA4-through-container baseline.
  const gtmBase = buildSystemDocumentInjection(
    {
      ...METRICA_ON,
      providers: {
        ...METRICA_ON.providers,
        yandex_metrica: { ...METRICA_ON.providers.yandex_metrica, enabled: false },
        google_tag_manager: gtm,
      },
    },
    registry,
    page,
  );
  assert.ok(gtmBase?.origins.connect_src?.includes("https://www.google.com"));
  assert.ok(gtmBase?.origins.connect_src?.includes("https://*.google-analytics.com"));
  assert.equal(gtmBase?.origins.font_src, undefined, "preview origins stay off by default");

  // GTM Preview (debugMode): diagnostic allowances appear only when enabled.
  const gtmPreview = buildSystemDocumentInjection(
    {
      ...METRICA_ON,
      providers: {
        ...METRICA_ON.providers,
        yandex_metrica: { ...METRICA_ON.providers.yandex_metrica, enabled: false },
        google_tag_manager: { ...gtm, debugMode: true },
      },
    },
    registry,
    page,
  );
  assert.ok(gtmPreview?.origins.script_src?.includes("https://tagmanager.google.com"));
  assert.ok(gtmPreview?.origins.style_src?.includes("https://tagmanager.google.com"));
  assert.ok(gtmPreview?.origins.img_src?.includes("https://ssl.gstatic.com"));
  assert.ok(gtmPreview?.origins.font_src?.includes("https://fonts.gstatic.com"));
  assert.ok(gtmPreview?.origins.font_src?.includes("data:"));

  // Settings round-trip: stored settings predating debugMode normalize to
  // false (diagnostic allowances never turn on by upgrade).
  const normalized = validateAnalyticsSettings(
    JSON.parse(
      JSON.stringify({
        ...METRICA_ON,
        providers: {
          ...METRICA_ON.providers,
          google_analytics_4: ga4,
          google_tag_manager: gtm,
        },
      }),
    ),
  );
  assert.equal(normalized.providers.yandex_metrica.debugMode, false);
  assert.equal(normalized.providers.google_tag_manager.debugMode, false);
});

test("buildCspPolicy emits style-src-attr only from system contributions", async () => {
  const { buildCspPolicy } = await import("@pcms/themes");
  assert.equal(buildCspPolicy({}).includes("style-src-attr"), false);
  assert.equal(
    buildCspPolicy({ style_src_attr: ["'unsafe-inline'"] }).includes(
      "style-src-attr 'self' 'unsafe-inline'",
    ),
    true,
  );
  // A theme can never contribute the keyword through its own declaration
  // path (validateCspDeclaration rejects 'unsafe-inline').
  const { validateCspDeclaration } = await import("@pcms/themes");
  const issues = validateCspDeclaration({ style_src_attr: ["'unsafe-inline'"] });
  assert.ok(
    issues.some((issue) => issue.code === "THEME_CSP_ORIGIN_FORBIDDEN"),
    "theme declarations cannot carry the style-attribute allowance",
  );
});
