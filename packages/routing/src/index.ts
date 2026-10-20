// @pcms/routing — Routing subsystem (M04, PCMS-NAV-T001).
//
// Public application surface of the Routing bounded context. Routing owns
// route identity: the mapping of site/domain + locale + path to its target
// (Navigation spec §22/§44). Entry identity is a stable ID, never a URL —
// canonical paths are mutable records with history. URL policies (trailing
// slash, slug normalization, reserved paths, legacy extensions) are site
// policy owned here. Deep imports like "@pcms/routing/src/…" are boundary
// violations (tests/architecture.test.ts).

export {
  type ActionHrefResolution,
  type ActionUrlService,
  createActionUrlService,
  type ResolvableAction,
} from "./actions.js";
export {
  createRouteProposalService,
  type ProposeRouteInput,
  type RouteAvailabilityIssue,
  type RouteAvailabilityResult,
  type RouteProposalService,
} from "./availability.js";
export {
  type CanonicalUrlOptions,
  type CanonicalUrlService,
  createCanonicalUrlService,
  localizedRoutePath,
} from "./canonical.js";
export {
  createRoutingDiscovery,
  type RoutingDiscovery,
} from "./discovery.js";
export {
  type AddDomainBindingInput,
  type CanonicalRedirectPolicy,
  createDomainService,
  type DomainBindingRecord,
  type DomainSchemePolicy,
  type DomainService,
  normalizeHostname,
} from "./domains.js";
export { ROUTING_ERROR_CODES, RoutingError, type RoutingErrorCode } from "./errors.js";
export {
  type ChangeRouteInput,
  createRouteHistoryService,
  type RecordRedirectInput,
  type RedirectStatusCode,
  type RouteHistoryRecord,
  type RouteHistoryService,
} from "./history.js";
export {
  applyRedirectImports,
  type ImportReport,
  type ImportRowReport,
  MAX_IMPORT_ROWS,
  type RedirectImportRow,
  validateRedirectImports,
} from "./import.js";
export {
  createSiteLocalizationService,
  type PeeledPrefix,
  type SiteLocalizationRecord,
  type SiteLocalizationService,
  type UpdateSiteLocalizationInput,
} from "./localization.js";
export {
  type BitrixElement,
  type BitrixSection,
  bitrixPathFromTemplate,
  buildWorkspaceFromBitrixExport,
} from "./migration/bitrix.js";
export {
  buildMigrationWorkspace,
  documentToPcmd,
  type MigrationRedirect,
  type MigrationWorkspace,
  redirectsToCsv,
  type SourcePage,
} from "./migration/common.js";
export {
  buildModxPlanFromFiles,
  buildModxRedirectPlan,
  type ModxPlan,
  normalizePath,
  type RedirectPlanRow,
  toCanonicalCsv,
  toRedirectsCsv,
} from "./migration/modx3.js";
export {
  type AgentExport,
  type AgentResource,
  buildWorkspaceFromAgentExport,
  type MigrationDocument,
  type MigrationWorkspacePlan,
  resourceToPcmd,
} from "./migration/modx3-agent.js";
export { buildWorkspaceFromTildaPages, sitemapLocs, tildaHtmlToPage } from "./migration/tilda.js";
export {
  buildWorkspaceFromWpRest,
  mediaInventoryCsv,
  type WpMediaItem,
  type WpPage,
  wpLinkToPath,
} from "./migration/wordpress.js";
export { decideRequestPath, normalizeStoredPath, type RequestPathDecision } from "./path.js";
export type {
  RoutePathPolicy,
  SlugCyrillicPolicy,
  SlugPolicy,
} from "./policy.js";
export {
  DEFAULT_MAX_REDIRECT_CHAIN,
  DEFAULT_RESERVED_PREFIXES,
  DEFAULT_ROUTE_POLICY,
  LEGACY_HTML_ROUTE_POLICY,
  parsePathPolicy,
} from "./policy.js";
export {
  createReservedRouteRegistry,
  type ReservedRouteRegistry,
} from "./reserved.js";
export {
  createRequestResolver,
  type RedirectGraphIssue,
  type RequestResolution,
  type RequestResolver,
  type ResolveInput,
} from "./resolve.js";
export {
  type ActivateRouteInput,
  createRouteService,
  type RouteRecord,
  type RouteService,
  type SiteRecord,
} from "./routes.js";
export { normalizeSlug, SlugInvalidError, slugSegmentsToPath } from "./slug.js";
export const PACKAGE_NAME = "@pcms/routing";
