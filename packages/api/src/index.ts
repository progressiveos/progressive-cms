// @pcms/api — application operation layer + REST /api/v1 transport (M09).
export const PACKAGE_NAME = "@pcms/api";
export { DEFAULT_PCPUB_LIMITS, type PcpubLimits } from "@pcms/publication";
export {
  type InstallResult,
  installSkillPackage,
  SkillInstallError,
  validateSkillPackage,
} from "@pcms/skills";
export {
  installThemePackage,
  listInstalledThemes,
  ThemeInstallError,
  uninstallThemePackage,
  validateThemePackage,
} from "@pcms/themes";
export * from "./active-theme-media-presets.js";
export { getAgentBootstrapOp } from "./agent-bootstrap-ops.js";
export * from "./analytics-ops.js";
export * from "./bundle.js";
export * from "./collection-source.js";
export * from "./content-schema-ops.js";
export * from "./context.js";
export * from "./diagnostics-ops.js";
export {
  bindExternalIdentityOp,
  resolveExternalIdentityOp,
} from "./entry-identity-ops.js";
export * from "./errors.js";
export * from "./extension-config-ops.js";
export { extensionCanonicalPath } from "./extension-http.js";
export { createExtensionJobHandlers } from "./extension-jobs.js";
export * from "./extension-mcp-tools.js";
export * from "./extension-operations.js";
export { buildExtensionSourceContext } from "./extension-platform.js";
export { createExtensionScheduleService } from "./extension-schedules.js";
export * from "./extensions-ops.js";
export * from "./http/auth.js";
export * from "./http/idempotency.js";
export * from "./http/openapi.js";
export * from "./http/pagination.js";
export * from "./http/plugin.js";
export * from "./http/registry.js";
export { makeAgentRoutes } from "./http/routes/agent.js";
export { makeAnalyticsRoutes } from "./http/routes/analytics.js";
export { makePcpubBundleRoutes } from "./http/routes/bundles-pcpub.js";
export { makeCollectionsRoutes } from "./http/routes/collections.js";
export { makeContentSchemaRoutes } from "./http/routes/content-schema.js";
export { makeCoreRoutes, makeOpenApiRoute } from "./http/routes/core.js";
export { makeDiscoveryRoutes } from "./http/routes/discovery.js";
export { makeExtensionsRoutes } from "./http/routes/extensions.js";
export { makeFormsRoutes } from "./http/routes/forms.js";
export { makeIntegrationsRoutes } from "./http/routes/integrations.js";
export { makeInteractionsRoutes } from "./http/routes/interactions.js";
export { makeLocalizationRoutes } from "./http/routes/localization.js";
export { makeMailRoutes } from "./http/routes/mail.js";
export { makeMaintenanceRoutes } from "./http/routes/maintenance.js";
export { makeMediaProviderRoutes } from "./http/routes/media-providers.js";
export { makeMutationRoutes } from "./http/routes/mutations.js";
export { makeNotificationRoutes } from "./http/routes/notifications.js";
export { makePaymentsRoutes } from "./http/routes/payments.js";
export { makeRegistryRoutes } from "./http/routes/registry.js";
export { makeRoutingRoutes } from "./http/routes/routing.js";
export {
  createRateLimiter,
  makeSearchRoutes,
  searchCapabilities,
  searchStatus,
} from "./http/routes/search.js";
export { makeSeoIndexNowRoutes } from "./http/routes/seo-indexnow.js";
export { makeSkillsRoutes } from "./http/routes/skills.js";
export { makeThemeManageRoutes } from "./http/routes/themes-manage.js";
export * from "./indexnow-ops.js";
export * from "./integrations-ops.js";
export * from "./lead-deliveries.js";
export * from "./mail-ops.js";
export * from "./maintenance-ops.js";
export * from "./mcp-surface.js";
export * from "./media-acquisition-ops.js";
export * from "./media-provider-ops.js";
export * from "./media-providers.js";
export * from "./notifications-ops.js";
export * from "./operations.js";
export * from "./payments-ops.js";
export {
  createPcpubTargetContracts,
  pcpubRichTextBridge,
} from "./pcpub-contracts.js";
export {
  getPcpubIngestStatus,
  PCPUB_INGEST_JOB_TYPE,
  processPcpubIngest,
  receivePcpub,
  validatePcpubBytes,
} from "./pcpub-ingest.js";
export { API_BODY_LIMIT_PCPUB } from "./pcpub-limits.js";
export * from "./publication-ux-ops.js";
export * from "./registry-client.js";
export { mapEntryRichText, validateRichTextBlockPolicy } from "./richtext-documents.js";
export {
  type AdminSearchResult,
  createAdminSearch,
  createPublicSearchOperation,
  createSearchDocumentSource,
} from "./search-source.js";

export {
  cleanupThemeRevisions,
  getConfirmedThemeRevision,
  readThemeLifecycleState,
  recoverThemeLifecycle,
  type ThemeCleanupInput,
  withThemeLifecycleLock,
} from "./theme-lifecycle.js";
