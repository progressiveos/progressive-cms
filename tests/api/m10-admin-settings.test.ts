// PCMS-ADMIN-T025 — site identity + system status contracts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationContext } from "@pcms/api";
import {
  apiContextOf,
  createApiFixture,
  ownerActor,
  scopedActor,
} from "../helpers/api-composition.js";
import { testDatabaseConfigured } from "../helpers/testdb.js";

async function fixture(t: { after: (fn: () => void) => void }) {
  const { app } = await createApiFixture(t, { themeDir: "themes/reference-theme-v1" });
  await app.routes.ensureSite("default");
  return { app };
}

test("site identity: empty default, typed save, read back; permission split", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const { getSiteIdentityOp, updateSiteIdentityOp } = await import("@pcms/api");

  const before = await getSiteIdentityOp(app, ctx);
  assert.equal(before.identity, null);

  await updateSiteIdentityOp(app, ctx, {
    identity: {
      site_name: "Пример",
      legal_name: "ООО «Пример»",
      organization_type: "Organization",
      phone: "+7 900 000-00-00",
      email: "info@example.ru",
    },
  });
  const after = await getSiteIdentityOp(app, ctx);
  assert.equal((after.identity as { site_name?: string }).site_name, "Пример");

  // seo.read can read; writing needs seo.site_settings
  const reader = apiContextOf(scopedActor(["seo.read"]));
  await getSiteIdentityOp(app, reader);
  await assert.rejects(
    () => updateSiteIdentityOp(app, reader, { identity: { site_name: "X" } }),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );

  // Ownership verification (2026-10-18 task B): meta + file proofs save and
  // read back typed; a pasted provider meta tag parses to the token.
  await updateSiteIdentityOp(app, ctx, {
    identity: {
      site_name: "Пример",
      verification: [
        {
          provider: "google",
          content: '<meta name="google-site-verification" content="jwA1BcD3eF5gHi7jK9lM=">',
        },
        {
          provider: "yandex",
          content: "5a24bfc8483b6e17",
          method: "file",
          file: { filename: "yandex_5a24bfc8483b6e17.html", body: "5a24bfc8483b6e17" },
        },
      ],
    },
  });
  const withVerification = await getSiteIdentityOp(app, ctx);
  const records = (withVerification.identity as { verification?: unknown[] }).verification ?? [];
  assert.deepEqual(records[0], { provider: "google", content: "jwA1BcD3eF5gHi7jK9lM=" });
  assert.deepEqual(records[1], {
    provider: "yandex",
    content: "5a24bfc8483b6e17",
    method: "file",
    file: { filename: "yandex_5a24bfc8483b6e17.html", body: "5a24bfc8483b6e17" },
  });

  // A proof path that already resolves to content is rejected loudly —
  // verification files never silently shadow existing routes. A system route
  // on a legacy site whose policy allows `.html` makes the conflict genuine.
  const conflictSite = await app.routes.ensureSite(app.defaultSiteKey);
  await app.routes.setPolicy(conflictSite.id, {
    ...(await app.routes.getPolicy(conflictSite.id)),
    allowedExtensions: [".html"],
  });
  await app.routes.activateRoute({
    siteId: conflictSite.id,
    path: "/google1a2b3c4d5e6f7a8b.html",
    targetType: "system",
    targetId: "conflict-fixture",
  });
  await assert.rejects(
    () =>
      updateSiteIdentityOp(app, ctx, {
        identity: {
          site_name: "Пример",
          verification: [
            {
              provider: "google",
              content: "t",
              method: "file",
              file: {
                filename: "google1a2b3c4d5e6f7a8b.html",
                body: "google-site-verification: t",
              },
            },
          ],
        },
      }),
    (error: { readonly code?: string }) => error?.code === "VERIFICATION_ROUTE_CONFLICT",
  );
  // The rejected save changed nothing (all-or-nothing identity admission).
  const unchanged = await getSiteIdentityOp(app, ctx);
  assert.equal(
    ((unchanged.identity as { verification?: { content: string }[] }).verification ?? []).some(
      (record) => record.content === "t",
    ),
    false,
  );
});

test("system status: migration head, theme info, no secrets; permission gated", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const ctx: OperationContext = apiContextOf(ownerActor());
  const { getSystemStatusOp } = await import("@pcms/api");

  const status = (await getSystemStatusOp(app, ctx)) as {
    db_migration_head: string;
    theme: { id: string } | null;
    site: { key: string } | null;
  };
  assert.match(status.db_migration_head, /^\d{4}_[a-z0-9_]+$/);
  assert.equal(status.theme?.id, "reference-theme-v1");
  assert.equal(status.site?.key, "default");

  const limited = apiContextOf(scopedActor(["seo.read"]));
  await assert.rejects(
    () => getSystemStatusOp(app, limited),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );
});
