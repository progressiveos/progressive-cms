import { randomUUID } from "node:crypto";
import { assertTokenConstraints, recordSecurityEvent } from "@pcms/auth";
import type { DbClient, DbPool } from "@pcms/core";
import {
  createThemeDiscovery,
  removeThemeRevisionFiles,
  resolveInstalledThemeDirectory,
  resolveSettingsValues,
  restoreThemeCatalog,
  satisfiesVersion,
  snapshotThemeFiles,
  stageThemePackage,
  ThemeInstallError,
  themeRevisionDirectory,
} from "@pcms/themes";
import type { ApplicationServices, OperationContext } from "./context.js";
import { auditBase } from "./context.js";
import { ApiError } from "./errors.js";

type Values = Record<string, boolean | string | number | null>;
export interface ThemeRevisionRow extends Record<string, unknown> {
  id: string;
  site_key: string;
  theme_key: string;
  package_version: string;
  file_sha256: string;
  storage_key: string;
  settings: Values;
}
interface ThemeStateRow extends Record<string, unknown> {
  theme_key: string | null;
  theme_version: string | null;
  settings: Values | null;
  settings_generation: number;
  theme_generation: string | number;
  active_revision_id: string | null;
  pending_operation_id: string | null;
}
interface OperationRow extends Record<string, unknown> {
  id: string;
  phase: "PREPARED" | "COMMITTED" | "ABORTED";
  from_revision_id: string;
  target_revision_id: string;
  catalog_theme_key: string | null;
  catalog_before_revision_id: string | null;
}
interface LifecycleInput {
  pool: DbPool;
  configuredDir: string;
  siteKey: string;
}
function failure(code: string, phase: string, operationId?: string): ApiError {
  return new ApiError(code, "theme change requires authoritative lifecycle recovery", {
    status: code === "THEME_CHANGE_BUSY" ? 409 : 503,
    retryable: true,
    details: [{ phase, ...(operationId ? { operation_id: operationId } : {}) }],
  });
}
export async function withThemeLifecycleLock<T>(
  input: LifecycleInput,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  return input.pool.withClient(async (client) => {
    const locked = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('pcms:theme'), hashtext(current_schema() || ':' || $1)) AS acquired",
      [input.siteKey],
    );
    if (!locked.rows[0]?.acquired) throw failure("THEME_CHANGE_BUSY", "LOCK");
    try {
      return await work(client);
    } finally {
      try {
        const unlocked = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(hashtext('pcms:theme'), hashtext(current_schema() || ':' || $1)) AS released",
          [input.siteKey],
        );
        if (!unlocked.rows[0]?.released) client.discard?.();
      } catch (error) {
        client.discard?.(error instanceof Error ? error : undefined);
      }
    }
  });
}
async function transaction<T>(db: DbClient, work: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await work();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch {
      db.discard?.();
    }
    throw error;
  }
}
export async function readThemeLifecycleState(
  db: DbClient,
  siteKey: string,
): Promise<ThemeStateRow | null> {
  const result = await db.query<ThemeStateRow>(
    "SELECT theme_key, theme_version, settings, settings_generation, theme_generation, active_revision_id, pending_operation_id FROM admin_theme_state WHERE site_key = $1",
    [siteKey],
  );
  return result.rows[0] ?? null;
}
async function revision(db: DbClient, siteKey: string, id: string): Promise<ThemeRevisionRow> {
  const result = await db.query<ThemeRevisionRow>(
    "SELECT * FROM theme_revisions WHERE site_key = $1 AND id = $2",
    [siteKey, id],
  );
  if (!result.rows[0]) throw failure("THEME_RECOVERY_UNAVAILABLE", "REVISION");
  return result.rows[0];
}
async function recoverLocked(input: LifecycleInput, db: DbClient): Promise<void> {
  const state = await readThemeLifecycleState(db, input.siteKey);
  if (!state?.pending_operation_id) return;
  const pending = await db.query<OperationRow>(
    "SELECT * FROM theme_operations WHERE site_key = $1 AND id = $2",
    [input.siteKey, state.pending_operation_id],
  );
  const operation = pending.rows[0];
  if (operation?.phase !== "PREPARED")
    throw failure("THEME_RECOVERY_UNAVAILABLE", "JOURNAL", state.pending_operation_id);
  const source = await revision(db, input.siteKey, operation.from_revision_id);
  if (state.active_revision_id !== source.id)
    throw failure("THEME_RECOVERY_UNAVAILABLE", "POINTER", operation.id);
  if (operation.catalog_theme_key) {
    if (!operation.catalog_before_revision_id)
      throw failure("THEME_RECOVERY_UNAVAILABLE", "CATALOG", operation.id);
    const catalogBefore = await revision(db, input.siteKey, operation.catalog_before_revision_id);
    restoreThemeCatalog(
      input.configuredDir,
      operation.catalog_theme_key,
      themeRevisionDirectory(input.configuredDir, catalogBefore.storage_key),
      operation.id,
    );
  }
  await transaction(db, async () => {
    await db.query(
      "UPDATE theme_operations SET phase = 'ABORTED', finished_at = now() WHERE id = $1 AND site_key = $2 AND phase = 'PREPARED'",
      [operation.id, input.siteKey],
    );
    await db.query(
      "UPDATE admin_theme_state SET pending_operation_id = NULL WHERE site_key = $1 AND pending_operation_id = $2",
      [input.siteKey, operation.id],
    );
  });
}
/** Called before discovery reads the mutable catalog on process startup. */
export async function recoverThemeLifecycle(input: LifecycleInput): Promise<void> {
  await withThemeLifecycleLock(input, async (db) => recoverLocked(input, db));
}
async function storeRevision(
  input: LifecycleInput,
  db: DbClient,
  dir: string,
  settings: Values,
): Promise<ThemeRevisionRow> {
  const manifest = createThemeDiscovery(dir).getManifest();
  const files = snapshotThemeFiles(input.configuredDir, dir);
  const row: ThemeRevisionRow = {
    id: randomUUID(),
    site_key: input.siteKey,
    theme_key: manifest.id,
    package_version: manifest.version,
    file_sha256: files.sha256,
    storage_key: files.storageKey,
    settings,
  };
  await db.query(
    "INSERT INTO theme_revisions(id, site_key, theme_key, package_version, file_sha256, storage_key, settings) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [
      row.id,
      row.site_key,
      row.theme_key,
      row.package_version,
      row.file_sha256,
      row.storage_key,
      JSON.stringify(settings),
    ],
  );
  return row;
}
function installedDirectory(configuredDir: string, key: string, cmsVersion: string): string {
  try {
    return resolveInstalledThemeDirectory(configuredDir, key, cmsVersion);
  } catch (error) {
    if (error instanceof ThemeInstallError)
      throw new ApiError(error.code, error.message, {
        status: error.code === "THEME_NOT_INSTALLED" ? 404 : 422,
      });
    throw error;
  }
}
function inputOf(app: ApplicationServices): LifecycleInput {
  const configuredDir = app.themeRuntime.configuredDir;
  if (!configuredDir)
    throw new ApiError("API_NOT_FOUND", "no theme source is configured", { status: 404 });
  return { pool: app.pool, siteKey: app.defaultSiteKey, configuredDir };
}
export type ThemeMutation =
  | { kind: "SETTINGS"; values: unknown; expectedGeneration: number }
  | { kind: "ACTIVATE"; themeKey: string; themeVersion?: string; expectedGeneration?: number }
  | { kind: "UPDATE"; packageBytes: Buffer; expectedGeneration?: number }
  | { kind: "ROLLBACK"; revisionId: string; expectedGeneration: number };
export async function changeTheme(
  app: ApplicationServices,
  ctx: OperationContext,
  mutation: ThemeMutation,
): Promise<{
  generation: number;
  applied: boolean;
  info?: { id: string; name: string; version: string; sha256: string };
}> {
  const input = inputOf(app);
  return app.themeRuntime.withChange(async () =>
    withThemeLifecycleLock(input, async (db) => {
      let phase = "RECOVERY";
      let operationId: string | undefined;
      try {
        await recoverLocked(input, db);
        let state = await readThemeLifecycleState(db, input.siteKey);
        const cmsVersion = app.extensions.contractVersions.get("cms")!.version;
        const currentDir = state?.active_revision_id
          ? themeRevisionDirectory(
              input.configuredDir,
              (await revision(db, input.siteKey, state.active_revision_id)).storage_key,
              cmsVersion,
            )
          : state?.theme_key
            ? installedDirectory(input.configuredDir, state.theme_key, cmsVersion)
            : input.configuredDir;
        if (
          mutation.kind === "SETTINGS" &&
          (state?.settings_generation ?? 0) !== mutation.expectedGeneration
        )
          throw new ApiError("THEME_SETTINGS_STALE", "settings were changed concurrently", {
            status: 409,
          });
        if (
          mutation.kind === "ROLLBACK" &&
          Number(state?.theme_generation ?? 0) !== mutation.expectedGeneration
        )
          throw new ApiError("THEME_REVISION_STALE", "theme was changed concurrently", {
            status: 409,
          });
        // Caller CAS for update/activate (CORE-THEME-REMOTE-PACKAGE-CYCLE §4):
        // checked inside the lifecycle lock, after recovery, BEFORE the lazy
        // baseline, snapshots, catalog writes or the pointer move. Generation
        // 0 is a real value, so the check is on `undefined`, not falsiness.
        if (
          (mutation.kind === "UPDATE" || mutation.kind === "ACTIVATE") &&
          mutation.expectedGeneration !== undefined &&
          Number(state?.theme_generation ?? 0) !== mutation.expectedGeneration
        )
          throw new ApiError(
            "THEME_REVISION_STALE",
            `theme generation is ${Number(state?.theme_generation ?? 0)}, not ${mutation.expectedGeneration}; read the served theme again`,
            { status: 409 },
          );
        phase = "SNAPSHOT";
        // Baseline registration is lazy; it preserves the exact existing settings.
        if (!state?.active_revision_id) {
          await transaction(db, async () => {
            const baseline = await storeRevision(input, db, currentDir, state?.settings ?? {});
            await db.query(
              `INSERT INTO admin_theme_state(site_key,theme_key,theme_version,settings,settings_generation,active_revision_id)
          VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(site_key) DO UPDATE SET active_revision_id=$6`,
              [
                input.siteKey,
                baseline.theme_key,
                baseline.package_version,
                JSON.stringify(baseline.settings),
                state?.settings_generation ?? 0,
                baseline.id,
              ],
            );
          });
          state = await readThemeLifecycleState(db, input.siteKey);
        }
        if (!state?.active_revision_id) throw failure("THEME_RECOVERY_UNAVAILABLE", "BASELINE");
        const source = await revision(db, input.siteKey, state.active_revision_id);
        let stage: Awaited<ReturnType<typeof stageThemePackage>> | undefined;
        try {
          let dir = currentDir;
          let catalogBefore: ThemeRevisionRow | undefined;
          let retained: ThemeRevisionRow | null = null;
          if (mutation.kind === "ROLLBACK") {
            retained = await getConfirmedThemeRevision(db, input.siteKey, mutation.revisionId);
            if (!retained)
              throw new ApiError("THEME_REVISION_NOT_FOUND", "retained theme revision not found", {
                status: 404,
              });
            dir = themeRevisionDirectory(input.configuredDir, retained.storage_key, cmsVersion);
          }
          if (mutation.kind === "UPDATE") {
            stage = await stageThemePackage(mutation.packageBytes, cmsVersion);
            if (stage.info.id !== source.theme_key)
              throw new ApiError(
                "THEME_UPDATE_ID_INVALID",
                "update-active only updates the same theme",
                { status: 409 },
              );
            const catalogDir = installedDirectory(
              input.configuredDir,
              source.theme_key,
              cmsVersion,
            );
            const installed = createThemeDiscovery(catalogDir, { cmsVersion }).getManifest();
            if (!satisfiesVersion(stage.info.version, `>${installed.version}`))
              throw new ApiError(
                "THEME_UPDATE_VERSION_CONFLICT",
                "package version must be newer than the active theme",
                { status: 409 },
              );
            catalogBefore = await transaction(db, () =>
              storeRevision(input, db, catalogDir, source.settings),
            );
            dir = stage.dir;
          } else if (mutation.kind === "ACTIVATE")
            dir = installedDirectory(input.configuredDir, mutation.themeKey, cmsVersion);
          const manifest = createThemeDiscovery(dir, { cmsVersion }).getManifest();
          if (
            mutation.kind === "ACTIVATE" &&
            mutation.themeVersion !== undefined &&
            mutation.themeVersion !== manifest.version
          )
            throw new ApiError(
              "THEME_VERSION_CONFLICT",
              "requested version differs from installed package",
              { status: 409 },
            );
          const previous = state.settings ?? {};
          const values =
            mutation.kind === "ROLLBACK"
              ? retained!.settings
              : mutation.kind === "SETTINGS"
                ? (mutation.values ?? {})
                : mutation.kind === "ACTIVATE"
                  ? Object.fromEntries(
                      (manifest.settings_schema ?? [])
                        .filter((setting) => setting.key in previous)
                        .map((setting) => [setting.key, previous[setting.key]]),
                    )
                  : previous;
          const resolved = resolveSettingsValues(manifest.settings_schema, values as never);
          if (!resolved.ok)
            throw new ApiError(
              mutation.kind === "UPDATE"
                ? "THEME_UPDATE_COMPATIBILITY_INVALID"
                : "THEME_SETTINGS_INVALID",
              "settings values do not match the theme schema",
              {
                status: mutation.kind === "UPDATE" ? 409 : 422,
                details: resolved.issues as unknown[],
              },
            );
          const generation = state.settings_generation + (mutation.kind === "UPDATE" ? 0 : 1);
          const target =
            retained ??
            (await transaction(db, async () => storeRevision(input, db, dir, resolved.values)));
          const targetDir = themeRevisionDirectory(input.configuredDir, target.storage_key);
          const oldDir = themeRevisionDirectory(input.configuredDir, source.storage_key);
          phase = "PREPARE";
          let apply: (() => void) | undefined;
          try {
            apply = await app.themeRuntime.prepareState?.(targetDir, target.settings, generation);
          } catch (error) {
            if (mutation.kind === "UPDATE")
              throw new ApiError(
                "THEME_UPDATE_COMPATIBILITY_INVALID",
                "cannot prepare render stack for the package",
                { status: 409 },
              );
            throw error;
          }
          const restore = await app.themeRuntime.prepareState?.(
            oldDir,
            source.settings,
            state.settings_generation,
          );
          if (mutation.kind !== "SETTINGS" && !apply)
            throw new ApiError(
              "THEME_RUNTIME_UNAVAILABLE",
              "public theme renderer is not registered",
              { status: 409 },
            );
          operationId = randomUUID();
          phase = "INTENT";
          await transaction(db, async () => {
            await db.query(
              "INSERT INTO theme_operations(id,site_key,kind,from_revision_id,target_revision_id,expected_generation,phase,catalog_theme_key,catalog_before_revision_id) VALUES($1,$2,$3,$4,$5,$6,'PREPARED',$7,$8)",
              [
                operationId,
                input.siteKey,
                mutation.kind,
                source.id,
                target.id,
                state.theme_generation,
                mutation.kind === "UPDATE" ? target.theme_key : null,
                catalogBefore?.id ?? null,
              ],
            );
            await db.query(
              "UPDATE admin_theme_state SET pending_operation_id=$2 WHERE site_key=$1",
              [input.siteKey, operationId],
            );
          });
          try {
            phase = "FILES";
            if (mutation.kind === "UPDATE")
              restoreThemeCatalog(input.configuredDir, target.theme_key, targetDir, operationId);
            phase = "RENDER";
            apply?.();
            phase = "CONFIRM";
            await transaction(db, async () => {
              const updated = await db.query(
                `UPDATE admin_theme_state SET theme_key=$2,theme_version=$3,settings=$4::jsonb,settings_generation=$5,
            active_revision_id=$6,theme_generation=theme_generation+1,pending_operation_id=NULL,updated_at=now()
            WHERE site_key=$1 AND theme_generation=$7 AND pending_operation_id=$8`,
                [
                  input.siteKey,
                  target.theme_key,
                  target.package_version,
                  JSON.stringify(target.settings),
                  generation,
                  target.id,
                  state.theme_generation,
                  operationId,
                ],
              );
              if (updated.rowCount !== 1)
                throw failure("THEME_CHANGE_BUSY", "CONFIRM", operationId);
              await db.query(
                "UPDATE theme_operations SET phase='COMMITTED',finished_at=now() WHERE id=$1 AND site_key=$2",
                [operationId, input.siteKey],
              );
              await recordSecurityEvent(db, null, {
                type: "THEME_UPDATED",
                ...auditBase(ctx),
                subjectType: "theme",
                subjectId: target.theme_key,
                metadata: {
                  operation_id: operationId,
                  kind: mutation.kind,
                  version: target.package_version,
                  revision_id: target.id,
                  ...(stage ? { sha256: stage.info.sha256 } : {}),
                },
              });
            });
          } catch (error) {
            // COMMIT errors are ambiguous: a fresh autocommit journal read decides
            // the outcome. A broken session fails closed for reconnect recovery.
            let durable: { phase: string } | undefined;
            try {
              durable = (
                await db.query<{ phase: string }>(
                  "SELECT phase FROM theme_operations WHERE id=$1 AND site_key=$2",
                  [operationId, input.siteKey],
                )
              ).rows[0];
            } catch {
              throw failure("THEME_RECOVERY_UNAVAILABLE", "CONFIRM", operationId);
            }
            if (durable?.phase === "COMMITTED") {
              apply?.();
            } else if (durable?.phase === "PREPARED") {
              try {
                await recoverLocked(input, db);
                restore?.();
              } catch {
                throw failure("THEME_RECOVERY_UNAVAILABLE", "RESTORE", operationId);
              }
              throw error;
            } else throw failure("THEME_RECOVERY_UNAVAILABLE", "JOURNAL", operationId);
          }
          app.themeRuntime.confirmed?.(target.id, Number(state.theme_generation) + 1);
          return {
            generation,
            applied: apply !== undefined,
            ...(stage ? { info: stage.info } : {}),
          };
        } finally {
          try {
            stage?.cleanup();
          } catch {
            /* A temporary-stage cleanup cannot undo a confirmed operation. */
          }
          // Keep confirmed history while other Web processes may still serve it.
          // Only unpublished snapshots with no journal/pointer references are safe.
          try {
            await cleanUnreferencedThemeRevisions(input, db);
          } catch {
            console.warn("[pcms:theme] unreferenced snapshot cleanup deferred", {
              operation_id: operationId,
            });
          }
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof ThemeInstallError)
          throw new ApiError(error.code, error.message, {
            status:
              error.code === "THEME_NOT_INSTALLED" ? 404 : mutation.kind === "UPDATE" ? 409 : 422,
          });
        throw failure("THEME_CHANGE_FAILED", phase, operationId);
      }
    }),
  );
}

// A lazy baseline is confirmed by the active pointer or by being an operation's
// source. Unconfirmed targets and private catalog snapshots are never exposed.
const CONFIRMED = `(r.pruned_at IS NULL AND (EXISTS (SELECT 1 FROM admin_theme_state a WHERE a.site_key=r.site_key AND a.active_revision_id=r.id)
 OR EXISTS (SELECT 1 FROM theme_operations o WHERE o.site_key=r.site_key AND (o.from_revision_id=r.id OR (o.phase='COMMITTED' AND o.target_revision_id=r.id)))))`;
export async function getConfirmedThemeRevision(
  db: DbClient,
  siteKey: string,
  id: string,
): Promise<ThemeRevisionRow | null> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return null;
  return (
    (
      await db.query<ThemeRevisionRow>(
        `SELECT r.* FROM theme_revisions r WHERE r.site_key=$1 AND r.id=$2 AND ${CONFIRMED}`,
        [siteKey, id],
      )
    ).rows[0] ?? null
  );
}
export async function listThemeRevisions(app: ApplicationServices, ctx: OperationContext) {
  app.authorize(ctx.actor, "theme.read");
  assertTokenConstraints(ctx.actor, {
    siteKey: app.defaultSiteKey,
    environment: ctx.actor.environment,
  });
  const rows = await app.pool.query<
    ThemeRevisionRow & {
      created_at: Date;
      activated_at: Date | null;
      active: boolean;
      theme_generation: string;
      active_revision_id: string;
    }
  >(
    `SELECT r.*,a.theme_generation,a.active_revision_id,r.id=a.active_revision_id AS active,
    (SELECT max(o.finished_at) FROM theme_operations o WHERE o.site_key=r.site_key AND o.target_revision_id=r.id AND o.phase='COMMITTED') AS activated_at
    FROM theme_revisions r LEFT JOIN admin_theme_state a ON a.site_key=r.site_key
    WHERE r.site_key=$1 AND ${CONFIRMED} ORDER BY (r.id=a.active_revision_id) DESC,r.created_at DESC,r.id DESC LIMIT 100`,
    [app.defaultSiteKey],
  );
  return {
    theme_generation: Number(rows.rows[0]?.theme_generation ?? 0),
    active_revision_id: rows.rows[0]?.active_revision_id ?? null,
    revisions: rows.rows.map((row) => ({
      revision_id: row.id,
      theme_id: row.theme_key,
      package_version: row.package_version,
      sha256: row.file_sha256,
      created_at: row.created_at,
      activated_at: row.activated_at,
      active: row.active === true,
    })),
  };
}

async function cleanUnreferencedThemeRevisions(input: LifecycleInput, db: DbClient): Promise<void> {
  const candidates = await db.query<{ id: string; storage_key: string }>(
    `SELECT r.id,r.storage_key FROM theme_revisions r WHERE r.site_key=$1 AND r.pruned_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM admin_theme_state a WHERE a.site_key=r.site_key AND a.active_revision_id=r.id)
     AND NOT EXISTS (SELECT 1 FROM theme_operations o WHERE o.site_key=r.site_key
       AND (o.from_revision_id=r.id OR o.target_revision_id=r.id OR o.catalog_before_revision_id=r.id))
     ORDER BY r.created_at,r.id LIMIT 50`,
    [input.siteKey],
  );
  for (const row of candidates.rows) {
    removeThemeRevisionFiles(input.configuredDir, row.storage_key);
    await db.query("DELETE FROM theme_revisions WHERE site_key=$1 AND id=$2", [
      input.siteKey,
      row.id,
    ]);
  }
}

export async function rollbackTheme(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { revision_id: string; expected_generation: number },
) {
  app.authorize(ctx.actor, "theme.write");
  app.authorize(ctx.actor, "theme.activate");
  assertTokenConstraints(ctx.actor, {
    siteKey: app.defaultSiteKey,
    environment: ctx.actor.environment,
  });
  if (!Number.isSafeInteger(input.expected_generation) || input.expected_generation < 0)
    throw new ApiError(
      "API_REQUEST_INVALID",
      "expected_generation must be a nonnegative safe integer",
      { status: 400 },
    );
  await changeTheme(app, ctx, {
    kind: "ROLLBACK",
    revisionId: input.revision_id,
    expectedGeneration: input.expected_generation,
  });
  return { ok: true, served: app.themeRuntime.served?.() };
}

export interface ThemeCleanupInput {
  dry_run?: boolean;
  keep_last?: number;
  older_than_days?: number;
  expected_generation?: number;
  revision_ids?: readonly string[];
}
interface CleanupCandidate extends Record<string, unknown> {
  id: string;
  theme_key: string;
  package_version: string;
  storage_key: string;
  last_used_at: string;
  pruned_at: string | null;
  files_deleted_at: string | null;
}

/** Retire metadata first; a failed file removal is retryable, never rollback-able. */
export async function cleanupThemeRevisions(
  app: ApplicationServices,
  ctx: OperationContext,
  request: ThemeCleanupInput,
) {
  const dryRun = request.dry_run ?? true;
  await app.authorize(ctx.actor, dryRun ? "theme.read" : "theme.write");
  assertTokenConstraints(ctx.actor, {
    siteKey: app.defaultSiteKey,
    environment: ctx.actor.environment,
  });
  const keepLast = request.keep_last ?? 5;
  const olderThan = request.older_than_days ?? 1;
  const ids = request.revision_ids ?? [];
  if (
    typeof dryRun !== "boolean" ||
    !Number.isSafeInteger(keepLast) ||
    keepLast < 5 ||
    keepLast > 100 ||
    !Number.isSafeInteger(olderThan) ||
    olderThan < 1 ||
    olderThan > 36500 ||
    !Array.isArray(ids) ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) => typeof id !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id),
    ) ||
    (!dryRun &&
      (ids.length === 0 ||
        !Number.isSafeInteger(request.expected_generation) ||
        (request.expected_generation ?? -1) < 0))
  )
    throw new ApiError(
      "API_REQUEST_INVALID",
      "cleanup requires a valid retention policy and, for apply, explicit revision_ids and expected_generation",
      { status: 400 },
    );
  const input = inputOf(app);
  return withThemeLifecycleLock(input, async (db) => {
    const state = await readThemeLifecycleState(db, input.siteKey);
    if (state?.pending_operation_id) throw failure("THEME_CHANGE_BUSY", "CLEANUP");
    const generation = Number(state?.theme_generation ?? 0);
    if (!dryRun && request.expected_generation !== generation)
      throw new ApiError("THEME_REVISION_STALE", "theme changed after cleanup preview", {
        status: 409,
      });
    const result = await db.query<{ retained_count: number; candidates: CleanupCandidate[] }>(
      `WITH uses AS (
        SELECT ref.id,max(coalesce(o.finished_at,o.created_at)) AS last_used_at,
          bool_or(o.phase='PREPARED') AS pending,
          bool_or(o.from_revision_id=ref.id OR (o.phase='COMMITTED' AND o.target_revision_id=ref.id)) AS confirmed
        FROM theme_operations o CROSS JOIN LATERAL
          (VALUES(o.from_revision_id),(o.target_revision_id),(o.catalog_before_revision_id)) ref(id)
        WHERE o.site_key=$1 AND ref.id IS NOT NULL GROUP BY ref.id
      ), inventory AS (
        SELECT r.id,r.theme_key,r.package_version,r.storage_key,r.pruned_at,r.files_deleted_at,r.created_at,
          (r.pruned_at IS NULL AND (coalesce(r.id=a.active_revision_id,false) OR coalesce(u.confirmed,false))) AS confirmed,
          coalesce(r.id=a.active_revision_id,false) AS active,
          r.id IN (SELECT o.from_revision_id FROM theme_operations o
            WHERE o.site_key=$1 AND o.phase='COMMITTED'
              AND o.from_revision_id<>(SELECT active_revision_id FROM admin_theme_state WHERE site_key=$1)
            ORDER BY o.expected_generation DESC,o.finished_at DESC,o.id DESC LIMIT 1) AS last_good,
          coalesce(u.pending,false) AS pending,
          greatest(r.created_at,coalesce(u.last_used_at,r.created_at)) AS last_used_at
        FROM theme_revisions r LEFT JOIN admin_theme_state a ON a.site_key=r.site_key
          LEFT JOIN uses u ON u.id=r.id WHERE r.site_key=$1
      ), ranked AS (
        SELECT *,count(*) FILTER (WHERE confirmed) OVER (ORDER BY created_at DESC,id DESC) AS retained_rank FROM inventory
      ) SELECT (SELECT count(*)::int FROM inventory WHERE pruned_at IS NULL) AS retained_count,
        coalesce((SELECT jsonb_agg(c) FROM (
          SELECT * FROM ranked WHERE NOT active AND NOT pending AND NOT last_good AND
            ((pruned_at IS NULL AND last_used_at < now()-make_interval(days => $3::int)
              AND (NOT confirmed OR retained_rank > $2))
             OR (pruned_at IS NOT NULL AND files_deleted_at IS NULL))
          ORDER BY last_used_at,id LIMIT 101
        ) c),'[]'::jsonb) AS candidates`,
      [input.siteKey, keepLast, olderThan],
    );
    const inventory = result.rows[0];
    if (!inventory) throw failure("THEME_CLEANUP_FAILED", "INVENTORY");
    const candidates = inventory.candidates.slice(0, 100);
    const removed: string[] = [];
    const pending: string[] = [];
    if (!dryRun) {
      const selected = await db.query<CleanupCandidate>(
        "SELECT * FROM theme_revisions WHERE site_key=$1 AND id=ANY($2::uuid[])",
        [input.siteKey, ids],
      );
      if (selected.rows.length !== ids.length)
        throw new ApiError("THEME_REVISION_NOT_FOUND", "cleanup revision not found in this site", {
          status: 404,
        });
      const eligible = new Set(candidates.map((row) => row.id));
      // Completed tombstones allow an identical request to succeed without deleting twice.
      if (
        selected.rows.some(
          (row) => !eligible.has(row.id) && !(row.pruned_at && row.files_deleted_at),
        )
      )
        throw new ApiError(
          "THEME_REVISION_PROTECTED",
          "active, recent, retained or pending theme revision cannot be removed",
          { status: 409 },
        );
      const fresh = selected.rows.filter((row) => !row.pruned_at).map((row) => row.id);
      if (fresh.length)
        await transaction(db, async () => {
          await db.query(
            "UPDATE theme_revisions SET pruned_at=now() WHERE site_key=$1 AND id=ANY($2::uuid[]) AND pruned_at IS NULL",
            [input.siteKey, fresh],
          );
          await recordSecurityEvent(db, null, {
            type: "THEME_UPDATED",
            ...auditBase(ctx),
            subjectType: "theme",
            subjectId: input.siteKey,
            metadata: {
              kind: "CLEANUP",
              revision_ids: fresh,
              keep_last: keepLast,
              older_than_days: olderThan,
            },
          });
        });
      for (const row of selected.rows) {
        try {
          if (!row.files_deleted_at) {
            removeThemeRevisionFiles(input.configuredDir, row.storage_key);
            await db.query(
              "UPDATE theme_revisions SET files_deleted_at=now() WHERE site_key=$1 AND id=$2 AND pruned_at IS NOT NULL",
              [input.siteKey, row.id],
            );
          }
          removed.push(row.id);
        } catch {
          pending.push(row.id);
        }
      }
    }
    return {
      ok: pending.length === 0,
      dry_run: dryRun,
      theme_generation: generation,
      keep_last: keepLast,
      older_than_days: olderThan,
      retained_count: inventory.retained_count,
      has_more: inventory.candidates.length > 100,
      candidates: candidates.map((row) => ({
        revision_id: row.id,
        theme_id: row.theme_key,
        package_version: row.package_version,
        last_used_at: row.last_used_at,
        pending_cleanup: row.pruned_at !== null,
      })),
      removed,
      pending,
    };
  });
}
