import { resolveActiveThemeDirectory } from "./active-theme-media-presets.js";
import { hasExplicitFeedOptions, readFeedOrder, validateFeedOptions } from "./feed-options.js";
import {
  createInteractionPrivacyService,
  type InteractionPrivacyService,
} from "./interaction-privacy.js";
import { mapEntryRichText, validateRichTextBlockPolicy } from "./richtext-documents.js";
// Transport-independent application layer (PCMS-API-T001; API spec §2).
//
// REST (packages/api/http), MCP (packages/mcp) and CLI (packages/cli) all run
// the same application operations over this context — one authorization model,
// one validation, one CAS semantics, one error surface (spec §0 forbids a
// business layer per channel).
//
// Layering note: L2 packages cannot import each other (architecture map), so
// @pcms/mcp receives these services through a structural interface and CLI
// composes the same L1 factories directly; this file is the one place that
// wires every subsystem into an application surface.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AnalyticsDiagnostic,
  type AnalyticsPageContext,
  type AnalyticsRegistry,
  type AnalyticsSettings,
  analyticsDoctor,
  buildSystemDocumentInjection,
  createAnalyticsRegistry,
  defaultAnalyticsSettings,
  FIRST_PARTY_PROVIDERS,
  type SystemDocumentInjection,
} from "@pcms/analytics";
import {
  type ActorContext,
  type ActorResolver,
  type ActorType,
  type AuthenticationService,
  type AuthorizationService,
  createActorResolver,
  createAuthenticationService,
  createAuthorizationService,
  createMachineIdentityService,
  createPasswordCredentialService,
  createPasswordPolicy,
  createSessionService,
  createThrottleService,
  createTotpService,
  createUserIdentityService,
  isRegisteredPermission,
  type MachineIdentityService,
  mfaRequiredFor,
  type PasswordCredentialService,
  type PasswordPolicy,
  registerExtensionPermissions,
  type SessionService,
  type ThrottleService,
  type TotpService,
  type UserIdentityService,
} from "@pcms/auth";
import {
  BLOCK_DOCUMENT_SCHEMA_VERSION,
  type BlockRegistry,
  createBlockDiscovery,
  createBlockRegistry,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import {
  type ContentTreeService,
  type ContentTypeDefinition,
  type ContentTypeRegistry,
  collectRichTextMediaIds,
  createContentDiscovery,
  createContentTreeService,
  createContentTypeRegistry,
  createEntriesService,
  createFieldRegistry,
  type EntriesService,
  type FieldRegistry,
  validateContentPayload,
  validateRichText,
} from "@pcms/content";
import type { Clock, DbPool, ResolvedSecrets } from "@pcms/core";
import {
  CONFIG_SCHEMA_VERSION,
  injectAfterOpeningTag,
  loadMigrations,
  migrationStatus,
} from "@pcms/core";
import {
  type CapabilityRegistry,
  type CompatibilityReport,
  type CompatibilitySnapshot,
  checkUpdate,
  composeExtensionRegistrations,
  createCapabilityRegistry,
  createContractVersionRegistry,
  createDeprecationRegistry,
  createExtensionCatalog,
  createExtensionLifecycleService,
  createSystemContractVersionRegistry,
  type DeprecationRecord,
  type DeprecationRegistry,
  discoverCmsVersion,
  EXTENSION_CONTRACT_VERSION,
  type ExtensionCatalog,
  type ExtensionLifecycleService,
  type ExtensionManifest,
  getExtensionRuntimeSecret,
  manifestFingerprint,
  parseReleaseManifest,
  preflightOutcome,
  type ReleaseManifestV1,
  resolveHandler,
  SUPPORTED_NODE_RANGE,
  SUPPORTED_POSTGRES_RANGE,
  scanCompatibility,
  type UpdatePreflight,
  validateExtensionConfig,
} from "@pcms/extensions/internal";
import { registerInteractionBlocks } from "@pcms/forms";
import {
  ConnectorRuntimeRegistry,
  createAmocrmConnectorRuntime,
  createBitrix24ConnectorRuntime,
  createConnectorRegistry,
  createDeliveryService,
  createEmailConnectorRuntime,
  createGuardedHttp,
  createHubspotConnectorRuntime,
  createInboundService,
  createIntegrationBindingService,
  createIntegrationDispatcher,
  createIntegrationInstanceService,
  createPipedriveConnectorRuntime,
  createProgressiveHqConnectorRuntime,
  createSalesforceConnectorRuntime,
  createSharecrmConnectorRuntime,
  createTalkConnectorRuntime,
  createTelegramConnectorRuntime,
  createWebhookConnectorRuntime,
  createZohoCrmConnectorRuntime,
  InboundContractRegistry,
  type IntegrationDispatcher,
  type IntegrationProjectionSource,
  loadInstanceRuntimeSecrets,
  registerFirstPartyConnectorDefinitionsV1,
  type SecretResolver,
  type SsrfPolicy,
} from "@pcms/integrations";
import { createJobsService, type JobsService } from "@pcms/jobs";
import {
  createMediaDiscoveryService,
  createMediaPresetRegistry,
  createMediaUsageService,
  ensureCoreDerivative,
  FAVICON_PRESET_ID,
  findCoreDerivative,
  getAsset,
  type IngestLimits,
  LOGO_PRESET_ID,
  listVariants,
  type MediaDiscoveryService,
  MediaError,
  type MediaPresetRegistry,
  type MediaStorage,
  type MediaUsageService,
  OG_IMAGE_PRESET_ID,
  variantPublicUrl,
} from "@pcms/media";
import {
  createNavigationDiscovery,
  createNavigationService,
  createPlacementBindingService,
  type NavigationDiscovery,
  type NavigationService,
  type PlacementBindingService,
  type PlacementDescriptor,
} from "@pcms/navigation";
import { resolveReleaseIdentity } from "@pcms/operations";
import {
  createPaymentProviderInstanceService,
  createPaymentService,
  FakePaymentProvider,
  PaymentError,
  type PaymentProvider,
  PaymentProviderRegistry,
} from "@pcms/payments";
import {
  type ChangeSetDiscovery,
  type ChangeSetService,
  createChangeSetService,
  createChangeSetsDiscovery,
  createPreviewStateResolver,
  createPreviewTokenService,
  createPublicationCalendarService,
  createPublicationPlanService,
  createPublicationPlansDiscovery,
  createPublicationService,
  PCMD_VERSION,
  PCPUB_VERSION,
  type PreviewStateResolver,
  type PreviewTokenService,
  type PublicationCalendarService,
  type PublicationPlanDiscovery,
  type PublicationPlanService,
  type PublicationService,
  type PublicationValidator,
  type RevisionReaderPort,
  type RouteOperationsPort,
  writeOutboxEvent,
} from "@pcms/publication";
import {
  canonicalJsonString,
  createRevisionStore,
  createVersionedEntityRegistry,
  hashCanonicalPayload,
  type RevisionActor,
  type RevisionIssue,
  type RevisionStore,
  type SealContext,
  type VersionedEntityRegistry,
} from "@pcms/revisions";
import {
  type ActionUrlService,
  type CanonicalUrlService,
  createActionUrlService,
  createCanonicalUrlService,
  createDomainService,
  createRequestResolver,
  createReservedRouteRegistry,
  createRouteHistoryService,
  createRouteProposalService,
  createRouteService,
  createRoutingDiscovery,
  createSiteLocalizationService,
  type DomainService,
  localizedRoutePath,
  type RequestResolver,
  type RouteHistoryService,
  type RouteProposalService,
  type RouteService,
  type SiteLocalizationService,
} from "@pcms/routing";
import {
  createPgSearchProvider,
  createSearchIndexingService,
  createSearchReindexService,
  SEARCH_INDEX_VERSION,
  type SearchDocumentSource as SearchDocumentSourcePort,
  type SearchIndexingService,
  type SearchProvider,
  type SearchReindexService,
} from "@pcms/search";
import {
  createSeoDiscovery,
  createSeoStore,
  defaultRobotsTxtPolicy,
  isNoindex,
  parseIndexNowSettings,
  type SeoCanonicalPort,
  type SeoDiscovery,
  type SeoEnvironment,
  type SeoStore,
} from "@pcms/seo";
import {
  createThemeDiscovery,
  THEME_CONTRACT_VERSION,
  type ThemeDiscovery,
  type ThemeManifest,
} from "@pcms/themes";
import { BUNDLE_VERSION } from "./bundle.js";
import { ApiError } from "./errors.js";
import {
  createExtensionHttpRouter,
  extensionCanonicalPath,
  isExtensionPublicPage,
} from "./extension-http.js";
import {
  assertExtensionPermissionsRegistered,
  createExtensionOperationsService,
  type ExtensionOperationsService,
} from "./extension-operations.js";
import { buildExtensionSourceContext } from "./extension-platform.js";
import { createExtensionRouteService } from "./extension-routes.js";
import { createExtensionRuntimeResolver } from "./extension-runtime.js";
import { createFormsProjectionSource, createFormsSource } from "./forms-source.js";
import { API_CONTRACT_VERSION } from "./http/openapi.js";
import { deliverIndexNowPending, planIndexNowForPublicationEvent } from "./indexnow-ops.js";
import { entryLocaleAllowed } from "./localization-ops.js";
import { createMediaProvidersService, type MediaProvidersService } from "./media-providers.js";
import { createRegistryClient } from "./registry-client.js";
import {
  type AdminSearchResult,
  createAdminSearch,
  createExtensionAwareSearchSource,
  createPublicSearchOperation,
  createSearchDocumentSource,
  createSearchResultMetadata,
} from "./search-source.js";

/** How an operation was invoked — travels into actor/audit metadata (spec §61). */
export interface OperationContext {
  readonly actor: ActorContext;
  readonly transport: "rest" | "mcp" | "cli";
  readonly requestId: string;
}

/** Maps the M08 ActorContext types onto the revisions/publication actor classes. */
export function actorClassOf(type: ActorType): RevisionActor["actorClass"] {
  switch (type) {
    case "USER":
      return "human";
    case "SERVICE_ACCOUNT":
      return "service_account";
    case "SYSTEM":
      return "system";
    case "GUEST":
      // Defensive: guests never author revisions (public mutations write
      // extension-owned data), the class is required by exhaustiveness.
      return "human";
    case "OPERATOR":
      return "operator";
  }
}

/** One audit-consistent actor projection for revisions/publication writes.
 * The request id travels as sourceRunId so any seam can correlate the write
 * back to its request line in the structured logs (spec §9/§61). */
export function revisionActorFrom(ctx: OperationContext): RevisionActor {
  return {
    actorClass: actorClassOf(ctx.actor.type),
    actorId: ctx.actor.id,
    origin: actorOriginOf(ctx),
    sourceRunId: ctx.requestId,
  };
}

function actorOriginOf(ctx: OperationContext): RevisionActor["origin"] {
  switch (ctx.actor.type) {
    case "SERVICE_ACCOUNT":
      return "service_account";
    case "SYSTEM":
      return "system";
    default:
      return "human";
  }
}

/** Extends the block registry with theme-declared variants from one theme
 * directory (theme.json block_renderers[].variants). Shared by the
 * composition-time themes-root scan and the runtime /themes/install route:
 * a candidate's variants must validate before activation, without a restart
 * (2026-10-01 site-developer report). Throws on an unreadable manifest or an
 * invalid variant key — callers pick the policy. */
export function extendThemeBlockVariants(blocks: BlockRegistry, themeDir: string): void {
  for (const renderer of createThemeDiscovery(themeDir).getManifest().block_renderers ?? []) {
    if (renderer.variants === undefined || renderer.variants.length === 0) continue;
    const typeId = renderer.block.split("@")[0] ?? renderer.block;
    blocks.extendBlockVariants(typeId, renderer.variants);
  }
}

export interface ApplicationServicesInput {
  readonly pool: DbPool;
  readonly clock?: Clock;
  /** Content type descriptors served to discovery + used for seal validation. */
  readonly contentTypeDefinitions?: readonly ContentTypeDefinition[];
  /** Theme source directory for theme discovery/validation/preview. */
  readonly themeDir?: string;
  /** Navigation placement descriptors declared by the theme contract. */
  readonly navigationPlacements?: readonly PlacementDescriptor[];
  /** Media preset descriptors (M05 contract). */
  readonly mediaPresets?: readonly unknown[];
  /** Storage adapters for media ingest; ingest ops fail-secure without them. */
  readonly mediaStorage?: MediaStorage;
  readonly mediaQuarantine?: MediaStorage;
  readonly mediaLimits?: IngestLimits;
  /** .pcpub ingest limits (ADR-0014; defaults apply when absent). */
  readonly pcpubBundleLimits?: import("@pcms/publication").PcpubLimits;
  /** Quarantine directory for received bundles (default: OS temp). */
  readonly pcpubQuarantineDir?: string;
  /** Preview token HMAC secret via the M01 secrets channel (>= 32 chars). */
  readonly previewSecret?: string;
  /** TOTP encryption key from the M01 secrets channel (M08 spec §67). */
  readonly totpEncryptionKey?: string;
  /**
   * MFA policy mode (M08 spec §23). Optional; composition passes
   * config.auth?.mfa?.policy. Default OPTIONAL — REQUIRED_* modes need an
   * enrolled TOTP factor (enrollment surface pending) and would lock
   * operators out if defaulted on.
   */
  readonly mfaPolicy?: "OPTIONAL" | "REQUIRED_PRIVILEGED" | "REQUIRED_ALL";
  /** SEO indexing environment (fail-secure default: development, noindex). */
  readonly seoEnvironment?: SeoEnvironment;
  /** Baseline site key for single-site v1 discovery (routing "default"). */
  readonly defaultSiteKey?: string;
  /**
   * M16 agent bootstrap: safety classification reported to agents
   * (fail-safe default: development). Composition passes config.nodeEnv.
   */
  readonly environmentClassification?: "development" | "production";
  /** M16 agent bootstrap: deployed release id from build metadata, if known. */
  readonly releaseId?: string | null;
  /** Optional installed-layout probe; absent in development/API-only composition. */
  readonly selectedReleaseStatus?: () => import("@pcms/operations").SelectedReleaseStatus;
  /** M16 agent bootstrap: installed skill packages root (release ships skills/). */
  readonly skillsDir?: string;
  /** Community skills root (operator-installed packages); loaded only when
   * enabled. Defaults to <cwd>/skills-community, off by default. */
  readonly communitySkillsDir?: string;
  readonly communitySkillsEnabled?: boolean;
  /** Artifact repository (skills/extensions/releases); null = unconfigured. */
  readonly registryBaseUrl?: string;
  readonly registryReportUpdates?: boolean;
  readonly registryIncomingDir?: string;
  /** ADR-0013: signing key material for stock candidate references. */
  readonly mediaCandidateSigningKey?: string;
  readonly previewTtlMilliseconds?: number;
  /** Extra publication validators beyond routing availability. */
  readonly publicationValidators?: readonly PublicationValidator[];
  /** Process secrets (M01 channel) resolving integration secret-ref NAMES. */
  readonly secrets?: ResolvedSecrets;
  /** SSRF policy for the guarded outbound HTTP client (fail-secure default). */
  readonly integrationHttpPolicy?: SsrfPolicy;
  /** Mail transport for the email connector (Operations-owned boundary). */
  readonly mailTransport?: import("@pcms/integrations").MailTransport;
  /**
   * Safe connection probe for the configured transport (PCMS-OPS-T110):
   * reach + authenticate, sends nothing, never exposes credentials.
   */
  readonly mailVerify?: () => Promise<import("@pcms/integrations").SmtpDiagnostics>;
  /**
   * Encryptor for Admin-managed runtime secret values (PCMS-OPS-T130/T131):
   * connector instance secrets (1602) and the managed SMTP password (1601).
   * Optional: absent → the Admin cannot store secret values.
   */
  readonly runtimeSecretBox?: import("@pcms/integrations").IntegrationSecretBox;
  /** Structural injected projection source for outbound payload mapping. */
  readonly integrationProjection?: IntegrationProjectionSource;
  /** Registered payment providers (composition; real adapters are PAY-T010). */
  readonly paymentProviders?: readonly PaymentProvider[];
  /** M15 production update adapters (T114); absent → apply fails closed. */
  readonly updateOrchestrationPorts?: import("@pcms/extensions/internal").UpdateOrchestrationPorts;
  /** Deterministic fake provider for tests/sandbox (not registered by default). */
  readonly registerFakePaymentProvider?: boolean;
  /** M14: trusted deployed extension artifacts (composition-time only). */
  readonly extensionCatalog?: ExtensionCatalog;
  /**
   * ADR-0013: resolves extension runtime secret slots (Admin-managed store).
   * Absent ⇒ provider secret slots report unconfigured.
   */
  readonly extensionSecretResolver?: (
    extensionId: string,
    refName: string,
  ) => Promise<string | undefined>;
  /** M14: system-provided capabilities (cms:core, cms:themes, …). */
  readonly extensionSystemCapabilities?: CapabilityRegistry;
  /** M14: deprecation records published by this build. */
  readonly extensionDeprecations?: readonly DeprecationRecord[];
  /** M14: deployed release version (defaults to the repo package version). */
  readonly cmsVersion?: string;
  /** M14: target release manifest document for `update check` surfaces. */
  readonly updateManifest?: unknown;
  /** M14: core migrations directory (bounded snapshot input). */
  readonly migrationsDir?: string;
  /**
   * M14: MCP protocol version of the composed MCP surface. L2→L2 imports
   * are forbidden, so the composition root (web/worker, which may import
   * @pcms/mcp) passes its MCP_PROTOCOL_VERSION here. Keep in sync with
   * packages/mcp/src/protocol.ts — the fixture gate covers the tool
   * contract, this input covers version discovery.
   */
  readonly mcpProtocolVersion?: string;
}

/** Extensions subsystem bundle (M14) on the application surface. */
export interface ExtensionsServices {
  readonly catalog: ExtensionCatalog;
  readonly systemCapabilities: CapabilityRegistry;
  readonly deprecations: DeprecationRegistry;
  readonly contractVersions: ReturnType<typeof createSystemContractVersionRegistry>;
  readonly lifecycle: ExtensionLifecycleService;
  readonly releaseManifest: ReleaseManifestV1 | null;
  /** Effective capability provisions (system + enabled extensions). */
  capabilities(): Promise<
    readonly { readonly key: string; readonly version: string; readonly provider: string }[]
  >;
  /** Read-only compatibility scan of the actual installation. */
  scanCompatibility(): Promise<CompatibilityReport>;
  /** Read-only update preflight against the configured target manifest. */
  updatePreflight(): Promise<UpdatePreflight>;
  /** Read-only preflight against an explicit target (registry apply-update:
   * the downloaded artifact's own manifest, sha256-verified upstream). */
  updatePreflightAgainst(target: ReleaseManifestV1): Promise<UpdatePreflight>;
  /** Compatibility issues for one extension (machine-readable subset). */
  extensionCompatibility(extensionId: string): Promise<{
    readonly found: boolean;
    readonly issues: CompatibilityReport["issues"];
    readonly outcome: CompatibilityReport["outcome"];
  }>;
}

/** Payments subsystem bundle (M13; ADR-0005) on the application surface. */
export interface PaymentsServices {
  readonly registry: PaymentProviderRegistry;
  readonly instances: ReturnType<typeof createPaymentProviderInstanceService>;
  readonly service: ReturnType<typeof createPaymentService>;
  /** Resolves a process secret BY NAME (S6 diagnostics report resolvability
   * only); undefined when the deployment configures no secret channel. */
  readonly secretResolver?: (name: string) => string | undefined;
  /**
   * R3/S5: recomposes the provider registry when the extension lifecycle
   * revision moved (here or in ANOTHER process) — payment operation entries
   * await it; a disabled provider package then reports
   * PAYMENT_PROVIDER_UNKNOWN (fail-closed, never a wrong-provider charge).
   */
  readonly ensureComposed: () => Promise<void>;
}

/** Integrations subsystem bundle (M13; ADR-0005) on the application surface. */
export interface IntegrationsServices {
  readonly registry: ReturnType<typeof createConnectorRegistry>;
  readonly runtimes: ConnectorRuntimeRegistry;
  readonly instances: ReturnType<typeof createIntegrationInstanceService>;
  readonly bindings: ReturnType<typeof createIntegrationBindingService>;
  readonly deliveries: ReturnType<typeof createDeliveryService>;
  readonly inbound: ReturnType<typeof createInboundService>;
  readonly inboundContracts: InboundContractRegistry;
  readonly dispatcher: IntegrationDispatcher;
}

export interface ApplicationServices {
  readonly pool: DbPool;
  readonly clock: Clock;
  /** Canonical public origin from the primary domain binding (null without
   * one) — the single source sitemap/canonical/IndexNow already use. */
  readonly primaryOrigin: () => Promise<string | null>;
  // auth (M08)
  readonly users: UserIdentityService;
  readonly passwords: PasswordCredentialService;
  readonly passwordPolicy: PasswordPolicy;
  readonly throttle: ThrottleService;
  readonly sessions: SessionService;
  readonly totp: TotpService;
  readonly authentication: AuthenticationService;
  readonly machineIdentity: MachineIdentityService;
  readonly actorResolver: ActorResolver;
  readonly authorization: AuthorizationService;
  // content/blocks (M02)
  readonly entries: EntriesService;
  readonly contentTree: ContentTreeService;
  readonly contentTypes: ContentTypeRegistry;
  readonly fields: FieldRegistry;
  readonly blocks: BlockRegistry;
  readonly contentDiscovery: ReturnType<typeof createContentDiscovery>;
  readonly blockDiscovery: ReturnType<typeof createBlockDiscovery>;
  // revisions/publication (M07)
  readonly revisionRegistry: VersionedEntityRegistry;
  readonly revisions: RevisionStore;
  readonly revisionReader: RevisionReaderPort;
  readonly publications: PublicationService;
  readonly changesets: ChangeSetService;
  readonly changesetDiscovery: ChangeSetDiscovery;
  readonly plans: PublicationPlanService;
  readonly planDiscovery: PublicationPlanDiscovery;
  readonly calendar: PublicationCalendarService;
  readonly jobs: JobsService;
  /** Deployed extension catalog of THIS composition (jobs enqueue resolver,
   * PREPUBLIC §4); always set by createApplicationServices. */
  readonly extensionCatalog: ExtensionCatalog;
  readonly previewTokens: PreviewTokenService | null;
  readonly previewState: PreviewStateResolver;
  // media (M05)
  readonly mediaUsage: MediaUsageService;
  readonly mediaStorage: MediaStorage | null;
  readonly mediaQuarantine: MediaStorage | null;
  readonly mediaLimits: IngestLimits | undefined;
  readonly pcpubBundleLimits: import("@pcms/publication").PcpubLimits | undefined;
  readonly pcpubQuarantineDir: string | undefined;
  readonly mediaDiscovery: MediaDiscoveryService;
  mediaPresets: MediaPresetRegistry;
  readonly prepareRichTextImage: (id: string) => Promise<void>;
  // seo (M06)
  readonly seo: SeoStore;
  readonly seoDiscovery: SeoDiscovery;
  readonly seoEnvironment: SeoEnvironment;
  readonly defaultSiteKey: string;
  // M16 agent bootstrap (discovery-first; agent-bootstrap-ops.ts)
  readonly environmentClassification: "development" | "production";
  readonly releaseId: string | null;
  readonly selectedReleaseStatus: (() => import("@pcms/operations").SelectedReleaseStatus) | null;
  readonly skillsDir: string;
  readonly communitySkillsDir: string;
  readonly communitySkillsEnabled: boolean;
  readonly registryClient: import("./registry-client.js").RegistryClient | null;
  readonly registryIncomingDir: string;
  /** Publish token from the registry.token secret slot (null = unset). */
  readonly registryAccountToken: string | null;
  /** Per-instance registry identity (2026-09-29): generated here, bound to
   * the operator's registry account via POST /registry/instances/register,
   * stored in the runtime secret store; consumed by best-effort download
   * notices on apply-update. */
  readonly registryInstanceCode: {
    read(): Promise<string | null>;
    write(value: string, actor: string): Promise<void>;
  };
  /** Per-instance registry token (v2 binding): stored encrypted, never
   * returned to clients; preferred over the file-channel citizen token. */
  /** Admin-managed account token (write-only runtime secret, key
   * registry.account_token; ADR — Task 2026-10-05 Registry Admin UX). */
  readonly registryAccountTokenRuntime: {
    read(): Promise<string | null>;
    write(value: string, actor: string): Promise<void>;
    clear(actor: string): Promise<void>;
    /** false when the runtime secrets key is not configured (store unusable). */
    readonly available: boolean;
  };
  readonly registryInstanceToken: {
    read(): Promise<string | null>;
    write(value: string, actor: string): Promise<void>;
  };
  /** Consent: upload agent reports after successful registry-sourced
   * apply-update (config registry.reportUpdates). */
  readonly registryReportUpdates: boolean;
  // navigation/routing (M04)
  readonly navigation: NavigationService;
  readonly placements: PlacementBindingService;
  navigationDiscovery: NavigationDiscovery;
  readonly routes: RouteService;
  readonly routeHistory: RouteHistoryService;
  readonly routeProposals: RouteProposalService;
  readonly domains: DomainService;
  readonly canonical: CanonicalUrlService;
  readonly actionUrls: ActionUrlService;
  readonly localization: SiteLocalizationService;
  readonly requestResolver: RequestResolver;
  readonly routingDiscovery: ReturnType<typeof createRoutingDiscovery>;
  // themes (M03)
  themeDir: string | undefined;
  themeDiscovery: ThemeDiscovery | null;
  readonly themeRuntime: {
    readonly configuredDir: string | undefined;
    withChange<T>(work: () => Promise<T>): Promise<T>;
    prepareState:
      | ((
          dir: string,
          values: Record<string, boolean | string | number | null>,
          generation: number,
        ) => Promise<() => void>)
      | null;
    prepareUpdate: ((stagedDir: string) => Promise<() => void>) | null;
    confirmed?: (revisionId: string, generation: number) => void;
    requestSnapshot?: () =>
      | { theme_key: string; revision_id: string | null; directory: string; generation: number }
      | undefined;
    served:
      | (() => {
          id: string;
          version: string;
          settings_generation: number;
          revision_id?: string | null;
          theme_generation?: number;
        })
      | null;
  };
  // search (M11) — derived projection composed over publications/routes/SEO
  readonly searchSource: SearchDocumentSourcePort;
  readonly searchProvider: SearchProvider;
  readonly searchIndexing: SearchIndexingService;
  readonly searchReindex: SearchReindexService;
  /** Public search application operation (Search spec §23). */
  searchQuery(input: {
    readonly q: string;
    readonly site?: string;
    readonly locale: string;
    readonly content_type?: string;
    readonly date_from?: string;
    readonly date_to?: string;
    readonly sort?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<import("@pcms/search").SearchQueryResult>;
  readonly searchResultMetadata: ReturnType<typeof createSearchResultMetadata>;
  /** Admin authorized search (Search spec §24; requires search.admin). */
  searchAdmin(input: {
    readonly q: string;
    readonly site?: string;
    readonly locale: string;
    readonly limit?: number;
  }): Promise<AdminSearchResult>;
  // forms/quizzes/leads (M12) — composed through the FormsSource ports
  readonly formsSource: import("./forms-source.js").FormsSource;
  readonly interactionPrivacy: InteractionPrivacyService;
  /** Integrations bounded context (M13). */
  readonly integrations: IntegrationsServices;
  readonly extensions: ExtensionsServices;
  /** ADR-0013: typed application-operation contributions of extensions. */
  readonly extensionOperations: ExtensionOperationsService;
  /** Extension Contract 2.0 (ADR-0018): site-level route mounts + the HTTP
   * dispatch over composed extension routes. */
  readonly extensionRouteMounts: ReturnType<typeof createExtensionRouteService>;
  readonly extensionHttp: ReturnType<typeof createExtensionHttpRouter>;
  /** Analytics & tagging (ADR-0016). */
  readonly analytics: {
    readonly registry: import("@pcms/analytics").AnalyticsRegistry;
    /** CAS-authoritative settings (analytics_settings; defaults when unset). */
    loadSettings(): Promise<{
      readonly settings: import("@pcms/analytics").AnalyticsSettings;
      readonly generation: number;
    }>;
    /** Per-request cached read for the render path (no settings row = null). */
    cachedSettings(): import("@pcms/analytics").AnalyticsSettings | null;
    updateCachedSettings(settings: import("@pcms/analytics").AnalyticsSettings | null): void;
    buildInjection(
      settings: import("@pcms/analytics").AnalyticsSettings,
      page: import("@pcms/analytics").AnalyticsPageContext,
    ): import("@pcms/analytics").SystemDocumentInjection | null;
    doctor(
      settings: import("@pcms/analytics").AnalyticsSettings,
    ): readonly import("@pcms/analytics").AnalyticsDiagnostic[];
  };
  /** IndexNow v1 (Progressive_CMS_IndexNow_v1_Spec.md): site-level,
   * DISABLED by default; every gate below re-checks `enabled` so a disabled
   * site makes zero outbound requests and serves no key route. */
  readonly indexNow: {
    /** Cached settings for the render path (key route); null = disabled. */
    cachedEnabledKey(): Promise<{ readonly enabled: boolean; readonly key: string | null }>;
    updateCachedSettings(settings: import("@pcms/seo").IndexNowSettings | null): void;
    handlePublicationEvent(event: {
      readonly eventType: string;
      readonly payload: unknown;
    }): Promise<void>;
    deliverPending(): Promise<void>;
  };
  /** ADR-0013: runtime media provider registries (stock + generation). */
  readonly mediaProviders: MediaProvidersService;
  /**
   * ADR-0013: HMAC key for stock candidate reference signing. Composition
   * supplies the runtime-secrets key material (never stored in the DB).
   * Absent ⇒ stock acquisition surfaces fail closed.
   */
  readonly mediaCandidateSigningKey: string | undefined;
  /** Payments bounded context (M13). */
  readonly payments: PaymentsServices;
  /**
   * Safe mail-connection probe (PCMS-OPS-T110, Operations spec §31): reach +
   * authenticate, send nothing. Undefined when no mail transport is
   * configured — the transport surface then reports MAIL_NOT_CONFIGURED.
   */
  readonly mailVerify?: () => Promise<import("@pcms/integrations").SmtpDiagnostics>;
  /** Resolved mail transport (undefined when the deployment configures none). */
  readonly mailTransport?: import("@pcms/integrations").MailTransport;
  /** Encryptor for Admin-managed runtime secret values (T130/T131). */
  readonly runtimeSecretBox?: import("@pcms/integrations").IntegrationSecretBox;
  /**
   * Production M15 update adapters (PCMS-OPS-T114). When present, the update
   * orchestrator performs real backup/maintenance/deploy/restart/doctor
   * phases; when absent, apply fails closed (UPDATE_DEPLOYMENT_ADAPTER_UNAVAILABLE).
   */
  readonly updateOrchestrationPorts?: import("@pcms/extensions/internal").UpdateOrchestrationPorts;
  /** Authorizes one permission key against the M08 registry (default-deny). */
  authorize(actor: ActorContext, permission: string): void;
}

/**
 * Seal validation runs inside the owning domain (spec §31): entry payloads are
 * checked against the content type registry (publish level) and the block
 * document contract. Unknown content types fail closed.
 */
function entryEntityAdapter(deps: {
  entries: EntriesService;
  contentTypes: ContentTypeRegistry;
  blocks: BlockRegistry;
  prepareImage: (id: string) => Promise<void>;
  /** ACTIVE theme manifest + preset ids, resolved live (not the boot seed). */
  resolveFeedTheme: () => Promise<{
    readonly manifest: ThemeManifest | null;
    readonly presets: ReadonlySet<string>;
  }>;
}): {
  entityType: "entry";
  description: string;
  validateForSeal(payload: unknown, ctx: SealContext): Promise<RevisionIssue[]>;
  canonicalize(payload: unknown): unknown;
  extractMediaAssetIds(payload: unknown, ctx: SealContext): Promise<readonly string[]>;
} {
  const STABLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  async function pinnedContentTypes(value: unknown, ctx: SealContext): Promise<readonly string[]> {
    const keys = new Set<string>();
    for (const id of Array.isArray(value) ? value : []) {
      if (typeof id !== "string" || !STABLE_ID_RE.test(id)) continue;
      const pinned =
        ctx.executor === undefined
          ? await deps.entries.findEntry(id as never).catch(() => null)
          : await deps.entries
              .findEntryWithinTx(ctx.executor as never, id as never)
              .catch(() => null);
      // A removed pinned id never invalidates the block; its type simply
      // cannot be checked (the id also stops rendering).
      if (pinned !== null) keys.add(pinned.contentTypeId);
    }
    return [...keys];
  }

  async function relatedContentFeedIssues(
    props: Record<string, unknown>,
    path: string,
    ctx: SealContext,
    theme: { readonly manifest: ThemeManifest | null; readonly presets: ReadonlySet<string> },
  ): Promise<RevisionIssue[]> {
    const mode = typeof props.mode === "string" ? props.mode : "manual";
    const binding =
      typeof props.collection_key === "string"
        ? theme.manifest?.collections?.[props.collection_key]
        : undefined;
    const themeKnown = theme.manifest !== null;
    const override = Array.isArray(props.content_types)
      ? props.content_types.filter((key): key is string => typeof key === "string")
      : null;
    // Without an override the binding decides; manual blocks have no binding,
    // so the still-resolvable pinned entries define the checked types.
    const keys =
      override ??
      (mode === "manual"
        ? await pinnedContentTypes(props.entry_ids, ctx)
        : (binding?.content_types ?? []));
    const appliedTypes = keys.flatMap((key) => {
      const type = deps.contentTypes.getLatestContentType(key);
      return type === null ? [] : [type];
    });
    return validateFeedOptions({
      mode,
      props,
      path,
      appliedTypes,
      collectionKnown: themeKnown ? binding !== undefined : null,
      knownPresets: themeKnown ? theme.presets : null,
      contentTypes: (key) => deps.contentTypes.getLatestContentType(key),
      explicit: hasExplicitFeedOptions(props),
      // Validation checks the EFFECTIVE order, including one inherited from
      // the collection binding.
      ...(binding === undefined ? {} : { bindingOrder: readFeedOrder(binding.order) }),
    }).map((issue) => ({ ...issue, severity: "error" as const }));
  }

  /**
   * Semantic validation of explicitly-declared feed options, including
   * nested renderable blocks. Structural prop shapes stay the block
   * registry's job; this is the single entry path (REST/MCP/PCPUB/seal) where
   * field/preset existence can be checked against the ACTIVE theme.
   */
  async function feedOptionIssues(blocks: unknown, ctx: SealContext): Promise<RevisionIssue[]> {
    const root = (blocks as { blocks?: unknown } | null)?.blocks;
    const targets: { props: Record<string, unknown>; path: string }[] = [];
    const collect = (list: unknown, path: string): void => {
      if (!Array.isArray(list)) return;
      for (const [index, value] of list.entries()) {
        if (typeof value !== "object" || value === null) continue;
        const block = value as { type?: unknown; props?: unknown; children?: unknown };
        const nodePath = `${path}/${index}`;
        if (
          block.type === "related_content" &&
          typeof block.props === "object" &&
          block.props !== null &&
          hasExplicitFeedOptions(block.props as Record<string, unknown>)
        ) {
          targets.push({
            props: block.props as Record<string, unknown>,
            path: `${nodePath}/props`,
          });
        }
        collect(block.children, `${nodePath}/children`);
      }
    };
    collect(root, "/blocks/blocks");
    // Documents without explicit feed options (i.e. all history) never touch
    // the theme or the content-type registry.
    if (targets.length === 0) return [];
    const theme = await deps.resolveFeedTheme();
    const issues: RevisionIssue[] = [];
    for (const target of targets) {
      issues.push(...(await relatedContentFeedIssues(target.props, target.path, ctx, theme)));
    }
    return issues;
  }

  return {
    entityType: "entry",
    description: "Content entry (fields + optional block document body)",
    canonicalize: (payload) => JSON.parse(canonicalJsonString(payload)) as unknown,
    async extractMediaAssetIds(payload, ctx) {
      const entry = ctx.executor
        ? await deps.entries.findEntryWithinTx(ctx.executor as never, ctx.entityId as never)
        : await deps.entries.findEntry(ctx.entityId as never);
      const type = entry ? deps.contentTypes.getLatestContentType(entry.contentTypeId) : null;
      if (!type) return [];
      const ids = new Set<string>();
      mapEntryRichText(payload, type, deps.blocks, (document) => {
        for (const id of collectRichTextMediaIds(document)) ids.add(id);
        return document;
      });
      return [...ids];
    },
    async validateForSeal(payload, ctx) {
      const issues: RevisionIssue[] = [];
      const entry =
        ctx.executor === undefined
          ? await deps.entries.findEntry(ctx.entityId as never)
          : await deps.entries.findEntryWithinTx(ctx.executor as never, ctx.entityId as never);
      if (entry === null) {
        return [
          {
            code: "ENTRY_NOT_FOUND",
            message: `entry ${ctx.entityId} does not exist`,
            severity: "error",
          },
        ];
      }
      // Locale contract (2026-10-02 site-developer report): a revision whose
      // locale differs from the entry identity never resolves in SEO or
      // WORKING lookups — reject it here so validate/seal/preflight catch it
      // before publication instead of a silent live breakage.
      // Only the revision being SEALED must match (Publication spec §6): SEALED
      // rows are immutable and keep their original locale, so identity repair
      // (`reidentifyLocale`) legitimately leaves older sealed history on the
      // old locale. Flagging that history would make the repair op produce
      // state its own validator rejects — `cleanup_entry_revisions` is the
      // sanctioned way to drop such history when it is not wanted.
      if (ctx.revisionState !== "SEALED" && ctx.locale !== entry.locale) {
        issues.push({
          code: "LOCALE_MISMATCH",
          message: `revision locale "${ctx.locale}" does not match the entry identity locale "${entry.locale}"`,
          severity: "error",
        });
      }
      const body = (payload ?? {}) as { fields?: unknown; blocks?: unknown };
      const loaded = deps.contentTypes.getLatestContentType(entry.contentTypeId);
      if (loaded === null) {
        return [
          {
            code: "CONTENT_TYPE_UNKNOWN",
            message: `content type "${entry.contentTypeId}" is not registered on this server`,
            severity: "error",
          },
        ];
      }
      const result = validateContentPayload(loaded, body.fields ?? {}, "publish");
      for (const issue of result.errors) {
        issues.push({ code: issue.code, message: issue.message, severity: "error" });
      }
      issues.push(
        ...validateRichTextBlockPolicy(loaded.bodyPolicy, body.blocks, ctx.revisionState),
      );
      if (loaded.bodyPolicy === "block_document") {
        const blockResult = validateBlockDocument(body.blocks ?? null, deps.blocks);
        if (!blockResult.ok) {
          for (const issue of blockResult.issues) {
            issues.push({ code: issue.code, message: issue.message, severity: "error" });
          }
        }
        // History is never re-judged: a theme change after publication must
        // not make a SEALED revision look broken.
        if (ctx.revisionState !== "SEALED") {
          issues.push(...(await feedOptionIssues(body.blocks, ctx)));
        }
      }
      const images = new Set<string>();
      mapEntryRichText(payload, loaded, deps.blocks, (document, path) => {
        const validation = validateRichText(document);
        if (!validation.ok)
          for (const issue of validation.issues)
            issues.push({
              code: issue.code,
              path: `${path}${issue.path}`,
              message: `${path}${issue.path}: ${issue.message}`,
              severity: "error",
            });
        else for (const id of collectRichTextMediaIds(document)) images.add(id);
        return document;
      });
      if (issues.length === 0)
        for (const id of images) {
          try {
            await deps.prepareImage(id);
          } catch (error) {
            issues.push({
              code: "RICHTEXT_MEDIA_UNAVAILABLE",
              message: error instanceof Error ? error.message : "Image is unavailable",
              severity: "error",
            });
          }
        }
      return issues;
    },
  };
}

function noPayloadAdapter(entityType: string, description: string) {
  return {
    entityType,
    description,
    validateForSeal: () => [] as RevisionIssue[],
  };
}

export function createApplicationServices(input: ApplicationServicesInput): ApplicationServices {
  const pool = input.pool;
  const clock = input.clock ?? ({ now: () => new Date() } satisfies Clock);

  // --- auth (M08): one ActorContext for every transport (spec §15/§16). ---
  const users = createUserIdentityService(pool);
  const passwords = createPasswordCredentialService(pool);
  const passwordPolicy = createPasswordPolicy();
  const throttle = createThrottleService(pool);
  const sessions = createSessionService(pool, { securitySink: null });
  const totp = createTotpService(pool, {
    throttle,
    ...(input.totpEncryptionKey === undefined ? {} : { encryptionKey: input.totpEncryptionKey }),
  });
  // MFA policy gate (spec §23/§24) — the policy now reaches the login flow.
  // Default OPTIONAL on purpose: REQUIRED_* modes demand an enrolled TOTP
  // factor, and enabling them before an enrollment surface exists would lock
  // every operator out instead of hardening the install.
  const mfaPolicy = input.mfaPolicy ?? "OPTIONAL";
  const authentication = createAuthenticationService(pool, {
    users,
    passwords,
    throttle,
    sessions,
    isMfaRequired: async (user) => {
      if (mfaPolicy === "OPTIONAL") return false;
      const { createRoleService } = await import("@pcms/auth");
      const roles = createRoleService(pool);
      const [roleKeys, permissions] = await Promise.all([
        roles.userRoleKeys(user.id),
        roles.userPermissions(user.id),
      ]);
      return mfaRequiredFor({ policy: mfaPolicy, roleKeys, permissions });
    },
  });
  const machineIdentity = createMachineIdentityService(pool);
  const actorResolver = createActorResolver(pool, { users });
  const authorization = createAuthorizationService();

  // --- content/blocks (M02). ---
  // Entry identity locale must follow the site's declared localization
  // policy (owner 2026-10-06, after a site agent created ru-RU identities on
  // a single-locale site, which made the Admin's locale-blind drafts
  // unsealable): multilingual disabled → the "default" sentinel only;
  // enabled → the declared locale list (plus the sentinel). Enforced here at
  // the composition root so every creation path (Admin, agents, pcpub,
  // extensions) hits the same gate.
  const entriesBase = createEntriesService(pool);
  // Entry identity locale must follow the site's declared localization policy
  // (owner 2026-10-06, after a site agent created ru-RU identities on a
  // single-locale site, which made the Admin's locale-blind drafts
  // unsealable): multilingual disabled → the "default" sentinel only;
  // enabled → the declared locale list (plus the sentinel). Enforced here at
  // the composition root so EVERY creation path (Admin, agents, pcpub,
  // extensions) hits the same gate — including the transactional variants,
  // which is where createDraft/duplicate/translation actually go.
  const assertIdentityLocaleAllowed = async (input: { readonly locale?: string }) => {
    const identityLocale = input.locale ?? "default";
    const localization = await createSiteLocalizationService(pool).get();
    if (entryLocaleAllowed(localization, identityLocale)) return;
    throw new ApiError(
      "LOCALIZATION_LOCALE_NOT_ENABLED",
      localization.enabled
        ? `entry identity locale "${identityLocale}" is not in the site locale list (Settings → Localization: ${
            localization.locales.length === 0 ? "empty" : localization.locales.join(", ")
          })`
        : `entry identity locale "${identityLocale}" is not allowed: this site runs single-locale (multilingual is disabled in Settings → Localization); use the "default" locale or enable multilingual first`,
      { status: 422 },
    );
  };
  const entries: typeof entriesBase = {
    ...entriesBase,
    async createEntry(input) {
      await assertIdentityLocaleAllowed(input);
      return entriesBase.createEntry(input);
    },
    async createEntryWithinTx(executor, input) {
      await assertIdentityLocaleAllowed(input);
      return entriesBase.createEntryWithinTx(executor, input);
    },
  };
  const contentTree = createContentTreeService(pool);
  const contentTypes = createContentTypeRegistry();
  // System type backing `entry_kind = "folder"` (structural tree node).
  // Folder semantics live in the entry_kind column — this definition only
  // gives folders a registrable schema (title-only, no body). Registered
  // first so a site definition may still override the key.
  contentTypes.registerContentType({
    key: "folder",
    version: 1,
    title: "Folder",
    description:
      "Structural grouping node — editorial tree only; never published, routed or indexed.",
    fields: { title: { id: "title", type: "string" } },
    bodyPolicy: "none",
  });
  for (const definition of input.contentTypeDefinitions ?? []) {
    // Rec 2 (152fz recommendations): a typesFile entry whose key@version is
    // already registered BY CODE (folder@1, …) is skipped with a warning —
    // the code definition is compatible, and a crash-loop here takes the
    // whole site down for a harmless duplicate. A CONFLICTING definition
    // (same key, different schema shape) still fails registration inside
    // the registry and surfaces at boot.
    const existing =
      contentTypes.getContentType(definition.key, definition.version) ??
      contentTypes.getLatestContentType(definition.key);
    if (
      existing !== null &&
      existing.key === definition.key &&
      existing.version === definition.version
    ) {
      // Composition root has no injected logger; composition warnings are
      // one-shot per process, console is the honest channel.
      console.warn(
        `[pcms:content] typesFile entry ${definition.key}@${definition.version} skipped — already registered by core`,
      );
      continue;
    }
    contentTypes.registerContentType(definition);
  }
  const fields = createFieldRegistry();
  const blocks = createBlockRegistry();
  registerFirstPartyBlocksV1(blocks);
  registerInteractionBlocks(blocks);
  const contentDiscovery = createContentDiscovery({ contentTypes, fields });
  const blockDiscovery = createBlockDiscovery(blocks);

  // --- revisions/publication (M07), wired through structural ports. ---
  const prepareRichTextImage = async (id: string): Promise<void> => {
    const asset = await getAsset(pool, id as never);
    if (
      asset === null ||
      asset.kind !== "image" ||
      asset.archivedAt !== null ||
      asset.mimeType === "image/svg+xml"
    )
      throw new ApiError("RICHTEXT_MEDIA_INVALID", "RichText requires an available raster image", {
        status: 422,
      });
    await ensureCoreDerivative(coreDerivativeDeps(), asset, mediaPresets, "richtext-v1");
  };
  // Seal-time semantic checks (feed-anywhere options) resolve the ACTIVE
  // theme, not the boot seed: a theme activated after boot declares the
  // collections/presets the check must use. Assigned once the discovery is
  // built below; the closure only runs during seal/validate.
  let resolveActiveTheme = async (): Promise<{
    readonly manifest: ThemeManifest | null;
    readonly presets: ReadonlySet<string>;
  }> => ({ manifest: null, presets: new Set() });
  const revisionRegistry = createVersionedEntityRegistry([
    entryEntityAdapter({
      entries,
      contentTypes,
      blocks,
      prepareImage: prepareRichTextImage,
      resolveFeedTheme: () => resolveActiveTheme(),
    }),
    noPayloadAdapter("global_content", "Global content record"),
    noPayloadAdapter("theme_settings", "Theme settings record"),
  ]);
  const mediaSnapshot = {
    // ponytail: per-asset SELECT; media lookups are keyed and bounded by
    // document size (MAX_BLOCKS_PER_DOCUMENT) — batch if profiles say so.
    async resolveCurrentVersions(assetIds: readonly string[]) {
      const out: Record<string, number> = {};
      for (const assetId of assetIds) {
        const asset = await getAsset(pool, assetId as never);
        if (asset !== null) out[assetId] = asset.currentVersionNo;
      }
      return out;
    },
  };
  const revisions = createRevisionStore(pool, {
    registry: revisionRegistry,
    clock,
    mediaSnapshot,
  });
  const revisionReader: RevisionReaderPort = {
    async getSealedRevision(executor, entityType, entityId, revisionId) {
      const record = await revisions.getRevision(executor, revisionId);
      if (record === null) return null;
      if (record.state !== "SEALED") return null;
      if (record.entityType !== entityType || record.entityId !== entityId) return null;
      if (record.payloadHash === null) return null;
      return {
        revisionId: record.id,
        entityType: record.entityType,
        entityId: record.entityId,
        payloadHash: record.payloadHash,
        schemaVersion: record.schemaVersion,
        locale: record.locale,
        payload: record.payload,
        mediaVersions: record.mediaVersions,
        sidecar: record.sidecar,
        sealedAt: record.sealedAt ?? record.createdAt,
      };
    },
    async getWorkingRevision(executor, entityType, entityId, revisionId) {
      // Draft preview (2026-09-29): WORKING revisions render through the
      // same snapshot shape; the hash is derived for the preview only, and
      // media resolves unpinned (current versions) — private no-store state.
      const record = await revisions.getRevision(executor, revisionId);
      if (record === null) return null;
      if (record.state !== "WORKING") return null;
      if (record.entityType !== entityType || record.entityId !== entityId) return null;
      return {
        revisionId: record.id,
        entityType: record.entityType,
        entityId: record.entityId,
        payloadHash: record.payloadHash ?? hashCanonicalPayload(record.payload),
        schemaVersion: record.schemaVersion,
        locale: record.locale,
        payload: record.payload,
        mediaVersions: record.mediaVersions,
        sidecar: record.sidecar,
        sealedAt: record.updatedAt ?? record.createdAt,
      };
    },
  };
  const publications = createPublicationService(pool, { clock, revisions: revisionReader });
  const routes = createRouteService(pool);
  const routeHistory = createRouteHistoryService(pool);
  const canonical = createCanonicalUrlService(pool);
  const routeOps: RouteOperationsPort = {
    async validateActivatable(input) {
      await routes.validateActivatable(input);
    },
    async activateWithinTx(client, operation) {
      if (operation.kind !== "set") return;
      const movedFrom =
        operation.freesPath !== undefined && operation.freesPath !== operation.path
          ? operation.freesPath
          : null;
      if (operation.freesPath !== undefined) {
        await routes.retireRouteWithinTx(client, {
          siteId: operation.siteId,
          path: operation.freesPath,
        });
      }
      if (movedFrom !== null) {
        const active = await client.query<{ target_type: string; target_id: string }>(
          `SELECT target_type, target_id FROM routes
           WHERE site_id = $1
             AND locale = COALESCE($2::text, (SELECT default_locale FROM sites WHERE id = $1))
             AND path = $3 AND domain_binding_id IS NULL
             AND retired_at IS NULL AND is_canonical
           FOR UPDATE`,
          [operation.siteId, operation.locale ?? null, operation.path],
        );
        const existing = active.rows[0];
        if (!(existing?.target_type === "entry" && existing.target_id === operation.entityId)) {
          await routes.activateRouteWithinTx(client, {
            siteId: operation.siteId,
            path: operation.path,
            // Opt-in multilingual: secondary locales publish their own canonical
            // route rows (routes.locale carries the BCP-47 code; the default
            // keeps the sentinel via ActivateRouteInput default).
            ...(operation.locale === undefined ? {} : { locale: operation.locale }),
            targetType: "entry",
            targetId: operation.entityId,
          });
        }
        // Freeing a path while binding the entity elsewhere IS a canonical
        // path change: the freed path becomes a historical 301 redirect
        // (Navigation spec §31, the same semantics the interactive
        // changeRoute op provides). Without this row the old URL 404s after
        // a native move (2026-10-04 report: /journal/… → /news/…).
        await routeHistory.recordRedirectWithinTx(client, {
          siteId: operation.siteId,
          oldPath: movedFrom,
          targetType: "path",
          targetId: operation.path,
          statusCode: 301,
          ...(operation.locale === undefined ? {} : { locale: operation.locale }),
          reason: "changeset route move",
        });
        // Generic public-state fact for outbox consumers (IndexNow spec §9:
        // a canonical move notifies OLD and NEW URLs; the paths are the
        // authoritative previous/current state at event time).
        await writeOutboxEvent(client, {
          aggregate: "routing",
          aggregateId: `${operation.entityId}:${operation.path}`,
          eventType: "EntryRouteChanged",
          payload: {
            entityType: "entry",
            entityId: operation.entityId,
            context: operation.locale ?? "default",
            previousPath: movedFrom,
            path: operation.path,
          },
        });
        return;
      }
      // Plain (re)activation: a repeated publish of the same entry on the
      // same path is a no-op, never a collision (0.1.169 regression guard).
      const active = await client.query<{ target_type: string; target_id: string }>(
        `SELECT target_type, target_id FROM routes
         WHERE site_id = $1
           AND locale = COALESCE($2::text, (SELECT default_locale FROM sites WHERE id = $1))
           AND path = $3 AND domain_binding_id IS NULL
           AND retired_at IS NULL AND is_canonical
         FOR UPDATE`,
        [operation.siteId, operation.locale ?? null, operation.path],
      );
      const existing = active.rows[0];
      if (existing?.target_type === "entry" && existing.target_id === operation.entityId) return;
      await routes.activateRouteWithinTx(client, {
        siteId: operation.siteId,
        path: operation.path,
        ...(operation.locale === undefined ? {} : { locale: operation.locale }),
        targetType: "entry",
        targetId: operation.entityId,
      });
    },
    async retireWithinTx(client, target) {
      const found = await canonical.findRouteByEntry(target.entityId);
      if (found.route !== null) {
        await routes.retireRouteWithinTx(client, {
          siteId: found.route.siteId,
          path: found.route.path,
        });
      }
    },
  };
  const routeValidator: PublicationValidator = {
    name: "routing",
    async validate(candidates) {
      // Same-release swap tolerance: a proposed path conflicts only if it is
      // occupied by a current route that no candidate in this release frees
      // (M07 canonical wiring, tests/helpers/publication-composition.ts).
      const issues: {
        code: string;
        severity: "error" | "warning";
        message: string;
        candidateIndex?: number;
      }[] = [];
      const keyOf = (siteId: string, locale: string | undefined, path: string): string =>
        `${siteId} ${locale ?? ""} ${path}`;
      const freed = new Set<string>();
      for (const candidate of candidates) {
        const op = candidate.routeOperation;
        if (op.kind === "set" && op.freesPath !== undefined) {
          freed.add(keyOf(op.siteId, op.locale, op.freesPath));
        }
      }
      const proposed = new Map<string, number>();
      for (const [index, candidate] of candidates.entries()) {
        const op = candidate.routeOperation;
        if (op.kind !== "set") continue;
        const key = keyOf(op.siteId, op.locale, op.path);
        const previous = proposed.get(key);
        if (previous !== undefined) {
          issues.push({
            code: "ROUTE_CONFLICT",
            severity: "error",
            message: `candidates ${previous} and ${index} both claim ${op.path}`,
            candidateIndex: index,
          });
          continue;
        }
        proposed.set(key, index);
        const active = await routes.findActiveRoute(op.siteId, op.path, {
          locale: op.locale ?? null,
        });
        const alreadyOwned =
          active?.targetType === "entry" && active.targetId === candidate.entityId;
        if (active !== null && !alreadyOwned && !freed.has(key)) {
          issues.push({
            code: "ROUTE_CONFLICT",
            severity: "error",
            message: `path ${op.path} is occupied by an active route not freed in this release`,
            candidateIndex: index,
          });
        }
      }
      return issues;
    },
  };
  const changesets = createChangeSetService(pool, {
    clock,
    revisions: revisionReader,
    publications,
    validators: [
      ...(input.publicationValidators ?? []),
      routeValidator,
      {
        // CORE-SHOP-01 P0-b (ADR-0018): a published entry route must not
        // cross an ACTIVE extension mount (both directions checked at mount
        // assign time too — two fail-closed layers over one truth).
        name: "extension-mounts",
        async validate(candidates) {
          const issues: {
            code: string;
            severity: "error" | "warning";
            message: string;
            candidateIndex?: number;
          }[] = [];
          for (const [index, candidate] of candidates.entries()) {
            const op = candidate.routeOperation;
            if (op.kind !== "set") continue;
            try {
              await extensionRouteMounts.assertEntryRouteActivatable(op.path);
            } catch (error) {
              issues.push({
                code: "EXTENSION_MOUNT_COLLISION",
                severity: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : `entry route crosses an active extension mount`,
                candidateIndex: index,
              });
            }
          }
          return issues;
        },
      },
      {
        // Extension validator contributions (spec §9) recompose per run:
        // enable/disable of a contributor applies from the NEXT publication,
        // no cache to invalidate (publications are rare; one enabledIds()
        // read is the price of correctness).
        name: "extensions",
        async validate(candidates) {
          let enabledIds: string[];
          try {
            enabledIds = await extensionLifecycle.enabledIds();
          } catch {
            return []; // pre-M14 database (no extension state tables yet)
          }
          const issues: {
            code: string;
            severity: "error" | "warning";
            message: string;
            path?: string;
            candidateIndex?: number;
          }[] = [];
          for (const registration of composeExtensionRegistrations(extensionCatalog, enabledIds)
            .registrations) {
            if (registration.kind !== "validator" || registration.point !== "publication") {
              continue;
            }
            const artifact = extensionCatalog.get(registration.extensionId);
            if (artifact === undefined) continue;
            const handler = resolveHandler(artifact, registration.handler) as (input: {
              candidates: typeof candidates;
            }) => readonly {
              code: string;
              severity: "error" | "warning";
              message: string;
              path?: string;
              candidateIndex?: number;
            }[];
            issues.push(...handler({ candidates }));
          }
          return issues;
        },
      },
    ],
    routes: routeOps,
  });
  const jobs = createJobsService(pool, { clock });
  const plans = createPublicationPlanService(pool, { clock, changesets, publications, jobs });
  const calendar = createPublicationCalendarService(pool, { clock, plans });
  const previewTokens =
    input.previewSecret === undefined
      ? null
      : createPreviewTokenService({
          secret: input.previewSecret,
          ttlMilliseconds: input.previewTtlMilliseconds ?? 3_600_000,
          clock,
        });
  const previewState = createPreviewStateResolver({
    revisions: revisionReader,
    changesets,
    clock,
  });

  // --- media (M05). ---
  const mediaDiscovery = createMediaDiscoveryService(pool);
  const mediaPresets = createMediaPresetRegistry(input.mediaPresets ?? []);
  // Extension Contract 2.0 (P1-a): extension media-usage contributors are
  // wired AFTER the extension composition below (let-binding + late init).
  let extensionSourceContext: ((extensionId: string) => unknown) | null = null;
  const mediaUsage = createMediaUsageService({
    // Inbound-reference scan: a LIKE prefilter bounds the candidate set,
    // then an exact JSON walk confirms real occurrences (ponytail: fine at
    // v1 corpus sizes; add a trigram index when profiles demand it).
    async listInboundReferences(mediaId) {
      const candidates = await pool.query<{ entity_id: string; payload: unknown }>(
        `SELECT entity_id, payload FROM revisions
         WHERE payload::text LIKE $1 AND payload::text LIKE '%' || $2 || '%'
         LIMIT 500`,
        ["%", mediaId],
      );
      const references: {
        sourceEntryId: string;
        sourcePath: string;
        origin: "field" | "block" | "external" | "theme_settings" | "seo";
      }[] = [];
      for (const row of candidates.rows) {
        scanForValue(row.payload, "", mediaId, [], (path, kinds) => {
          references.push({
            sourceEntryId: row.entity_id,
            sourcePath: path,
            origin: kinds.includes("blocks") ? "block" : "field",
          });
        });
      }
      // Global reference graph (owner UX pass 0.1.28): media-typed theme
      // settings and SEO/social images are consumers too — a full audit
      // must see them or "unused" lies.
      const themeState = await pool
        .query<{ theme_key: string | null; settings: unknown }>(
          `SELECT theme_key, settings FROM admin_theme_state
         WHERE settings::text LIKE '%' || $1 || '%' LIMIT 1`,
          [mediaId],
        )
        .catch(() => ({ rows: [] as { theme_key: string | null; settings: unknown }[] }));
      for (const row of themeState.rows) {
        scanForValue(row.settings, "", mediaId, [], (path) => {
          references.push({
            sourceEntryId: `theme:${row.theme_key ?? ""}`,
            sourcePath: path,
            origin: "theme_settings",
          });
        });
      }
      const seoDocs = await pool
        .query<{ entry_id: string; payload: unknown }>(
          `SELECT entry_id, payload FROM seo_documents
         WHERE payload::text LIKE '%' || $1 || '%' LIMIT 100`,
          [mediaId],
        )
        .catch(() => ({ rows: [] as { entry_id: string; payload: unknown }[] }));
      for (const row of seoDocs.rows) {
        scanForValue(row.payload, "", mediaId, [], (path) => {
          references.push({
            sourceEntryId: row.entry_id,
            sourcePath: path,
            origin: "seo",
          });
        });
      }
      // Extension contributors (ADR-0018 §5): fail-CLOSED — a broken source
      // must block the delete, never hide a reference. Resolved per call:
      // Disabled/uninstalled data retains its references; missing code cannot
      // turn an unverifiable graph into permission to delete.
      if (extensionSourceContext !== null) {
        const installations = await extensionLifecycle.listInstallations();
        const retained = await pool.query<{ key: string; value: string }>(
          "SELECT key, value FROM pcms_kernel_metadata WHERE starts_with(key, 'extension.retained_media:')",
        );
        const protectedIds = new Set([
          ...installations.map((installation) => installation.extensionId),
          ...retained.rows.map((row) => row.key.slice("extension.retained_media:".length)),
        ]);
        for (const extensionId of protectedIds) {
          const artifact = extensionCatalog.get(extensionId);
          if (artifact === undefined) {
            throw new MediaError(
              "MEDIA_IN_USE",
              `cannot verify retained media references of undeployed extension "${extensionId}"`,
            );
          }
          const saved = retained.rows.find(
            (row) => row.key === `extension.retained_media:${extensionId}`,
          );
          const savedSources =
            saved === undefined
              ? []
              : (JSON.parse(saved.value) as { source_id: string; handler: string }[]);
          const sources = new Map(
            [...savedSources, ...artifact.manifest.registrations.media_usage_sources].map(
              (source) => [source.source_id, source],
            ),
          );
          for (const source of sources.values()) {
            const handler = resolveHandler(artifact, source.handler) as (
              context: unknown,
              mediaId: string,
            ) => Promise<readonly { source_id: string; source_path: string }[]>;
            const context = (await extensionSourceContext(artifact.manifest.id)) as {
              extension: { config: Record<string, unknown> | null };
            } & Record<string, unknown>;
            const contributed = await handler(context, mediaId);
            for (const reference of contributed) {
              references.push({
                sourceEntryId: reference.source_id,
                sourcePath: reference.source_path,
                origin: "extension" as never,
              });
            }
          }
        }
      }
      return references;
    },
  });

  // --- seo (M06). ---
  const seo = createSeoStore(pool);
  const seoEnvironment: SeoEnvironment = input.seoEnvironment ?? "development";
  const defaultSiteKey = input.defaultSiteKey ?? "default";
  const environmentClassification = input.environmentClassification ?? "development";
  const releaseId = input.releaseId ?? null;
  const skillsDir = input.skillsDir ?? join(process.cwd(), "skills");
  const communitySkillsDir = input.communitySkillsDir ?? join(process.cwd(), "skills-community");
  const communitySkillsEnabled = input.communitySkillsEnabled ?? false;
  const registryIncomingDir = input.registryIncomingDir ?? "/opt/progressive-cms/incoming";
  const registryClient =
    input.registryBaseUrl === undefined
      ? null
      : createRegistryClient({
          baseUrl: input.registryBaseUrl,
          ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
          resolveInstanceToken: () => registryInstanceToken.read(),
          resolveAccountToken: () => registryAccountTokenRuntime.read(),
        });
  // Per-instance registry identity (2026-09-29, owner design): the code is
  // generated here, bound to the operator's registry account once via the
  // Registry v2 per-instance identity. Home: pcms_kernel_metadata — neutral
  // key-value with no FK to any extension (the previous E3-slot hack died on
  // its FK: uninstalling the carrier extension CASCADEd the binding away).
  // The CODE is not secret (owner decision: displayed in Admin for the account-area
  // claim flow). The TOKEN is a credential: stored base64(AES-256-GCM) with
  // the runtime secret box, never returned to clients, never logged.
  const registryIdentityRead = async (key: string): Promise<string | null> => {
    const row = await pool.query<{ value: string }>(
      "SELECT value FROM pcms_kernel_metadata WHERE key = $1",
      [key],
    );
    return row.rows[0]?.value ?? null;
  };
  const registryIdentityWrite = async (key: string, value: string): Promise<void> => {
    await pool.query(
      `INSERT INTO pcms_kernel_metadata (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  };
  const registryInstanceCode = {
    read: () => registryIdentityRead("registry.instance_code"),
    write: (value: string, _actor: string) =>
      registryIdentityWrite("registry.instance_code", value),
  };
  const registryAccountTokenRuntime = {
    available: input.runtimeSecretBox !== undefined,
    async read(): Promise<string | null> {
      const stored = await registryIdentityRead("registry.account_token");
      if (stored === null) return null;
      if (input.runtimeSecretBox === undefined) return null;
      return input.runtimeSecretBox.decrypt(Buffer.from(stored, "base64"));
    },
    async write(value: string, _actor: string): Promise<void> {
      if (input.runtimeSecretBox === undefined) {
        throw new ApiError(
          "REGISTRY_ACCOUNT_TOKEN_STORE_UNAVAILABLE",
          "runtime secrets key is not configured (integrations.runtimeSecretsEncryptionKeySecretRef)",
          { status: 503 },
        );
      }
      const enc = input.runtimeSecretBox.encrypt(value);
      await registryIdentityWrite("registry.account_token", enc.toString("base64"));
    },
    async clear(_actor: string): Promise<void> {
      await pool.query("DELETE FROM pcms_kernel_metadata WHERE key = 'registry.account_token'");
    },
  };
  const registryInstanceToken = {
    async read(): Promise<string | null> {
      const stored = await registryIdentityRead("registry.instance_token");
      if (stored === null) return null;
      if (input.runtimeSecretBox === undefined) return null;
      return input.runtimeSecretBox.decrypt(Buffer.from(stored, "base64"));
    },
    async write(value: string, _actor: string): Promise<void> {
      if (input.runtimeSecretBox === undefined) {
        throw new ApiError(
          "REGISTRY_INSTANCE_STORE_UNAVAILABLE",
          "runtime secrets key is not configured (integrations.runtimeSecretsEncryptionKeySecretRef)",
          { status: 503 },
        );
      }
      const enc = input.runtimeSecretBox.encrypt(value);
      await registryIdentityWrite("registry.instance_token", enc.toString("base64"));
    },
  };
  const primaryOrigin = async (): Promise<string | null> => {
    const bindings = await createDomainService(pool).listDomainBindings();
    const primary = bindings.find((binding) => binding.isPrimary) ?? bindings[0];
    return primary === undefined ? null : `https://${primary.hostname}`;
  };
  const seoCanonical: SeoCanonicalPort = {
    canonicalUrl: async (entryId, locale) => {
      // Without a primary domain binding there is no canonical absolute URL —
      // degrade to null instead of failing the whole resolve (M10 Admin SEO
      // tab found this no-domain deployment path). `locale` selects the
      // language version (opt-in multilingual; secondary routes carry the
      // BCP-47 code and are served under their path prefix).
      try {
        const site = await routes.findSiteByKey(defaultSiteKey);
        const localization = await createSiteLocalizationService(pool).get();
        const entry = await entries.findEntry(entryId as never);
        const effectiveLocale = locale ?? entry?.locale ?? "default";
        const members =
          site?.homeEntryId == null
            ? []
            : await entries.listTranslations(site.homeEntryId as never);
        if (site?.homeEntryId === entryId || members.some((member) => member.id === entryId)) {
          const origin = await primaryOrigin();
          const code =
            effectiveLocale === "default" || effectiveLocale === localization.defaultLocale
              ? "x-default"
              : effectiveLocale;
          return origin === null
            ? null
            : `${origin}${localizedRoutePath({ locale: code, path: "/" })}`;
        }
        const found = await canonical.findRouteByEntry(entryId, {
          ...(effectiveLocale === "default" ||
          effectiveLocale === "x-default" ||
          effectiveLocale === localization.defaultLocale
            ? {}
            : { locale: effectiveLocale }),
        });
        if (found.route === null) return null;
        const origin = await primaryOrigin();
        return origin === null
          ? null
          : `${origin}${localizedRoutePath({ locale: found.route.locale, path: found.route.path })}`;
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "DOMAIN_NOT_ALLOWED") return null;
        throw error;
      }
    },
  };
  // The site-identity store is keyed by the routing site UUID, while
  // defaultSiteKey is the site KEY ("default") — resolve once and cache
  // (bug found by the M10 Admin SEO tab; M09 discovery tests missed the seam).
  let siteIdCache: string | null | undefined;
  const resolveSiteId = async (): Promise<string | null> => {
    if (siteIdCache !== undefined) return siteIdCache;
    const site = await routes.findSiteByKey(defaultSiteKey);
    siteIdCache = site?.id ?? null;
    return siteIdCache;
  };
  // Core derivative materializers (OG contract §1/§7, 2026-10-03): og-v1 and
  // favicon-v1 generate ONLY at their semantic points — assignment of the
  // source reference, social preview, publication validate, publish — never
  // at upload and never on a public crawler request.
  const coreDerivativeDeps = () => {
    if (input.mediaStorage === undefined || input.mediaStorage === null) {
      throw new ApiError("MEDIA_STORAGE_UNCONFIGURED", "media storage is not configured", {
        status: 503,
      });
    }
    return { pool, storage: input.mediaStorage, maxSourceBytes: 128 * 1024 * 1024 };
  };
  const materializeCoreDerivative = async (
    assetId: string,
    presetId: "og-v1" | "favicon-v1",
  ): Promise<void> => {
    const asset = await getAsset(pool, assetId as never);
    if (asset === null || asset.kind !== "image" || asset.mimeType === "image/svg+xml") {
      throw new ApiError(
        "OG_IMAGE_SOURCE_INVALID",
        `media asset ${assetId} is not a raster image`,
        {
          status: 422,
        },
      );
    }
    await ensureCoreDerivative(coreDerivativeDeps(), asset, mediaPresets, presetId);
  };
  /**
   * Reads a declared `media` field as a stable asset reference. The field's
   * persisted value is the asset ID STRING (Media spec §4; the validators,
   * collections feed and card builder all read it that way) — the earlier
   * `typeof === "object"` test therefore never matched, which silently made
   * the hero branch of the OG chain dead (CORE-RC19 B discovery). Both shapes
   * are accepted so an object-form payload written by an older integration
   * keeps working.
   */
  const mediaRefOf = (value: unknown): { asset_id: string } | null => {
    if (typeof value === "string") return value === "" ? null : { asset_id: value };
    if (value !== null && typeof value === "object") {
      const assetId = (value as { asset_id?: unknown }).asset_id;
      return typeof assetId === "string" && assetId !== "" ? { asset_id: assetId } : null;
    }
    return null;
  };
  /**
   * Effective social image inherited from the nearest ancestor section
   * (CORE-RC19 B). Walks the Content Tree upward and returns the first
   * ancestor that yields an image, taking that ancestor's EXPLICIT social
   * image before its hero/featured image — the same priority the entry itself
   * gets. Resolution only: nothing is written to the descendants, so changing
   * a section image is visible on the next read and a whole subtree is not
   * rewritten (no migration wave). Unpublished ancestors are skipped: a draft
   * section must not leak an unreleased image into live pages. The walk is
   * bounded and cycle-safe (getAncestors includes a depth limit).
   *
   * Skipped entirely when the entry resolves its own image — an explicit
   * social image or its own hero outranks inheritance, so the walk (and its
   * per-ancestor queries) must not run for the common case.
   */
  const inheritedSectionImage = async (
    entryId: string,
    locale: string,
  ): Promise<{ asset_id: string } | null> => {
    const own = await seo.getDocument(entryId).catch(() => null);
    if (own?.social_image != null) return null;
    const ancestors = await contentTree.getAncestors(entryId as never).catch(() => [] as string[]);
    // Root-first → nearest ancestor first.
    for (const ancestorId of [...ancestors].reverse()) {
      const image = await sectionImageOf(ancestorId as string, locale);
      if (image !== null) return image;
    }
    return null;
  };
  const sectionImageOf = async (
    entryId: string,
    locale: string,
  ): Promise<{ asset_id: string } | null> => {
    const published = await pool
      .withTransaction((tx) =>
        publications.getPublishedRevision(tx, "entry", entryId as never, locale),
      )
      .catch(() => null);
    if (published === null) return null;
    // An explicit section SEO image outranks the section's featured image.
    const document = await seo.getDocument(entryId).catch(() => null);
    if (document?.social_image != null) return { asset_id: document.social_image.asset_id };
    const fields = ((published.payload ?? {}) as { fields?: Record<string, unknown> }).fields ?? {};
    return mediaRefOf(fields.hero_image);
  };
  const seoDiscovery = createSeoDiscovery({
    store: seo,
    environment: seoEnvironment,
    getSiteIdentity: async () => {
      const siteId = await resolveSiteId();
      return siteId === null ? null : seo.getSiteSettings(siteId);
    },
    getOrigin: primaryOrigin,
    canonical: seoCanonical,
    getFacts: async (entryId, context) => {
      const entry = await entries.findEntry(entryId as never);
      if (entry === null) return null;
      const locale =
        context?.locale == null || context.locale === "default" || context.locale === "x-default"
          ? entry.locale
          : await createSiteLocalizationService(pool).contextFor(context.locale);
      // Identity repair preserves SEALED locale history. Editorial SEO may
      // use the revision pinned by this identity's publication when no
      // working/latest revision exists in the repaired locale.
      const publishedFallback =
        context?.revisionId === undefined && context?.published !== true
          ? await pool.withTransaction((tx) =>
              publications.getPublishedRevision(tx, "entry", entryId as never, locale),
            )
          : null;
      const revision =
        context?.revisionId !== undefined
          ? await revisions.getRevision(pool, context.revisionId as never)
          : context?.published === true
            ? await pool.withTransaction((tx) =>
                publications.getPublishedRevision(tx, "entry", entryId as never, locale),
              )
            : ((await revisions.findWorkingRevision(pool, "entry", entryId as never, locale)) ??
              (
                await revisions.listRevisions(pool, "entry", entryId as never, { limit: 1, locale })
              )[0] ??
              publishedFallback);
      if (
        revision == null ||
        revision.entityType !== "entry" ||
        revision.entityId !== entryId ||
        (revision.locale !== locale && revision !== publishedFallback)
      )
        return null;
      const fields = (revision.payload as { fields?: Record<string, unknown> }).fields ?? {};
      // Publication-contract times (§35/§55) for the article structured-data
      // family: first publication and the contract modified_at (set only when
      // the published payload changed) — never file mtimes. Dates describe
      // the entry's live publication state, so the record is read for every
      // facts context, including exact-revision inspection.
      const publication = await publications.getPublication(
        pool,
        "entry",
        entryId as never,
        locale,
      );
      return {
        page_title: typeof fields.title === "string" ? (fields.title as string) : null,
        intro: typeof fields.intro === "string" ? (fields.intro as string) : null,
        hero_image: mediaRefOf(fields.hero_image),
        // Only consulted when the entry has neither an explicit social image
        // nor its own hero — the resolver keeps that priority order, and the
        // tree walk is skipped entirely when the entry has a hero.
        inherited_social_image:
          mediaRefOf(fields.hero_image) !== null
            ? null
            : await inheritedSectionImage(entryId, locale),
        content_type_key: entry.contentTypeId,
        ...(publication?.state === "PUBLISHED"
          ? {
              published_at: publication.firstPublishedAt?.toISOString() ?? null,
              modified_at: publication.modifiedAt?.toISOString() ?? null,
            }
          : {}),
      };
    },
    // Social images resolve to the current-document media URL composed with
    // the routing primary origin (never a request Host, spec §61).
    // Favicon and social images are IMAGES: Media §33 deliberately never
    // serves image originals through the document/current grammar, so both
    // ports resolve through the SAME generated-variant composition the rest
    // of the public media transport serves (R16, 2026-10-03 site-developer
    // report: a document-URL favicon 404ed by design). Best browser-safe
    // format first (png → webp → avif → jpeg), then the largest variant.
    // Explicit contract (OG rework, 2026-10-03): og:image and favicon resolve
    // ONLY their core derivative (og-v1 / favicon-v1) when it exists — the
    // renderer never generates, never falls back to heuristics. Absence is
    // reflected by validation; materialization happens at assignment /
    // social preview / publication validate / publish.
    socialImage: {
      resolveSocialImage: async (ref) => {
        const asset = await getAsset(pool, ref.asset_id as never);
        if (asset === null || asset.kind !== "image") return null;
        const variant = await findCoreDerivative(
          pool,
          asset.id,
          asset.currentVersionNo,
          OG_IMAGE_PRESET_ID,
        );
        if (variant === null) return null;
        const origin = await primaryOrigin();
        return {
          asset_id: asset.id,
          version: asset.currentVersionNo,
          url: `${origin ?? ""}${variantPublicUrl({
            assetId: asset.id,
            versionNo: variant.versionNo,
            presetId: variant.presetId,
            variantKey: variant.variantKey,
            format: variant.format,
          })}`,
          width: variant.width,
          height: variant.height,
          mime_type: `image/${variant.format}`,
          alt: asset.altDefault ?? null,
        };
      },
    },
    materializeSocialDerivative: async (ref: { readonly asset_id: string }) => {
      await materializeCoreDerivative(ref.asset_id, OG_IMAGE_PRESET_ID);
    },
    favicon: {
      resolveFavicon: async (ref) => {
        const asset = await getAsset(pool, ref.asset_id as never);
        if (asset === null || asset.kind !== "image") return null;
        const variant = await findCoreDerivative(
          pool,
          asset.id,
          asset.currentVersionNo,
          FAVICON_PRESET_ID,
        );
        if (variant === null) return null;
        const origin = await primaryOrigin();
        return {
          asset_id: asset.id,
          version: asset.currentVersionNo,
          url: `${origin ?? ""}${variantPublicUrl({
            assetId: asset.id,
            versionNo: variant.versionNo,
            presetId: variant.presetId,
            variantKey: variant.variantKey,
            format: variant.format,
          })}`,
          width: variant.width,
          height: variant.height,
          mime_type: "image/png",
        };
      },
    },
    // Site Identity logo resolves ONLY its logo-v1 core derivative (same
    // contract as og-v1/favicon-v1): generated at identity assignment, the
    // renderer never generates, absence omits the Organization logo.
    logo: {
      resolveLogo: async (ref) => {
        const asset = await getAsset(pool, ref.asset_id as never);
        if (asset === null || asset.kind !== "image") return null;
        const variant = await findCoreDerivative(
          pool,
          asset.id,
          asset.currentVersionNo,
          LOGO_PRESET_ID,
        );
        if (variant === null) return null;
        const origin = await primaryOrigin();
        return {
          asset_id: asset.id,
          version: asset.currentVersionNo,
          url: `${origin ?? ""}${variantPublicUrl({
            assetId: asset.id,
            versionNo: variant.versionNo,
            presetId: variant.presetId,
            variantKey: variant.variantKey,
            format: variant.format,
          })}`,
          width: variant.width,
          height: variant.height,
          mime_type: "image/png",
        };
      },
    },
    // M17 §44: sitemap candidates = canonical published entry routes plus the
    // homepage binding; noindex comes from each entry's SEO document.
    getSitemapCandidates: async () => {
      // Locale-aware (opt-in multilingual): publications join on the route's
      // locale context (legacy sentinels 'x-default'/'default' match);
      // secondary routes emit their prefixed public path; reciprocal
      // alternates come from the entry's translation group — published
      // members only, drafts never leak into the sitemap.
      const localizationSettings = await createSiteLocalizationService(pool).get();
      const site = await routes.findSiteByKey(defaultSiteKey);
      const homeMembers =
        site?.homeEntryId == null ? [] : await entries.listTranslations(site.homeEntryId as never);
      const homeIds = new Set(homeMembers.map((member) => member.id as string));
      const localeCode = (raw: string): string =>
        raw === "x-default" || raw === "default" || raw === ""
          ? localizationSettings.defaultLocale
          : raw;
      const publicPath = (entryId: string, routeLocale: string, path: string): string =>
        localizedRoutePath({
          locale: routeLocale === localizationSettings.defaultLocale ? "x-default" : routeLocale,
          path: homeIds.has(entryId) ? "/" : path,
        });
      const result = await pool.query<{
        entry_id: string;
        path: string;
        route_locale: string;
        published_at: Date | null;
        seo_payload: unknown;
      }>(
        `SELECT r.target_id::text AS entry_id, r.path, r.locale AS route_locale, p.published_at, sd.payload AS seo_payload
         FROM routes r
         JOIN publications p ON p.entity_type = 'entry' AND p.entity_id::text = r.target_id AND p.state = 'PUBLISHED'
            AND p.context = CASE WHEN r.locale IN ('x-default', 'default') THEN 'default' ELSE r.locale END
         LEFT JOIN seo_documents sd ON sd.entry_id::text = r.target_id
         WHERE r.retired_at IS NULL AND r.is_canonical AND r.target_type = 'entry'
         UNION ALL
         SELECT he.id::text, '/', CASE WHEN he.locale IN ('default', 'x-default', $1) THEN 'x-default' ELSE he.locale END, hp.published_at, shd.payload
         FROM sites s
         JOIN entries home ON home.id = s.home_entry_id
         JOIN entries he ON COALESCE(he.translation_group_id, he.id) = COALESCE(home.translation_group_id, home.id)
         JOIN publications hp ON hp.entity_type = 'entry' AND hp.entity_id = he.id AND hp.state = 'PUBLISHED'
            AND hp.context = CASE WHEN he.locale IN ('default', 'x-default', $1) THEN 'default' ELSE he.locale END
         LEFT JOIN seo_documents shd ON shd.entry_id = he.id
         WHERE s.home_entry_id IS NOT NULL`,
        [localizationSettings.defaultLocale],
      );
      // Translation groups of the routed entries → alternates.
      const entryIds = result.rows.map((row) => row.entry_id);
      const alternatesByGroup = new Map<string, { hreflang: string; href: string }[]>();
      const groupOf = new Map<string, string>();
      if (entryIds.length > 0) {
        const members = await pool.query<{
          entry_id: string;
          group_id: string;
          entry_locale: string;
          path: string | null;
          route_locale: string | null;
        }>(
          `SELECT e.id::text AS entry_id,
                  COALESCE(e.translation_group_id::text, e.id::text) AS group_id,
                  e.locale AS entry_locale,
                  r.path AS path, r.locale AS route_locale
           FROM entries e
           JOIN publications mp ON mp.entity_type = 'entry' AND mp.entity_id = e.id AND mp.state = 'PUBLISHED'
              AND mp.context = CASE WHEN e.locale IN ('x-default', 'default') THEN 'default' ELSE e.locale END
           LEFT JOIN routes r ON r.target_id = e.id::text AND r.retired_at IS NULL AND r.is_canonical AND r.target_type = 'entry'
              AND r.locale = CASE WHEN e.locale IN ('x-default', 'default') THEN 'x-default' ELSE e.locale END
           WHERE COALESCE(e.translation_group_id::text, e.id::text) IN (
             SELECT COALESCE(translation_group_id::text, id::text) FROM entries WHERE id::text = ANY($1::text[])
           )`,
          [entryIds],
        );
        const origin = await primaryOrigin();
        for (const row of members.rows) {
          groupOf.set(row.entry_id, row.group_id);
          if (!homeIds.has(row.entry_id) && (row.path === null || row.route_locale === null))
            continue;
          const href = `${origin ?? ""}${publicPath(row.entry_id, row.route_locale ?? row.entry_locale, row.path ?? "/")}`;
          const group = alternatesByGroup.get(row.group_id) ?? [];
          group.push({
            hreflang: localeCode(row.entry_locale),
            href,
          });
          alternatesByGroup.set(row.group_id, group);
        }
      }
      const candidates = result.rows.map((row) => {
        const alternates = alternatesByGroup.get(groupOf.get(row.entry_id) ?? row.entry_id);
        return {
          entryId: row.entry_id,
          path: publicPath(row.entry_id, row.route_locale, row.path),
          lastmod: row.published_at == null ? null : new Date(row.published_at).toISOString(),
          noindex: isNoindex(
            (row.seo_payload as { robots_policy?: never } | null)?.robots_policy ?? null,
          ),
          eligibility: { public: true, http200: true },
          ...(alternates === undefined ? {} : { alternates }),
        };
      });
      // Extension sitemap sources (ADR-0018 §4): cursor/batch with a global
      // ceiling; a failing source is skipped for this run (search/sitemap is
      // derived — the next publication or reindex retries it).
      if (extensionSourceContext !== null) {
        const enabled = await extensionLifecycle.enabledIds();
        for (const artifact of extensionCatalog.list()) {
          if (!enabled.includes(artifact.manifest.id)) continue;
          for (const source of artifact.manifest.registrations.sitemap_sources) {
            try {
              const handler = resolveHandler(artifact, source.handler) as (
                context: unknown,
                cursor: string | null,
              ) => Promise<{
                items: readonly {
                  path: string;
                  lastmod: string | null;
                  noindex: boolean;
                  locale?: string;
                }[];
                cursor: string | null;
              }>;
              const context = (await extensionSourceContext(artifact.manifest.id)) as {
                readonly site: { readonly defaultLocale: string };
              };
              // Canonical URL policy (CORE-SHOP-SEO-01): source paths are
              // mount-relative; the canonical URL is built from the ACTIVE
              // mount — a mount move re-canonicalizes every URL.
              const mount = await extensionRouteMounts.activeFor(artifact.manifest.id);
              if (mount === null) continue;
              const localization = await createSiteLocalizationService(pool).get();
              let cursor: string | null = null;
              let guard = 0;
              do {
                const page = await handler(context, cursor);
                for (const item of page.items) {
                  // PREPUBLIC §3: sitemap candidates derive through the ONE
                  // extensionCanonicalPath builder (byte-identical to HTTP
                  // canonical and search document routes).
                  const locale =
                    item.locale === undefined ||
                    item.locale === "default" ||
                    item.locale === "x-default"
                      ? localization.defaultLocale
                      : item.locale;
                  if (
                    !(
                      localization.enabled ? localization.locales : [localization.defaultLocale]
                    ).includes(locale) ||
                    !isExtensionPublicPage(artifact, item.path)
                  )
                    continue;
                  const canonicalPath = extensionCanonicalPath({
                    mountPath: mount.mountPath,
                    extensionId: artifact.manifest.id,
                    path: item.path,
                    locale,
                    defaultLocale: localization.defaultLocale,
                  });
                  candidates.push({
                    entryId: `${artifact.manifest.id}/${source.source_id}:${canonicalPath}`,
                    path: canonicalPath,
                    lastmod: item.lastmod,
                    noindex: item.noindex === true,
                    eligibility: { public: true, http200: true },
                  });
                }
                cursor = page.cursor;
                guard += 1;
              } while (cursor !== null && guard < 100);
            } catch {
              // derived-surface tolerance (see comment above)
            }
          }
        }
      }
      return [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
    },
    // M17 §45: robots.txt carries the sitemap directive once a primary
    // domain binding exists.
    getRobotsPolicy: async () => {
      const origin = await primaryOrigin();
      return defaultRobotsTxtPolicy({
        sitemapUrl: origin === null ? null : `${origin}/sitemap.xml`,
      });
    },
  });

  // --- navigation/routing (M04). ---
  const navigation = createNavigationService(pool);
  const placements = createPlacementBindingService(pool, navigation);

  // --- search (M11): derived projection, composed over authoritative
  // state. The source joins publications/revisions/entries/routes/SEO;
  // the provider is the dumb index; failures stay inside the outbox/jobs
  // retry cycle and never fail a content or publication operation. ---
  const searchComposition = {
    pool,
    contentTypes,
    seoEnvironment,
    getDefaultLocale: async () => (await createSiteLocalizationService(pool).get()).defaultLocale,
  };
  const baseSearchSource = createSearchDocumentSource(searchComposition);
  // Extension Contract 2.0 / PREPUBLIC §2: one unified phased source — "entry"
  // first, then "<extensionId>/<source_id>" per enabled extension search
  // source; "<ext>/<source>" buildDocument calls delegate to the extension
  // handler with the ACTIVE-mount canonical route (CORE-SHOP-SEO-01).
  const searchSource = createExtensionAwareSearchSource({
    base: baseSearchSource,
    catalog: {
      get: (extensionId) => extensionCatalog.get(extensionId),
      list: () => extensionCatalog.list(),
    },
    enabledIds: () => extensionLifecycle.enabledIds(),
    sourceContext: (extensionId) =>
      extensionSourceContext === null ? null : extensionSourceContext(extensionId),
    activeMountPath: async (extensionId) =>
      (await extensionRouteMounts.activeFor(extensionId))?.mountPath ?? null,
    getLocalization: async () => {
      const localization = await createSiteLocalizationService(pool).get();
      return {
        defaultLocale: localization.defaultLocale,
        enabledLocales: localization.enabled ? localization.locales : [localization.defaultLocale],
      };
    },
  });
  const searchResultMetadata = createSearchResultMetadata(searchComposition);

  // Analytics & tagging (ADR-0016): first-party provider registry +
  // CAS-cached settings + render-plan injection. The registry is
  // composition-time (trusted/static) — extension provider modules may
  // register here at composition, never at runtime.
  const analyticsRegistry = createAnalyticsRegistry();
  for (const provider of FIRST_PARTY_PROVIDERS) analyticsRegistry.registerProvider(provider);
  const analyticsCache: { settings: import("@pcms/analytics").AnalyticsSettings | null } = {
    settings: null,
  };
  void (async () => {
    try {
      const result = await pool.query<{ settings: import("@pcms/analytics").AnalyticsSettings }>(
        "SELECT settings FROM analytics_settings WHERE site_key = $1",
        [defaultSiteKey],
      );
      analyticsCache.settings = result.rows[0]?.settings ?? null;
    } catch {
      // Pre-migration database (tests boot subsets): analytics stays disabled.
    }
  })();
  const analyticsService = {
    registry: analyticsRegistry,
    loadSettings: async () => {
      const result = await pool.query<{
        settings: import("@pcms/analytics").AnalyticsSettings;
        settings_generation: number;
      }>("SELECT settings, settings_generation FROM analytics_settings WHERE site_key = $1", [
        defaultSiteKey,
      ]);
      const row = result.rows[0];
      if (row === undefined) {
        return {
          settings: defaultAnalyticsSettings(),
          generation: 0,
        };
      }
      return { settings: row.settings, generation: row.settings_generation };
    },
    cachedSettings: () => analyticsCache.settings,
    updateCachedSettings: (settings: import("@pcms/analytics").AnalyticsSettings | null) => {
      analyticsCache.settings = settings;
    },
    buildInjection: (
      settings: import("@pcms/analytics").AnalyticsSettings,
      page: import("@pcms/analytics").AnalyticsPageContext,
    ) => buildSystemDocumentInjection(settings, analyticsRegistry, page),
    doctor: (settings: import("@pcms/analytics").AnalyticsSettings) =>
      analyticsDoctor(settings, analyticsRegistry, {
        probe: (probeSettings, probePage) => {
          const injection = buildSystemDocumentInjection(
            probeSettings,
            analyticsRegistry,
            probePage,
          );
          if (injection === null) {
            return {
              html: "",
              headEarlyPresent: false,
              bodyStartPresent: false,
              dataLayerBeforeGtm: false,
              duplicates: [],
            };
          }
          let html = "<!doctype html><html><head></head><body></body></html>";
          html = injectAfterOpeningTag(html, "head", injection.headEarlyHtml);
          html = injectAfterOpeningTag(html, "body", injection.bodyStartHtml);
          const occurrences = (needle: string) => html.split(needle).length - 1;
          return {
            html,
            headEarlyPresent:
              html.includes("data-pcms-analytics") || injection.headEarlyHtml.length > 0,
            bodyStartPresent:
              injection.bodyStartHtml === "" ? true : html.includes(injection.bodyStartHtml),
            dataLayerBeforeGtm:
              !injection.dataLayerUsed ||
              (html.indexOf("window.dataLayer") >= 0 &&
              html.indexOf("googletagmanager.com/gtm.js") === -1
                ? true
                : html.indexOf("window.dataLayer") < html.indexOf("googletagmanager.com/gtm.js")),
            duplicates: ["mc.yandex.ru/metrika/tag.js", "googletagmanager.com/gtm.js"].filter(
              (needle) => occurrences(needle) > 1,
            ),
          };
        },
      }),
  };
  // The reindex chunk chain rides the M07 durable jobs queue — without this
  // seam the first chunk job is never enqueued and a reindex run stays
  // BUILDING forever (found by the M15 production search-index fix).
  const searchReindex = createSearchReindexService({
    pool,
    source: searchSource,
    jobs: {
      enqueue: (input) => jobs.enqueue(input),
    },
  });
  const searchProvider = createPgSearchProvider({
    pool,
    reindex: () => searchReindex.runSynchronously(),
    extensionRoutes: async (locale) => {
      const enabled = await extensionLifecycle.enabledIds();
      const localization = await createSiteLocalizationService(pool).get();
      if (
        !(localization.enabled ? localization.locales : [localization.defaultLocale]).includes(
          locale,
        )
      )
        return [];
      const scopes: {
        entityType: string;
        routePrefix: string;
        routePattern: string;
        priority: number;
        publicPage: boolean;
      }[] = [];
      for (const artifact of extensionCatalog.list()) {
        if (!enabled.includes(artifact.manifest.id)) continue;
        const mount = await extensionRouteMounts.activeFor(artifact.manifest.id);
        if (mount === null) continue;
        const prefix = extensionCanonicalPath({
          mountPath: mount.mountPath,
          extensionId: artifact.manifest.id,
          path: "/",
          locale,
          defaultLocale: localization.defaultLocale,
        });
        for (const source of artifact.manifest.registrations.search_sources) {
          for (const [priority, route] of artifact.manifest.registrations.http_routes.entries()) {
            if (route.method !== "GET") continue;
            const parts = route.path.split("/").filter(Boolean);
            const wildcard = parts.findIndex((part) => part.startsWith("*"));
            const pattern = (wildcard < 0 ? parts : parts.slice(0, wildcard + 1))
              .map((part) =>
                part.startsWith("*")
                  ? ".*"
                  : part.startsWith(":")
                    ? "[^/]+"
                    : part.replaceAll("*", "\\*"),
              )
              .join("/");
            scopes.push({
              entityType: `${artifact.manifest.id}/${source.source_id}`,
              routePrefix: prefix,
              routePattern: `^/${pattern}/?$`,
              priority,
              publicPage: route.visibility === "public" && route.view !== undefined,
            });
          }
        }
      }
      return scopes;
    },
  });
  const searchIndexing = createSearchIndexingService({
    provider: searchProvider,
    source: searchSource,
    pool,
    clock,
  });
  // IndexNow v1: settings cache (key route) + publication planner + delivery.
  // Everything gates on `enabled` — a disabled site makes zero outbound
  // requests, serves no key route and delivers no pending rows.
  const indexNowCache: { settings: import("@pcms/seo").IndexNowSettings | null } = {
    settings: null,
  };
  void (async () => {
    try {
      const result = await pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM seo_indexnow_settings WHERE site_key = $1",
        [defaultSiteKey],
      );
      const row = result.rows[0];
      if (row === undefined) {
        indexNowCache.settings = null;
      } else {
        const { status: _stripped, ...config } = row.settings;
        indexNowCache.settings = parseIndexNowSettings(config);
      }
    } catch {
      indexNowCache.settings = null; // pre-migration database: disabled
    }
  })();
  const indexNowDomains = createDomainService(pool);
  const indexNowAppLike = {
    pool,
    defaultSiteKey,
    routes,
    domains: indexNowDomains,
    canonical,
    seoEnvironment: input.seoEnvironment ?? "production",
    jobs,
  } as never;
  const indexNowService = {
    cachedEnabledKey: async () => {
      // Read-through: a settings row created before this process booted (or
      // while the boot probe lost a race) must not leave the key route dead.
      if (indexNowCache.settings === null) {
        try {
          const result = await pool.query<{ settings: Record<string, unknown> }>(
            "SELECT settings FROM seo_indexnow_settings WHERE site_key = $1",
            [defaultSiteKey],
          );
          const row = result.rows[0];
          if (row === undefined) {
            indexNowCache.settings = null;
          } else {
            // The row carries the delivery-status sub-document — strip it
            // before strict validation (same as the ops read path).
            const { status: _stripped, ...config } = row.settings;
            indexNowCache.settings = parseIndexNowSettings(config);
          }
        } catch {
          indexNowCache.settings = null;
        }
      }
      const settings = indexNowCache.settings;
      return settings === null
        ? { enabled: false, key: null }
        : { enabled: settings.enabled, key: settings.key };
    },
    updateCachedSettings: (settings: import("@pcms/seo").IndexNowSettings | null) => {
      indexNowCache.settings = settings;
    },
    handlePublicationEvent: (event: { readonly eventType: string; readonly payload: unknown }) =>
      planIndexNowForPublicationEvent(indexNowAppLike, event as never),
    deliverPending: () => deliverIndexNowPending(indexNowAppLike),
  };
  const searchQuery = createPublicSearchOperation({
    provider: searchProvider,
    defaultSiteKey,
    getDefaultLocale: searchComposition.getDefaultLocale,
  });
  const searchAdmin = createAdminSearch({
    pool,
    defaultSiteKey,
    getDefaultLocale: searchComposition.getDefaultLocale,
    provider: searchProvider,
    mediaSearch: async (text, limit) => {
      const result = await mediaDiscovery.searchAssets({ text, limit });
      return result.items.map((asset) => ({
        asset_id: asset.id,
        filename: asset.filenameOriginal,
        kind: asset.kind,
      }));
    },
  });

  // --- forms/quizzes/leads (M12): interaction persistence + outbox events
  // via the M07 envelope; export audit rides the security-event stream. ---
  const formsSource = createFormsSource({ pool, clock });

  // --- integrations (M13): connector registry + delivery infrastructure.
  // Outbound HTTP goes through ONE guarded client (SSRF-pinned, redirect-
  // revalidating); the email transport and payment providers are injected
  // by the composition root; secrets resolve by NAME from the M01 channel.
  const integrationSecretResolver: SecretResolver = (name) => input.secrets?.get(name);
  const integrationsRegistry = createConnectorRegistry();
  registerFirstPartyConnectorDefinitionsV1(integrationsRegistry);
  const integrationsRuntimes = new ConnectorRuntimeRegistry();
  const guardedHttp = createGuardedHttp(input.integrationHttpPolicy ?? {});
  if (input.mailTransport !== undefined) {
    integrationsRuntimes.register("email", createEmailConnectorRuntime(input.mailTransport));
  }
  integrationsRuntimes.register("telegram", createTelegramConnectorRuntime(guardedHttp));
  integrationsRuntimes.register("nextcloud-talk", createTalkConnectorRuntime(guardedHttp));
  integrationsRuntimes.register(
    "webhook-http",
    createWebhookConnectorRuntime(guardedHttp, guardedHttp.guard),
  );
  integrationsRuntimes.register("progressive-hq", createProgressiveHqConnectorRuntime(guardedHttp));
  integrationsRuntimes.register("bitrix24", createBitrix24ConnectorRuntime(guardedHttp));
  integrationsRuntimes.register("amocrm", createAmocrmConnectorRuntime(guardedHttp));
  integrationsRuntimes.register("hubspot", createHubspotConnectorRuntime(guardedHttp));
  integrationsRuntimes.register("pipedrive", createPipedriveConnectorRuntime(guardedHttp));
  integrationsRuntimes.register("zoho-crm", createZohoCrmConnectorRuntime(guardedHttp));
  integrationsRuntimes.register("sharecrm", createSharecrmConnectorRuntime(guardedHttp));
  integrationsRuntimes.register("salesforce", createSalesforceConnectorRuntime(guardedHttp));
  const integrationInstances = createIntegrationInstanceService({
    pool,
    clock,
    registry: integrationsRegistry,
  });
  const integrationBindings = createIntegrationBindingService({
    pool,
    clock,
    instances: integrationInstances,
    registry: integrationsRegistry,
  });
  const interactionPrivacy = createInteractionPrivacyService(pool, { clock });
  const integrationDeliveries = createDeliveryService({
    pool,
    clock,
    privacyGuard: interactionPrivacy.deliveryBlocked,
  });
  const inboundContracts = new InboundContractRegistry();
  const integrationInbound = createInboundService({ pool, clock, contracts: inboundContracts });
  const integrationDispatcher = createIntegrationDispatcher({
    clock,
    registry: integrationsRegistry,
    runtimes: integrationsRuntimes,
    bindings: integrationBindings,
    instances: integrationInstances,
    deliveries: integrationDeliveries,
    secretResolver: integrationSecretResolver,
    // Admin-managed runtime secrets (PCMS-OPS-T131) overlay env/file refs.
    ...(input.runtimeSecretBox === undefined
      ? {}
      : {
          runtimeSecretSource: (instanceId: string) =>
            loadInstanceRuntimeSecrets(pool, input.runtimeSecretBox, instanceId),
        }),
    // M12→M13 projection precedence: an explicitly injected projection source
    // wins; otherwise the default adapter projects allowlisted fields through
    // the M12 FormsSource boundary (integrations never reads Forms tables).
    projectionSource: input.integrationProjection ?? createFormsProjectionSource(formsSource),
  });
  const integrations: IntegrationsServices = {
    registry: integrationsRegistry,
    runtimes: integrationsRuntimes,
    instances: integrationInstances,
    bindings: integrationBindings,
    deliveries: integrationDeliveries,
    inbound: integrationInbound,
    inboundContracts,
    dispatcher: integrationDispatcher,
  };

  // --- extensions (M14): trusted deployed catalog + lifecycle state +
  // contract/version + deprecation registries + compatibility/update
  // preflight surfaces. The DB is not a package manager: executable code
  // enters ONLY through the composition-time catalog here. ---
  // The CMS build version resolves BEFORE theme discovery so embedded
  // manifest validation reports the real version instead of "unknown"
  // (/theme/state THEME_CMS_INCOMPATIBLE, 2026-10-04 site-developer report).
  const cmsVersion = input.cmsVersion ?? readCmsVersionFromRelease();
  const themeDiscoveryValue =
    input.themeDir === undefined || !existsSync(join(input.themeDir, "theme.json"))
      ? null
      : createThemeDiscovery(input.themeDir, { cmsVersion });
  // Seal-time feed checks see the ACTIVE theme (theme pointer → installed
  // package → configured renderDir). An unresolvable active theme degrades to
  // the boot-seed manifest: filesystem state must never block a seal.
  resolveActiveTheme = async () => {
    const presets = new Set<string>(mediaPresets.listPresets().map((preset) => preset.id));
    const configuredDir = input.themeDir;
    if (configuredDir === undefined) return { manifest: null, presets };
    const manifest = await resolveActiveThemeDirectory({
      db: pool,
      siteKey: defaultSiteKey,
      configuredDir,
      cmsVersion,
    })
      .then((dir) => createThemeDiscovery(dir, { cmsVersion }).getManifest())
      .catch(() => themeDiscoveryValue?.getManifest() ?? null);
    for (const preset of manifest?.media_presets ?? []) presets.add(preset.id);
    return { manifest, presets };
  };
  // Theme-declared block variants feed the single validation point
  // (2026-09-29: theme.json block_renderers[].variants were dead — content
  // validation rejected every variant, discovery reported []). The theme is
  // the variant SOURCE; the block registry stays the validation POINT.
  // Source = every installed theme in the themes root (renderDir + installed
  // candidates): validation, seal/preflight and candidate previews must
  // accept a candidate's variants BEFORE activation (2026-10-01
  // site-developer report). Runtime installs re-extend through
  // /themes/install; a variant no installed theme declares stays an error;
  // uninstalling does not retract already-admitted variants.
  if (input.themeDir !== undefined) {
    const themesRoot = dirname(input.themeDir);
    if (existsSync(themesRoot)) {
      for (const entry of readdirSync(themesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        try {
          extendThemeBlockVariants(blocks, join(themesRoot, entry.name));
        } catch {
          // Not a valid theme directory — contributes no variants.
        }
      }
    }
  }
  const extensionCatalog = input.extensionCatalog ?? createExtensionCatalog();
  const extensionSystemCapabilities =
    input.extensionSystemCapabilities ?? createCapabilityRegistry();
  if (input.extensionSystemCapabilities === undefined) {
    // First-party baseline capability when composition provides none.
    extensionSystemCapabilities.provide({
      key: "theme-contract",
      version: THEME_CONTRACT_VERSION,
      provider: "cms:themes",
    });
  }
  const extensionDeprecations = createDeprecationRegistry(input.extensionDeprecations ?? []);
  const contractVersions = createSystemContractVersionRegistry({
    cmsVersion,
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    extensionContractVersion: EXTENSION_CONTRACT_VERSION,
    restApiVersion: API_CONTRACT_VERSION,
    mcpProtocolVersion: input.mcpProtocolVersion ?? "2024-11-05",
    themeContractVersion: THEME_CONTRACT_VERSION,
    blockDocumentSchemaVersion: BLOCK_DOCUMENT_SCHEMA_VERSION,
    searchIndexVersion: SEARCH_INDEX_VERSION,
    bundleVersion: BUNDLE_VERSION,
    pcpubVersion: PCPUB_VERSION,
    pcmdVersion: PCMD_VERSION,
  });
  const extensionLifecycle = createExtensionLifecycleService({
    pool,
    clock,
    coreVersion: cmsVersion,
    catalog: extensionCatalog,
    systemCapabilities: extensionSystemCapabilities,
  });
  // ADR-0013 §52.5 + ADR-0017 R1: manifest permissions are validated, never
  // granted. Platform keys must already be registered (fail-closed at
  // composition); a package with `permission_namespace` may declare its OWN
  // `<namespace>.*` keys — they register here so enforcement/tokens/scopes
  // see one registry, with NO implicit grants to existing roles or service
  // accounts (granting stays an explicit operator action).
  const seenExtensionPermissionKeys = new Set<string>();
  for (const artifact of extensionCatalog.list()) {
    const manifest = artifact.manifest;
    const namespace = manifest.permission_namespace;
    for (const key of [
      ...manifest.permissions,
      ...manifest.registrations.operations.map((operation) => operation.permission),
    ]) {
      if (isRegisteredPermission(key)) continue;
      if (namespace === undefined || !key.startsWith(`${namespace}.`)) {
        throw new ApiError(
          "EXTENSION_PERMISSION_UNREGISTERED",
          `extension "${manifest.id}" declares unregistered permission "${key}"${
            namespace === undefined
              ? " (no permission_namespace declared)"
              : ` (outside its namespace "${namespace}")`
          }`,
          { status: 500 },
        );
      }
      if (!seenExtensionPermissionKeys.has(key)) {
        seenExtensionPermissionKeys.add(key);
        registerExtensionPermissions([{ key, summary: `${manifest.id} namespace key (${key})` }]);
      }
    }
    assertExtensionPermissionsRegistered(manifest);
  }

  // --- payments (M13): separate stateful bounded context sharing only the
  // secret channel and the inbound persistence boundary (no payments ->
  // integrations import; ADR-0005). Provider inbound contracts are exposed
  // through the integrations inbound registry so callbacks verify ->
  // persist/dedupe -> normalize before touching payment state.
  const paymentsRegistry = new PaymentProviderRegistry();
  /** Providers injected at composition (tests/embedders) — re-registered on
   * every composition rebuild; never subject to extension lifecycle. */
  const injectedPaymentProviders: readonly PaymentProvider[] = input.paymentProviders ?? [];
  /** Registers one provider's inbound callback contract (verify → dedupe →
   * normalize before payment state; ADR-0005). Reused by the async extension
   * composition fill below. */
  const registerPaymentInboundContract = (provider: PaymentProvider): void => {
    inboundContracts.register(`payment_provider:${provider.providerType}`, {
      payloadLimitBytes: 262_144,
      verify: async (request, context) => {
        const instance = await paymentInstances.get(context.sourceId);
        if (instance === null) {
          throw new PaymentError(
            "PAYMENT_PROVIDER_INSTANCE_NOT_FOUND",
            `provider instance ${context.sourceId} not found`,
          );
        }
        const values: Record<string, string> = {};
        for (const requirement of provider.secretRequirements) {
          const refName = instance.secretRefs[requirement];
          const value = refName === undefined ? undefined : integrationSecretResolver(refName);
          if (refName === undefined || value === undefined) {
            throw new PaymentError(
              "PAYMENT_REQUEST_INVALID",
              `secret "${requirement}" is not configured for provider instance "${instance.name}"`,
            );
          }
          values[requirement] = value;
        }
        provider.verifyCallback(request, { values });
      },
      // Malformed bodies must not crash the pipeline before verification
      // records a FAILED event — treat them as "no provider event id".
      extractEventId: (request) => {
        try {
          return provider.parseCallback(request).providerEventId;
        } catch {
          return null;
        }
      },
      parse: (request) => {
        const parsed = provider.parseCallback(request);
        return { eventType: `payment.${parsed.outcome.toLowerCase()}`, normalized: parsed };
      },
    });
  };
  const fakeProvider =
    input.registerFakePaymentProvider === true ? new FakePaymentProvider() : undefined;
  // S5/R3 (ADR-0017): concrete payment providers are trusted extension
  // packages composed from the catalog's payment_provider registrations of
  // ENABLED extensions (core ships no vendor adapter). The composition is
  // REVISION-GATED: every payment operation entry re-checks the lifecycle
  // revision — a disable in THIS or ANOTHER process rebuilds the registry
  // before the next operation, so a disabled provider reports
  // PAYMENT_PROVIDER_UNKNOWN immediately (history stays fully readable).
  let paymentsCompositionRevision: string | null = null;
  let paymentsCompositionChain: Promise<void> = Promise.resolve();
  const composePaymentProviders = (): Promise<void> => {
    const run = async (): Promise<void> => {
      let revision: string;
      try {
        revision = await extensionLifecycle.revision();
      } catch {
        return; // pre-M14 database: zero providers, fail-closed
      }
      if (revision === paymentsCompositionRevision) return;
      let enabledExtensionIds: string[] = [];
      try {
        enabledExtensionIds = await extensionLifecycle.enabledIds();
      } catch {
        enabledExtensionIds = [];
      }
      const composed: PaymentProvider[] = [];
      for (const registration of composeExtensionRegistrations(
        extensionCatalog,
        enabledExtensionIds,
      ).registrations) {
        if (registration.kind !== "provider" || registration.registry !== "payment_provider") {
          continue;
        }
        const artifact = extensionCatalog.get(registration.extensionId);
        if (artifact === undefined) continue;
        composed.push(resolveHandler(artifact, registration.handler)() as PaymentProvider);
      }
      paymentsRegistry.clear();
      for (const provider of [
        ...injectedPaymentProviders,
        ...(fakeProvider === undefined ? [] : [fakeProvider]),
        ...composed,
      ]) {
        paymentsRegistry.register(provider);
        registerPaymentInboundContract(provider);
      }
      paymentsCompositionRevision = revision;
    };
    // Serialize concurrent entrants; re-check after acquiring (a disable
    // landing mid-composition recomposes once more on the next call).
    paymentsCompositionChain = paymentsCompositionChain.then(run, run);
    return paymentsCompositionChain;
  };
  const paymentInstances = createPaymentProviderInstanceService({
    pool,
    clock,
    configSchemaFor: (providerType) => paymentsRegistry.get(providerType)?.configSchema,
  });
  const paymentsService = createPaymentService({
    pool,
    clock,
    providers: paymentsRegistry,
    instances: paymentInstances,
    secretResolver: integrationSecretResolver,
  });
  const payments: PaymentsServices = {
    registry: paymentsRegistry,
    instances: paymentInstances,
    service: paymentsService,
    /** Process-channel secret resolution by NAME (S6 config check uses it to
     * report resolvability; values never leave the process). */
    secretResolver: integrationSecretResolver,
    // Payment-operation entries call this (R3): a lifecycle revision change —
    // here or in another process — rebuilds the provider registry before the
    // operation proceeds; a disabled provider then reports
    // PAYMENT_PROVIDER_UNKNOWN, never a silent wrong-provider charge.
    ensureComposed: composePaymentProviders,
  };

  void composePaymentProviders().catch(() => {
    // Fail-closed: an unfilled registry reports PAYMENT_PROVIDER_UNKNOWN;
    // payment history remains fully readable.
  });

  const extensionRuntimeResolver = createExtensionRuntimeResolver({
    catalog: extensionCatalog,
    lifecycle: extensionLifecycle,
    ...(input.runtimeSecretBox === undefined
      ? {}
      : {
          resolveSecret: (extensionId: string, refName: string) =>
            getExtensionRuntimeSecret(pool, input.runtimeSecretBox, extensionId, refName),
        }),
  });
  const extensionOperations = createExtensionOperationsService({
    catalog: extensionCatalog,
    enabledIds: () => extensionLifecycle.enabledIds(),
    // R3: the composed set is stamped with the authoritative lifecycle
    // revision — another process's disable recomposes here before the next
    // list/invoke.
    lifecycleRevision: () => extensionLifecycle.revision(),
    // Operation handlers read their extension's settings through the call
    // context (PCMS-PRE-RESEARCH A2): same validated-config + secret-slot
    // resolution path as the provider registries.
    resolveRuntime: extensionRuntimeResolver,
  });
  // Extension Contract 2.0 (CORE-SHOP-01 P0-b; ADR-0018): site-level mounts +
  // the extension HTTP router. Core Routing owns extension public URLs.
  const extensionRouteMounts = createExtensionRouteService({
    pool,
    reserved: createReservedRouteRegistry(),
    activeEntryRoutes: async () => {
      const result = await pool.query<{ path: string }>(
        `SELECT path FROM routes WHERE retired_at IS NULL AND is_canonical`,
      );
      return result.rows.map((row) => row.path);
    },
  });
  const extensionHttp = createExtensionHttpRouter({
    catalog: extensionCatalog,
    lifecycle: {
      enabledIds: () => extensionLifecycle.enabledIds(),
      revision: () => extensionLifecycle.revision(),
    },
    resolveRuntime: extensionRuntimeResolver,
    extensionRoutes: extensionRouteMounts,
  });
  extensionSourceContext = async (extensionId: string) => {
    const localization = await createSiteLocalizationService(pool).get();
    const runtime = await extensionRuntimeResolver(extensionId);
    return buildExtensionSourceContext({
      pool,
      site: { key: defaultSiteKey, defaultLocale: localization.defaultLocale },
      extensionId,
      config: runtime?.config ?? null,
    });
  };
  const mediaProviders = createMediaProvidersService({
    catalog: extensionCatalog,
    lifecycle: extensionLifecycle,
    // ADR-0013 §52.4: provider secret slots resolve from the Admin-managed
    // extension runtime secret store (same structural box as Integration Hub
    // runtime secrets — one operator master key).
    ...(input.runtimeSecretBox === undefined
      ? {}
      : {
          resolveSecret: (extensionId: string, refName: string) =>
            getExtensionRuntimeSecret(pool, input.runtimeSecretBox, extensionId, refName),
        }),
  });
  const releaseManifest =
    input.updateManifest === undefined ? null : parseReleaseManifest(input.updateManifest);

  const effectiveCapabilities = async () => {
    const installations = await extensionLifecycle.listInstallations();
    const enabled = installations.filter((entry) => entry.state === "ENABLED");
    const effective = createCapabilityRegistry();
    for (const provision of extensionSystemCapabilities.list()) {
      effective.provide(provision);
    }
    for (const installation of enabled) {
      const artifact = extensionCatalog.get(installation.extensionId);
      for (const provision of artifact?.manifest.provides ?? []) {
        effective.provide({
          key: provision.capability,
          version: provision.version,
          provider: installation.extensionId,
        });
      }
    }
    return effective.list().map((entry) => ({
      key: entry.key,
      version: entry.version,
      provider: entry.provider,
    }));
  };

  const buildCompatibilitySnapshot = async (): Promise<CompatibilitySnapshot> => {
    const migrations = loadMigrations(input.migrationsDir ?? "db/migrations");
    const dbStatus = await migrationStatus(pool, migrations);
    let postgresVersion = "";
    try {
      const result = await pool.query<{ version: string }>("SELECT version() AS version");
      postgresVersion =
        (result.rows[0]?.version ?? "").match(/PostgreSQL (\d+(\.\d+)?)/)?.[1] ?? "";
    } catch {
      postgresVersion = "";
    }
    const installations = await extensionLifecycle.listInstallations();
    const effectiveCapabilityItems = await effectiveCapabilities();
    const scannedExtensions = [];
    for (const artifact of extensionCatalog.list()) {
      const manifest: ExtensionManifest = artifact.manifest;
      const installation = installations.find((entry) => entry.extensionId === manifest.id);
      const configIssues =
        installation === undefined
          ? []
          : validateExtensionConfig({
                extensionId: manifest.id,
                schema: manifest.config_schema,
                config: installation.config,
              }).ok
            ? []
            : (
                validateExtensionConfig({
                  extensionId: manifest.id,
                  schema: manifest.config_schema,
                  config: installation.config,
                }) as { ok: false; issues: readonly { path: string; message: string }[] }
              ).issues;
      const migrationState =
        manifest.migrations === undefined
          ? undefined
          : await extensionLifecycle.migrationStatus(manifest.id);
      scannedExtensions.push({
        id: manifest.id,
        deployed: true,
        installed: installation !== undefined,
        state: installation?.state,
        manifestVersion: manifest.version,
        extensionContractVersion: manifest.extension_contract,
        cmsCompatibility: manifest.cms_compatibility,
        fingerprintMatches:
          installation === undefined
            ? undefined
            : installation.manifestFingerprint === manifestFingerprint(manifest),
        artifactDigest: installation?.artifactDigest ?? null,
        requires: manifest.requires.map((entry) => ({
          capability: entry.capability,
          range: entry.range,
        })),
        provides: manifest.provides.map((entry) => ({
          capability: entry.capability,
          version: entry.version,
        })),
        configIssues: configIssues.map((entry) => ({ path: entry.path, message: entry.message })),
        migrations:
          migrationState === undefined
            ? undefined
            : {
                applied: migrationState.applied.map((entry) => entry.name),
                pending: [...migrationState.pending],
                drifted: [...migrationState.drifted],
              },
      });
    }
    // Undeployed-but-installed rows are visible to the scanner too (they
    // must block updates rather than silently vanish).
    for (const installation of installations) {
      if (extensionCatalog.has(installation.extensionId)) continue;
      scannedExtensions.push({
        id: installation.extensionId,
        deployed: false,
        installed: true,
        state: installation.state,
        manifestVersion: installation.version,
        extensionContractVersion: undefined,
        cmsCompatibility: undefined,
        fingerprintMatches: false,
        artifactDigest: installation.artifactDigest,
        requires: [],
        provides: [],
        configIssues: [],
        migrations: undefined,
      });
    }
    return {
      generatedAt: clock.now().toISOString(),
      cms: {
        version: cmsVersion,
        nodeRuntime: {
          current: process.version.replace(/^v/, ""),
          supportedRange: SUPPORTED_NODE_RANGE,
        },
        postgresRuntime: {
          current: postgresVersion,
          supportedRange: SUPPORTED_POSTGRES_RANGE,
        },
        database: {
          pendingMigrations: [...dbStatus.pending],
          driftedMigrations: [...dbStatus.drifted],
          appliedMigrations: dbStatus.applied.map((entry) => entry.name),
        },
      },
      contracts: contractVersions.list(),
      theme:
        input.themeDir === undefined
          ? undefined
          : {
              contractVersion: THEME_CONTRACT_VERSION,
              supportedContractRange: `^${THEME_CONTRACT_VERSION.split(".")[0] ?? "0"}`,
            },
      extensions: scannedExtensions,
      capabilities: effectiveCapabilityItems,
      content: undefined,
      deprecations: extensionDeprecations.list(),
    };
  };

  const scanExtensionsCompatibility = async () =>
    scanCompatibility(await buildCompatibilitySnapshot());

  const extensions: ExtensionsServices = {
    catalog: extensionCatalog,
    systemCapabilities: extensionSystemCapabilities,
    deprecations: extensionDeprecations,
    contractVersions,
    lifecycle: extensionLifecycle,
    releaseManifest,
    capabilities: effectiveCapabilities,
    scanCompatibility: scanExtensionsCompatibility,
    async updatePreflight() {
      if (releaseManifest === null) {
        throw new ApiError(
          "UPDATE_MANIFEST_INVALID",
          "no target release manifest is configured for this environment",
          { status: 409 },
        );
      }
      return checkUpdate({
        snapshot: await buildCompatibilitySnapshot(),
        target: releaseManifest,
      });
    },
    async updatePreflightAgainst(target) {
      return checkUpdate({ snapshot: await buildCompatibilitySnapshot(), target });
    },
    async extensionCompatibility(extensionId: string) {
      const report = await scanExtensionsCompatibility();
      const issues = report.issues.filter((issue) => issue.subject === extensionId);
      return {
        found: extensionCatalog.has(extensionId),
        issues,
        outcome: preflightOutcome(issues),
      };
    },
  };

  const localization = createSiteLocalizationService(pool);

  let themeChange = Promise.resolve();
  return {
    pool,
    clock,
    users,
    passwords,
    passwordPolicy,
    throttle,
    sessions,
    totp,
    authentication,
    machineIdentity,
    actorResolver,
    authorization,
    entries,
    contentTree,
    contentTypes,
    fields,
    blocks,
    contentDiscovery,
    blockDiscovery,
    revisionRegistry,
    revisions,
    revisionReader,
    publications,
    changesets,
    changesetDiscovery: createChangeSetsDiscovery(changesets),
    plans,
    planDiscovery: createPublicationPlansDiscovery({ plans, calendar }),
    calendar,
    jobs,
    // PREPUBLIC §4: extension job enqueue resolves registrations from the
    // SAME deployed catalog the application was composed over.
    extensionCatalog,
    previewTokens,
    previewState,
    environmentClassification,
    releaseId,
    selectedReleaseStatus: input.selectedReleaseStatus ?? null,
    skillsDir,
    communitySkillsDir,
    communitySkillsEnabled,
    registryClient,
    registryIncomingDir,
    registryAccountToken: input.secrets?.get("registry.token") ?? null,
    registryInstanceCode,
    registryAccountTokenRuntime,
    registryInstanceToken,
    registryReportUpdates: input.registryReportUpdates === true,
    mediaStorage: input.mediaStorage ?? null,
    mediaQuarantine: input.mediaQuarantine ?? null,
    mediaLimits: input.mediaLimits,
    pcpubBundleLimits: input.pcpubBundleLimits,
    pcpubQuarantineDir: input.pcpubQuarantineDir,
    mediaDiscovery,
    mediaUsage,
    mediaPresets,
    prepareRichTextImage,
    seo,
    seoDiscovery,
    seoEnvironment,
    defaultSiteKey,
    navigation,
    placements,
    navigationDiscovery: createNavigationDiscovery(pool, input.navigationPlacements ?? []),
    routes,
    routeHistory,
    routeProposals: createRouteProposalService(pool),
    domains: createDomainService(pool),
    canonical,
    actionUrls: createActionUrlService(pool),
    localization,
    requestResolver: createRequestResolver(pool, { localization }),
    routingDiscovery: createRoutingDiscovery(pool),
    themeDir: input.themeDir,
    themeDiscovery: themeDiscoveryValue,
    themeRuntime: {
      configuredDir: input.themeDir,
      prepareState: null,
      prepareUpdate: null,
      served: null,
      async withChange<T>(work: () => Promise<T>): Promise<T> {
        const previous = themeChange;
        let release!: () => void;
        themeChange = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await work();
        } finally {
          release();
        }
      },
    },
    searchSource,
    searchProvider,
    searchIndexing,
    searchReindex,
    searchQuery,
    searchResultMetadata,
    analytics: analyticsService,
    indexNow: indexNowService,
    searchAdmin,
    formsSource,
    interactionPrivacy,
    integrations,
    payments,
    extensions,
    extensionOperations,
    extensionRouteMounts,
    extensionHttp,
    mediaProviders,
    mediaCandidateSigningKey: input.mediaCandidateSigningKey,
    ...(input.mailTransport === undefined ? {} : { mailTransport: input.mailTransport }),
    primaryOrigin,
    ...(input.mailVerify === undefined ? {} : { mailVerify: input.mailVerify }),
    ...(input.runtimeSecretBox === undefined ? {} : { runtimeSecretBox: input.runtimeSecretBox }),
    ...(input.updateOrchestrationPorts === undefined
      ? {}
      : { updateOrchestrationPorts: input.updateOrchestrationPorts }),
    authorize(actor, permission) {
      authorization.authorize(actor, permission);
    },
  };
}

/** Depth-bounded JSON walk collecting paths where `needle` occurs. */
function scanForValue(
  value: unknown,
  path: string,
  needle: string,
  kinds: readonly string[],
  emit: (path: string, kinds: readonly string[]) => void,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value === needle) emit(path || "/", kinds);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) return;
    for (const [index, item] of value.entries()) {
      scanForValue(item, `${path}/${index}`, needle, kinds, emit);
    }
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nextKinds = "blocks" in record && path === "" ? [...kinds, "blocks"] : kinds;
    for (const [key, child] of Object.entries(record).slice(0, 256)) {
      scanForValue(child, `${path}/${key}`, needle, nextKinds, emit);
    }
  }
}

/** Fail-secure guard used by every mutating operation (spec §21). */

/**
 * Secret-ref slot values never leave the server: read-side views omit them
 * (presence is reported via secret_slots), write-side merges preserve them
 * (callers may only set non-secret keys).
 */
export function omitSecretRefs(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (
      typeof value === "object" &&
      value !== null &&
      "$secret_ref" in (value as Record<string, unknown>)
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function pickSecretRefs(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (
      typeof value === "object" &&
      value !== null &&
      "$secret_ref" in (value as Record<string, unknown>)
    ) {
      out[key] = value;
    }
  }
  return out;
}

/** Actor metadata for audit rows (never includes secret material). */
export function auditBase(ctx: OperationContext) {
  return {
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    transport: (ctx.transport === "rest" ? "api" : ctx.transport) as "api" | "mcp" | "cli",
  };
}

export function requirePermission(
  app: ApplicationServices,
  ctx: OperationContext,
  permission: string,
): void {
  app.authorize(ctx.actor, permission);
}

/** Reads the deployed release version (M14; M17-T003 cwd independence). */
export function readCmsVersionFromRelease(): string {
  // The running module's own release root decides — never the operator's
  // cwd: a release process must report the release version, a dev tree the
  // workspace version, regardless of where the process was started from.
  const resolved = resolveReleaseIdentity(fileURLToPath(import.meta.url));
  if (resolved.mode === "release") return resolved.identity.version;
  try {
    return discoverCmsVersion(
      JSON.parse(readFileSync(join(resolved.root, "package.json"), "utf8")),
    );
  } catch {
    // A missing/unreadable release document is a composition error for the
    // update surfaces, but must not break unrelated subsystems at boot.
    return "0.0.0";
  }
}
