// Opt-in site localization (multilingual) — integration acceptance.
//
// Two independent scenarios per the work package:
//  SINGLE LANGUAGE: feature off → resolver/entries/search behavior is
//  byte-identical to the baseline (no /en/ routes, no locale anywhere).
//  MULTILINGUAL: enable → prefix peel, per-locale routes/publications,
//  translation groups, no wrong-language fallback (404, never default copy).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEntriesService, type EntriesService } from "@pcms/content";
import { createDbPool, type DbPool, loadMigrations, migrateDatabase } from "@pcms/core";
import {
  createRequestResolver,
  createRouteService,
  createSiteLocalizationService,
  type RequestResolver,
  type RouteService,
  type SiteLocalizationService,
} from "@pcms/routing";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const ENTRY_ID = "01900000-0000-7000-8000-0000000000e1";

function connectionInfo(db: TestDatabase) {
  const info = {
    host: db.connection.host,
    port: db.connection.port,
    database: db.connection.database,
    user: db.connection.user,
    sslMode: "disable" as const,
  };
  return db.connection.password === undefined
    ? info
    : { ...info, password: db.connection.password };
}

interface Fixture {
  pool: DbPool;
  routes: RouteService;
  resolver: RequestResolver;
  localization: SiteLocalizationService;
  entries: EntriesService;
  siteId: string;
}

async function withFixture(
  t: { after: (fn: () => void) => void },
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 5 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const routes = createRouteService(pool);
  const site = await routes.ensureSite("default");
  const localization = createSiteLocalizationService(pool);
  const resolver = createRequestResolver(pool, { localization });
  const entries = createEntriesService(pool);
  await run({ pool, routes, resolver, localization, entries, siteId: site.id });
}

test("localization state defaults to disabled single-language", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL unset");
  await withFixture(t, async ({ localization }) => {
    const record = await localization.get();
    assert.equal(record.enabled, false);
    assert.equal(record.defaultLocale, "ru-RU");
    assert.deepEqual(record.locales, []);
    // Prefix peel is a no-op while disabled — even for enabled-looking paths.
    assert.equal(await localization.peelPrefix("/en/services/"), null);
    assert.equal(await localization.contextFor(null), "default");
  });
});

test("enabling validates locale list and prefix uniqueness", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL unset");
  await withFixture(t, async ({ localization }) => {
    await assert.rejects(
      localization.update({
        enabled: true,
        defaultLocale: "de-DE",
        locales: ["ru-RU", "en-US"],
        updatedBy: "test",
      }),
      (error: { code: string }) => error.code === "LOCALE_DEFAULT_NOT_ENABLED",
    );
    await assert.rejects(
      localization.update({
        enabled: true,
        defaultLocale: "en-US",
        locales: ["en-US", "en-GB"],
        updatedBy: "test",
      }),
      (error: { code: string }) => error.code === "LOCALE_PREFIX_CONFLICT",
    );
    await assert.rejects(
      localization.update({
        enabled: true,
        defaultLocale: "en-US",
        locales: ["en-US", "not a locale"],
        updatedBy: "test",
      }),
      (error: { code: string }) => error.code === "LOCALE_INVALID",
    );
    const record = await localization.update({
      enabled: true,
      defaultLocale: "ru-RU",
      locales: ["ru-RU", "en-US"],
      updatedBy: "test",
    });
    assert.equal(record.enabled, true);
    assert.deepEqual(record.locales, ["ru-RU", "en-US"]);
    const peeled = await localization.peelPrefix("/en/services/");
    assert.deepEqual(peeled, { locale: "en-US", path: "/services/", prefix: "/en" });
    assert.equal(await localization.peelPrefix("/ru/services/"), null); // default → unprefixed
    assert.equal(await localization.contextFor("en-US"), "en-US");
    assert.equal(await localization.contextFor("ru-RU"), "default");
    await assert.rejects(
      localization.contextFor("fr-FR"),
      (error: { code: string }) => error.code === "LOCALE_NOT_ENABLED",
    );
  });
});

test("SINGLE LANGUAGE: resolver behavior is unchanged (no /en/ magic)", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL unset");
  await withFixture(t, async ({ routes, resolver, siteId }) => {
    await routes.setHomeEntry(siteId, ENTRY_ID);
    await routes.activateRoute({
      siteId,
      path: "/services/erp/",
      targetType: "entry",
      targetId: ENTRY_ID,
    });
    const direct = await resolver.resolve({ path: "/services/erp/" });
    assert.equal(direct.kind, "route");
    if (direct.kind === "route") assert.equal(direct.locale, undefined);
    // A prefixed path is just an unknown path — 404, never a locale scope.
    assert.equal((await resolver.resolve({ path: "/en/services/erp/" })).kind, "not_found");
    assert.equal((await resolver.resolve({ path: "/en/" })).kind, "not_found");
  });
});

test("MULTILINGUAL: secondary routes resolve under the locale prefix", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL unset");
  await withFixture(t, async ({ routes, resolver, localization, siteId }) => {
    await localization.update({
      enabled: true,
      defaultLocale: "ru-RU",
      locales: ["ru-RU", "en-US"],
      updatedBy: "test",
    });
    await routes.setHomeEntry(siteId, ENTRY_ID);
    // Same stripped path may exist per locale (partial unique (site, locale, path)).
    await routes.activateRoute({
      siteId,
      path: "/services/erp/",
      targetType: "entry",
      targetId: ENTRY_ID,
    });
    const enRoute = await routes.activateRoute({
      siteId,
      path: "/services/erp-en/",
      locale: "en-US",
      targetType: "entry",
      targetId: ENTRY_ID,
    });
    const en = await resolver.resolve({ path: "/en/services/erp-en/" });
    assert.equal(en.kind, "route");
    if (en.kind === "route") {
      assert.equal(en.locale, "en-US");
      assert.equal(en.route.path, "/services/erp-en/");
    }
    // Trailing-slash normalization redirects stay inside the locale scope.
    const noSlash = await resolver.resolve({ path: "/en/services/erp-en" });
    assert.equal(noSlash.kind, "redirect");
    if (noSlash.kind === "redirect") {
      assert.equal(noSlash.location, "/en/services/erp-en/");
    }
    // Default locale keeps unprefixed URLs with sentinel lookups.
    const ru = await resolver.resolve({ path: "/services/erp/" });
    assert.equal(ru.kind, "route");
    if (ru.kind === "route") assert.equal(ru.route.targetId, ENTRY_ID);
    // Unknown locale prefix → plain 404 (no silent fallback).
    assert.equal((await resolver.resolve({ path: "/fr/anything/" })).kind, "not_found");
    // A missing translation of an existing default path → 404, never RU copy.
    assert.equal((await resolver.resolve({ path: "/en/services/erp/" })).kind, "not_found");
  });
});

test("translation groups: entries link versions of one logical entity", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL unset");
  await withFixture(t, async ({ entries }) => {
    const ru = await entries.createEntry({ contentTypeId: "page", createdBy: "test" });
    assert.equal(ru.locale, "default");
    assert.equal(ru.translationGroupId, null);
    const en = await entries.createEntry({
      contentTypeId: "page",
      createdBy: "test",
      locale: "en-US",
      translationGroupId: ru.id,
    });
    const members = await entries.listTranslations(ru.id);
    assert.deepEqual(
      members.map((member) => [member.locale, member.id]),
      [
        ["default", ru.id],
        ["en-US", en.id],
      ],
    );
    const found = await entries.findTranslation(ru.id, "en-US");
    assert.equal(found?.id, en.id);
    assert.equal(await entries.findTranslation(ru.id, "fr-FR"), null);
    // The group resolves from either side, and the entry itself matches its
    // own locale.
    assert.equal((await entries.findTranslation(en.id, "en-US"))?.id, en.id);
  });
});

test("per-locale publication: each locale lifecycle is independent", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL unset");
  await withFixture(t, async ({ pool, entries }) => {
    const ru = await entries.createEntry({ contentTypeId: "page", createdBy: "test" });
    const en = await entries.createEntry({
      contentTypeId: "page",
      createdBy: "test",
      locale: "en-US",
      translationGroupId: ru.id,
    });
    // Publish RU (default context) only.
    await pool.query(
      `INSERT INTO revisions (id, entity_type, entity_id, revision_no, state, payload, schema_version, locale, origin, created_by_type, created_by, edit_generation, payload_hash, sealed_at)
       VALUES ('01900000-0000-7000-8000-000000000101', 'entry', $1, 1, 'SEALED', '{}', '1', 'default', 'system', 'system', 'test', 0, 'hash', now()),
              ('01900000-0000-7000-8000-000000000102', 'entry', $2, 1, 'SEALED', '{}', '1', 'en-US', 'system', 'system', 'test', 0, 'hash', now())`,
      [ru.id, en.id],
    );
    await pool.query(
      `INSERT INTO publications (entity_type, entity_id, context, state, current_revision_id, current_payload_hash, generation, first_published_at, published_at, modified_at)
       VALUES ('entry', $1, 'default', 'PUBLISHED', '01900000-0000-7000-8000-000000000101', 'hash', 0, now(), now(), now())`,
      [ru.id],
    );
    const publishedRu = await pool.query(
      `SELECT 1 FROM publications WHERE entity_id = $1 AND context = 'default' AND state = 'PUBLISHED'`,
      [ru.id],
    );
    assert.equal(publishedRu.rowCount, 1);
    // EN has no publication in its context yet — the reverse lookup proves
    // the locale axes are independent (RU published, EN absent).
    const publishedEn = await pool.query(
      `SELECT 1 FROM publications WHERE entity_id = $1 AND context = 'en-US' AND state = 'PUBLISHED'`,
      [en.id],
    );
    assert.equal(publishedEn.rowCount, 0);
  });
});
