// Analytics & tagging application operations (Analytics spec §10/§11;
// ADR-0016). Settings follow the admin_theme_state CAS pattern; changes are
// audited into the append-only analytics_events trail (provider
// enable/disable + network rule add/update/remove diffs).

import {
  type AnalyticsDiagnostic,
  AnalyticsError,
  type AnalyticsPageContext,
  type AnalyticsRegistry,
  type AnalyticsSettings,
  defaultAnalyticsSettings,
  type SystemDocumentInjection,
  validateAnalyticsSettings,
} from "@pcms/analytics";
import { newStableId } from "@pcms/core";
import type { ApplicationServices, OperationContext } from "./context.js";
import { auditBase, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export interface AnalyticsSettingsWire {
  readonly settings: AnalyticsSettings;
  readonly generation: number;
}

export async function getAnalyticsSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<AnalyticsSettingsWire> {
  requirePermission(app, ctx, "analytics.read");
  return loadAnalyticsSettings(app);
}

async function loadAnalyticsSettings(app: ApplicationServices): Promise<AnalyticsSettingsWire> {
  const result = await app.pool.query<{
    settings: AnalyticsSettings;
    settings_generation: number;
  }>("SELECT settings, settings_generation FROM analytics_settings WHERE site_key = $1", [
    app.defaultSiteKey,
  ]);
  const row = result.rows[0];
  if (row === undefined) {
    return { settings: defaultAnalyticsSettings(), generation: 0 };
  }
  return { settings: row.settings, generation: row.settings_generation };
}

/** Enabled-provider / network-rule diff → the audit event rows (spec §24). */
function settingsAuditEvents(
  before: AnalyticsSettings,
  after: AnalyticsSettings,
): { event_type: string; provider: string | null; payload: Record<string, unknown> }[] {
  const events: {
    event_type: string;
    provider: string | null;
    payload: Record<string, unknown>;
  }[] = [];
  for (const [providerId, config] of Object.entries(after.providers)) {
    const was = before.providers[providerId as keyof typeof before.providers];
    if (config.enabled && !(was?.enabled === true)) {
      events.push({ event_type: "ANALYTICS_PROVIDER_ENABLED", provider: providerId, payload: {} });
    }
    if (!config.enabled && was?.enabled === true) {
      events.push({ event_type: "ANALYTICS_PROVIDER_DISABLED", provider: providerId, payload: {} });
    }
  }
  const beforeRules = new Map(before.networkRules.map((rule) => [rule.id, rule]));
  const afterRules = new Map(after.networkRules.map((rule) => [rule.id, rule]));
  for (const [id, rule] of afterRules) {
    if (!beforeRules.has(id)) {
      events.push({
        event_type: "ANALYTICS_NETWORK_RULE_ADDED",
        provider: null,
        payload: { rule_id: id, origin: rule.origin },
      });
    } else if (JSON.stringify(beforeRules.get(id)) !== JSON.stringify(rule)) {
      events.push({
        event_type: "ANALYTICS_NETWORK_RULE_UPDATED",
        provider: null,
        payload: { rule_id: id, origin: rule.origin },
      });
    }
  }
  for (const [id, rule] of beforeRules) {
    if (!afterRules.has(id)) {
      events.push({
        event_type: "ANALYTICS_NETWORK_RULE_REMOVED",
        provider: null,
        payload: { rule_id: id, origin: rule.origin },
      });
    }
  }
  return events;
}

export async function saveAnalyticsSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly settings: unknown; readonly expected_generation: number },
): Promise<{ generation: number }> {
  requirePermission(app, ctx, "analytics.manage");
  const touchesNetwork =
    typeof input.settings === "object" &&
    input.settings !== null &&
    Array.isArray((input.settings as { networkRules?: unknown }).networkRules) &&
    (input.settings as { networkRules: unknown[] }).networkRules.length > 0;
  if (touchesNetwork) {
    // Network rules change which third-party origins the site may load —
    // deliberately its own scope (Analytics spec §7).
    app.authorize(ctx.actor, "analytics.network.manage");
  }
  let settings: AnalyticsSettings;
  try {
    settings = validateAnalyticsSettings(input.settings);
  } catch (error) {
    if (error instanceof AnalyticsError) {
      throw new ApiError(error.code, error.message, { status: 422 });
    }
    throw error;
  }
  const previous = await loadAnalyticsSettings(app);
  if (previous.generation !== input.expected_generation) {
    throw new ApiError("ANALYTICS_SETTINGS_STALE", "settings were changed concurrently", {
      status: 409,
    });
  }
  const before = previous.settings;
  // An empty replacement also changes network policy when it removes rules.
  if (!touchesNetwork && before.networkRules.length > 0) {
    app.authorize(ctx.actor, "analytics.network.manage");
  }
  const audit = settingsAuditEvents(before, settings);
  const meta = auditBase(ctx);
  const generation = await app.pool.withTransaction(async (tx) => {
    const result = await tx.query<{ settings_generation: number }>(
      `INSERT INTO analytics_settings (site_key, settings, settings_generation)
       VALUES ($1, $2::jsonb, 1)
       ON CONFLICT (site_key) DO UPDATE
         SET settings = $2::jsonb,
             settings_generation = analytics_settings.settings_generation + 1,
             updated_at = now()
       WHERE analytics_settings.settings_generation = $3
       RETURNING settings_generation`,
      [app.defaultSiteKey, JSON.stringify(settings), input.expected_generation],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApiError("ANALYTICS_SETTINGS_STALE", "settings were changed concurrently", {
        status: 409,
      });
    }
    const events =
      audit.length > 0
        ? audit
        : [
            {
              event_type: "ANALYTICS_SETTINGS_UPDATED",
              provider: null,
              payload: {} as Record<string, unknown>,
            },
          ];
    for (const event of events) {
      await tx.query(
        `INSERT INTO analytics_events (id, site_key, event_type, provider, actor_type, actor_id, transport, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          newStableId(),
          app.defaultSiteKey,
          event.event_type,
          event.provider,
          meta.actorType,
          meta.actorId,
          meta.transport,
          JSON.stringify(event.payload),
        ],
      );
    }
    return row.settings_generation;
  });
  app.analytics.updateCachedSettings(settings);
  return { generation };
}

export async function listAnalyticsProvidersOp(app: ApplicationServices): Promise<{
  items: readonly {
    id: string;
    version: number;
    title: string;
    config_schema: Record<string, unknown>;
    privacy: { category: string; loads_before_consent: boolean };
  }[];
}> {
  return {
    items: app.analytics.registry.list().map((provider) => ({
      id: provider.id,
      version: provider.version,
      title: provider.title,
      config_schema: provider.configSchema,
      privacy: {
        category: provider.privacy.category,
        loads_before_consent: provider.privacy.loadsBeforeConsent,
      },
    })),
  };
}

/** Public-render injection for one page (web composition; §2). */
export function analyticsInjectionFor(
  app: ApplicationServices,
  page: AnalyticsPageContext,
): SystemDocumentInjection | null {
  const settings = app.analytics.cachedSettings();
  if (settings === null) return null;
  try {
    return app.analytics.buildInjection(settings, page);
  } catch {
    return null;
  }
}

export async function analyticsDoctorOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<{ issues: readonly AnalyticsDiagnostic[] }> {
  requirePermission(app, ctx, "analytics.read");
  const { settings } = await loadAnalyticsSettings(app);
  return { issues: app.analytics.doctor(settings) };
}
