// IndexNow application operations (Progressive_CMS_IndexNow_v1_Spec.md
// §1–§6/§29): site-level settings (CAS), key generation/rotation, pending
// queue, delivery. DEFAULT = DISABLED — an absent settings row is disabled,
// no code path enables the feature implicitly, and a disabled site makes
// ZERO outbound requests, serves NO key route and delivers NO pending
// notifications (disabling CANCELS the pending queue, so re-enabling never
// replays history).

import { recordSecurityEvent } from "@pcms/auth";
import { newStableId } from "@pcms/core";
import { localizedRoutePath } from "@pcms/routing";
import {
  DEFAULT_INDEXNOW_SETTINGS,
  environmentAllowsIndexing,
  generateIndexNowKey,
  INDEXNOW_BATCH_LIMIT,
  INDEXNOW_COOLDOWN_MS,
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY_RE,
  INDEXNOW_MAX_ATTEMPTS,
  INDEXNOW_VERIFICATION_RETRY_MS,
  type IndexNowReason,
  type IndexNowSettings,
  type IndexNowState,
  indexNowUrlIssue,
  parseIndexNowSettings,
} from "@pcms/seo";
import type { ApplicationServices, OperationContext } from "./context.js";
import { auditBase, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export interface IndexNowSettingsWire {
  readonly settings: IndexNowSettings;
  readonly generation: number;
  readonly keyFileUrl: string | null;
  readonly state: IndexNowState;
  readonly status: IndexNowStatusSnapshot;
}

export interface IndexNowStatusSnapshot {
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastHttpStatus: number | null;
  readonly lastBatchSize: number | null;
  readonly lastDiagnostic: string | null;
}

interface SettingsRow extends Record<string, unknown> {
  readonly settings: IndexNowSettings & { status?: Record<string, unknown> };
  readonly settings_generation: number;
}

function statusFrom(row: SettingsRow | undefined): IndexNowStatusSnapshot {
  const raw = (row?.settings as { status?: Record<string, unknown> } | undefined)?.status ?? {};
  const iso = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    lastAttemptAt: iso(raw["lastAttemptAt"]),
    lastSuccessAt: iso(raw["lastSuccessAt"]),
    lastHttpStatus: typeof raw["lastHttpStatus"] === "number" ? raw["lastHttpStatus"] : null,
    lastBatchSize: typeof raw["lastBatchSize"] === "number" ? raw["lastBatchSize"] : null,
    lastDiagnostic: typeof raw["lastDiagnostic"] === "string" ? raw["lastDiagnostic"] : null,
  };
}

async function loadRow(
  app: ApplicationServices,
): Promise<{ settings: IndexNowSettings; generation: number; status: IndexNowStatusSnapshot }> {
  const siteKey = app.defaultSiteKey;
  const result = await app.pool.query<SettingsRow>(
    "SELECT settings, settings_generation FROM seo_indexnow_settings WHERE site_key = $1",
    [siteKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return {
      settings: { ...DEFAULT_INDEXNOW_SETTINGS },
      generation: 0,
      status: statusFrom(undefined),
    };
  }
  const { status: _stripped, ...settings } = row.settings;
  return {
    settings: parseIndexNowSettings(settings),
    generation: row.settings_generation,
    status: statusFrom(row),
  };
}

async function saveStatus(
  app: ApplicationServices,
  siteKey: string,
  patch: Partial<IndexNowStatusSnapshot>,
): Promise<void> {
  await app.pool.query(
    `UPDATE seo_indexnow_settings
     SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{status}', $2::jsonb, true)
     WHERE site_key = $1`,
    [siteKey, JSON.stringify(patch)],
  );
}

async function primaryHost(app: ApplicationServices): Promise<string | null> {
  const site = await app.routes.findSiteByKey(app.defaultSiteKey);
  if (site === null) return null;
  const bindings = await app.domains.listDomainBindings(site.id);
  const primary = bindings.find((binding) => binding.isPrimary) ?? bindings[0];
  return primary === undefined ? null : primary.hostname;
}

export async function getIndexNowSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<IndexNowSettingsWire> {
  requirePermission(app, ctx, "seo.read");
  return indexNowWire(app);
}

async function indexNowWire(app: ApplicationServices): Promise<IndexNowSettingsWire> {
  const { settings, generation, status } = await loadRow(app);
  const host = await primaryHost(app);
  const keyFileUrl =
    settings.enabled && settings.key !== null && host !== null
      ? `https://${host}/${settings.key}.txt`
      : null;
  let state: IndexNowState = "Disabled";
  if (settings.enabled) {
    const pending = await app.pool.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM seo_indexnow_pending WHERE site_key = $1",
      [app.defaultSiteKey],
    );
    const pendingCount = Number(pending.rows[0]?.count ?? 0);
    state = !environmentAllowsIndexing(app.seoEnvironment)
      ? "Suppressed by noindex"
      : settings.key === null
        ? "Configured"
        : status.lastDiagnostic === "INDEXNOW_DELIVERY_INVALID_KEY"
          ? "Configuration error"
          : status.lastHttpStatus === 429
            ? "Rate limited"
            : status.lastDiagnostic === "INDEXNOW_DELIVERY_FAILED"
              ? "Delivery degraded"
              : status.lastHttpStatus === 202 || status.lastSuccessAt === null
                ? "Awaiting verification"
                : "Operational";
    void pendingCount;
  }
  return { settings, generation, keyFileUrl, state, status };
}

/** Enables/disables and updates notify flags (CAS). Enabling generates the
 * key when absent and enqueues AT MOST ONE verification notification for the
 * canonical homepage — never a historical backfill. Disabling CANCELS the
 * pending queue (suppression = cancellation; re-enable starts clean). */
export async function saveIndexNowSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly settings: {
      readonly enabled: boolean;
      readonly notifyOnPublish?: boolean;
      readonly notifyOnUpdate?: boolean;
      readonly notifyOnUnpublish?: boolean;
      readonly notifyOnRouteChange?: boolean;
    };
    readonly expected_generation: number;
  },
): Promise<{ generation: number; keyFileUrl: string | null }> {
  requirePermission(app, ctx, "seo.site_settings");
  const site = await app.routes.findSiteByKey(app.defaultSiteKey);
  if (site === null) {
    throw new ApiError("SITE_NOT_FOUND", `site "${app.defaultSiteKey}" does not exist`, {
      status: 404,
    });
  }
  const host = await primaryHost(app);
  if (input.settings.enabled && host === null) {
    throw new ApiError(
      "INDEXNOW_CANONICAL_ORIGIN_MISSING",
      "IndexNow needs a primary domain binding (canonical public origin) before it can be enabled",
      { status: 422 },
    );
  }
  const before = await loadRow(app);
  let key = before.settings.key;
  if (input.settings.enabled && key === null) key = generateIndexNowKey();
  const settings: IndexNowSettings = {
    schemaVersion: 1,
    enabled: input.settings.enabled,
    key,

    notifyOnPublish: input.settings.notifyOnPublish ?? true,
    notifyOnUpdate: input.settings.notifyOnUpdate ?? true,
    notifyOnUnpublish: input.settings.notifyOnUnpublish ?? true,
    notifyOnRouteChange: input.settings.notifyOnRouteChange ?? true,
  };
  const persisted = JSON.stringify({
    ...settings,
    ...(Object.keys(before.status).length === 0 ? {} : { status: before.status }),
  });
  const generation = await app.pool.withTransaction(async (tx) => {
    const result = await tx.query<{ settings_generation: number }>(
      `INSERT INTO seo_indexnow_settings (site_key, settings, settings_generation)
       VALUES ($1, $2::jsonb, 1)
       ON CONFLICT (site_key) DO UPDATE
         SET settings = $2::jsonb,
             settings_generation = seo_indexnow_settings.settings_generation + 1,
             updated_at = now()
       WHERE seo_indexnow_settings.settings_generation = $3
       RETURNING settings_generation`,
      [app.defaultSiteKey, persisted, input.expected_generation],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApiError("INDEXNOW_SETTINGS_STALE", "settings were changed concurrently", {
        status: 409,
      });
    }
    if (before.settings.enabled && !settings.enabled) {
      // Disabled: cancel the pending queue — suppressed means never
      // delivered, and a re-enable must not replay history (spec §1).
      await tx.query("DELETE FROM seo_indexnow_pending WHERE site_key = $1", [app.defaultSiteKey]);
    }
    if (!before.settings.enabled && settings.enabled) {
      // Enable flow: at most ONE verification notification (canonical
      // homepage) — never a bulk backfill (spec §12).
      const homePath = "/";
      const url = `https://${host}${homePath}`;
      await tx.query(
        `INSERT INTO seo_indexnow_pending (id, site_key, url, reason)
         VALUES ($1, $2, $3, 'verification') ON CONFLICT (site_key, url) DO NOTHING`,
        [newStableId(), app.defaultSiteKey, url],
      );
      await enqueueFlush(tx, app.defaultSiteKey);
    }
    return row.settings_generation;
  });
  const eventType =
    settings.enabled && !before.settings.enabled
      ? "INDEXNOW_ENABLED"
      : !settings.enabled && before.settings.enabled
        ? "INDEXNOW_DISABLED"
        : "INDEXNOW_SETTINGS_UPDATED";
  await recordSecurityEvent(app.pool, null, {
    type: eventType,
    ...auditBase(ctx),
    subjectType: "seo_indexnow",
    subjectId: app.defaultSiteKey,
    metadata: { enabled: settings.enabled },
  });
  app.indexNow.updateCachedSettings(settings); // key route + delivery see it immediately
  const wire = await indexNowWire(app);
  return { generation, keyFileUrl: wire.keyFileUrl };
}

function enqueueFlush(
  executor: { query(sql: string, params?: readonly unknown[]): Promise<unknown> },
  siteKey: string,
): Promise<void> {
  // Idempotent per site: duplicate pending flushes collapse (jobs dedupe on
  // the idempotency key while one is queued; a completed one re-enqueues).
  return executor
    .query(
      `INSERT INTO jobs (id, type, payload, run_at, idempotency_key, max_attempts, origin)
       VALUES ($1, 'seo.indexnow.flush', $2::jsonb, now(), $3, 3, 'worker')
       ON CONFLICT DO NOTHING`,
      [newStableId(), JSON.stringify({ siteKey }), `seo.indexnow.flush:${siteKey}`],
    )
    .then(() => undefined);
}

/** Publication event → pending notifications (planner; spec §8–§10).
 * Disabled sites short-circuit BEFORE anything is queued. */
export async function planIndexNowForPublicationEvent(
  app: ApplicationServices,
  event: {
    readonly eventType: string;
    readonly payload: { entityType?: unknown; entityId?: unknown; context?: unknown };
  },
): Promise<void> {
  const { settings } = await loadRow(app);
  if (!settings.enabled) return;
  const payload = event.payload ?? {};
  if (payload.entityType !== "entry" || typeof payload.entityId !== "string") return;
  const context = typeof payload.context === "string" ? payload.context : "default";
  const site = await app.routes.findSiteByKey(app.defaultSiteKey);
  if (site === null) return;
  const host = await primaryHost(app);
  if (host === null) return;
  const localeOption = context === "default" ? {} : ({ locale: context } as { locale: string });

  const queue = async (url: string, reason: IndexNowReason): Promise<void> => {
    if (url === null || url === "") return;
    if (indexNowUrlIssue(url, host) !== null) return;
    await app.pool.query(
      `INSERT INTO seo_indexnow_pending (id, site_key, url, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_key, url) DO UPDATE SET queued_at = now()`,
      [newStableId(), app.defaultSiteKey, url, reason],
    );
    await enqueueFlush(app.pool, app.defaultSiteKey);
  };

  if (event.eventType.endsWith("RouteChanged")) {
    if (!settings.notifyOnRouteChange) return;
    const record = payload as { previousPath?: unknown; path?: unknown };
    if (typeof record.previousPath !== "string" || typeof record.path !== "string") return;
    const locale = context === "default" ? "x-default" : context;
    await queue(
      `https://${host}${localizedRoutePath({ locale, path: record.previousPath })}`,
      "route_changed",
    );
    await queue(
      `https://${host}${localizedRoutePath({ locale, path: record.path })}`,
      "route_changed",
    );
    return;
  }

  const unpublished = event.eventType.endsWith("Unpublished");
  const rolledBack = event.eventType.endsWith("RolledBack");
  if (unpublished && !settings.notifyOnUnpublish) return;
  if (rolledBack && !settings.notifyOnUpdate) return;
  if (!unpublished && !rolledBack) {
    if (!settings.notifyOnPublish && !settings.notifyOnUpdate) return;
  }

  // The published/canonical URL. For unpublish the canonical route SURVIVES
  // the pointer removal — the previous public URL must still be reported
  // (spec §10 exception).
  let url: string | null = null;
  try {
    url = await app.canonical.getCanonicalUrl(payload.entityId as never, localeOption);
  } catch {
    return; // unrouted entry — nothing public to report
  }
  await queue(url, unpublished ? "unpublished" : rolledBack ? "rollback" : "updated");
}

export async function getIndexNowStatusOp(app: ApplicationServices): Promise<{
  state: IndexNowState;
  key_file_url: string | null;
  pending_url_count: number;
  status: IndexNowStatusSnapshot;
  checks: readonly { code: string; ok: boolean; severity: "error" | "warning" | "info" }[];
}> {
  const wire = await indexNowWire(app);
  const pending = await app.pool.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM seo_indexnow_pending WHERE site_key = $1",
    [app.defaultSiteKey],
  );
  const host = await primaryHost(app);
  const settings = wire.settings;
  const checks: { code: string; ok: boolean; severity: "error" | "warning" | "info" }[] = [];
  checks.push({ code: "INDEXNOW_CONFIG_VALID", ok: true, severity: "info" });
  checks.push({
    code: "INDEXNOW_CANONICAL_ORIGIN_PRESENT",
    ok: host !== null,
    severity: host === null ? "warning" : "info",
  });
  checks.push({
    code: "INDEXNOW_KEY_VALID",
    ok: !settings.enabled || settings.key === null || INDEXNOW_KEY_RE.test(settings.key),
    severity: "info",
  });
  checks.push({
    code: "INDEXNOW_SITE_INDEXABLE",
    ok: !settings.enabled || environmentAllowsIndexing(app.seoEnvironment),
    severity: "info",
  });
  if (!environmentAllowsIndexing(app.seoEnvironment) && settings.enabled) {
    checks.push({
      code: "INDEXNOW_SUPPRESSED_BY_NOINDEX",
      ok: false,
      severity: "warning",
    });
  }
  return {
    state: wire.state,
    key_file_url: wire.keyFileUrl,
    pending_url_count: Number(pending.rows[0]?.count ?? 0),
    status: wire.status,
    checks,
  };
}

export async function rotateIndexNowKeyOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<{ generation: number; key_file_url: string | null }> {
  requirePermission(app, ctx, "seo.site_settings");
  const { settings, generation } = await loadRow(app);
  if (!settings.enabled) {
    throw new ApiError("INDEXNOW_SETTINGS_INVALID", "IndexNow is not enabled", { status: 409 });
  }
  const key = generateIndexNowKey();
  await app.pool.query(
    `UPDATE seo_indexnow_settings
     SET settings = jsonb_set(settings, '{key}', to_jsonb($2::text)), updated_at = now()
     WHERE site_key = $1`,
    [app.defaultSiteKey, key],
  );
  await app.indexNow.updateCachedSettings({ ...settings, key });
  await recordSecurityEvent(app.pool, null, {
    type: "INDEXNOW_KEY_ROTATED",
    ...auditBase(ctx),
    subjectType: "seo_indexnow",
    subjectId: app.defaultSiteKey,
    metadata: {},
  });
  const wire = await indexNowWire(app);
  return { generation, key_file_url: wire.keyFileUrl };
}

/** «Проверить настройку» (spec §28): local checks + enqueue the homepage
 * verification notification. No external HTTP inside the transaction. */
export async function checkIndexNowOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<{ queued: boolean; checks: readonly { code: string; ok: boolean }[] }> {
  requirePermission(app, ctx, "seo.site_settings");
  const { settings } = await loadRow(app);
  const status = await getIndexNowStatusOp(app);
  if (!settings.enabled) {
    throw new ApiError("INDEXNOW_SETTINGS_INVALID", "IndexNow is not enabled", { status: 409 });
  }
  const host = await primaryHost(app);
  let queued = false;
  if (host !== null && environmentAllowsIndexing(app.seoEnvironment)) {
    const url = `https://${host}/`;
    await app.pool.query(
      `INSERT INTO seo_indexnow_pending (id, site_key, url, reason)
       VALUES ($1, $2, $3, 'verification') ON CONFLICT (site_key, url) DO UPDATE SET queued_at = now()`,
      [newStableId(), app.defaultSiteKey, url],
    );
    await enqueueFlush(app.pool, app.defaultSiteKey);
    queued = true;
  }
  return { queued, checks: status.checks.map(({ code, ok }) => ({ code, ok })) };
}

/** Worker flush job (spec §14/§18/§21): disabled sites are a no-op (pending
 * preserved but never delivered — and disable already cancelled the queue),
 * the global noindex environment suppresses delivery, batches are
 * per-host/deduped, the key is resolved at send time. */
export async function deliverIndexNowPending(app: ApplicationServices): Promise<void> {
  const { settings } = await loadRow(app);
  if (!settings.enabled || settings.key === null) return; // suppressed: zero outbound
  if (!environmentAllowsIndexing(app.seoEnvironment)) return; // spec §11
  const host = await primaryHost(app);
  if (host === null) return;
  const due = await app.pool.query<{ id: string; url: string }>(
    `SELECT id, url FROM seo_indexnow_pending
     WHERE site_key = $1 AND not_before <= now()
     ORDER BY queued_at
     LIMIT $2`,
    [app.defaultSiteKey, INDEXNOW_BATCH_LIMIT],
  );
  if (due.rows.length === 0) return;
  const urls = [...new Set(due.rows.map((row) => row.url))].filter(
    (url) => indexNowUrlIssue(url, host) === null,
  );
  if (urls.length === 0) {
    await app.pool.query("DELETE FROM seo_indexnow_pending WHERE id = ANY($1::uuid[])", [
      due.rows.map((row) => row.id),
    ]);
    return;
  }
  const attemptAt = (delayMs: number): string => new Date(Date.now() + delayMs).toISOString();
  const requeue = async (ids: readonly string[], delayMs: number): Promise<void> => {
    for (const id of ids) {
      await app.pool.query(
        `UPDATE seo_indexnow_pending
         SET not_before = $2, attempts = attempts + 1
         WHERE id = $1 AND attempts < $3`,
        [id, attemptAt(delayMs), INDEXNOW_MAX_ATTEMPTS],
      );
      // Bounded retry: past the cap the row is dropped — the diagnostic in
      // the status snapshot is the dead-letter surface (spec §22).
      await app.pool.query("DELETE FROM seo_indexnow_pending WHERE id = $1 AND attempts >= $2", [
        id,
        INDEXNOW_MAX_ATTEMPTS,
      ]);
    }
  };
  let httpStatus: number | null = null;
  try {
    const response = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key: settings.key, urlList: urls }),
      signal: AbortSignal.timeout(15_000),
    });
    httpStatus = response.status;
    if (response.status === 200) {
      await app.pool.query("DELETE FROM seo_indexnow_pending WHERE id = ANY($1::uuid[])", [
        due.rows.map((row) => row.id),
      ]);
    } else if (response.status === 202) {
      await requeue(
        due.rows.map((row) => row.id),
        INDEXNOW_VERIFICATION_RETRY_MS,
      );
    } else if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "");
      await requeue(
        due.rows.map((row) => row.id),
        Number.isFinite(retryAfter) ? retryAfter * 1000 : 300_000,
      );
    } else if (response.status === 403) {
      await saveStatus(app, app.defaultSiteKey, {
        lastDiagnostic: "INDEXNOW_DELIVERY_INVALID_KEY",
      });
      await requeue(
        due.rows.map((row) => row.id),
        3_600_000,
      );
    } else if (response.status === 400 || response.status === 405 || response.status === 422) {
      // Permanent: drop with a diagnostic (dead-letter observable in status).
      await app.pool.query("DELETE FROM seo_indexnow_pending WHERE id = ANY($1::uuid[])", [
        due.rows.map((row) => row.id),
      ]);
      await saveStatus(app, app.defaultSiteKey, {
        lastDiagnostic: `INDEXNOW_DELIVERY_REJECTED (HTTP ${response.status})`,
      });
    } else {
      await requeue(
        due.rows.map((row) => row.id),
        300_000,
      );
    }
  } catch {
    // timeout/DNS/connection — transient backoff, publication unaffected.
    await requeue(
      due.rows.map((row) => row.id),
      300_000,
    );
    httpStatus = 0;
  }
  await saveStatus(app, app.defaultSiteKey, {
    lastAttemptAt: new Date().toISOString(),
    ...(httpStatus !== null ? { lastHttpStatus: httpStatus } : {}),
    lastBatchSize: urls.length,
    ...(httpStatus === 200 ? { lastSuccessAt: new Date().toISOString() } : {}),
  });
}
