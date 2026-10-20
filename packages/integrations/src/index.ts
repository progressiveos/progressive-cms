// @pcms/integrations — Integration Hub bounded context (M13; ADR-0005).
// Outbound delivery history, bindings, first-party connectors, inbound
// events, SSRF-safe HTTP. L1 subsystem: imports @pcms/core only.
export const PACKAGE_NAME = "@pcms/integrations";
export {
  AMO_LEAD_PROJECTION_FIELDS,
  amocrmConnectorDefinition,
  amocrmLeadBody,
  createAmocrmConnectorRuntime,
} from "./amocrm.js";
export {
  type BindingAction,
  createIntegrationBindingService,
  type IntegrationBinding,
  type IntegrationBindingInput,
  type IntegrationBindingService,
} from "./bindings.js";
export {
  B24_LEAD_PROJECTION_FIELDS,
  bitrix24ConnectorDefinition,
  bitrix24LeadBody,
  createBitrix24ConnectorRuntime,
} from "./bitrix24.js";
export {
  type BindingCondition,
  type ConditionOperator,
  evaluateConditions,
  type FailurePolicy,
  type MappingValue,
  type PayloadMapping,
  readPath,
  resolvePayloadMapping,
  validateConditions,
  validatePayloadMapping,
} from "./conditions.js";
export {
  type ConnectorActionDescriptor,
  type ConnectorDefinition,
  type ConnectorInboundDescriptor,
  type ConnectorRegistry,
  type ConnectorSchema,
  type ConnectorSecretRequirement,
  connectorAction,
  createConnectorRegistry,
  validateConnectorPayload,
} from "./connectors.js";
export { createConsoleMailTransport } from "./console-mail.js";
export {
  backoffDelay,
  createDeliveryService,
  type DeliveryAttempt,
  type DeliveryIdentity,
  type DeliveryService,
  type DeliveryStatus,
  type IntegrationDelivery,
} from "./deliveries.js";
export {
  createIntegrationDispatcher,
  type IntegrationDispatcher,
  type IntegrationDomainEvent,
  type IntegrationProjectionSource,
} from "./dispatcher.js";
export {
  createEmailConnectorRuntime,
  emailConnectorDefinition,
  type MailTransport,
} from "./email.js";
export {
  INTEGRATION_ERROR_CODES,
  IntegrationError,
  type IntegrationErrorCode,
} from "./errors.js";
export { registerFirstPartyConnectorDefinitionsV1 } from "./first-party.js";
export { createGuardedHttp } from "./guarded-http.js";
export {
  createHubspotConnectorRuntime,
  HUBSPOT_LEAD_PROJECTION_FIELDS,
  hubspotConnectorDefinition,
  hubspotContactBody,
  hubspotDealBody,
  leadTitle,
} from "./hubspot.js";
export {
  createInboundService,
  InboundContractRegistry,
  type InboundEndpointContract,
  type InboundReceiveResult,
  type InboundRecord,
  type InboundRequestView,
} from "./inbound.js";
export {
  createIntegrationInstanceService,
  type IntegrationInstance,
  type IntegrationInstanceInput,
  type IntegrationInstanceService,
  resolveSecrets,
  type SecretResolver,
} from "./instances.js";
export {
  type FormSubmittedPayload,
  INTERACTION_AGGREGATES,
  INTERACTION_EVENT_TYPES,
  type InteractionEventType,
  type LeadCreatedPayload,
  type LeadStatusChangedPayload,
  type QuizCompletedPayload,
  type QuizRunLifecyclePayload,
} from "./interactions.js";
export {
  buildSmtpOptionsForWrite,
  loadActiveSmtpOptions,
  loadMailSettings,
  type MailSecretBox,
  MailSettingsError,
  type MailSettingsView,
  type MailSettingsWrite,
  saveMailSettings,
} from "./mail-settings.js";
export {
  applyManagedMailSettings,
  buildMailSurface,
  type MailConfigView,
  type MailSecretLoader,
  type MailSurface,
} from "./mail-surface.js";
export {
  createPipedriveConnectorRuntime,
  PIPEDRIVE_LEAD_PROJECTION_FIELDS,
  pipedriveConnectorDefinition,
  pipedrivePersonBody,
} from "./pipedrive.js";
export {
  createProgressiveHqConnectorRuntime,
  HQ_INTAKE_EVENT_TYPE,
  HQ_LEAD_PROJECTION_FIELDS,
  hqEventId,
  hqIntakeEnvelope,
  progressiveHqConnectorDefinition,
} from "./progressive-hq.js";
export * from "./runtime.js";
export {
  clearInstanceRuntimeSecret,
  type IntegrationSecretBox,
  listInstanceRuntimeSecretKeys,
  loadInstanceRuntimeSecrets,
  RuntimeSecretError,
  setInstanceRuntimeSecret,
} from "./runtime-secrets.js";
export {
  createSalesforceConnectorRuntime,
  SALESFORCE_LEAD_PROJECTION_FIELDS,
  salesforceConnectorDefinition,
  salesforceLeadBody,
} from "./salesforce.js";
export { validateAgainstSchema } from "./schema.js";
export {
  createSharecrmConnectorRuntime,
  SHARECRM_LEAD_PROJECTION_FIELDS,
  sharecrmConnectorDefinition,
  sharecrmLeadBody,
} from "./sharecrm.js";
export {
  createSmtpMailTransport,
  type SmtpDiagnostics,
  SmtpError,
  type SmtpOptions,
  verifySmtpConnection,
} from "./smtp.js";
export {
  createSsrfGuard,
  isBlockedAddress,
  type ResolvedAddress,
  SsrfBlockedError,
  type SsrfPolicy,
  type ValidatedTarget,
} from "./ssrf.js";
export { createTalkConnectorRuntime, talkConnectorDefinition } from "./talk.js";
export {
  createTelegramConnectorRuntime,
  escapeForParseMode,
  telegramConnectorDefinition,
} from "./telegram.js";
export {
  networkFailure,
  type OutboundHttp,
  type OutboundHttpRequest,
  type OutboundHttpResponse,
} from "./transport.js";
export {
  createWebhookConnectorRuntime,
  type UrlGuard,
  webhookConnectorDefinition,
} from "./webhook.js";
export {
  createZohoCrmConnectorRuntime,
  ZOHO_LEAD_PROJECTION_FIELDS,
  zohoContactBody,
  zohoCrmConnectorDefinition,
  zohoDealBody,
} from "./zoho-crm.js";
