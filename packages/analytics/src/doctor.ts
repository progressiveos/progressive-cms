// Analytics doctor (Analytics spec §11): static config diagnostics + a
// render-plan probe. Never gates site health on external provider
// availability — that is always a warning, never an error.

import type { AnalyticsRegistry } from "./registry.js";
import type { AnalyticsDiagnostic, AnalyticsPageContext, AnalyticsSettings } from "./types.js";

export function analyticsDoctor(
  settings: AnalyticsSettings,
  registry: AnalyticsRegistry,
  deps: {
    probe: (
      settings: AnalyticsSettings,
      page: AnalyticsPageContext,
    ) => {
      readonly html: string;
      readonly headEarlyPresent: boolean;
      readonly bodyStartPresent: boolean;
      readonly dataLayerBeforeGtm: boolean;
      readonly duplicates: readonly string[];
    };
  },
): readonly AnalyticsDiagnostic[] {
  const issues: AnalyticsDiagnostic[] = [];
  const enabled: string[] = [];
  for (const [providerId, config] of Object.entries(settings.providers)) {
    if (!config.enabled) continue;
    const provider = registry.get(providerId);
    if (provider === null) {
      issues.push({
        code: "ANALYTICS_PROVIDER_UNKNOWN",
        severity: "error",
        provider: providerId,
        message: `provider "${providerId}" is not registered`,
      });
      continue;
    }
    enabled.push(providerId);
    issues.push(
      ...provider.validateConfig(config).map((issue) => ({ ...issue, provider: providerId })),
    );
  }

  if (
    settings.providers.google_analytics_4.enabled &&
    settings.providers.google_tag_manager.enabled
  ) {
    issues.push({
      code: "ANALYTICS_GA4_GTM_POSSIBLE_DUPLICATION",
      severity: "warning",
      message:
        "Google Analytics is connected directly; if the same Measurement ID is also configured inside GTM, views or events may be sent twice",
    });
  }
  if (settings.providers.yandex_metrica.enabled && settings.providers.google_tag_manager.enabled) {
    issues.push({
      code: "ANALYTICS_METRICA_GTM_POSSIBLE_DUPLICATION",
      severity: "warning",
      message:
        "Yandex Metrica is configured alongside GTM; if the same counter is also deployed inside GTM, hits may double",
    });
  }
  // Diagnostic-grade CSP allowances are opt-in; surface them so an operator
  // can see why the public policy differs from the strict baseline.
  if (settings.providers.yandex_metrica.enabled && settings.providers.yandex_metrica.debugMode) {
    issues.push({
      code: "ANALYTICS_DEBUG_ALLOWANCES_ACTIVE",
      severity: "info",
      provider: "yandex_metrica",
      message:
        "Counter-check debugger allowances are active (style attributes for the ?_ym_debug=2 check panel); disable after the check",
    });
  }
  if (
    settings.providers.google_tag_manager.enabled &&
    settings.providers.google_tag_manager.debugMode
  ) {
    issues.push({
      code: "ANALYTICS_DEBUG_ALLOWANCES_ACTIVE",
      severity: "info",
      provider: "google_tag_manager",
      message:
        "GTM Preview allowances are active (tagmanager.google.com, gstatic, Google Fonts); disable outside preview sessions",
    });
  }

  const page: AnalyticsPageContext = {
    siteKey: "doctor",
    pageId: "doctor-probe",
    pageType: "page",
    locale: "default",
    isSearch: false,
    isNotFound: false,
  };
  const probe = deps.probe(settings, page);
  if (!probe.headEarlyPresent) {
    issues.push({
      code: "ANALYTICS_RENDER_HEAD_SLOT_MISSING",
      severity: "error",
      message: "system.head.early fragment missing from the render probe",
    });
  }
  if (!probe.bodyStartPresent) {
    issues.push({
      code: "ANALYTICS_RENDER_BODY_START_SLOT_MISSING",
      severity: "error",
      message: "system.body.start fragment missing from the render probe",
    });
  }
  if (!probe.dataLayerBeforeGtm) {
    issues.push({
      code: "ANALYTICS_DATALAYER_ORDER_INVALID",
      severity: "error",
      message: "dataLayer bootstrap must exist before the GTM container loads",
    });
  }
  if (probe.duplicates.length > 0) {
    issues.push({
      code: "ANALYTICS_RENDER_DUPLICATE",
      severity: "error",
      message: `duplicate system fragments in render probe: ${probe.duplicates.join(", ")}`,
    });
  }

  issues.push({
    code: "ANALYTICS_EXTERNAL_AVAILABILITY_UNKNOWN",
    severity: "warning",
    message: "external provider availability not verified",
  });
  return issues;
}
