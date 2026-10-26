// Structural operation interface consumed by the MCP tools (PCMS-API-T019).
//
// This package must not import other @pcms packages (architecture map: L2
// transports never import each other). The composition root (apps/web) binds
// the @pcms/api application surface into THIS shape; TypeScript verifies the
// match there. Method names mirror the application operations so REST and MCP
// cannot drift (API spec §46).

/** The subset of ActorContext the tools see (no secrets, no internals). */
export interface OperationContextLike {
  readonly actor: {
    readonly type: string;
    readonly id: string;
    readonly permissions: ReadonlySet<string>;
    readonly siteKey: string | null;
    readonly environment: string | null;
  };
  readonly transport: string;
  readonly requestId: string;
}

/** The bound application operations the tools call.
 * Method syntax is deliberate: it keeps parameter checking bivariant, so the
 * composition root can bind @pcms/api's precisely-typed operations into this
 * interface without a cast, while tool handlers may pass structural inputs. */
export interface PrivacyOperationInput {
  readonly target: { readonly entity: "submission" | "quiz_run" | "lead"; readonly id: string };
  readonly action: "rectify" | "block" | "unblock" | "erase";
  readonly correction?: {
    readonly submission_payload?: Readonly<Record<string, unknown>>;
    readonly quiz_answers?: readonly { readonly question_id: string; readonly value: unknown }[];
  };
}

export interface McpOperations {
  previewInteractionPrivacy(
    ctx: OperationContextLike,
    input: PrivacyOperationInput,
  ): Promise<unknown>;
  applyInteractionPrivacy(
    ctx: OperationContextLike,
    input: PrivacyOperationInput & {
      readonly request_id: string;
      readonly expected_token: string;
      readonly request_ref?: string;
    },
  ): Promise<unknown>;
  getInteractionPrivacyCase(ctx: OperationContextLike, caseId: string): Promise<unknown>;
  acknowledgeInteractionPrivacy(
    ctx: OperationContextLike,
    caseId: string,
    deliveryId: string,
    input: {
      readonly decision: "acknowledged" | "owner_exception";
      readonly evidence_ref?: string;
    },
  ): Promise<unknown>;
  listThemeRevisions(ctx: OperationContextLike): Promise<unknown>;
  // Remote theme package cycle: binary bytes travel over REST, MCP carries
  // only refs, identity and CAS generations.
  getActiveTheme(ctx: OperationContextLike): Promise<unknown>;
  exportThemeSource(ctx: OperationContextLike): Promise<unknown>;
  listInstalledThemes(ctx: OperationContextLike): Promise<unknown>;
  validateThemePackage(
    ctx: OperationContextLike,
    input: { readonly package_ref: string },
  ): Promise<unknown>;
  installThemePackage(
    ctx: OperationContextLike,
    input: { readonly package_ref: string },
  ): Promise<unknown>;
  updateActiveTheme(
    ctx: OperationContextLike,
    input: { readonly package_ref: string; readonly expected_generation: number },
  ): Promise<unknown>;
  activateTheme(
    ctx: OperationContextLike,
    input: {
      readonly theme_key: string;
      readonly theme_version?: string;
      readonly expected_generation: number;
    },
  ): Promise<unknown>;
  rollbackTheme(
    ctx: OperationContextLike,
    input: { readonly revision_id: string; readonly expected_generation: number },
  ): Promise<unknown>;
  cleanupThemeRevisions(
    ctx: OperationContextLike,
    input: {
      dry_run?: boolean;
      keep_last?: number;
      older_than_days?: number;
      expected_generation?: number;
      revision_ids?: readonly string[];
    },
  ): Promise<unknown>;
  /** Trusted application permission gate; absence fails closed for protected tools. */
  authorizeTool?(
    ctx: OperationContextLike,
    permission: string,
    site?: string,
  ): void | Promise<void>;
  listSiteDomains(ctx: OperationContextLike, site?: string): Promise<unknown>;
  addSiteDomain(ctx: OperationContextLike, args: Record<string, unknown>): Promise<unknown>;
  setPrimarySiteDomain(
    ctx: OperationContextLike,
    site: string | undefined,
    hostname: string,
  ): Promise<unknown>;
  removeSiteDomain(
    ctx: OperationContextLike,
    site: string | undefined,
    hostname: string,
  ): Promise<unknown>;
  reidentifyEntryLocale(
    ctx: OperationContextLike,
    input: { readonly entry_id: string; readonly locale: string },
  ): Promise<unknown>;
  cleanupEntryRevisions(ctx: OperationContextLike, input: { entry_id: string }): Promise<unknown>;
  registryReleases(): Promise<unknown>;
  applyRegistryUpdate(ctx: OperationContextLike, version: string): Promise<unknown>;
  getCurrentActor(ctx: OperationContextLike): unknown;
  getAgentBootstrap(ctx: OperationContextLike): unknown;
  resolveExternalIdentity(
    ctx: OperationContextLike,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  bindExternalIdentity(ctx: OperationContextLike, args: Record<string, unknown>): Promise<unknown>;
  buildCapabilities(ctx: OperationContextLike): unknown;
  getServerInfo(): unknown;
  getSiteInfo(): Promise<unknown>;
  listContentTypes(): unknown;
  getContentTypeSchema(key: string, version?: number): unknown;
  listFieldTypes(): unknown;
  getCollectionCapabilities(): unknown;
  listBlockTypes(): unknown;
  getBlockSchema(typeId: string): unknown;
  getThemeContract(): unknown;
  listNavigationSets(): Promise<unknown>;
  getNavigationTree(setRef: string): Promise<unknown>;
  listPlacementBindings(): Promise<unknown>;
  listMediaPresets(): unknown;
  searchMedia(
    ctx: OperationContextLike,
    query: { text?: string; kind?: string; limit?: number; cursor?: string },
  ): Promise<unknown>;
  getMediaUsage(ctx: OperationContextLike, id: string): Promise<unknown>;
  regenerateMediaVariants(ctx: OperationContextLike, id: string): Promise<unknown>;
  archiveMedia(ctx: OperationContextLike, id: string): Promise<unknown>;
  validateEntrySeo(ctx: OperationContextLike, id: string): Promise<unknown>;
  listSeoEntries(
    ctx: OperationContextLike,
    query: { limit?: number; cursor?: string },
  ): Promise<unknown>;
  changeEntryRoute(
    ctx: OperationContextLike,
    input: { entry_id: string; to_path: string; reason?: string },
  ): Promise<unknown>;
  searchQuery(input: {
    q: string;
    locale: string;
    site?: string;
    content_type?: string;
    date_from?: string;
    date_to?: string;
    sort?: string;
    limit?: number;
    cursor?: string;
  }): Promise<unknown>;
  searchAdmin(input: {
    q: string;
    locale: string;
    site?: string;
    limit?: number;
  }): Promise<unknown>;
  getIndexNowSettings(ctx: unknown): Promise<unknown>;
  updateIndexNowSettings(
    ctx: unknown,
    input: { settings: { enabled: boolean }; expected_generation: number },
  ): Promise<unknown>;
  getIndexNowStatus(): Promise<unknown>;
  checkIndexNow(ctx: unknown): Promise<unknown>;
  rotateIndexNowKey(ctx: unknown): Promise<unknown>;
  getAnalyticsSettings(ctx: unknown): Promise<unknown>;
  updateAnalyticsSettings(
    ctx: unknown,
    input: { settings: unknown; expected_generation: number },
  ): Promise<unknown>;
  listAnalyticsProviders(): Promise<unknown>;
  runAnalyticsDoctor(ctx: unknown): Promise<unknown>;
  getSearchStatus(): Promise<unknown>;
  getSearchCapabilities(): unknown;
  validateSearchDocument(input: { entity_type: string; entity_id: string }): Promise<unknown>;
  reindexSearch(input: { resume?: boolean }): Promise<unknown>;
  listSearchReindexRuns(): Promise<unknown>;
  listForms(ctx: OperationContextLike, input: { status?: string }): Promise<unknown>;
  getFormDefinition(ctx: OperationContextLike, formId: string): Promise<unknown>;
  listQuizzes(ctx: OperationContextLike, input: { status?: string }): Promise<unknown>;
  getQuizDefinition(ctx: OperationContextLike, quizId: string): Promise<unknown>;
  getQuizPublicSchema(ctx: OperationContextLike, quizId: string): Promise<unknown>;
  listSubmissions(
    ctx: OperationContextLike,
    input: { form_definition_id?: string; status?: string; limit?: number; cursor?: string },
  ): Promise<unknown>;
  getSubmission(ctx: OperationContextLike, submissionId: string): Promise<unknown>;
  listQuizRuns(
    ctx: OperationContextLike,
    input: { quiz_definition_id?: string; state?: string; limit?: number; cursor?: string },
  ): Promise<unknown>;
  getQuizRun(ctx: OperationContextLike, runId: string): Promise<unknown>;
  listLeads(
    ctx: OperationContextLike,
    input: { status?: string; limit?: number; cursor?: string },
  ): Promise<unknown>;
  updateLeadStatus(
    ctx: OperationContextLike,
    input: { lead_id: string; status: string },
  ): Promise<unknown>;
  exportInteractions(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  getMedia(mediaId: string): Promise<unknown>;
  getSeoSchema(): unknown;
  checkRouteAvailable(path: string): Promise<unknown>;
  listRevisions(entityType: string, entityId: string): Promise<unknown>;
  getRevision(revisionId: string): Promise<unknown>;
  listChangesets(): Promise<unknown>;
  getChangeset(changesetId: string): Promise<unknown>;
  getPublication(entityType: string, entityId: string): Promise<unknown>;
  listPublicationCalendar(input: { from?: string; to?: string }): Promise<unknown>;
  createDraft(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  updateDraft(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  validateRevision(ctx: OperationContextLike, input: { revision_id: string }): Promise<unknown>;
  sealRevision(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  deleteRevision(ctx: OperationContextLike, input: { revision_id: string }): Promise<unknown>;
  archiveEntry(ctx: OperationContextLike, input: { entry_id: string }): Promise<unknown>;
  createChangeset(ctx: OperationContextLike, input: { title: string }): Promise<unknown>;
  addChangesetItem(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  preflightChangeset(ctx: OperationContextLike, input: { changeset_id: string }): Promise<unknown>;
  applyChangeset(ctx: OperationContextLike, input: { changeset_id: string }): Promise<unknown>;
  cancelChangeset(ctx: OperationContextLike, input: { changeset_id: string }): Promise<unknown>;
  createPlan(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  previewPlan(
    ctx: OperationContextLike,
    input: { plan_id: string; spec: unknown; overrides?: readonly unknown[] },
  ): Promise<unknown>;
  schedulePlan(
    ctx: OperationContextLike,
    input: { plan_id: string; spec: unknown; overrides?: readonly unknown[] },
  ): Promise<unknown>;
  reschedulePlanItem(
    ctx: OperationContextLike,
    input: { plan_id: string; item_id: string; publish_at: string },
  ): Promise<unknown>;
  cancelPlanItem(
    ctx: OperationContextLike,
    input: { plan_id: string; item_id: string },
  ): Promise<unknown>;
  publishNow(
    ctx: OperationContextLike,
    input: { plan_id: string; item_id: string },
  ): Promise<unknown>;
  publishRevision(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  unpublishPublication(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  updateMediaMetadata(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  createPreview(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  validateTheme(ctx: OperationContextLike): Promise<unknown>;
  listConnectors(ctx: OperationContextLike): unknown;
  getConnectorSchema(ctx: OperationContextLike, input: { connector_type: string }): unknown;
  listIntegrationInstances(
    ctx: OperationContextLike,
    input?: { connector_type?: string },
  ): Promise<unknown>;
  createIntegrationInstance(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  updateIntegrationInstance(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  testIntegrationInstance(
    ctx: OperationContextLike,
    input: { instance_id: string },
  ): Promise<unknown>;
  listIntegrationBindings(ctx: OperationContextLike): Promise<unknown>;
  createIntegrationBinding(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  updateIntegrationBinding(
    ctx: OperationContextLike,
    input: { binding_id: string; patch: unknown },
  ): Promise<unknown>;
  listIntegrationDeliveries(
    ctx: OperationContextLike,
    input?: { status?: string; limit?: number },
  ): Promise<unknown>;
  getIntegrationDelivery(
    ctx: OperationContextLike,
    input: { delivery_id: string },
  ): Promise<unknown>;
  retryIntegrationDelivery(
    ctx: OperationContextLike,
    input: { delivery_id: string },
  ): Promise<unknown>;
  cancelIntegrationDelivery(
    ctx: OperationContextLike,
    input: { delivery_id: string },
  ): Promise<unknown>;
  listInboundEvents(
    ctx: OperationContextLike,
    input?: { source_id?: string; status?: string; limit?: number },
  ): Promise<unknown>;
  // extensions (M14) — machine discovery + privileged lifecycle
  getContractVersions(ctx: OperationContextLike): Promise<unknown>;
  getCapabilities(ctx: OperationContextLike): Promise<unknown>;
  listExtensions(ctx: OperationContextLike): Promise<unknown>;
  getExtensionCompatibility(
    ctx: OperationContextLike,
    input: { extension_id: string },
  ): Promise<unknown>;
  getUpdatePreflight(ctx: OperationContextLike): Promise<unknown>;
  listDeprecations(ctx: OperationContextLike): Promise<unknown>;
  installExtension(ctx: OperationContextLike, input: { extension_id: string }): Promise<unknown>;
  enableExtension(ctx: OperationContextLike, input: { extension_id: string }): Promise<unknown>;
  disableExtension(ctx: OperationContextLike, input: { extension_id: string }): Promise<unknown>;
  uninstallExtension(
    ctx: OperationContextLike,
    input: { extension_id: string; confirmation?: string },
  ): Promise<unknown>;
  // media acquisition (ADR-0013) — provider-neutral, same ops as REST
  listMediaProviders(ctx: OperationContextLike): Promise<unknown>;
  getMediaProvider(ctx: OperationContextLike, input: { provider_id: string }): Promise<unknown>;
  // Image Generation v2 (plan T2.5): agent-safe capability + cost surfaces.
  getMediaProviderCapabilities(
    ctx: OperationContextLike,
    input: { provider_id: string },
  ): Promise<unknown>;
  estimateMediaGeneration(
    ctx: OperationContextLike,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  // Site migrations (Navigation spec §33/§60): bulk legacy-URL redirects.
  validateRedirectImport(
    ctx: OperationContextLike,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  applyRedirectImport(ctx: OperationContextLike, input: Record<string, unknown>): Promise<unknown>;
  // Managed image pull (media.import): SSRF-safe fetch → sha256-deduped library
  // import → variants. Site migrations reuse it per source URL.
  importMediaUrl(ctx: OperationContextLike, input: { url: string }): Promise<unknown>;
  searchStockMedia(ctx: OperationContextLike, input: Record<string, unknown>): Promise<unknown>;
  importStockCandidate(
    ctx: OperationContextLike,
    input: { candidate_ref: string },
  ): Promise<unknown>;
  createMediaGeneration(
    ctx: OperationContextLike,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  getMediaGeneration(ctx: OperationContextLike, input: { generation_id: string }): Promise<unknown>;
  acceptGeneratedMedia(
    ctx: OperationContextLike,
    input: { generation_id: string; candidate_index: number },
  ): Promise<unknown>;
  // ADR-0013 §52.3: typed extension application operations, exposed as
  // derived cms_ext_* tools; permission enforcement lives in the operation.
  invokeExtensionOperation(
    ctx: OperationContextLike,
    input: { extension_id: string; operation_id: string; input: unknown },
  ): Promise<unknown>;
  listPaymentProviders(ctx: OperationContextLike): unknown;
  listPaymentProviderInstances(ctx: OperationContextLike): Promise<unknown>;
  getPaymentProviderCapabilities(
    ctx: OperationContextLike,
    input: { provider_type: string },
  ): unknown;
  createPayment(ctx: OperationContextLike, input: unknown): Promise<unknown>;
  getPayment(ctx: OperationContextLike, input: { payment_id: string }): Promise<unknown>;
  listPayments(
    ctx: OperationContextLike,
    input?: { status?: string; subject_type?: string; limit?: number },
  ): Promise<unknown>;
  cancelPayment(ctx: OperationContextLike, input: { payment_id: string }): Promise<unknown>;
  refundPayment(
    ctx: OperationContextLike,
    input: { payment_id: string; amount?: number; reason?: string },
  ): Promise<unknown>;
  listPaymentEvents(ctx: OperationContextLike, input: { payment_id: string }): Promise<unknown>;
  submitBundle(
    ctx: OperationContextLike,
    bundle: Record<string, unknown>,
    mode: "validate" | "apply",
  ): Promise<unknown>;
}
