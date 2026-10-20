// PCMS-OPS-T131 — generic Integration Hub runtime secret store, API layer:
// RBAC (configure + secrets.manage), declared-key validation, write-only
// serialization (key names visible, values never), fail-closed without the
// encryption key, and the Telegram connector being fully Admin-configurable.
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

async function fixture(t: { after: (fn: () => void) => void }, withBox = true) {
  const { deriveKeyForTesting, createSecretBox } = await import("@pcms/auth");
  const box = createSecretBox(deriveKeyForTesting("runtime-secrets-test"));
  const { app } = await createApiFixture(t, withBox ? { runtimeSecretBox: box } : {});
  await app.routes.ensureSite("default");
  return { app };
}

async function createTelegramInstance(app: Awaited<ReturnType<typeof fixture>>["app"]) {
  const owner = apiContextOf(ownerActor());
  const { createIntegrationInstance } = await import("@pcms/api");
  return createIntegrationInstance(app, owner, {
    connector_type: "telegram",
    name: `tg-${Date.now().toString(36)}`,
    config: { default_chat_id: "42" },
  });
}

test("instance secrets: set requires configure + secrets.manage; key must be declared", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t);
  const instance = await createTelegramInstance(app);
  const { setIntegrationInstanceSecret } = await import("@pcms/api");

  const configureOnly = apiContextOf(scopedActor(["integrations.configure", "integrations.read"]));
  await assert.rejects(
    () =>
      setIntegrationInstanceSecret(app, configureOnly, {
        instance_id: instance.id,
        key: "bot_token",
        value: "tok",
      }),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );

  const manageOnly = apiContextOf(
    scopedActor(["integrations.secrets.manage", "integrations.read"]),
  );
  await assert.rejects(
    () =>
      setIntegrationInstanceSecret(app, manageOnly, {
        instance_id: instance.id,
        key: "bot_token",
        value: "tok",
      }),
    (error: { readonly code?: string }) => error?.code === "AUTH_PERMISSION_DENIED",
  );

  // Undeclared key → rejected (fail-secure against typo-sculated storage).
  const owner = apiContextOf(ownerActor());
  await assert.rejects(
    () =>
      setIntegrationInstanceSecret(app, owner, {
        instance_id: instance.id,
        key: "not_a_requirement",
        value: "tok",
      }),
    (error: { readonly code?: string }) => error?.code === "INTEGRATION_SECRET_KEY_UNKNOWN",
  );

  const saved = (await setIntegrationInstanceSecret(app, owner, {
    instance_id: instance.id,
    key: "bot_token",
    value: "123:ABC",
  })) as { runtime_secrets: readonly string[]; secret_refs: Record<string, string> };
  assert.deepEqual(saved.runtime_secrets, ["bot_token"]);
  // Write-only: the response carries names, never the value.
  assert.equal(JSON.stringify(saved).includes("123:ABC"), false);
});

test("instance secrets: no encryption key → fail closed; clear removes; values never serialize", async (t) => {
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const { app } = await fixture(t, false);
  const instance = await createTelegramInstance(app);
  const owner = apiContextOf(ownerActor());
  const { setIntegrationInstanceSecret, listIntegrationInstances } = await import("@pcms/api");

  await assert.rejects(
    () =>
      setIntegrationInstanceSecret(app, owner, {
        instance_id: instance.id,
        key: "bot_token",
        value: "tok",
      }),
    (error: { readonly code?: string }) =>
      error?.code === "INTEGRATION_RUNTIME_SECRETS_NOT_CONFIGURED",
  );

  // With a box: set → clear roundtrip through the enriched views.
  const { deriveKeyForTesting, createSecretBox } = await import("@pcms/auth");
  const { clearIntegrationInstanceSecret } = await import("@pcms/api");
  const boxedApp = { ...app, runtimeSecretBox: createSecretBox(deriveKeyForTesting("rt")) };
  await setIntegrationInstanceSecret(boxedApp, owner, {
    instance_id: instance.id,
    key: "bot_token",
    value: "tok",
  });
  const view = (await listIntegrationInstances(app, owner)).items.find(
    (candidate) => candidate.id === instance.id,
  ) as { runtime_secrets: readonly string[] };
  assert.deepEqual(view.runtime_secrets, ["bot_token"]);
  await clearIntegrationInstanceSecret(boxedApp, owner, {
    instance_id: instance.id,
    key: "bot_token",
  });
  const cleared = (await listIntegrationInstances(app, owner)).items.find(
    (candidate) => candidate.id === instance.id,
  ) as { runtime_secrets: readonly string[] };
  assert.deepEqual(cleared.runtime_secrets, []);
});
