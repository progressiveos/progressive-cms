// PCMS-EXT-T003 — Capability registry and version resolution.
// Acceptance (Master Plan M14): satisfied, unsatisfied, version mismatch,
// provider conflict, multi-provider where explicitly supported; discovery
// deterministic.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCapabilitiesSatisfied,
  createCapabilityRegistry,
  ExtensionError,
  resolveCapabilities,
} from "@pcms/extensions/internal";

test("satisfied requirement resolves to its providers", () => {
  const registry = createCapabilityRegistry();
  registry.provide({ key: "blocks.gallery", version: "1.2.0", provider: "cms:blocks" });
  const result = resolveCapabilities(registry, [{ capability: "blocks.gallery", range: "^1.0.0" }]);
  assert.deepEqual(result, [
    {
      capability: "blocks.gallery",
      range: "^1.0.0",
      status: "satisfied",
      providers: ["cms:blocks"],
    },
  ]);
});

test("missing capability is unsatisfied (fail-closed)", () => {
  const registry = createCapabilityRegistry();
  const result = resolveCapabilities(registry, [
    { capability: "search.provider", range: "^1.0.0" },
  ]);
  assert.deepEqual(result, [
    { capability: "search.provider", range: "^1.0.0", status: "unsatisfied", reason: "missing" },
  ]);
});

test("version mismatch reports available versions", () => {
  const registry = createCapabilityRegistry();
  registry.provide({ key: "theme-contract", version: "2.0.0", provider: "cms:themes" });
  const result = resolveCapabilities(registry, [{ capability: "theme-contract", range: "^1.0.0" }]);
  assert.deepEqual(result, [
    {
      capability: "theme-contract",
      range: "^1.0.0",
      status: "unsatisfied",
      reason: "version_mismatch",
      available: ["2.0.0"],
    },
  ]);
});

test("single-provider capability conflicts on second provider (no last-wins)", () => {
  const registry = createCapabilityRegistry();
  registry.provide({ key: "search.provider", version: "1.0.0", provider: "com.example.a" });
  assert.throws(
    () => registry.provide({ key: "search.provider", version: "1.0.0", provider: "com.example.b" }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_CAPABILITY_CONFLICT",
  );
});

test("multi-provider capability explicitly supports several providers", () => {
  const registry = createCapabilityRegistry();
  registry.provide({
    key: "integration.connector",
    version: "1.0.0",
    provider: "com.example.telegram",
    multi: true,
  });
  registry.provide({
    key: "integration.connector",
    version: "1.1.0",
    provider: "com.example.email",
    multi: true,
  });
  const providers = registry.providers("integration.connector").map((p) => p.provider);
  assert.deepEqual(providers, ["com.example.email", "com.example.telegram"]);
  const result = resolveCapabilities(registry, [
    { capability: "integration.connector", range: ">=1.0.0 <2.0.0" },
  ]);
  assert.equal(result[0]?.status, "satisfied");
});

test("assertCapabilitiesSatisfied throws a stable dependency error naming the extension", () => {
  const registry = createCapabilityRegistry();
  registry.provide({ key: "payments.provider", version: "1.0.0", provider: "cms:payments" });
  assert.throws(
    () =>
      assertCapabilitiesSatisfied(
        registry,
        [
          { capability: "payments.provider", range: "^1.0.0" },
          { capability: "forms.destinations", range: "^1.0.0" },
        ],
        "com.example.checkout",
      ),
    (error: unknown) => {
      if (!(error instanceof ExtensionError) || error.code !== "EXTENSION_DEPENDENCY_UNSATISFIED") {
        return false;
      }
      assert.match(error.message, /com\.example\.checkout/);
      assert.match(error.message, /forms\.destinations/);
      return true;
    },
  );
});

test("invalid requirement ranges fail closed instead of silently matching", () => {
  const registry = createCapabilityRegistry();
  registry.provide({ key: "blocks.gallery", version: "1.0.0", provider: "cms:blocks" });
  assert.throws(
    () => resolveCapabilities(registry, [{ capability: "blocks.gallery", range: "latest" }]),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_CAPABILITY_CONFLICT",
  );
});

test("discovery is deterministic regardless of provision order", () => {
  const a = createCapabilityRegistry();
  a.provide({ key: "b.cap", version: "1.0.0", provider: "cms:x" });
  a.provide({ key: "a.cap", version: "1.0.0", provider: "cms:y" });
  const b = createCapabilityRegistry();
  b.provide({ key: "a.cap", version: "1.0.0", provider: "cms:y" });
  b.provide({ key: "b.cap", version: "1.0.0", provider: "cms:x" });
  assert.deepEqual(a.list(), b.list());
});
