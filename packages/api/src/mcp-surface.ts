import type {
  PrivacyAcknowledgement,
  PrivacyApplyInput,
  PrivacyOperation,
} from "./interaction-privacy.js";
import {
  acknowledgeInteractionPrivacy,
  applyInteractionPrivacy,
  getInteractionPrivacyCase,
  previewInteractionPrivacy,
} from "./interaction-privacy-ops.js";
// MCP operation surface (PCMS-API-T019/T020). The MCP transport cannot import
// this package (L2→L2 is forbidden by the architecture map), so @pcms/mcp
// declares a structural interface and the composition root (apps/web) binds
// THIS object into it — TypeScript verifies the shapes match. The tools then
// run the exact same application operations as REST (API spec §46).

import { BLOCK_DOCUMENT_SCHEMA_VERSION } from "@pcms/blocks";
import { RICHTEXT_AST_VERSIONS, RICHTEXT_NODE_TYPES } from "@pcms/content";
import { validateSearchDocument } from "@pcms/search";
import { THEME_CONTRACT_VERSION } from "@pcms/themes";
import { getAgentBootstrapOp } from "./agent-bootstrap-ops.js";
import {
  analyticsDoctorOp,
  getAnalyticsSettingsOp,
  listAnalyticsProvidersOp,
  saveAnalyticsSettingsOp,
} from "./analytics-ops.js";
import { submitBundle } from "./bundle.js";
import type { ApplicationServices, OperationContext } from "./context.js";
import {
  addSiteDomainOp,
  listSiteDomainsOp,
  removeSiteDomainOp,
  setPrimarySiteDomainOp,
} from "./domains-ops.js";
import { bindExternalIdentityOp, resolveExternalIdentityOp } from "./entry-identity-ops.js";
import { ApiError } from "./errors.js";
import {
  disableExtension as disableExtensionExtOp,
  enableExtension as enableExtensionExtOp,
  getCapabilities as getCapabilitiesExtOp,
  getContractVersions as getContractVersionsExtOp,
  getExtensionCompatibility as getExtensionCompatibilityExtOp,
  getUpdatePreflight as getUpdatePreflightExtOp,
  installExtension as installExtensionExtOp,
  listDeprecations as listDeprecationsExtOp,
  listExtensions as listExtensionsExtOp,
  uninstallExtension as uninstallExtensionExtOp,
} from "./extensions-ops.js";
import { API_CONTRACT_VERSION } from "./http/openapi.js";
import { encodeCursor, parsePageRequest } from "./http/pagination.js";
import { decodeInteractionCursor } from "./http/routes/interactions.js";
import { registryApplyUpdateOp } from "./http/routes/registry.js";
import { searchCapabilities } from "./http/routes/search.js";
import {
  checkIndexNowOp,
  getIndexNowSettingsOp,
  getIndexNowStatusOp,
  rotateIndexNowKeyOp,
  saveIndexNowSettingsOp,
} from "./indexnow-ops.js";
import {
  cancelIntegrationDelivery as cancelIntegrationDeliveryOp,
  createIntegrationBinding as createIntegrationBindingOp,
  createIntegrationInstance as createIntegrationInstanceOp,
  getConnectorSchema as getConnectorSchemaOp,
  getIntegrationDelivery as getIntegrationDeliveryOp,
  listConnectors as listConnectorsOp,
  listInboundEvents as listInboundEventsOp,
  listIntegrationBindings as listIntegrationBindingsOp,
  listIntegrationDeliveries as listIntegrationDeliveriesOp,
  listIntegrationInstances as listIntegrationInstancesOp,
  retryIntegrationDelivery as retryIntegrationDeliveryOp,
  testIntegrationInstance as testIntegrationInstanceOp,
  updateIntegrationBinding as updateIntegrationBindingOp,
  updateIntegrationInstance as updateIntegrationInstanceOp,
} from "./integrations-ops.js";
import {
  acceptGeneratedMediaOp,
  createMediaGenerationOp,
  getMediaGenerationOp,
  importStockCandidateOp,
  searchStockMediaOp,
} from "./media-acquisition-ops.js";
import { estimateMediaGenerationOp, getMediaProviderCapabilitiesV2Op } from "./media-model-ops.js";
import { getMediaProviderOp, listMediaProvidersOp } from "./media-provider-ops.js";
import {
  activateTheme,
  addChangesetItem,
  applyChangeset,
  archiveEntry,
  archiveMediaOp,
  cancelChangeset,
  cancelPlanItem,
  changeEntryRoute,
  cleanupEntryRevisionsOp,
  createChangeset,
  createDraft,
  createPublicationPlan,
  createThemePreview,
  deleteRevisionOp,
  getMediaUsageOp,
  importMediaUrl,
  listContentTree,
  preflightChangeset,
  previewPublicationPlan,
  publishNowOp,
  publishRevision,
  regenerateMediaVariantsOp,
  reidentifyEntryLocale,
  reschedulePlanItem,
  schedulePublicationPlan,
  sealRevision,
  searchMediaOp,
  unpublishPublication,
  updateDraft,
  updateMediaMetadataOp,
  validateEntrySeoOp,
  validateRevision,
  validateThemeOp,
} from "./operations.js";
import {
  cancelPayment as cancelPaymentOp,
  createPayment as createPaymentOp,
  getPayment as getPaymentOp,
  getPaymentProviderCapabilities as getPaymentProviderCapabilitiesOp,
  listPaymentEvents as listPaymentEventsOp,
  listPaymentProviderInstances as listPaymentProviderInstancesOp,
  listPaymentProviders as listPaymentProvidersOp,
  listPayments as listPaymentsOp,
  refundPayment as refundPaymentOp,
} from "./payments-ops.js";
import { applyRedirectImportOp, validateRedirectImportOp } from "./redirect-import-ops.js";
import {
  cleanupThemeRevisions,
  listThemeRevisions,
  rollbackTheme,
  type ThemeCleanupInput,
} from "./theme-lifecycle.js";
import {
  getActiveThemeOp,
  getThemeSourceOp,
  installThemePackageOp,
  listInstalledThemesOp,
  updateActiveThemeOp,
  validateThemePackageOp,
} from "./theme-package-ops.js";

/** Actor-visible, permission-filtered capability report (spec §20/§55). */
export function buildCapabilities(app: ApplicationServices, ctx: OperationContext) {
  const has = (permission: string, installed = true) =>
    installed && ctx.actor.permissions.has(permission);
  return {
    contract_versions: {
      api: API_CONTRACT_VERSION,
      theme: THEME_CONTRACT_VERSION,
      block_document: BLOCK_DOCUMENT_SCHEMA_VERSION,
      bundle: 1,
      pcpub: 1,
      pcmd: 1,
    },
    pcpub: {
      installed: true,
      pcpub_versions: [1, 2],
      external_entries: { supported: true, pcpub_version: 2, required_scope: "content.read" },
    },
    content: {
      installed: true,
      read: has("content.read"),
      create: has("content.create"),
      edit: has("content.edit"),
      archive: has("content.archive"),
      schema_read: has("content_schema.read"),
      rich_text: {
        readable_versions: RICHTEXT_AST_VERSIONS,
        write_version: 2,
        node_types: RICHTEXT_NODE_TYPES,
      },
    },
    blocks: { installed: true, read: has("content.read") },
    themes: {
      installed: app.themeDiscovery !== null,
      read: has("theme.read"),
      validate: has("theme.validate"),
      preview: has("theme.preview"),
      // Activation shipped with the M10 active-theme store (migration 1000):
      // available whenever a theme source is configured (aligns with REST).
      activate: has("theme.activate"),
      activation_available: app.themeDiscovery !== null,
      // Remote package cycle: export the served source, upload/validate a
      // package over REST, apply it with lifecycle CAS. No SSH/file access.
      write: has("theme.write"),
      package_cycle: app.themeDiscovery !== null,
      package_cycle_cas: true,
    },
    navigation: { installed: true, read: has("navigation.read") },
    media: {
      installed: app.mediaStorage !== null,
      read: has("media.read"),
      write: has("media.write"),
      import: has("media.import"),
    },
    seo: { installed: true, scopes: app.seoDiscovery.scopes, read: has("seo.read") },
    publication: {
      installed: true,
      read: has("publication.read"),
      plan: has("publication.plan"),
      schedule: has("publication.schedule"),
      publish: has("publication.publish"),
    },
    // M12 Forms/Quizzes/Leads: installed now; interaction PII stays out of
    // agent capability surfaces by design (Forms spec §34/§35).
    forms: {
      installed: true,
      read_definition: has("forms.read_definition"),
      manage_definition: has("forms.manage_definition"),
    },
    quizzes: {
      installed: true,
      read_definition: has("quizzes.read_definition"),
      manage_definition: has("quizzes.manage_definition"),
    },
    interactions: {
      installed: true,
      read: has("interactions.read"),
      manage: has("interactions.manage"),
      export: has("interactions.export"),
      privacy: has("privacy.manage"),
    },
    leads: {
      installed: true,
      read: has("leads.read"),
      manage: has("leads.manage"),
      export: has("leads.export"),
    },
  };
}

/**
 * The operation object handed to the MCP server. Method names are the
 * machine contract — @pcms/mcp's McpOperations interface mirrors them.
 */
export function bindOperations(app: ApplicationServices) {
  return {
    async authorizeTool(ctx: OperationContext, permission: string, site?: string) {
      await app.authorize(ctx.actor, permission);
      await app.authorization.authorizeSite(ctx.actor, site ?? app.defaultSiteKey);
    },
    listThemeRevisions: (ctx: OperationContext) => listThemeRevisions(app, ctx),
    getActiveTheme: (ctx: OperationContext) => getActiveThemeOp(app, ctx),
    exportThemeSource: (ctx: OperationContext) => getThemeSourceOp(app, ctx),
    listInstalledThemes: (ctx: OperationContext) => listInstalledThemesOp(app, ctx),
    validateThemePackage: (ctx: OperationContext, input: { package_ref: string }) =>
      validateThemePackageOp(app, ctx, input),
    installThemePackage: (ctx: OperationContext, input: { package_ref: string }) =>
      installThemePackageOp(app, ctx, input),
    updateActiveTheme: (
      ctx: OperationContext,
      input: { package_ref: string; expected_generation: number },
    ) => updateActiveThemeOp(app, ctx, input),
    activateTheme: (
      ctx: OperationContext,
      input: { theme_key: string; theme_version?: string; expected_generation: number },
    ) => activateTheme(app, ctx, input),
    rollbackTheme: (
      ctx: OperationContext,
      input: { revision_id: string; expected_generation: number },
    ) => rollbackTheme(app, ctx, input),
    cleanupThemeRevisions: (ctx: OperationContext, input: ThemeCleanupInput) =>
      cleanupThemeRevisions(app, ctx, input),
    getCurrentActor(ctx: OperationContext) {
      return {
        actor_type: ctx.actor.type,
        actor_id: ctx.actor.id,
        permissions: [...ctx.actor.permissions].sort(),
        site_key: ctx.actor.siteKey,
        environment: ctx.actor.environment,
        factors: [...ctx.actor.strength.factors],
        transport: ctx.transport,
      };
    },
    buildCapabilities(ctx: OperationContext) {
      return buildCapabilities(app, ctx);
    },
    getAgentBootstrap: (ctx: OperationContext) => getAgentBootstrapOp(app, ctx),
    resolveExternalIdentity: (ctx: OperationContext, args: Record<string, unknown>) =>
      resolveExternalIdentityOp(
        app,
        ctx,
        String(args.source_namespace),
        String(args.external_id),
        ...(args.source_hash === undefined ? [] : [{ sourceHash: String(args.source_hash) }]),
      ),
    bindExternalIdentity: (ctx: OperationContext, args: Record<string, unknown>) =>
      bindExternalIdentityOp(app, ctx, String(args.source_namespace), String(args.external_id), {
        entry_id: String(args.entry_id),
        ...(args.source_hash === undefined ? {} : { source_hash: String(args.source_hash) }),
        ...(args.last_agent_generation === undefined
          ? {}
          : { last_agent_generation: Number(args.last_agent_generation) }),
        ...(args.run_id === undefined ? {} : { run_id: String(args.run_id) }),
      }),
    // --- domain bindings + identity repair + registry (owner 2026-10-06) ---
    listSiteDomains: async (ctx: OperationContext, site?: string) => {
      app.authorize(ctx.actor, "domains.manage");
      return listSiteDomainsOp(app, site ?? app.defaultSiteKey);
    },
    addSiteDomain: async (
      ctx: OperationContext,
      input: {
        site?: string;
        hostname: string;
        is_primary?: boolean;
        locale?: string | null;
        scheme_policy?: "https" | "http";
        canonical_redirect_policy?: "redirect" | "serve";
      },
    ) => {
      app.authorize(ctx.actor, "domains.manage");
      return addSiteDomainOp(app, input.site ?? app.defaultSiteKey, input);
    },
    setPrimarySiteDomain: async (
      ctx: OperationContext,
      site: string | undefined,
      hostname: string,
    ) => {
      app.authorize(ctx.actor, "domains.manage");
      return setPrimarySiteDomainOp(app, site ?? app.defaultSiteKey, hostname);
    },
    removeSiteDomain: async (ctx: OperationContext, site: string | undefined, hostname: string) => {
      app.authorize(ctx.actor, "domains.manage");
      return removeSiteDomainOp(app, site ?? app.defaultSiteKey, hostname);
    },
    cleanupEntryRevisions: (ctx: OperationContext, input: { entry_id: string }) =>
      cleanupEntryRevisionsOp(app, ctx, input),
    reidentifyEntryLocale: (
      ctx: OperationContext,
      input: { readonly entry_id: string; readonly locale: string },
    ) => reidentifyEntryLocale(app, ctx, input),
    registryReleases: () => {
      if (app.registryClient === null) {
        throw new ApiError("REGISTRY_NOT_CONFIGURED", "registry is not configured", {
          status: 409,
        });
      }
      return app.registryClient.index();
    },
    applyRegistryUpdate: (ctx: OperationContext, version: string) => {
      if (app.registryClient === null) {
        throw new ApiError("REGISTRY_NOT_CONFIGURED", "registry is not configured", {
          status: 409,
        });
      }
      return registryApplyUpdateOp(app, ctx, version);
    },
    getServerInfo() {
      return {
        name: "progressive-cms",
        api_version: "v1",
        contract_versions: {
          api: API_CONTRACT_VERSION,
          theme: THEME_CONTRACT_VERSION,
          block_document: BLOCK_DOCUMENT_SCHEMA_VERSION,
          bundle: 1,
        },
        server_time: app.clock.now().toISOString(),
      };
    },
    // discovery
    listContentTypes: () => app.contentDiscovery.listContentTypes(),
    getContentTypeSchema: (key: string, version?: number) =>
      version === undefined
        ? app.contentDiscovery.getLatestContentTypeSchema(key)
        : app.contentDiscovery.getContentTypeSchema(key, version),
    listFieldTypes: () => app.contentDiscovery.listFieldTypes(),
    getCollectionCapabilities: () => app.contentDiscovery.getCollectionCapabilities(),
    listBlockTypes: () => app.blockDiscovery.listBlockTypes(),
    getBlockSchema: (typeId: string) => {
      const latest = app.blockDiscovery
        .listBlockTypes()
        .find((summary) => summary.typeId === typeId)
        ?.versions.at(-1);
      return latest === undefined ? null : app.blockDiscovery.getBlockSchema(typeId, latest);
    },
    getThemeContract: () =>
      app.themeDiscovery === null
        ? { available: false }
        : {
            available: true,
            contract_version: app.themeDiscovery.getThemeContractVersion(),
            theme_id: app.themeDiscovery.getThemeId(),
            ...app.themeDiscovery.describeTheme(),
          },
    listNavigationSets: () => app.navigationDiscovery.listNavigationSets(),
    getNavigationTree: (setRef: string) => app.navigationDiscovery.getNavigationTree(setRef),
    listPlacementBindings: () => app.navigationDiscovery.getPlacementBindings(),
    listMediaPresets: () => app.mediaPresets.listPresets(),
    searchMedia: (
      ctx: OperationContext,
      query: { text?: string; kind?: string; limit?: number; cursor?: string },
    ) =>
      searchMediaOp(app, ctx, {
        ...query,
        ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
      }),
    getMediaUsage: (ctx: OperationContext, id: string) => getMediaUsageOp(app, ctx, id),
    regenerateMediaVariants: (ctx: OperationContext, id: string) =>
      regenerateMediaVariantsOp(app, ctx, { media_id: id }),
    archiveMedia: (ctx: OperationContext, id: string) => archiveMediaOp(app, ctx, { media_id: id }),
    validateEntrySeo: (ctx: OperationContext, id: string) => validateEntrySeoOp(app, ctx, id),
    listSeoEntries: (ctx: OperationContext, query: { limit?: number; cursor?: string }) =>
      listContentTree(app, ctx, {
        limit: String(query.limit ?? 100),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      }),
    changeEntryRoute: (
      ctx: OperationContext,
      input: { entry_id: string; to_path: string; reason?: string },
    ) => changeEntryRoute(app, ctx, input),
    searchQuery: (input: Parameters<ApplicationServices["searchQuery"]>[0]) =>
      app.searchQuery(input),
    searchAdmin: (input: Parameters<ApplicationServices["searchAdmin"]>[0]) =>
      app.searchAdmin(input),
    getIndexNowSettings: (ctx: OperationContext) => getIndexNowSettingsOp(app, ctx),
    updateIndexNowSettings: (
      ctx: OperationContext,
      input: { settings: { enabled: boolean }; expected_generation: number },
    ) =>
      saveIndexNowSettingsOp(app, ctx, {
        settings: { enabled: input.settings.enabled },
        expected_generation: input.expected_generation,
      }),
    getIndexNowStatus: () => getIndexNowStatusOp(app),
    checkIndexNow: (ctx: OperationContext) => checkIndexNowOp(app, ctx),
    rotateIndexNowKey: (ctx: OperationContext) => rotateIndexNowKeyOp(app, ctx),
    getAnalyticsSettings: (ctx: OperationContext) => getAnalyticsSettingsOp(app, ctx),
    updateAnalyticsSettings: (
      ctx: OperationContext,
      input: { settings: unknown; expected_generation: number },
    ) => saveAnalyticsSettingsOp(app, ctx, input),
    listAnalyticsProviders: () => listAnalyticsProvidersOp(app),
    runAnalyticsDoctor: (ctx: OperationContext) => analyticsDoctorOp(app, ctx),
    getSearchStatus: async () => {
      const health = await app.searchProvider.health();
      return { health, reindex_runs: await app.searchReindex.listRuns() };
    },
    getSearchCapabilities: () => searchCapabilities(),
    listForms: (ctx: OperationContext, input: { status?: "ACTIVE" | "ARCHIVED" }) => {
      app.authorize(ctx.actor, "forms.read_definition");
      return app.formsSource.domain.definitions.listDefinitions(input ?? {});
    },
    getFormDefinition: (ctx: OperationContext, formId: string) => {
      app.authorize(ctx.actor, "forms.read_definition");
      return app.formsSource.domain.definitions.getDefinition(formId);
    },
    listQuizzes: (ctx: OperationContext, input: { status?: "ACTIVE" | "ARCHIVED" }) => {
      app.authorize(ctx.actor, "quizzes.read_definition");
      return app.formsSource.domain.quizzes.listDefinitions(input ?? {});
    },
    getQuizDefinition: (ctx: OperationContext, quizId: string) => {
      app.authorize(ctx.actor, "quizzes.read_definition");
      return app.formsSource.domain.quizzes.getDefinition(quizId);
    },
    previewInteractionPrivacy: (ctx: OperationContext, input: PrivacyOperation) =>
      previewInteractionPrivacy(app, ctx, input),
    applyInteractionPrivacy: (ctx: OperationContext, input: Omit<PrivacyApplyInput, "actor">) =>
      applyInteractionPrivacy(app, ctx, input),
    getInteractionPrivacyCase: (ctx: OperationContext, caseId: string) =>
      getInteractionPrivacyCase(app, ctx, caseId),
    acknowledgeInteractionPrivacy: (
      ctx: OperationContext,
      caseId: string,
      deliveryId: string,
      input: Omit<PrivacyAcknowledgement, "actor">,
    ) => acknowledgeInteractionPrivacy(app, ctx, caseId, deliveryId, input),
    listSubmissions: (
      ctx: OperationContext,
      input: { form_definition_id?: string; status?: string; limit?: number; cursor?: string },
    ) => {
      app.authorize(ctx.actor, "interactions.read");
      return app.formsSource.domain.submissions
        .listSubmissions({
          ...(input.form_definition_id === undefined
            ? {}
            : { form_definition_id: input.form_definition_id }),
          ...(input.status === undefined
            ? {}
            : { status: input.status as "ACCEPTED" | "SPAM" | "ARCHIVED" }),
          ...decodeInteractionCursor(input.cursor ?? null),
          limit: Math.min(Math.max(input.limit ?? 20, 1), 100),
        })
        .then((rows) => ({
          items: rows,
          next_cursor:
            rows.length > 0
              ? encodeCursor(rows[rows.length - 1]!.submitted_at, rows[rows.length - 1]!.id)
              : null,
        }));
    },
    getSubmission: (ctx: OperationContext, submissionId: string) => {
      app.authorize(ctx.actor, "interactions.read");
      return app.formsSource.domain.submissions.getSubmission(submissionId);
    },
    listQuizRuns: (
      ctx: OperationContext,
      input: { quiz_definition_id?: string; state?: string; limit?: number; cursor?: string },
    ) => {
      app.authorize(ctx.actor, "interactions.read");
      return app.formsSource.domain.runs
        .listRuns({
          ...(input.quiz_definition_id === undefined
            ? {}
            : { quiz_definition_id: input.quiz_definition_id }),
          ...(input.state === undefined
            ? {}
            : { state: input.state as "STARTED" | "COMPLETED" | "ABANDONED" | "EXPIRED" }),
          ...decodeInteractionCursor(input.cursor ?? null),
          limit: Math.min(Math.max(input.limit ?? 20, 1), 100),
        })
        .then((rows) => ({
          items: rows,
          next_cursor:
            rows.length > 0
              ? encodeCursor(rows[rows.length - 1]!.started_at, rows[rows.length - 1]!.id)
              : null,
        }));
    },
    getQuizRun: async (ctx: OperationContext, runId: string) => {
      app.authorize(ctx.actor, "interactions.read");
      const run = await app.formsSource.domain.runs.getRun(runId);
      return { ...run, answers: await app.formsSource.domain.runs.listAnswers(runId) };
    },
    listLeads: (
      ctx: OperationContext,
      input: { status?: string; limit?: number; cursor?: string },
    ) => {
      app.authorize(ctx.actor, "leads.read");
      return app.formsSource.domain.leads
        .listLeads({
          ...(input.status === undefined ? {} : { status: input.status as never }),
          ...decodeInteractionCursor(input.cursor ?? null),
          limit: Math.min(Math.max(input.limit ?? 20, 1), 100),
        })
        .then((rows) => ({
          items: rows,
          next_cursor:
            rows.length > 0
              ? encodeCursor(rows[rows.length - 1]!.created_at, rows[rows.length - 1]!.id)
              : null,
        }));
    },
    updateLeadStatus: (ctx: OperationContext, input: { lead_id: string; status: string }) => {
      app.authorize(ctx.actor, "leads.manage");
      return app.formsSource.setLeadStatus({
        lead_id: input.lead_id,
        status: input.status as "NEW" | "VIEWED" | "PROCESSED" | "ARCHIVED" | "SPAM",
      });
    },
    exportInteractions: (ctx: OperationContext, input: Record<string, unknown>) => {
      const entity = input["entity"];
      app.authorize(ctx.actor, entity === "leads" ? "leads.export" : "interactions.export");
      return app.formsSource.export.export(
        {
          entity: entity as "submissions" | "quiz_runs" | "leads",
          format: (input["format"] ?? "json") as "csv" | "json",
          ...(typeof input["form_definition_id"] === "string"
            ? { form_definition_id: input["form_definition_id"] as string }
            : {}),
          ...(typeof input["status"] === "string" ? { status: input["status"] as string } : {}),
          limit: typeof input["limit"] === "number" ? input["limit"] : 500,
        },
        { actor_type: ctx.actor.type, actor_id: ctx.actor.id },
      );
    },
    getQuizPublicSchema: (ctx: OperationContext, quizId: string) => {
      app.authorize(ctx.actor, "quizzes.read_definition");
      return app.formsSource.publicQuiz.getPublicSchema(quizId);
    },
    validateSearchDocument: async (input: { entity_type: string; entity_id: string }) => {
      const document = await app.searchSource.buildDocument(input.entity_type, input.entity_id);
      if (document === null) {
        return {
          entity_type: input.entity_type,
          entity_id: input.entity_id,
          indexable: false,
          issues: [],
        };
      }
      return {
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        indexable: true,
        issues: validateSearchDocument(document),
      };
    },
    reindexSearch: (input: { resume?: boolean }) =>
      app.searchReindex.start({ resume: input.resume === true }),
    listSearchReindexRuns: () => app.searchReindex.listRuns(),
    getMedia: async (mediaId: string) => app.mediaDiscovery.inspectAsset(mediaId),
    getSeoSchema: () => app.seoDiscovery.getSeoSchema(),
    getSiteInfo: async () => {
      const site = await app.routes.findSiteByKey(app.defaultSiteKey);
      if (site === null) return null;
      const policy = await app.routes.getPolicy(site.id);
      const domains = await app.domains.listDomainBindings(site.id);
      return {
        site: { id: site.id, key: site.key, title: site.title },
        route_policy: policy,
        domains: domains.map((binding) => ({
          hostname: binding.hostname,
          is_primary: binding.isPrimary,
        })),
      };
    },
    checkRouteAvailable: (path: string) => app.routingDiscovery.checkRouteAvailable(path),
    // publication discovery
    listRevisions: async (entityType: string, entityId: string) =>
      app.revisions.listRevisions(app.pool, entityType, entityId as never, { limit: 100 }),
    getRevision: async (revisionId: string) =>
      app.revisions.getRevision(app.pool, revisionId as never),
    listChangesets: () => app.changesets.listChangesets({ limit: 100 }),
    getChangeset: async (changesetId: string) => {
      const changeset = await app.changesets.getChangeset(changesetId as never);
      const items = await app.changesets.listItems(changeset.id);
      return { changeset, items };
    },
    getPublication: async (entityType: string, entityId: string) =>
      app.publications.getPublication(app.pool, entityType, entityId as never),
    listPublicationCalendar: (input: { from?: string; to?: string }) =>
      app.calendar.listCalendar({
        ...(input.from === undefined ? {} : { from: new Date(input.from) }),
        ...(input.to === undefined ? {} : { to: new Date(input.to) }),
        limit: 100,
      }),
    // mutations (the SAME operations the REST routes call)
    createDraft: (ctx: OperationContext, input: Parameters<typeof createDraft>[2]) =>
      createDraft(app, ctx, input),
    updateDraft: (ctx: OperationContext, input: Parameters<typeof updateDraft>[2]) =>
      updateDraft(app, ctx, input),
    validateRevision: (ctx: OperationContext, input: Parameters<typeof validateRevision>[2]) =>
      validateRevision(app, ctx, input),
    sealRevision: (ctx: OperationContext, input: Parameters<typeof sealRevision>[2]) =>
      sealRevision(app, ctx, input),
    deleteRevision: (ctx: OperationContext, input: { revision_id: string }) =>
      deleteRevisionOp(app, ctx, input),
    archiveEntry: (ctx: OperationContext, input: Parameters<typeof archiveEntry>[2]) =>
      archiveEntry(app, ctx, input),
    createChangeset: (ctx: OperationContext, input: { title: string }) =>
      createChangeset(app, ctx, input),
    addChangesetItem: (ctx: OperationContext, input: Parameters<typeof addChangesetItem>[2]) =>
      addChangesetItem(app, ctx, input),
    preflightChangeset: (ctx: OperationContext, input: { changeset_id: string }) =>
      preflightChangeset(app, ctx, input),
    applyChangeset: (ctx: OperationContext, input: { changeset_id: string }) =>
      applyChangeset(app, ctx, input),
    cancelChangeset: (ctx: OperationContext, input: { changeset_id: string }) =>
      cancelChangeset(app, ctx, input),
    createPlan: (ctx: OperationContext, input: Parameters<typeof createPublicationPlan>[2]) =>
      createPublicationPlan(app, ctx, input),
    previewPlan: (ctx: OperationContext, input: Parameters<typeof previewPublicationPlan>[2]) =>
      previewPublicationPlan(app, ctx, input),
    schedulePlan: (ctx: OperationContext, input: Parameters<typeof schedulePublicationPlan>[2]) =>
      schedulePublicationPlan(app, ctx, input),
    reschedulePlanItem: (
      ctx: OperationContext,
      input: { plan_id: string; item_id: string; publish_at: string },
    ) => reschedulePlanItem(app, ctx, input),
    cancelPlanItem: (ctx: OperationContext, input: { plan_id: string; item_id: string }) =>
      cancelPlanItem(app, ctx, input),
    publishNow: (ctx: OperationContext, input: { plan_id: string; item_id: string }) =>
      publishNowOp(app, ctx, input),
    publishRevision: (ctx: OperationContext, input: Parameters<typeof publishRevision>[2]) =>
      publishRevision(app, ctx, input),
    unpublishPublication: (
      ctx: OperationContext,
      input: Parameters<typeof unpublishPublication>[2],
    ) => unpublishPublication(app, ctx, input),
    updateMediaMetadata: (
      ctx: OperationContext,
      input: Parameters<typeof updateMediaMetadataOp>[2],
    ) => updateMediaMetadataOp(app, ctx, input),
    createPreview: (ctx: OperationContext, input: Parameters<typeof createThemePreview>[2]) =>
      createThemePreview(app, ctx, input),
    validateTheme: (ctx: OperationContext) => validateThemeOp(app, ctx),
    submitBundle: (
      ctx: OperationContext,
      bundle: Record<string, unknown>,
      mode: "validate" | "apply",
    ) => submitBundle(app, ctx, bundle, mode),
    // integrations (M13) — the SAME audited application operations as REST
    listConnectors: (ctx: OperationContext) => listConnectorsOp(app, ctx),
    getConnectorSchema: (ctx: OperationContext, input: { connector_type: string }) =>
      getConnectorSchemaOp(app, ctx, input),
    listIntegrationInstances: (ctx: OperationContext, input?: { connector_type?: string }) =>
      listIntegrationInstancesOp(app, ctx, input ?? {}),
    createIntegrationInstance: (ctx: OperationContext, input: unknown) =>
      createIntegrationInstanceOp(app, ctx, input as never),
    updateIntegrationInstance: (ctx: OperationContext, input: unknown) =>
      updateIntegrationInstanceOp(app, ctx, input as never),
    testIntegrationInstance: (ctx: OperationContext, input: { instance_id: string }) =>
      testIntegrationInstanceOp(app, ctx, input),
    listIntegrationBindings: (ctx: OperationContext) => listIntegrationBindingsOp(app, ctx),
    createIntegrationBinding: (ctx: OperationContext, input: unknown) =>
      createIntegrationBindingOp(app, ctx, input as never),
    updateIntegrationBinding: (
      ctx: OperationContext,
      input: { binding_id: string; patch: unknown },
    ) => updateIntegrationBindingOp(app, ctx, input as never),
    listIntegrationDeliveries: (
      ctx: OperationContext,
      input?: { status?: string; limit?: number },
    ) => listIntegrationDeliveriesOp(app, ctx, input ?? {}),
    getIntegrationDelivery: (ctx: OperationContext, input: { delivery_id: string }) =>
      getIntegrationDeliveryOp(app, ctx, input),
    retryIntegrationDelivery: (ctx: OperationContext, input: { delivery_id: string }) =>
      retryIntegrationDeliveryOp(app, ctx, input),
    cancelIntegrationDelivery: (ctx: OperationContext, input: { delivery_id: string }) =>
      cancelIntegrationDeliveryOp(app, ctx, input),
    listInboundEvents: (
      ctx: OperationContext,
      input?: { source_id?: string; status?: string; limit?: number },
    ) => listInboundEventsOp(app, ctx, input ?? {}),
    // extensions (M14) — the same audited application operations as REST
    getContractVersions: (ctx: OperationContext) => getContractVersionsExtOp(app, ctx),
    getCapabilities: (ctx: OperationContext) => getCapabilitiesExtOp(app, ctx),
    listExtensions: (ctx: OperationContext) => listExtensionsExtOp(app, ctx),
    getExtensionCompatibility: (ctx: OperationContext, input: { extension_id: string }) =>
      getExtensionCompatibilityExtOp(app, ctx, input),
    getUpdatePreflight: (ctx: OperationContext) => getUpdatePreflightExtOp(app, ctx),
    listDeprecations: (ctx: OperationContext) => listDeprecationsExtOp(app, ctx),
    installExtension: (ctx: OperationContext, input: { extension_id: string }) =>
      installExtensionExtOp(app, ctx, input),
    enableExtension: (ctx: OperationContext, input: { extension_id: string }) =>
      enableExtensionExtOp(app, ctx, input),
    disableExtension: (ctx: OperationContext, input: { extension_id: string }) =>
      disableExtensionExtOp(app, ctx, input),
    uninstallExtension: (
      ctx: OperationContext,
      input: { extension_id: string; confirmation?: string },
    ) => uninstallExtensionExtOp(app, ctx, input),
    // ADR-0013: typed extension application operations — the exact service
    // the generic REST route calls; permission enforced inside.
    // media acquisition (ADR-0013) — provider-neutral, same ops as REST
    listMediaProviders: (ctx: OperationContext) => listMediaProvidersOp(app, ctx),
    getMediaProvider: (ctx: OperationContext, input: { provider_id: string }) =>
      getMediaProviderOp(app, ctx, input),
    // Image Generation v2 (plan T2.5): capability + estimate surfaces, and
    // the agent count clamp (owner decision: one image per agent call).
    getMediaProviderCapabilities: (ctx: OperationContext, input: { provider_id: string }) =>
      getMediaProviderCapabilitiesV2Op(app, ctx, input),
    estimateMediaGeneration: (ctx: OperationContext, input: Record<string, unknown>) =>
      estimateMediaGenerationOp(app, ctx, input as never),
    validateRedirectImport: (ctx: OperationContext, input: Record<string, unknown>) =>
      validateRedirectImportOp(app, ctx, input as never),
    applyRedirectImport: (ctx: OperationContext, input: Record<string, unknown>) =>
      applyRedirectImportOp(app, ctx, input as never),
    importMediaUrl: (ctx: OperationContext, input: Record<string, unknown>) =>
      importMediaUrl(app, ctx, input as never),
    createMediaGeneration: (
      ctx: OperationContext,
      input: { prompt: string } & Record<string, unknown>,
    ) =>
      createMediaGenerationOp(app, ctx, {
        ...input,
        count: 1,
      } as never),
    searchStockMedia: (ctx: OperationContext, input: { query: string } & Record<string, unknown>) =>
      searchStockMediaOp(app, ctx, input as never),
    importStockCandidate: (ctx: OperationContext, input: { candidate_ref: string }) =>
      importStockCandidateOp(app, ctx, input),
    getMediaGeneration: (ctx: OperationContext, input: { generation_id: string }) =>
      getMediaGenerationOp(app, ctx, input),
    acceptGeneratedMedia: (
      ctx: OperationContext,
      input: { generation_id: string; candidate_index: number },
    ) => acceptGeneratedMediaOp(app, ctx, input),
    invokeExtensionOperation: (
      ctx: OperationContext,
      args: { extension_id: string; operation_id: string; input: unknown },
    ) =>
      app.extensionOperations
        .invoke(app, ctx, args.extension_id, args.operation_id, args.input)
        .then((result) => ({
          extension_id: args.extension_id,
          operation_id: args.operation_id,
          result,
        })),
    // payments (M13) — the same audited application operations as REST
    listPaymentProviders: (ctx: OperationContext) => listPaymentProvidersOp(app, ctx),
    listPaymentProviderInstances: (ctx: OperationContext) =>
      listPaymentProviderInstancesOp(app, ctx),
    getPaymentProviderCapabilities: (ctx: OperationContext, input: { provider_type: string }) =>
      getPaymentProviderCapabilitiesOp(app, ctx, input),
    createPayment: (ctx: OperationContext, input: unknown) =>
      createPaymentOp(app, ctx, input as never),
    getPayment: (ctx: OperationContext, input: { payment_id: string }) =>
      getPaymentOp(app, ctx, input),
    listPayments: (
      ctx: OperationContext,
      input?: { status?: string; subject_type?: string; limit?: number },
    ) => listPaymentsOp(app, ctx, input ?? {}),
    cancelPayment: (ctx: OperationContext, input: { payment_id: string }) =>
      cancelPaymentOp(app, ctx, input),
    refundPayment: (
      ctx: OperationContext,
      input: { payment_id: string; amount?: number; reason?: string },
    ) => refundPaymentOp(app, ctx, input),
    listPaymentEvents: (ctx: OperationContext, input: { payment_id: string }) =>
      listPaymentEventsOp(app, ctx, input),
  };
}
