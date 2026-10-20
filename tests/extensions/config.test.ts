// PCMS-EXT-T004 — Extension config namespacing.
// Acceptance (Master Plan M14): two extensions can use the same local key
// safely, invalid config blocks enable, secret values are not serialized.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createExtensionConfigSpace,
  ExtensionError,
  resolveExtensionConfig,
  validateExtensionConfig,
} from "@pcms/extensions/internal";

const schemaWithSecret = {
  type: "object",
  additionalProperties: false,
  properties: {
    token: { type: "string", maxLength: 64 },
    bot_token: { type: "string", format: "secret-ref" },
    retries: { type: "integer", minimum: 0, maximum: 10 },
  },
};

test("config validates against the manifest schema", () => {
  const result = validateExtensionConfig({
    extensionId: "com.example.a",
    schema: schemaWithSecret,
    config: { token: "public-label", bot_token: { $secret_ref: "telegram.bot" }, retries: 3 },
  });
  assert.equal(result.ok, true);
});

test("invalid config is rejected with per-path issues (blocks enable)", () => {
  const result = validateExtensionConfig({
    extensionId: "com.example.a",
    schema: schemaWithSecret,
    config: { retries: 99, unknown_key: true },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.issues.some((issue) => issue.path === "retries"));
    assert.ok(result.issues.some((issue) => issue.path === "unknown_key"));
  }
});

test("plaintext in a secret slot never validates — references only", () => {
  const plaintext = validateExtensionConfig({
    extensionId: "com.example.a",
    schema: schemaWithSecret,
    config: { bot_token: "sk-live-plaintext-value" },
  });
  assert.equal(plaintext.ok, false, "plaintext secret must be rejected");
  // References outside a secret slot are rejected too.
  const misplaced = validateExtensionConfig({
    extensionId: "com.example.a",
    schema: schemaWithSecret,
    config: { token: { $secret_ref: "telegram.bot" } },
  });
  assert.equal(misplaced.ok, false);
});

test("resolved secret values exist only in memory — never serialized back", () => {
  const stored = { bot_token: { $secret_ref: "telegram.bot" } };
  const secrets = new Map([["telegram.bot", "SUPER-SECRET-VALUE"]]);
  const runtimeConfig = resolveExtensionConfig(stored, (name) => secrets.get(name));
  assert.equal(runtimeConfig.bot_token, "SUPER-SECRET-VALUE");
  // The stored document still holds only the reference…
  assert.equal(JSON.stringify(stored).includes("SUPER-SECRET-VALUE"), false);
  // …and a serialized runtime view of the stored config never leaks the value.
  assert.equal(JSON.stringify(stored).includes("$secret_ref"), true);
});

test("unresolvable secret reference fails closed with a stable code", () => {
  assert.throws(
    () => resolveExtensionConfig({ bot_token: { $secret_ref: "nope.missing" } }, () => undefined),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_SECRET_REF_UNRESOLVED",
  );
});

test("two extensions can safely use the same local config keys", () => {
  const space = createExtensionConfigSpace();
  const schema = { type: "object", properties: { token: { type: "string" } } };
  const configA = validateExtensionConfig({
    extensionId: "com.example.a",
    schema,
    config: { token: "A-token" },
  });
  const configB = validateExtensionConfig({
    extensionId: "com.example.b",
    schema,
    config: { token: "B-token" },
  });
  assert.ok(configA.ok && configB.ok);
  space.set("com.example.a", configA.config);
  space.set("com.example.b", configB.config);
  assert.equal(space.get("com.example.a")?.token, "A-token");
  assert.equal(space.get("com.example.b")?.token, "B-token");
});

test("extension declaring no config schema must be configured with {}", () => {
  const empty = validateExtensionConfig({
    extensionId: "com.example.plain",
    schema: undefined,
    config: {},
  });
  assert.equal(empty.ok, true);
  const anything = validateExtensionConfig({
    extensionId: "com.example.plain",
    schema: undefined,
    config: { token: "x" },
  });
  assert.equal(anything.ok, false);
});
