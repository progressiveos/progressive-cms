// First-party providers v1 (Analytics spec §5/§16). Every provider is a pure
// function of its validated config: typed fragments out, structured CSP
// contributions out. No snippet ever reaches Admin as editable text.
//
// Consent semantics: the planner defers both bootstraps and external loaders
// by category; shared queues must not receive denied provider configuration.

import {
  type AnalyticsCspContribution,
  type AnalyticsFragment,
  type AnalyticsTagProviderV1,
  GA4_ID_RE,
  GTM_ID_RE,
  METRICA_ID_RE,
} from "./types.js";

function issue(
  code: string,
  message: string,
): { code: string; severity: "error"; message: string } {
  return { code, severity: "error", message };
}

/** Escapes a validated ID for safe interpolation into system fragments. */
function esc(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "");
}

interface ProviderPlan {
  readonly headEarly: readonly AnalyticsFragment[];
  /** External loaders — planner may defer these to post-consent injection. */
  readonly loaders: readonly AnalyticsFragment[];
  readonly bodyStart: readonly AnalyticsFragment[];
  readonly csp: AnalyticsCspContribution;
  readonly dataLayerUsed: boolean;
  readonly inlineScripts: readonly string[];
}

export const YANDEX_METRICA_PROVIDER: AnalyticsTagProviderV1 & {
  buildRenderPlan(config: unknown, page?: unknown): ProviderPlan;
} = {
  id: "yandex_metrica",
  version: 1,
  title: "Yandex Metrica",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      counterId: { type: ["string", "null"], pattern: METRICA_ID_RE.source },
      webvisor: { type: "boolean" },
      clickmap: { type: "boolean" },
      trackLinks: { type: "boolean" },
      accurateTrackBounce: { type: "boolean" },
      ecommerce: { type: "boolean" },
      sendTitle: { type: "boolean" },
      debugMode: { type: "boolean" },
      activationPolicy: {
        type: "string",
        enum: ["immediate", "analytics_consent", "marketing_consent"],
      },
    },
  },
  validateConfig(config) {
    const issues: ReturnType<typeof issue>[] = [];
    const raw = (config ?? {}) as Record<string, unknown>;
    const counterId = raw.counterId;
    if (raw.enabled === true && (typeof counterId !== "string" || !METRICA_ID_RE.test(counterId))) {
      issues.push(issue("YANDEX_COUNTER_ID_INVALID", "counter id must be 6-12 digits"));
    } else if (typeof counterId === "string" && !METRICA_ID_RE.test(counterId)) {
      issues.push(issue("YANDEX_COUNTER_ID_INVALID", "counter id must be 6-12 digits"));
    }
    return issues;
  },
  buildRenderPlan(config): ProviderPlan {
    const cfg = config as {
      counterId: string;
      webvisor: boolean;
      clickmap: boolean;
      trackLinks: boolean;
      accurateTrackBounce: boolean;
      ecommerce: boolean;
      sendTitle: boolean;
      debugMode: boolean;
      activationPolicy: string;
    };
    const id = esc(cfg.counterId);
    // Per Yandex's init contract the url/referrer arguments must be the
    // BROWSER's values. They are emitted as literal generator code below —
    // never through JSON.stringify (0.1.196 defect: the page reported
    // /location.href pseudo-URLs) and never from operator settings (no eval).
    const options = {
      ssr: true,
      clickmap: cfg.clickmap,
      trackLinks: cfg.trackLinks,
      accurateTrackBounce: cfg.accurateTrackBounce,
      webvisor: cfg.webvisor,
      ...(cfg.ecommerce ? { ecommerce: "dataLayer" } : {}),
      ...(cfg.sendTitle ? {} : { title: false }),
    };
    const loaderUrl = `https://mc.yandex.ru/metrika/tag.js?id=${id}`;
    // Immediate: the Yandex-recommended bootstrap (2026-10-05), rewritten
    // without document.write: queue + ssr flag + dedup guard (the loader URL
    // carries the counter id, so a duplicated tag can never double-load) +
    // init. Deferred: queue + init only — the loader rides the runtime's
    // consent activation.
    const immediate = cfg.activationPolicy === "immediate";
    const bootstrap = `(function (m, e, t, r, i, k, a) {
  m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
  m[i].l = 1 * new Date();
  ${
    immediate
      ? `for (var j = 0; j < document.scripts.length; j++) { if (document.scripts[j].src === r) { return; } }
  k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);`
      : `// loader injected after consent (pcms consent contract)`
  }
})(window, document, "script", "${loaderUrl}", "ym");
ym(${id}, "init", ${JSON.stringify(options)}, {
  referrer: document.referrer,
  url: location.href,
});`;
    return {
      headEarly: [{ kind: "inline_script", code: bootstrap }],
      // The immediate bootstrap creates the dedup-guarded loader itself; the
      // deferred loader URL rides the runtime consent activation.
      loaders: immediate ? [] : [{ kind: "external_script", src: loaderUrl }],
      bodyStart: immediate
        ? [{ kind: "noscript_image", src: `https://mc.yandex.ru/watch/${id}` }]
        : [],
      csp: {
        origins: {
          script_src: ["https://mc.yandex.ru", ...(cfg.debugMode ? ["https://yastatic.net"] : [])],
          connect_src: ["https://mc.yandex.ru", "https://*.mc.yandex.ru"],
          img_src: ["https://mc.yandex.ru"],
          // The tag creates its mc.yandex.ru transport iframe in default mode
          // (reproduced 2026-10-18: blocked by webvisor-gated frame-src).
          frame_src: ["https://mc.yandex.ru"],
          // Session-replay hosts per Yandex's CSP guide (mc.* + matching
          // wss://); only the optional Webvisor feature needs them.
          ...(cfg.webvisor
            ? {
                connect_src: [
                  "https://mc.yandex.ru",
                  "https://*.mc.yandex.ru",
                  "https://mc.webvisor.com",
                  "https://mc.webvisor.org",
                  "wss://mc.yandex.ru",
                  "wss://mc.webvisor.com",
                  "wss://mc.webvisor.org",
                ],
              }
            : {}),
          // Counter-check debugger (`?_ym_debug=2` check flow) renders its
          // panel through style ATTRIBUTES — hashes can never authorize those
          // (reproduced 2026-10-18). Diagnostic-grade, provider-gated; themes
          // can never declare this channel (§34).
          ...(cfg.debugMode ? { style_src_attr: ["'unsafe-inline'"] } : {}),
        },
        blobFrame: cfg.webvisor,
      },
      dataLayerUsed: cfg.ecommerce,
      inlineScripts: [bootstrap],
    };
  },
  privacy: { category: "analytics", loadsBeforeConsent: true },
  doctor(config) {
    return this.validateConfig(config);
  },
};

export const GOOGLE_ANALYTICS_4_PROVIDER: AnalyticsTagProviderV1 & {
  buildRenderPlan(config: unknown, page?: unknown): ProviderPlan;
} = {
  id: "google_analytics_4",
  version: 1,
  title: "Google Analytics 4",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      measurementId: { type: ["string", "null"], pattern: GA4_ID_RE.source },
      activationPolicy: {
        type: "string",
        enum: ["immediate", "analytics_consent", "marketing_consent"],
      },
    },
  },
  validateConfig(config) {
    const issues: ReturnType<typeof issue>[] = [];
    const raw = (config ?? {}) as Record<string, unknown>;
    const id = raw.measurementId;
    if (typeof id === "string" && id.startsWith("GTM-")) {
      issues.push(
        issue(
          "GA4_MEASUREMENT_ID_INVALID",
          "GTM container ids belong to the google_tag_manager provider",
        ),
      );
      return issues;
    }
    if (raw.enabled === true && (typeof id !== "string" || !GA4_ID_RE.test(id))) {
      issues.push(issue("GA4_MEASUREMENT_ID_INVALID", "measurement id must match G-[A-Z0-9]+"));
    }
    return issues;
  },
  buildRenderPlan(config): ProviderPlan {
    const cfg = config as { measurementId: string; activationPolicy: string };
    const id = esc(cfg.measurementId);
    const bootstrap = `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag("js", new Date());
gtag("config", "${id}");`;
    return {
      headEarly: [{ kind: "inline_script", code: bootstrap }],
      loaders: [
        { kind: "external_script", src: `https://www.googletagmanager.com/gtag/js?id=${id}` },
      ],
      bodyStart: [],
      csp: {
        // Google tag-platform CSP guide (GA4, no-Ads baseline, checked
        // 2026-10-18): collection endpoints + the loader host itself, which
        // also serves as a beacon destination.
        origins: {
          script_src: ["https://www.googletagmanager.com"],
          connect_src: [
            "https://www.googletagmanager.com",
            "https://www.google-analytics.com",
            "https://*.google-analytics.com",
            "https://*.analytics.google.com",
            "https://www.google.com",
          ],
          img_src: [
            "https://www.googletagmanager.com",
            "https://www.google-analytics.com",
            "https://*.google-analytics.com",
          ],
        },
      },
      dataLayerUsed: true,
      inlineScripts: [bootstrap],
    };
  },
  privacy: { category: "analytics", loadsBeforeConsent: true },
  doctor(config) {
    return this.validateConfig(config);
  },
};

export const GOOGLE_TAG_MANAGER_PROVIDER: AnalyticsTagProviderV1 & {
  buildRenderPlan(config: unknown, page?: unknown): ProviderPlan;
} = {
  id: "google_tag_manager",
  version: 1,
  title: "Google Tag Manager",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      containerId: { type: ["string", "null"], pattern: GTM_ID_RE.source },
      debugMode: { type: "boolean" },
      activationPolicy: {
        type: "string",
        enum: ["immediate", "analytics_consent", "marketing_consent"],
      },
    },
  },
  validateConfig(config) {
    const issues: ReturnType<typeof issue>[] = [];
    const raw = (config ?? {}) as Record<string, unknown>;
    const id = raw.containerId;
    if (raw.enabled === true && (typeof id !== "string" || !GTM_ID_RE.test(id))) {
      issues.push(issue("GTM_CONTAINER_ID_INVALID", "container id must match GTM-[A-Z0-9]+"));
    }
    return issues;
  },
  buildRenderPlan(config): ProviderPlan {
    const cfg = config as { containerId: string; debugMode: boolean; activationPolicy: string };
    const id = esc(cfg.containerId);
    const bootstrap = `window.dataLayer = window.dataLayer || [];
dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });`;
    const immediate = cfg.activationPolicy === "immediate";
    return {
      headEarly: [{ kind: "inline_script", code: bootstrap }],
      loaders: [
        { kind: "external_script", src: `https://www.googletagmanager.com/gtm.js?id=${id}` },
      ],
      bodyStart: immediate
        ? [
            {
              kind: "noscript_iframe",
              src: `https://www.googletagmanager.com/ns.html?id=${id}`,
              width: 0,
              height: 0,
            },
          ]
        : [],
      csp: {
        // Google tag-platform CSP guide (GTM base + the GA4 baseline most
        // containers forward to, checked 2026-10-18).
        origins: {
          script_src: ["https://www.googletagmanager.com"],
          connect_src: [
            "https://www.googletagmanager.com",
            "https://www.google.com",
            "https://www.google-analytics.com",
            "https://*.google-analytics.com",
            "https://*.analytics.google.com",
          ],
          img_src: ["https://www.googletagmanager.com", "https://*.google-analytics.com"],
          frame_src: ["https://www.googletagmanager.com"],
          // GTM Preview / Tag Assistant (debugMode): diagnostic-grade,
          // provider-gated. `data:` here is the documented Google requirement
          // for preview fonts; user network rules can never express it.
          ...(cfg.debugMode
            ? {
                script_src: ["https://www.googletagmanager.com", "https://tagmanager.google.com"],
                style_src: [
                  "https://www.googletagmanager.com",
                  "https://tagmanager.google.com",
                  "https://fonts.googleapis.com",
                ],
                img_src: [
                  "https://www.googletagmanager.com",
                  "https://*.google-analytics.com",
                  "https://ssl.gstatic.com",
                  "https://www.gstatic.com",
                ],
                font_src: ["https://fonts.gstatic.com", "data:"],
              }
            : {}),
        },
      },
      dataLayerUsed: true,
      inlineScripts: [bootstrap],
    };
  },
  privacy: { category: "marketing", loadsBeforeConsent: true },
  doctor(config) {
    return this.validateConfig(config);
  },
};

export const FIRST_PARTY_PROVIDERS: readonly AnalyticsTagProviderV1[] = [
  YANDEX_METRICA_PROVIDER,
  GOOGLE_ANALYTICS_4_PROVIDER,
  GOOGLE_TAG_MANAGER_PROVIDER,
];
