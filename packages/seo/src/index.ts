// @pcms/seo — SEO, Social & Structured Data subsystem (M06, PCMS-SEO-T001).
//
// Public application surface of the SEO bounded context. SEO owns metadata
// semantics: title/description resolution, canonical rendering, indexing
// policy, Open Graph/X compatibility, JSON-LD structured data, sitemap and
// robots.txt. Routing provides canonical URLs, Content provides semantic
// facts, Media provides images — through injected plain-data ports wired at
// the composition layer (packages/seo is L1 and imports @pcms/core only;
// tests/architecture.test.ts). Deep imports like "@pcms/seo/src/…" are
// boundary violations.

export {
  type CanonicalOverrideContext,
  type CanonicalProvenance,
  canonicalConsistencyIssues,
  resolveCanonical,
  type SeoCanonicalPort,
  type SeoUrlSignals,
  validateCanonicalOverride,
} from "./canonical.js";
export {
  SEO_DIAGNOSTIC_CODES,
  type SeoDiagnostic,
  type SeoDiagnosticCode,
  type SeoSeverity,
} from "./diagnostics.js";
export {
  createSeoDiscovery,
  SEO_AGENT_SCOPES,
  type SeoAgentScope,
  type SeoDiscovery,
  type SeoDiscoveryDeps,
  type SeoDocumentSchemaDescriptor,
  type SeoFactsContext,
  type SeoOperationDescriptor,
} from "./discovery.js";
export {
  emptySeoDocument,
  parseSeoDocument,
  parseSeoMediaRef,
  parseSeoRobotsPolicy,
  type SeoDocument,
  type SeoMediaRef,
  type SeoRobotsPolicy,
  STRUCTURED_DATA_TYPE_HINTS,
  type StructuredDataTypeHint,
} from "./document.js";
export {
  applyEnvironmentGuard,
  environmentAllowsIndexing,
  type SeoEnvironment,
} from "./environment.js";
export { SEO_ERROR_CODES, SeoError, type SeoErrorCode } from "./errors.js";
export {
  DEFAULT_SITE_SEO_DEFAULTS,
  type ResolvedSeoMetadata,
  type ResolvedSeoValue,
  resolveSeoMetadata,
  type SemanticPageFacts,
  type SeoProvenanceSource,
  type SiteSeoDefaults,
} from "./fallback.js";
export {
  buildFaviconIcons,
  type FaviconViewModel,
  faviconIssues,
  type SeoFaviconPort,
  type SeoHeadIcon,
  type SeoLogoPort,
} from "./favicon.js";
export {
  type BuiltSeoHeadModel,
  buildSeoHeadModel,
  type SeoHeadModelInput,
  type SeoHeadViewModel,
} from "./head-model.js";
export {
  DEFAULT_INDEXNOW_SETTINGS,
  generateIndexNowKey,
  INDEXNOW_BATCH_LIMIT,
  INDEXNOW_COOLDOWN_MS,
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY_RE,
  INDEXNOW_MAX_ATTEMPTS,
  INDEXNOW_VERIFICATION_RETRY_MS,
  type IndexNowReason,
  type IndexNowSettings,
  type IndexNowState,
  indexNowUrlIssue,
  PACKAGE_INDEXNOW_NAME,
  parseIndexNowSettings,
} from "./indexnow.js";
export {
  previewSeo,
  previewStructuredData,
  type SeoPreviewPorts,
  type SeoPreviewRequest,
  type SeoPreviewResult,
  siteFactsFromIdentity,
} from "./preview.js";
export { isNoindex, renderRobotsMeta, robotsConflicts } from "./robots-meta.js";
export {
  defaultRobotsTxtPolicy,
  parseRobotsTxtPolicy,
  RESERVED_ROBOTS_PATHS,
  type RobotsTxtPolicy,
  type RobotsTxtRule,
  renderRobotsTxt,
} from "./robots-txt.js";
export {
  type ComposedStructuredData,
  composeStructuredData,
  STRUCTURED_DATA_NODE_TYPES_V1,
  type StructuredDataPageInput,
  serializeJsonLd,
} from "./schema/compose.js";
export type {
  ArticleAuthorFacts,
  ArticleFacts,
  ArticlePublisherFacts,
  ArticleSchemaType,
  BreadcrumbFacts,
  LocalBusinessFacts,
  OrganizationFacts,
  PostalAddressFacts,
  VideoFacts,
  WebPageFacts,
  WebSiteFacts,
} from "./schema/facts.js";
export {
  buildArticleNode,
  buildBreadcrumbNode,
  buildOrganizationNode,
  buildVideoNode,
  buildWebPageNode,
  buildWebSiteNode,
  type JsonLdNode,
  validateGraphNode,
} from "./schema/nodes.js";
export {
  duplicateContentIssues,
  type SeoResolvedPage,
  type SiteSeoAuditInput,
  type SiteSitemapEntry,
  validateSiteSeo,
} from "./site-checks.js";
export {
  type OrganizationSchemaSelection,
  parseSeoSiteIdentity,
  type SeoAddressFacts,
  type SeoLocalBusinessFacts,
  type SeoSiteIdentity,
  type SeoVerificationEntry,
  selectOrganizationSchema,
  toSiteSeoDefaults,
} from "./site-identity.js";
export {
  assertSitemapOrigin,
  buildSitemapEntries,
  buildSitemapFiles,
  MAX_URLS_PER_SITEMAP,
  renderSitemapIndexXml,
  renderSitemapXml,
  type SitemapBuildInput,
  type SitemapBuildResult,
  type SitemapCandidate,
  type SitemapEligibility,
  type SitemapFile,
  type SitemapFilesResult,
  type SitemapUrlEntry,
} from "./sitemap.js";
export {
  buildOpenGraphMeta,
  isAbsoluteHttpUrl,
  type OpenGraphMetaInput,
  resolveOgType,
  type SeoSocialImagePort,
  type SocialImageViewModel,
} from "./social.js";
export { createSeoStore, type SeoDocumentRecord, type SeoStore } from "./store.js";
export {
  buildTwitterCardMeta,
  LARGE_IMAGE_MIN,
  type TwitterCardMetaInput,
} from "./twitter.js";
export {
  type SeoValidationInput,
  type SeoValidationReport,
  validateSeoPage,
} from "./validate.js";
