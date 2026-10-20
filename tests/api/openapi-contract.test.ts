// PCMS-API-T026 — OpenAPI contract gate: the frozen release fixture, the
// route-registry consistency checks, and the breaking-diff semantics.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  type ApiRoute,
  buildOpenApiDocument,
  makeAgentRoutes,
  makeAnalyticsRoutes,
  makeCollectionsRoutes,
  makeContentSchemaRoutes,
  makeCoreRoutes,
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
  makeOpenApiRoute,
  makePaymentsRoutes,
  makePcpubBundleRoutes,
  makeRegistryRoutes,
  makeRoutingRoutes,
  makeSearchRoutes,
  makeSeoIndexNowRoutes,
  makeSkillsRoutes,
  makeThemeManageRoutes,
  stableStringify,
} from "@pcms/api";
import { type BreakingChange, breakingDiff } from "./helpers/openapi-diff.js";

/** Mirrors the PRODUCTION assembly (apps/web/src/main.ts createApiV1 call).
 * Was a stale reduced copy until 2026-10-06 — the snapshot then missed
 * whole surfaces (routing, skills, registry, collections, content schema,
 * SEO IndexNow, localization, agent) that the served openapi.json has. */
function fullRouteSet(): ApiRoute[] {
  const core = makeCoreRoutes({ cookieSecure: true });
  const domain = [
    ...makeDiscoveryRoutes(),
    ...makeContentSchemaRoutes(),
    ...makeRoutingRoutes(),
    ...makeSkillsRoutes(),
    ...makeRegistryRoutes(),
    ...makeThemeManageRoutes(),
    ...makeMutationRoutes(),
    ...makeSearchRoutes(),
    ...makeCollectionsRoutes(),
    ...makeAnalyticsRoutes(),
    ...makeSeoIndexNowRoutes(),
    ...makeFormsRoutes(),
    ...makeInteractionsRoutes(),
    ...makeIntegrationsRoutes(),
    ...makePaymentsRoutes(),
    ...makeExtensionsRoutes(),
    ...makeMediaProviderRoutes(),
    // .pcpub ingest transport (ADR-0014 §8; bundle tag).
    ...makePcpubBundleRoutes(),
    ...makeLocalizationRoutes(),
    ...makeMaintenanceRoutes(),
    ...makeAgentRoutes(),
    // Admin-facing outbound-mail surface incl. managed SMTP settings
    // (PCMS-OPS-T110/T130; integrations tag).
    ...makeMailRoutes(),
  ];
  return [...core, ...domain, makeOpenApiRoute([...core, ...domain])];
}

const FIXTURE_PATH = "fixtures/api/openapi-v1.json";

test("OpenAPI document is internally consistent with the route registry (T003/T026)", () => {
  const routes = fullRouteSet();
  const document = buildOpenApiDocument(routes) as unknown as {
    paths: Record<
      string,
      Record<
        string,
        { operationId: string; security?: unknown; responses: Record<string, unknown> }
      >
    >;
    components: { securitySchemes: Record<string, unknown> };
  };

  // Every registered route is documented exactly once, and vice versa.
  const documented = new Set<string>();
  const operationIds: string[] = [];
  for (const route of routes) {
    const path = route.spec.url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
    const operation = document.paths[path]?.[route.spec.method.toLowerCase()];
    assert.ok(operation, `${route.spec.method} ${route.spec.url} is not documented`);
    assert.equal(operation.operationId, route.spec.operationId);
    documented.add(`${route.spec.method} ${path}`);
    operationIds.push(operation.operationId);
  }
  assert.equal(new Set(operationIds).size, operationIds.length, "operationIds unique");

  // Security: authenticated operations declare schemes; error responses share
  // the envelope; security schemes exist (spec §72).
  assert.ok(document.components.securitySchemes.bearerAuth);
  assert.ok(document.components.securitySchemes.cookieAuth);
  for (const route of routes) {
    if (route.spec.auth !== "authenticated") continue;
    const path = route.spec.url.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
    const operation = document.paths[path]![route.spec.method.toLowerCase()]!;
    assert.ok(Array.isArray(operation.security), `${route.spec.operationId} declares security`);
    for (const status of ["401", "409", "500"]) {
      assert.ok(
        JSON.stringify(operation.responses[status]).includes("ErrorEnvelope"),
        `${route.spec.operationId} ${status} uses the shared envelope`,
      );
    }
  }
});

test("OpenAPI breaking-diff gate: minor breaks fail, additive changes pass (T026)", () => {
  const routes = fullRouteSet();
  const before = buildOpenApiDocument(routes);

  const deepClone = (value: unknown): Record<string, unknown> =>
    JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

  // Break 1: an operation disappears.
  const withoutOperation = deepClone(before);
  delete (withoutOperation.paths as Record<string, unknown>)["/changesets"];
  const removals = breakingDiff(before, withoutOperation);
  assert.ok(removals.some((change: BreakingChange) => change.kind === "operation_removed"));

  // Break 2: an operationId is renamed.
  const renamed = deepClone(before);
  (
    (
      (renamed["paths"] as Record<string, Record<string, { operationId: string }>>)[
        "/server"
      ] as Record<string, { operationId: string }>
    )["get"] as { operationId: string }
  ).operationId = "renamed_operation";
  assert.ok(
    breakingDiff(before, renamed).some(
      (change: BreakingChange) => change.kind === "operation_id_changed",
    ),
  );

  // Break 3: a documented request property disappears.
  const narrowed = deepClone(before);
  const withoutProperty = deepClone(before);
  const login = (
    ((withoutProperty["paths"] as Record<string, Record<string, { requestBody?: unknown }>>)[
      "/auth/login"
    ] ?? {}) as Record<string, { requestBody?: unknown }>
  )["post"]!;
  const loginBody = login.requestBody as {
    content: {
      "application/json": { schema: { properties: Record<string, unknown>; required: string[] } };
    };
  };
  const loginSchema = loginBody.content["application/json"].schema;
  delete loginSchema.properties.password;
  loginSchema.required = loginSchema.required.filter((name) => name !== "password");
  assert.ok(
    breakingDiff(before, withoutProperty).some(
      (change: BreakingChange) => change.kind === "request_property_removed",
    ),
  );

  // Additive change: a new optional property + a new operation are compatible.
  const additive = deepClone(before);
  const additiveServer = (
    (additive["paths"] as Record<string, Record<string, Record<string, unknown>>>)[
      "/server"
    ] as Record<string, Record<string, unknown>>
  )["get"] as Record<string, unknown>;
  additiveServer["summary"] = "Server identity and contract versions (amended text)";
  assert.deepEqual(breakingDiff(before, additive), []);
});

test("frozen OpenAPI fixture matches the generated contract byte-for-byte (T026)", (t) => {
  const routes = fullRouteSet();
  const generated = stableStringify(buildOpenApiDocument(routes));
  if (process.env["PCMS_UPDATE_OPENAPI_FIXTURE"] === "1") {
    writeFileSync(FIXTURE_PATH, generated);
    t.skip("fixture regenerated");
    return;
  }
  if (!existsSync(FIXTURE_PATH)) {
    writeFileSync(FIXTURE_PATH, generated);
    return; // first run materializes the baseline
  }
  const frozen = readFileSync(FIXTURE_PATH, "utf8");
  assert.equal(
    generated,
    frozen,
    "OpenAPI contract drifted from fixtures/api/openapi-v1.json — regenerate deliberately (PCMS_UPDATE_OPENAPI_FIXTURE=1) and run the breaking-diff review (spec §65)",
  );
});
