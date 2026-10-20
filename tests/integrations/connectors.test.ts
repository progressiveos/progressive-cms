// PCMS-INT-T001 — connector registry contracts: explicit typed definitions,
// deterministic listing, duplicate/unknown rejection, schema validation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ConnectorDefinition,
  createConnectorRegistry,
  type IntegrationError,
  validateConnectorPayload,
} from "@pcms/integrations";

const fakeConnector: ConnectorDefinition = {
  connectorType: "fake-notify",
  title: "Fake notifier",
  description: "Deterministic test connector",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", format: "uri" },
      retries: { type: "integer", minimum: 0, maximum: 5 },
    },
    required: ["url"],
  },
  secrets: [{ name: "api_key", description: "API key secret ref" }],
  actions: [
    {
      actionType: "notify",
      description: "Send a notification",
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", maxLength: 200 } },
        required: ["text"],
      },
    },
  ],
  testable: true,
};

test("connector registry: typed contract round-trip + deterministic order", () => {
  const registry = createConnectorRegistry();
  registry.register(fakeConnector);
  registry.register({ ...fakeConnector, connectorType: "aaa-first" });
  assert.deepEqual(
    registry.list().map((definition) => definition.connectorType),
    ["aaa-first", "fake-notify"],
  );
  const found = registry.get("fake-notify");
  assert.equal(found?.actions[0]?.actionType, "notify");
  assert.equal(found?.secrets[0]?.name, "api_key");
  assert.equal(registry.get("nope"), undefined);
});

test("connector registry: duplicate type and duplicate action rejected", () => {
  const registry = createConnectorRegistry();
  registry.register(fakeConnector);
  assert.throws(
    () => registry.register({ ...fakeConnector }),
    (error: IntegrationError) => error.code === "CONNECTOR_TYPE_UNKNOWN",
  );
  assert.throws(
    () =>
      registry.register({
        ...fakeConnector,
        connectorType: "other",
        actions: [fakeConnector.actions[0]!, fakeConnector.actions[0]!],
      }),
    (error: IntegrationError) => error.code === "CONNECTOR_TYPE_UNKNOWN",
  );
});

test("connector payloads validate against the declared bounded schema", () => {
  const registry = createConnectorRegistry();
  registry.register(fakeConnector);
  const definition = registry.get("fake-notify")!;
  assert.deepEqual(
    validateConnectorPayload(definition.configSchema, { url: "https://x.example" }, "config"),
    [],
  );
  assert.deepEqual(
    [
      ...validateConnectorPayload(definition.configSchema, { url: 5, extra: true }, "config"),
    ].sort(),
    ["config/extra: unknown property", "config/url: expected string"],
  );
  assert.ok(
    validateConnectorPayload(definition.configSchema, {}, "config").some((issue) =>
      issue.includes("url: required"),
    ),
  );
  assert.deepEqual(
    validateConnectorPayload(definition.actions[0]!.payloadSchema, { text: "hi" }, "payload"),
    [],
  );
  assert.ok(
    validateConnectorPayload(
      definition.actions[0]!.payloadSchema,
      { text: "x".repeat(201) },
      "payload",
    ).length > 0,
  );
});
