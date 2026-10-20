// Startup schema regression (2026-09-30 prod incident): one malformed
// paramsSchema (`{ setId: … }` shorthand instead of a JSON Schema object)
// crashed the web process at boot — Ajv strict mode rejects unknown root
// keywords, and route registration is the first place that compiles these
// schemas. This test compiles EVERY declared route schema with the same
// strictness, without a database, so a bad schema fails here first.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeAgentRoutes,
  makeContentSchemaRoutes,
  makeDiscoveryRoutes,
  makeExtensionsRoutes,
  makeFormsRoutes,
  makeIntegrationsRoutes,
  makeInteractionsRoutes,
  makeLocalizationRoutes,
  makeMailRoutes,
  makeMaintenanceRoutes,
  makeMediaProviderRoutes,
  makeMutationRoutes,
  makePaymentsRoutes,
  makePcpubBundleRoutes,
  makeRegistryRoutes,
  makeRoutingRoutes,
  makeSearchRoutes,
  makeSkillsRoutes,
  makeThemeManageRoutes,
} from "@pcms/api";
import Ajv from "ajv";
import addFormats from "ajv-formats";

test("every route schema compiles under Ajv strict mode (boot regression)", () => {
  const routes = [
    ...makeDiscoveryRoutes(),
    ...makeContentSchemaRoutes(),
    ...makeRoutingRoutes(),
    ...makeSkillsRoutes(),
    ...makeRegistryRoutes(),
    ...makeThemeManageRoutes(),
    ...makeMutationRoutes(),
    ...makeSearchRoutes(),
    ...makeFormsRoutes(),
    ...makeInteractionsRoutes(),
    ...makeIntegrationsRoutes(),
    ...makePaymentsRoutes(),
    ...makeExtensionsRoutes(),
    ...makeMediaProviderRoutes(),
    ...makePcpubBundleRoutes(),
    ...makeLocalizationRoutes(),
    ...makeMaintenanceRoutes(),
    ...makeAgentRoutes(),
    ...makeMailRoutes(),
  ];
  assert.ok(routes.length > 100, `route registry looks broken: ${routes.length} routes`);

  // ajv-formats matches the runtime compiler (fastify registers date-time et
  // al.), so only genuinely malformed schemas fail here.
  const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));
  const failures: string[] = [];
  for (const route of routes) {
    const label = `${route.spec.method} ${route.spec.url}`;
    for (const [kind, schema] of [
      ["params", route.spec.paramsSchema],
      ["query", route.spec.querySchema],
      ["body", route.spec.bodySchema],
    ] as const) {
      if (schema === undefined) continue;
      try {
        ajv.compile(schema as object);
      } catch (error) {
        failures.push(
          `${label} (${kind}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("plan overrides accept both wire spellings and require an item and timestamp", () => {
  const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));
  const id = "01a1200b-6587-7a0d-8419-9ac784490fd4";
  const instant = "2030-10-09T10:00:00Z";
  const routes = makeMutationRoutes().filter((route) =>
    ["preview_publication_plan", "schedule_publication_plan"].includes(route.spec.operationId),
  );
  assert.equal(routes.length, 2);
  for (const route of routes) {
    const validate = ajv.compile(route.spec.bodySchema as object);
    for (const override of [
      { changeset_item_id: id, publish_at: instant },
      { changesetItemId: id, publishAt: instant },
      { changeset_item_id: id, unpublish_at: instant },
      { changesetItemId: id, unpublishAt: instant },
    ])
      assert.equal(validate({ spec: {}, overrides: [override] }), true);
    for (const override of [
      { publish_at: instant },
      { changeset_item_id: id },
      { changesetItemId: id, publishAt: "bad-date" },
    ])
      assert.equal(validate({ spec: {}, overrides: [override] }), false);
  }
});

test("extension mount discovery is GET; assigning a mount is a permissioned PUT", () => {
  const routes = makeExtensionsRoutes().filter(
    (route) => route.spec.url === "/extensions/:extensionId/mount",
  );
  assert.deepEqual(
    routes
      .map((route) => [route.spec.method, route.spec.operationId, route.spec.permission])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["GET", "extension_mount_get", "extensions.manage"],
      ["PUT", "extension_mount_set", "extensions.manage"],
    ],
  );
});
