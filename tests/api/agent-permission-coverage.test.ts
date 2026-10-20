// Owner 2026-10-06 (P3-7 of the spangar frictions report): a permission
// handed to site agents must have at least one documented HTTP surface —
// "the right without an endpoint" must not appear silently (it happened
// twice: extension ops 0.1.98, domains.manage 0.1.181).
import assert from "node:assert/strict";
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
} from "@pcms/api";
import {
  CONTENT_WORK_SCOPES,
  INTEGRATIONS_WORK_SCOPES,
  SITE_DEVELOPMENT_SCOPES,
  THEME_WORK_SCOPES,
} from "@pcms/auth";

/** Mirrors the PRODUCTION assembly (apps/web/src/main.ts createApiV1 call) —
 * a coverage test against a reduced set would lie (the openapi-contract
 * test's own fullRouteSet is a stale copy; flagged 2026-10-06). */
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
    ...makePcpubBundleRoutes(),
    ...makeLocalizationRoutes(),
    ...makeMaintenanceRoutes(),
    ...makeAgentRoutes(),
    ...makeMailRoutes(),
  ];
  return [...core, ...domain, makeOpenApiRoute([...core, ...domain])];
}

/** Scopes consumed by background/system flows, not by an HTTP surface the
 * agent calls directly. Each entry MUST name the enforcement point — an
 * entry without a reason is a hole, not an exception. */
const SCOPE_WITHOUT_HTTP_SURFACE = new Set<string>([
  // enforced inside embed rendering/validation (allowlist of providers)
  "embed.trusted",
  // checked inside the payments settings save path (stricter than payments.manage)
  "payments.configure",
  // web-research tooling transport (agent client), not an admin HTTP surface
  "research.fetch",
  "research.manage",
  "research.search",
  // validated inside SEO document writes (canonical override field)
  "seo.canonical_override",
  // checked by the maintenance gate middleware, never an endpoint of its own
  "site.maintenance.bypass",
  // preview transport is signed-URL based (PCMS-API-T016), header-less
  "theme.preview",
]);

test("every agent permission has a documented HTTP surface (owner 2026-10-06)", () => {
  const routes = fullRouteSet();
  const routePermissions = new Set(
    routes.flatMap((route) => (route.spec.permission ? [route.spec.permission] : [])),
  );
  const agentScopes = [
    ...new Set([
      ...SITE_DEVELOPMENT_SCOPES,
      ...CONTENT_WORK_SCOPES,
      ...THEME_WORK_SCOPES,
      ...INTEGRATIONS_WORK_SCOPES,
    ]),
  ];
  const missing = agentScopes.filter(
    (scope) => !routePermissions.has(scope) && !SCOPE_WITHOUT_HTTP_SURFACE.has(scope),
  );
  assert.deepEqual(missing, [], `agent permissions without any API surface: ${missing.join(", ")}`);
});

test("openapi exposes the CMS version, not a static placeholder", async () => {
  // P3-7: openapi.info.version was hard-coded "1.0.0"; agents could not tell
  // which build a contract belongs to. The document now carries the running
  // CMS version (option, wired from build metadata at the composition root).
  const doc = buildOpenApiDocument(fullRouteSet(), { cmsVersion: "9.9.9-test" }) as unknown as {
    info: { version: string };
  };
  assert.equal(doc.info.version, "9.9.9-test");
});
