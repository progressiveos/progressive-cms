// PCMS-SEO-T010 — Site Identity SEO schema (§20): typed org/site facts,
// hostile values rejected, defaults mapping, PG round-trip.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDbPool,
  type DbPool,
  loadMigrations,
  migrateDatabase,
  newStableId,
} from "@pcms/core";
import { createSeoStore, parseSeoSiteIdentity, SeoError, toSiteSeoDefaults } from "@pcms/seo";
import {
  assertBaseReachable,
  createTestDatabase,
  testDatabaseConfigured,
} from "../helpers/testdb.js";

const LOGO = "0195fdc0-7a5e-7000-8000-0000000000aa";

test("site identity round-trips with org/site facts typed (§20)", () => {
  const identity = parseSeoSiteIdentity({
    site_name: "Пример",
    alternate_site_name: "Example",
    legal_name: "ООО «Пример»",
    organization_type: "LocalBusiness",
    logo: { asset_id: LOGO },
    favicon: { asset_id: LOGO },
    default_social_image: { asset_id: LOGO, version: 4 },
    phone: "+7 495 000-00-00",
    email: "hi@example.ru",
    address: { locality: "Москва", country: "RU" },
    social_profiles: ["https://t.me/example", "https://vk.com/example"],
    title_pattern: "{page_title} — {site_name}",
    article_content_types: ["news", "blog_post"],
    local_business: { subtype: "ProfessionalService", opening_hours: "Mo-Fr 09:00-18:00" },
    verification: [{ provider: "yandex", content: "0123456789abcdef" }],
  });
  assert.equal(identity.site_name, "Пример");
  assert.equal(identity.organization_type, "LocalBusiness");
  assert.deepEqual(identity.local_business, {
    subtype: "ProfessionalService",
    opening_hours: "Mo-Fr 09:00-18:00",
  });
  assert.deepEqual(identity.default_social_image, { asset_id: LOGO, version: 4 });
  // Round-trip stable: parsing the parsed form is identity.
  assert.deepEqual(parseSeoSiteIdentity(identity), identity);
});

test("unknown fields, non-http(s) profiles and bad values are rejected", () => {
  const issuesOf = (fn: () => unknown): readonly { path: string }[] => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof SeoError);
      assert.equal(err.code, "SEO_SETTINGS_INVALID");
      return (err.details as { issues: { path: string }[] }).issues;
    }
    throw new Error("expected rejection");
  };
  assert.ok(
    issuesOf(() => parseSeoSiteIdentity({ site_name: "S", keywords: "x" })).some(
      (i) => i.path === "/keywords",
    ),
  );
  assert.ok(
    issuesOf(() =>
      parseSeoSiteIdentity({ site_name: "S", social_profiles: ["javascript:alert(1)"] }),
    ).some((i) => i.path === "/social_profiles/0"),
  );
  assert.ok(
    issuesOf(() => parseSeoSiteIdentity({ site_name: "S", email: "not-an-email" })).length > 0,
  );
  assert.ok(
    issuesOf(() => parseSeoSiteIdentity({ site_name: "" })).some((i) => i.path === "/site_name"),
  );
  assert.ok(
    issuesOf(() =>
      parseSeoSiteIdentity({ site_name: "S", local_business: { subtype: "Bad Type!" } }),
    ).some((i) => i.path === "/local_business/subtype"),
  );
});

test("toSiteSeoDefaults maps identity onto the fallback chains (§4/§63)", () => {
  assert.deepEqual(toSiteSeoDefaults(null), {
    site_name: null,
    title_pattern: null,
    default_social_image: null,
    allow_intro_description_fallback: true,
  });
  const defaults = toSiteSeoDefaults(
    parseSeoSiteIdentity({
      site_name: "S",
      title_pattern: "{page_title} — {site_name}",
      allow_intro_description_fallback: false,
    }),
  );
  assert.equal(defaults.site_name, "S");
  assert.equal(defaults.allow_intro_description_fallback, false);
});

const DB_SKIP = testDatabaseConfigured() ? undefined : "PCMS_TEST_DATABASE_URL is not set";

test("site settings persist and round-trip through the store", { skip: DB_SKIP }, async (t) => {
  assertBaseReachable();
  const db = await createTestDatabase(t);
  const pool: DbPool = createDbPool({
    connectionInfo: {
      host: db.connection.host,
      port: db.connection.port,
      database: db.connection.database,
      user: db.connection.user,
      sslMode: "disable" as const,
      ...(db.connection.password === undefined ? {} : { password: db.connection.password }),
    },
    max: 3,
  });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const store = createSeoStore(pool);
  const siteId = newStableId();

  assert.equal(await store.getSiteSettings(siteId), null);
  const identity = parseSeoSiteIdentity({ site_name: "Пример", favicon: { asset_id: LOGO } });
  await store.saveSiteSettings(siteId, identity);
  await store.saveSiteSettings(siteId, parseSeoSiteIdentity({ site_name: "Пример 2" }));
  const read = await store.getSiteSettings(siteId);
  assert.equal(read?.site_name, "Пример 2");
  await assert.rejects(
    () => store.saveSiteSettings(siteId, { site_name: "" } as never),
    (err: SeoError) => err.code === "SEO_SETTINGS_INVALID",
  );
});

test("verification entries: meta-tag paste parses to the token, markup is rejected", () => {
  const parsed = parseSeoSiteIdentity({
    site_name: "Пример",
    verification: [
      {
        provider: "google",
        content: '<meta name="google-site-verification" content="jwA1BcD3eF5gHi7jK9lM="/>',
      },
      {
        provider: "yandex",
        method: "meta",
        content: "<meta name='yandex-verification' content='5a24bfc8483b6e17' />",
      },
      { provider: "other", content: "legacy-token", label: "прочее" },
    ],
  });
  const verification = parsed.verification ?? [];
  assert.equal(verification.length, 3);
  // "meta" stays implicit — records predate the field.
  assert.deepEqual(verification[0], { provider: "google", content: "jwA1BcD3eF5gHi7jK9lM=" });
  assert.deepEqual(verification[1], { provider: "yandex", content: "5a24bfc8483b6e17" });
  // Existing records without method keep meta semantics; "other" passes through.
  assert.deepEqual(verification[2], {
    provider: "other",
    content: "legacy-token",
    label: "прочее",
  });

  // Any other markup is rejected — no arbitrary <head> HTML support.
  assert.throws(
    () =>
      parseSeoSiteIdentity({
        site_name: "X",
        verification: [{ provider: "google", content: "<script>alert(1)</script>" }],
      }),
    (error: { details?: { issues?: { path?: string }[] } }) =>
      (error.details?.issues ?? []).some((issue) => issue.path === "/verification/0/content"),
  );
  // A pasted tag for the wrong provider is not silently accepted.
  assert.throws(() =>
    parseSeoSiteIdentity({
      site_name: "X",
      verification: [
        { provider: "yandex", content: '<meta name="google-site-verification" content="x">' },
      ],
    }),
  );
  // "other" never accepts markup and never carries file proofs.
  assert.throws(() =>
    parseSeoSiteIdentity({
      site_name: "X",
      verification: [{ provider: "other", content: "<meta name=x content=y>" }],
    }),
  );
  assert.throws(() =>
    parseSeoSiteIdentity({
      site_name: "X",
      verification: [
        {
          provider: "other",
          content: "t",
          method: "file",
          file: { filename: "other.html", body: "t" },
        },
      ],
    }),
  );
});

test("verification files: provider templates validated, hostile input rejected", () => {
  const token = "5a24bfc8483b6e17";
  const parsed = parseSeoSiteIdentity({
    site_name: "Пример",
    verification: [
      {
        provider: "google",
        method: "file",
        content: "jwA1BcD3eF5gHi7jK9lM=",
        file: {
          filename: "google1a2b3c4d5e6f7a8b.html",
          body: "google-site-verification: jwA1BcD3eF5gHi7jK9lM=\n",
        },
      },
      {
        provider: "yandex",
        method: "file",
        content: token,
        file: { filename: `yandex_${token}.html`, body: token },
      },
    ],
  });
  const verification = parsed.verification ?? [];
  assert.equal(verification[0]?.file?.filename, "google1a2b3c4d5e6f7a8b.html");
  // Provider-required body is preserved EXACTLY as submitted (providers
  // recheck the file; even a trailing newline is part of the served bytes).
  assert.equal(verification[0]?.file?.body, "google-site-verification: jwA1BcD3eF5gHi7jK9lM=\n");
  assert.equal(verification[1]?.file?.filename, `yandex_${token}.html`);
  assert.equal(verification[1]?.file?.body, token);

  const bad = (entry: unknown) =>
    parseSeoSiteIdentity({ site_name: "X", verification: [entry as never] });
  // Body/token mismatch (this is also the script/active-content gate).
  assert.throws(() =>
    bad({
      provider: "google",
      method: "file",
      content: "t1",
      file: { filename: "google1a2b3c4d5e6f7a8b.html", body: "<script>alert(1)</script>" },
    }),
  );
  // Wrong filename pattern: traversal, other providers, wrong length.
  assert.throws(() =>
    bad({
      provider: "google",
      method: "file",
      content: "t",
      file: { filename: "../google1a2b3c4d5e6f7a8b.html", body: "google-site-verification: t" },
    }),
  );
  assert.throws(() =>
    bad({
      provider: "google",
      method: "file",
      content: "t",
      file: { filename: "yandex_5a24bfc8483b6e17.html", body: "google-site-verification: t" },
    }),
  );
  assert.throws(() =>
    bad({
      provider: "yandex",
      method: "file",
      content: token,
      file: { filename: `yandex_zzzz.html`, body: token },
    }),
  );
  // File without a file object; file field on a meta entry.
  assert.throws(() => bad({ provider: "google", method: "file", content: "t" }));
  assert.throws(() =>
    bad({
      provider: "google",
      content: "t",
      file: { filename: "google1a2b3c4d5e6f7a8b.html", body: "google-site-verification: t" },
    }),
  );
  // Conflicting proofs for one provider; same token on two providers is fine.
  assert.throws(() =>
    bad([
      { provider: "google", content: "token-a" },
      { provider: "google", content: "token-b" },
    ]),
  );
  const twoProviders = parseSeoSiteIdentity({
    site_name: "X",
    verification: [
      { provider: "google", content: "same-token" },
      { provider: "yandex", content: "same-token" },
    ],
  });
  assert.equal((twoProviders.verification ?? []).length, 2);
});
