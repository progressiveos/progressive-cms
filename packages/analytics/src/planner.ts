// Render planner + fragment serialization (Analytics spec §2/§5/§8).
//
// The planner is the ONLY place system fragments become HTML: inline scripts
// are system constants plus strictly-validated provider ids; everything is
// deterministic per settings, so the CSP inline-script hashes are computed
// here (ADR-0016). Deferred (consent-gated) providers contribute loader URLs
// to the runtime config instead of static tags.

import { createHash } from "node:crypto";
import type { AnalyticsRegistry } from "./registry.js";
import { ANALYTICS_RUNTIME_SOURCE } from "./runtime-source.js";
import type {
  AnalyticsCspContribution,
  AnalyticsFragment,
  AnalyticsPageContext,
  AnalyticsProviderPlan,
  AnalyticsSettings,
} from "./types.js";

export interface SystemDocumentInjection {
  /** HTML for system.head.early (runtime + bootstraps + immediate loaders). */
  readonly headEarlyHtml: string;
  /** HTML for system.body.start (noscript fallbacks). */
  readonly bodyStartHtml: string;
  /** Script-src hashes ('sha256-…') for the inline scripts above. */
  readonly scriptHashes: readonly string[];
  /** Structured, validated origins per CSP directive. */
  readonly origins: AnalyticsCspContribution["origins"];
  /** Webvisor-grade blob allowance for frame-src (provider-gated). */
  readonly blobFrame: boolean;
  readonly dataLayerUsed: boolean;
}

function serializeFragment(fragment: AnalyticsFragment): string {
  switch (fragment.kind) {
    case "inline_script":
      return `<script>${fragment.code}</script>`;
    case "external_script":
      return `<script src="${fragment.src}" async></script>`;
    case "noscript_iframe":
      // No style attributes: the strict CSP style policy blocks them in
      // JS-off browsers too; 0x0 geometry comes from the HTML attributes.
      return `<noscript><iframe src="${fragment.src}" height="${fragment.height}" width="${fragment.width}" title="analytics-fallback" aria-hidden="true"></iframe></noscript>`;
    case "noscript_image":
      // 1x1 pixel renders invisible without any inline style.
      return `<noscript><img src="${fragment.src}" alt="" height="1" width="1"/></noscript>`;
  }
}

function sha256(code: string): string {
  return `'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`;
}

function mergeOrigins(
  target: AnalyticsCspContribution["origins"],
  source: AnalyticsCspContribution["origins"],
): void {
  for (const [directive, origins] of Object.entries(source)) {
    if (!origins || origins.length === 0) continue;
    const key = directive as keyof AnalyticsCspContribution["origins"];
    target[key] = [...new Set([...(target[key] ?? []), ...origins])];
  }
}

/**
 * Builds the system injection for one public page. Returns null when
 * nothing is enabled — zero fragments, zero CSP contributions, zero
 * third-party requests (spec §13).
 */
export function buildSystemDocumentInjection(
  settings: AnalyticsSettings,
  registry: AnalyticsRegistry,
  page: AnalyticsPageContext,
): SystemDocumentInjection | null {
  const headEarly: AnalyticsFragment[] = [];
  const bodyStart: AnalyticsFragment[] = [];
  const inlineScripts: string[] = [];
  const deferred: {
    category: "analytics" | "marketing";
    scripts: string[];
    loaders: string[];
  }[] = [];
  const origins: AnalyticsCspContribution["origins"] = {};
  let blobFrame = false;
  let dataLayerUsed = false;
  let anyEnabled = false;

  for (const [providerId, config] of Object.entries(settings.providers)) {
    if (!config.enabled) continue;
    const provider = registry.get(providerId);
    if (provider === null) continue; // unknown ids are a settings error; validated at save
    const issues = provider.validateConfig(config);
    if (issues.some((issue) => issue.severity === "error")) continue;
    anyEnabled = true;
    const plan: AnalyticsProviderPlan = provider.buildRenderPlan(config, page);
    if (config.activationPolicy === "immediate") {
      headEarly.push(...plan.headEarly);
      headEarly.push(...plan.loaders);
      bodyStart.push(...plan.bodyStart);
    } else {
      // Defer bootstrap too: a granted GTM must not consume a denied GA4
      // configuration from their shared dataLayer.
      deferred.push({
        category: config.activationPolicy === "analytics_consent" ? "analytics" : "marketing",
        scripts: plan.headEarly.flatMap((fragment) =>
          fragment.kind === "inline_script" ? [fragment.code] : [],
        ),
        loaders: [...plan.headEarly, ...plan.loaders].flatMap((fragment) =>
          fragment.kind === "external_script" ? [fragment.src] : [],
        ),
      });
    }
    mergeOrigins(origins, plan.csp.origins);
    blobFrame = blobFrame || plan.csp.blobFrame === true;
    dataLayerUsed = dataLayerUsed || plan.dataLayerUsed;
    inlineScripts.push(...plan.inlineScripts);
  }
  if (!anyEnabled) return null;

  const directiveKeys: Readonly<Record<string, keyof AnalyticsCspContribution["origins"]>> = {
    "script-src": "script_src",
    "connect-src": "connect_src",
    "img-src": "img_src",
    "frame-src": "frame_src",
    "style-src": "style_src",
    "font-src": "font_src",
  };
  for (const rule of settings.networkRules) {
    for (const directive of rule.directives) {
      // script-src-elem is covered by script-src in our policy builder.
      if (directive === "script-src-elem") continue;
      const key = directiveKeys[directive];
      if (key === undefined) continue;
      origins[key] = [...new Set([...(origins[key] ?? []), rule.origin])];
    }
  }

  // Runtime first (creates dataLayer before any provider bootstrap — spec
  // §8), then provider bootstraps, then immediate loaders.
  const runtimeConfig = JSON.stringify({
    page_id: page.pageId,
    page_type: page.pageType,
    locale: page.locale,
    is_search: page.isSearch,
    is_not_found: page.isNotFound,
    deferred,
    consent_key: `pcms:consent:${page.siteKey}`,
    consent_version: createHash("sha256").update(JSON.stringify(settings.providers)).digest("hex"),
  }).replace(/</g, "\\u003c");
  const runtimeScript = `window.__PCMS_ANALYTICS_CONFIG__=${runtimeConfig};\n${ANALYTICS_RUNTIME_SOURCE}`;
  const headEarlyHtml = [
    `<script>${runtimeScript}</script>`,
    ...headEarly.map(serializeFragment),
  ].join("\n");
  const bodyStartHtml = bodyStart.map(serializeFragment).join("\n");
  return {
    headEarlyHtml,
    bodyStartHtml,
    scriptHashes: [sha256(runtimeScript), ...inlineScripts.map(sha256)],
    origins,
    blobFrame,
    dataLayerUsed,
  };
}
