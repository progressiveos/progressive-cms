// Analytics & Tagging v1 — typed contract surface (spec
// Progressive_CMS_Analytics_Tagging_v1_Spec.md §3/§5/§6/§7).
//
// Fragments are SYSTEM-OWNED typed fragments: the only variable content is
// provider IDs validated by strict patterns before interpolation. There is
// deliberately no `adminProvidedHtml/JavaScript` type anywhere.

export const PACKAGE_NAME = "@pcms/analytics";

export type AnalyticsActivationPolicy = "immediate" | "analytics_consent" | "marketing_consent";

export const ACTIVATION_POLICIES: readonly AnalyticsActivationPolicy[] = [
  "immediate",
  "analytics_consent",
  "marketing_consent",
];

export type AnalyticsNetworkDirective =
  | "script-src"
  | "script-src-elem"
  | "connect-src"
  | "img-src"
  | "frame-src"
  | "style-src"
  | "font-src";

export const NETWORK_DIRECTIVES: readonly AnalyticsNetworkDirective[] = [
  "script-src",
  "script-src-elem",
  "connect-src",
  "img-src",
  "frame-src",
  "style-src",
  "font-src",
];

export interface AnalyticsNetworkRule {
  readonly id: string;
  readonly label?: string;
  readonly origin: string;
  readonly directives: readonly AnalyticsNetworkDirective[];
}

export interface YandexMetricaConfig {
  readonly enabled: boolean;
  readonly counterId: string | null;
  readonly webvisor: boolean;
  readonly clickmap: boolean;
  readonly trackLinks: boolean;
  readonly accurateTrackBounce: boolean;
  readonly ecommerce: boolean;
  readonly sendTitle: boolean;
  /** Counter-check debugger allowances (owner 2026-10-18 CSP task A):
   * style-attribute allowance for the vendor's `_ym_debug=2` check panel.
   * Diagnostic-grade, default off — never part of ordinary collection. */
  readonly debugMode: boolean;
  readonly activationPolicy: AnalyticsActivationPolicy;
}

export interface GoogleAnalytics4Config {
  readonly enabled: boolean;
  readonly measurementId: string | null;
  readonly activationPolicy: AnalyticsActivationPolicy;
}

export interface GoogleTagManagerConfig {
  readonly enabled: boolean;
  readonly containerId: string | null;
  /** GTM Preview / Tag Assistant allowances (Google tag-platform CSP guide):
   * diagnostic-grade, default off — never part of ordinary collection. */
  readonly debugMode: boolean;
  readonly activationPolicy: AnalyticsActivationPolicy;
}

export interface AnalyticsSettings {
  readonly schemaVersion: 1;
  readonly providers: {
    readonly yandex_metrica: YandexMetricaConfig;
    readonly google_analytics_4: GoogleAnalytics4Config;
    readonly google_tag_manager: GoogleTagManagerConfig;
  };
  readonly networkRules: readonly AnalyticsNetworkRule[];
}

export const METRICA_ID_RE = /^[1-9][0-9]{5,11}$/;
export const GA4_ID_RE = /^G-[A-Z0-9]{6,12}$/;
export const GTM_ID_RE = /^GTM-[A-Z0-9]{5,10}$/;

/** System document fragments (typed; serialized only by the planner). */
export type AnalyticsFragment =
  | { readonly kind: "inline_script"; readonly code: string }
  | { readonly kind: "external_script"; readonly src: string }
  | {
      readonly kind: "noscript_iframe";
      readonly src: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "noscript_image"; readonly src: string };

export interface AnalyticsCspContribution {
  /** Origins added to the named directives (validated https origins).
   * `style_src_attr` carries system-owned keyword sources only (the
   * provider-gated style-attribute allowance) — it is deliberately NOT a
   * network-rule directive and themes can never declare it (§34 forbids
   * `unsafe-inline` in theme declarations). */
  readonly origins: Partial<
    Record<
      | "script_src"
      | "connect_src"
      | "img_src"
      | "frame_src"
      | "style_src"
      | "style_src_attr"
      | "font_src",
      readonly string[]
    >
  >;
  /** Webvisor-grade frame blob allowance — provider-gated, never user-set. */
  readonly blobFrame?: boolean;
}

export interface AnalyticsPageContext {
  readonly siteKey: string;
  readonly pageId: string;
  readonly pageType: string;
  readonly locale: string;
  readonly isSearch: boolean;
  readonly isNotFound: boolean;
}

export interface AnalyticsProviderPlan {
  readonly headEarly: readonly AnalyticsFragment[];
  /** External loaders — the planner may defer these to post-consent injection. */
  readonly loaders: readonly AnalyticsFragment[];
  readonly bodyStart: readonly AnalyticsFragment[];
  readonly csp: AnalyticsCspContribution;
  readonly dataLayerUsed: boolean;
  /** Inline script texts, for deterministic CSP hash computation. */
  readonly inlineScripts: readonly string[];
}

export interface AnalyticsPrivacyDescriptor {
  readonly category: "analytics" | "marketing";
  readonly loadsBeforeConsent: boolean;
}

export interface AnalyticsDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly provider?: string;
  readonly message: string;
}

export interface AnalyticsTagProviderV1 {
  readonly id: string;
  readonly version: 1;
  readonly title: string;
  /** Strict JSON Schema for the provider config object. */
  readonly configSchema: Record<string, unknown>;
  validateConfig(config: unknown): AnalyticsDiagnostic[];
  buildRenderPlan(config: unknown, page: AnalyticsPageContext): AnalyticsProviderPlan;
  readonly privacy: AnalyticsPrivacyDescriptor;
  doctor(config: unknown): readonly AnalyticsDiagnostic[];
}

export const DEFAULT_METRICA: YandexMetricaConfig = {
  enabled: false,
  counterId: null,
  webvisor: false,
  clickmap: true,
  trackLinks: true,
  accurateTrackBounce: true,
  ecommerce: false,
  sendTitle: true,
  debugMode: false,
  activationPolicy: "immediate",
};

export const DEFAULT_GA4: GoogleAnalytics4Config = {
  enabled: false,
  measurementId: null,
  activationPolicy: "immediate",
};

export const DEFAULT_GTM: GoogleTagManagerConfig = {
  enabled: false,
  containerId: null,
  debugMode: false,
  activationPolicy: "immediate",
};

export function defaultAnalyticsSettings(): AnalyticsSettings {
  return {
    schemaVersion: 1,
    providers: {
      yandex_metrica: { ...DEFAULT_METRICA },
      google_analytics_4: { ...DEFAULT_GA4 },
      google_tag_manager: { ...DEFAULT_GTM },
    },
    networkRules: [],
  };
}
