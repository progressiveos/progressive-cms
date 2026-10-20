// @pcms/analytics — theme-independent analytics & tag management
// (Analytics spec §1). L1 subsystem: imports @pcms/core only.

export { analyticsDoctor } from "./doctor.js";
export { buildSystemDocumentInjection, type SystemDocumentInjection } from "./planner.js";
export {
  FIRST_PARTY_PROVIDERS,
  GOOGLE_ANALYTICS_4_PROVIDER,
  GOOGLE_TAG_MANAGER_PROVIDER,
  YANDEX_METRICA_PROVIDER,
} from "./providers.js";
export { type AnalyticsRegistry, createAnalyticsRegistry } from "./registry.js";
export { ANALYTICS_RUNTIME_SOURCE } from "./runtime-source.js";
export {
  AnalyticsError,
  validateAnalyticsOrigin,
  validateAnalyticsSettings,
} from "./settings-schema.js";
export {
  ACTIVATION_POLICIES,
  type AnalyticsActivationPolicy,
  type AnalyticsCspContribution,
  type AnalyticsDiagnostic,
  type AnalyticsFragment,
  type AnalyticsNetworkDirective,
  type AnalyticsNetworkRule,
  type AnalyticsPageContext,
  type AnalyticsPrivacyDescriptor,
  type AnalyticsProviderPlan,
  type AnalyticsSettings,
  type AnalyticsTagProviderV1,
  DEFAULT_GA4,
  DEFAULT_GTM,
  DEFAULT_METRICA,
  defaultAnalyticsSettings,
  GA4_ID_RE,
  type GoogleAnalytics4Config,
  type GoogleTagManagerConfig,
  GTM_ID_RE,
  METRICA_ID_RE,
  NETWORK_DIRECTIVES,
  PACKAGE_NAME,
  type YandexMetricaConfig,
} from "./types.js";
