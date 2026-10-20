// Remote diagnostics surface (2026-09-29, "remote diagnostics" platform
// gap): doctor/info read the server-local config, which a token-only agent
// can never reach — the site developer had to fall back to shell access the
// owner had just forbidden. GET /diagnostics answers the same operational
// questions over the API under site.validate: release version, DB, worker
// queue/heartbeat with recent job errors, media providers, registry
// binding, maintenance. Read-only, best-effort per block (a failed read is
// null, never a fake green), no secrets, no PII.

import { systemClock } from "@pcms/core";
import {
  heartbeatAgeMilliseconds,
  heartbeatIsFresh,
  readMaintenanceState,
  readWorkerHeartbeat,
} from "@pcms/operations";
import type { ApplicationServices, OperationContext } from "./context.js";
import { readCmsVersionFromRelease, requirePermission } from "./context.js";

const RECENT_ERRORS_LIMIT = 10;
const ERROR_SNIPPET_LIMIT = 500;

export async function getDiagnosticsOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "site.validate");

  const dbStarted = Date.now();
  const dbOk = await app.pool
    .query("SELECT 1")
    .then(() => true)
    .catch(() => false);
  const db_latency_ms = dbOk ? Date.now() - dbStarted : null;

  const migrationHead = await app.pool
    .query<{ name: string }>("SELECT name FROM pcms_schema_migrations ORDER BY name DESC LIMIT 1")
    .then((result) => result.rows[0]?.name ?? null)
    .catch(() => null);

  const queue = await app.pool
    .query<{
      pending: string;
      running: string;
      dead: string;
      failed_permanent: string;
    }>(
      `SELECT count(*) FILTER (WHERE state = 'PENDING')::text AS pending,
              count(*) FILTER (WHERE state = 'RUNNING')::text AS running,
              count(*) FILTER (WHERE state = 'DEAD')::text AS dead,
              count(*) FILTER (WHERE state = 'FAILED')::text AS failed_permanent
       FROM jobs`,
    )
    .then((result) => {
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            pending: Number(row.pending),
            running: Number(row.running),
            dead: Number(row.dead),
            failed_permanent: Number(row.failed_permanent),
          };
    })
    .catch(() => null);

  const recent_errors = await app.pool
    .query<{
      type: string;
      state: string;
      error_kind: string | null;
      attempts: number;
      last_error: string | null;
      updated_at: string;
    }>(
      `SELECT type, state, error_kind, attempts, last_error, updated_at::text AS updated_at
       FROM jobs WHERE last_error IS NOT NULL
       ORDER BY updated_at DESC LIMIT ${RECENT_ERRORS_LIMIT}`,
    )
    .then((result) =>
      result.rows.map((row) => ({
        type: row.type,
        state: row.state,
        error_kind: row.error_kind,
        attempts: row.attempts,
        // Snippet only: job errors name subsystems, not secrets — still,
        // the surface is diagnostics, not a log dump.
        last_error: row.last_error === null ? null : row.last_error.slice(0, ERROR_SNIPPET_LIMIT),
        updated_at: row.updated_at,
      })),
    )
    .catch(() => []);

  const heartbeat = await readWorkerHeartbeat(app.pool).catch(() => null);
  const worker_heartbeat =
    heartbeat === null
      ? null
      : {
          boot_id: heartbeat.bootId,
          started_at: heartbeat.startedAt,
          last_beat_at: heartbeat.lastBeatAt,
          age_seconds: Math.max(
            0,
            Math.round(heartbeatAgeMilliseconds(heartbeat, systemClock) / 1000),
          ),
          fresh: heartbeatIsFresh(heartbeat, systemClock),
        };

  const providers = await app.mediaProviders.list().catch(() => []);
  const maintenance = await readMaintenanceState(app.pool).catch(() => null);

  return {
    release: { version: readCmsVersionFromRelease() },
    time: new Date().toISOString(),
    db: { ok: dbOk, latency_ms: db_latency_ms, migration_head: migrationHead },
    maintenance: maintenance === null ? null : { enabled: maintenance.enabled },
    worker: { queue, heartbeat: worker_heartbeat, recent_errors },
    media_providers: providers.map((provider) => ({
      provider_id: provider.provider_id,
      kind: provider.kind,
      configured: provider.configured,
    })),
    registry: {
      configured: app.registryClient !== null,
      ...(app.registryClient === null
        ? {}
        : { base_url_configured: true, incoming_dir: app.registryIncomingDir }),
    },
  };
}
