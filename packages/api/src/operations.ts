// Application mutation operations (PCMS-API-T013..T016; API spec §31–§47).
// Every transport (REST routes, MCP tools) calls these exact functions —
// authorization, CAS semantics, validation and errors are identical by
// construction (spec §0 "no business logic per channel").

import {
  assertTokenConstraints,
  BUILTIN_ROLE_BUNDLES,
  PERMISSION_REGISTRY,
  recordSecurityEvent,
} from "@pcms/auth";
import { type StableId, systemClock } from "@pcms/core";
import {
  type AcceptedMedia,
  archiveAsset,
  createMediaFolder,
  deleteMediaFolder,
  ensureCoreDerivative,
  FAVICON_PRESET_ID,
  fetchRemoteMedia,
  generateVariantsForAsset,
  getAsset,
  LOGO_PRESET_ID,
  listMediaFolders,
  moveMediaAsset,
  OG_IMAGE_PRESET_ID,
  replaceDocument,
  updateAssetMetadata,
  updateMediaFolder,
  uploadMedia,
} from "@pcms/media";
import {
  heartbeatAgeMilliseconds,
  heartbeatIsFresh,
  readRuntimeResourceSample,
  readWorkerHeartbeat,
} from "@pcms/operations";
import {
  type BatchScheduleSpec,
  type ItemScheduleOverride,
  type PreviewRef,
  type PublicationActor,
  PublicationError,
  writeOutboxEvent,
} from "@pcms/publication";
import type { RevisionRecord } from "@pcms/revisions";
import { createSiteLocalizationService } from "@pcms/routing";
import { createThemeDiscovery, ThemeInstallError, validateThemeDir } from "@pcms/themes";
import {
  type ApplicationServices,
  auditBase,
  type OperationContext,
  readCmsVersionFromRelease,
  requirePermission,
  revisionActorFrom,
} from "./context.js";
import { ApiError } from "./errors.js";
import { decodeOffsetCursor, parsePageRequest } from "./http/pagination.js";
import { entryLocaleAllowed } from "./localization-ops.js";
import { changeTheme } from "./theme-lifecycle.js";

/** Publication actor carries the request correlation id (spec §58). */
function publicationActorFrom(ctx: OperationContext): PublicationActor {
  return { ...revisionActorFrom(ctx), requestId: ctx.requestId };
}

/**
 * Structural folder gate: `entry_kind = "folder"` entries live in the
 * editorial Content Tree only — no publication, route, preview, SEO,
 * duplication, translation or navigation-target surface. One helper so every
 * mutation entry point rejects folders with the same stable code instead of
 * smearing kind checks (or `contentTypeId === "folder"`) across call sites.
 */
/**
 * Validates a template assignment against the ACTIVE theme contract
 * (Theme Contract §12/§14): the template must exist and accept the entry's
 * content type. Backend-enforced — UI filtering is never the guard.
 */
async function requireCompatibleTemplate(
  app: ApplicationServices,
  templateKey: string,
  entry: { readonly contentTypeId: string },
): Promise<void> {
  if (app.themeDiscovery === null) {
    throw new ApiError("API_NOT_FOUND", "no theme source is configured", { status: 503 });
  }
  if (!app.themeDiscovery.listTemplates().some((t) => t.id === templateKey)) {
    throw new ApiError(
      "TEMPLATE_INCOMPATIBLE",
      `template "${templateKey}" is not declared by the active theme`,
      { status: 422, details: [{ template_key: templateKey }] },
    );
  }
  const contentType = app.contentTypes.getLatestContentType(entry.contentTypeId);
  if (
    contentType !== null &&
    !app.themeDiscovery
      .listTemplates()
      .some(
        (t) =>
          t.id === templateKey &&
          t.accepts_content_types.some(
            (accepted) => accepted.split("@")[0] === entry.contentTypeId,
          ),
      )
  ) {
    throw new ApiError(
      "TEMPLATE_INCOMPATIBLE",
      `template "${templateKey}" does not accept content type "${entry.contentTypeId}"`,
      {
        status: 422,
        details: [{ template_key: templateKey }, { content_type: entry.contentTypeId }],
      },
    );
  }
}

async function forbidFolderEntry(
  app: ApplicationServices,
  entryId: string,
  action: string,
): Promise<void> {
  const entry = await app.entries.findEntry(entryId as never);
  if (entry !== null && entry.entryKind === "folder") {
    throw new ApiError("ENTRY_KIND_FORBIDDEN", `a folder cannot be ${action}`, {
      status: 422,
      details: [{ entry_id: entryId }],
    });
  }
}

// ---------------------------------------------------------------------------
// Content (T013) — spec §31 baseline operations.
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  readonly content_type: string;
  readonly entry_id?: string;
  readonly parent_entry_id?: string | null;
  readonly template_key?: string | null;
  readonly payload: { readonly fields?: unknown; readonly blocks?: unknown };
  readonly locale?: string;
}

/** Creates the entry identity + first working revision in ONE transaction. */
export async function createDraft(
  app: ApplicationServices,
  ctx: OperationContext,
  input: CreateDraftInput,
): Promise<{
  entry_id: string;
  revision_id: string;
  edit_generation: number;
  base_revision_id: string | null;
}> {
  requirePermission(app, ctx, "content.create");
  const loaded = app.contentTypes.getLatestContentType(input.content_type);
  if (loaded === null) {
    throw new ApiError(
      "CONTENT_TYPE_UNKNOWN",
      `content type "${input.content_type}" is not registered`,
      {
        status: 422,
      },
    );
  }
  if (input.template_key !== undefined && input.template_key !== null) {
    // Theme Contract §14: explicit assignment is backend-validated.
    await requireCompatibleTemplate(app, input.template_key, { contentTypeId: input.content_type });
  }
  const actor = revisionActorFrom(ctx);
  // The folder content type maps onto `entry_kind = "folder"` (the column is
  // the semantic source of truth; clients cannot set the kind directly).
  const entryKind = input.content_type === "folder" ? "folder" : "content";
  const result = await app.pool.withTransaction(async (tx) => {
    const entry = await app.entries.createEntryWithinTx(tx, {
      contentTypeId: input.content_type,
      entryKind,
      ...(input.template_key === undefined || input.template_key === null
        ? {}
        : { templateKey: input.template_key }),
      createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
      ...(input.entry_id === undefined ? {} : { id: input.entry_id as never }),
      ...(input.parent_entry_id === undefined || input.parent_entry_id === null
        ? {}
        : { parentEntryId: input.parent_entry_id as never }),
      // The entry identity carries the SAME locale as its first revision
      // (2026-10-02 site-developer report: a `ru-RU` revision under a
      // `default` identity silently broke locale-keyed SEO/WORKING
      // resolution — identity and revisions must agree by construction).
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    });
    const revision = await app.revisions.createWorkingRevisionWithinTx(tx, {
      entityType: "entry",
      entityId: entry.id,
      payload: { fields: input.payload.fields ?? {}, blocks: input.payload.blocks ?? null },
      schemaVersion: String(loaded.version),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      actor,
    });
    return {
      entry_id: entry.id,
      revision_id: revision.id,
      edit_generation: revision.editGeneration,
      base_revision_id: revision.parentRevisionId,
    };
  });
  return result;
}

export interface UpdateDraftInput {
  readonly revision_id: string;
  readonly payload: { readonly fields?: unknown; readonly blocks?: unknown };
  readonly expected_edit_generation: number;
}

/** Autosave CAS (spec §50): stale generations are explicit conflicts. */
export async function updateDraft(
  app: ApplicationServices,
  ctx: OperationContext,
  input: UpdateDraftInput,
): Promise<RevisionRecord> {
  requirePermission(app, ctx, "content.edit");
  return app.revisions.updateWorkingRevision({
    revisionId: input.revision_id as StableId,
    payload: { fields: input.payload.fields ?? {}, blocks: input.payload.blocks ?? null },
    expectedEditGeneration: input.expected_edit_generation,
  });
}

/** Draft-level validation: same payload checks as seal, without sealing. */
export async function validateRevision(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly revision_id: string; readonly publish_level?: boolean },
): Promise<{ ok: boolean; issues: readonly unknown[] }> {
  requirePermission(app, ctx, "content.edit");
  const revision = await app.revisions.requireRevision(app.pool, input.revision_id as StableId);
  const adapter = app.revisionRegistry.get(revision.entityType);
  const issues = await adapter.validateForSeal(revision.payload, {
    entityType: revision.entityType,
    entityId: revision.entityId,
    locale: revision.locale,
    revisionState: revision.state,
  });
  const errors = issues.filter((issue) => issue.severity !== "warning");
  return { ok: errors.length === 0, issues };
}

export interface SealInput {
  readonly revision_id: string;
  readonly expected_edit_generation?: number;
}

/** Identity repair (owner 2026-10-06, site-agent /privacy/ case): moves an
 * entry and all its revisions to a policy-allowed identity locale in one
 * transaction. Entry id, routes, publication pointers, payloads and edit
 * generations are untouched. Translation-group members are refused —
 * multilingual re-identification goes through the translations flow. */
export async function reidentifyEntryLocale(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string; readonly locale: string },
): Promise<{
  readonly changed: boolean;
  readonly entry_id: string;
  readonly from: string;
  readonly to: string;
  readonly revisions_adopted: number;
}> {
  requirePermission(app, ctx, "content.edit");
  const entry = await app.entries.getEntry(input.entry_id as never);
  const localization = await createSiteLocalizationService(app.pool).get();
  if (!entryLocaleAllowed(localization, input.locale)) {
    throw new ApiError(
      "LOCALIZATION_LOCALE_NOT_ENABLED",
      localization.enabled
        ? `entry identity locale "${input.locale}" is not in the site locale list (Settings → Localization)`
        : `entry identity locale "${input.locale}" is not allowed: this site runs single-locale (multilingual is disabled in Settings → Localization); use the "default" locale`,
      { status: 422 },
    );
  }
  if (entry.translationGroupId !== null && entry.locale !== input.locale) {
    throw new ApiError(
      "LOCALIZATION_TRANSLATION_GROUP",
      "entry belongs to a translation group — re-identify through the translations flow, not the repair op",
      { status: 409 },
    );
  }
  if (entry.locale === input.locale) {
    return {
      changed: false,
      entry_id: entry.id,
      from: entry.locale,
      to: input.locale,
      revisions_adopted: 0,
    };
  }
  const result = await app.entries.reidentifyLocale(entry.id as never, input.locale);
  await recordSecurityEvent(app.pool, null, {
    type: "ENTRY_IDENTITY_LOCALE_CHANGED",
    ...auditBase(ctx),
    subjectType: "entry",
    subjectId: entry.id,
    metadata: { from: entry.locale, to: input.locale, revisions_adopted: result.revisionsAdopted },
  });
  return {
    changed: true,
    entry_id: entry.id,
    from: entry.locale,
    to: input.locale,
    revisions_adopted: result.revisionsAdopted,
  };
}

/** Seals a revision (publish-level validation inside the owning domain). */
/**
 * Deletes a WORKING or SEALED revision (2026-09-29 owner request: revision
 * cleanup from the Admin and via API/CLI/MCP). Guarded: the currently
 * published revision of its entity is undeletable — unpublish or roll back
 * first. Audited.
 */
/** Bulk cleanup (owner 2026-10-06, iterative-editing case): delete all
 * SEALED revisions of an entry except the currently published one. The
 * working revision is ALWAYS kept (in-progress work is not junk), and an
 * entry without a published revision is refused (nothing to keep). Same
 * sanctioned-cleanup pattern as deleteRevision (1714 guard). */
export async function cleanupEntryRevisionsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string },
): Promise<{
  readonly deleted: number;
  readonly kept_published_revision_id: string;
  readonly working_revision_kept: string | null;
}> {
  requirePermission(app, ctx, "content.edit");
  const entryId = input.entry_id as StableId;
  const published = await app.pool.query<{ current_revision_id: string }>(
    `SELECT current_revision_id FROM publications
     WHERE entity_type = 'entry' AND entity_id = $1 AND state = 'PUBLISHED' AND context = 'default'
     LIMIT 1`,
    [entryId],
  );
  const publishedId = published.rows[0]?.current_revision_id ?? null;
  if (publishedId === null) {
    throw new ApiError(
      "REVISION_CLEANUP_NO_PUBLISHED",
      "entry has no published revision — cleanup keeps the published revision; publish first",
      { status: 409 },
    );
  }
  const working = await app.pool.query<{ id: string }>(
    `SELECT id FROM revisions
     WHERE entity_type = 'entry' AND entity_id = $1 AND state = 'WORKING' LIMIT 1`,
    [entryId],
  );
  const result = await app.pool.withTransaction(async (tx) => {
    // Opt in past revisions_sealed_delete_guard (migration 1714).
    await tx.query(`SET LOCAL pcms.allow_sealed_delete = 'on'`);
    await tx.query(
      `UPDATE revisions SET parent_revision_id = NULL
       WHERE parent_revision_id IN (
         SELECT id FROM revisions
         WHERE entity_type = 'entry' AND entity_id = $1 AND id <> $2
       )`,
      [entryId, publishedId],
    );
    // Stale non-default context pointers (freelance-locale era rows) would
    // otherwise keep ever-published revisions "current" somewhere forever —
    // an explicit operator cleanup means exactly that they go too.
    await tx.query(
      `DELETE FROM publications
       WHERE entity_type = 'entry' AND entity_id = $1
         AND context <> 'default' AND current_revision_id <> $2`,
      [entryId, publishedId],
    );
    const deleted = await tx.query<{ id: string }>(
      `DELETE FROM revisions
       WHERE entity_type = 'entry' AND entity_id = $1
         AND state = 'SEALED' AND id <> $2
       RETURNING id`,
      [entryId, publishedId],
    );
    return deleted.rowCount ?? 0;
  });
  await recordSecurityEvent(app.pool, null, {
    type: "REVISIONS_CLEANED",
    ...auditBase(ctx),
    subjectType: "entry",
    subjectId: entryId,
    metadata: {
      deleted: result,
      kept_published_revision_id: publishedId,
      working_revision_kept: working.rows[0]?.id ?? null,
    },
  });
  return {
    deleted: result,
    kept_published_revision_id: publishedId,
    working_revision_kept: working.rows[0]?.id ?? null,
  };
}

export async function deleteRevisionOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly revision_id: string },
): Promise<{ deleted: true; revision_id: string }> {
  requirePermission(app, ctx, "content.edit");
  const revision = await app.revisions.requireRevision(app.pool, input.revision_id as StableId);
  const published = await app.pool.query<{ current_revision_id: string }>(
    // Only the LIVE "default" pointer blocks a delete; stale non-default
    // context rows must not protect ever-published revisions forever
    // (owner 2026-10-06: iterative-editing cleanup case).
    `SELECT current_revision_id FROM publications
     WHERE entity_type = $1 AND entity_id = $2 AND current_revision_id = $3
       AND state = 'PUBLISHED' AND context = 'default'
     LIMIT 1`,
    [revision.entityType, revision.entityId, revision.id],
  );
  if (published.rows.length > 0) {
    throw new ApiError(
      "REVISION_PUBLISHED",
      "revision is the currently published revision — unpublish or publish another revision first",
      { status: 409 },
    );
  }
  await app.revisions.deleteRevision(revision.id);
  await recordSecurityEvent(app.pool, null, {
    type: "REVISION_DELETED",
    ...auditBase(ctx),
    subjectType: "revision",
    subjectId: revision.id,
    metadata: { entity_type: revision.entityType, state: revision.state },
  });
  return { deleted: true, revision_id: revision.id };
}

export async function sealRevision(
  app: ApplicationServices,
  ctx: OperationContext,
  input: SealInput,
): Promise<RevisionRecord> {
  requirePermission(app, ctx, "revision.seal");
  // Sidecar: the effective SEO document rides with the sealed snapshot
  // (Publication spec §52 semantics) when one exists for the entry.
  const revision = await app.revisions.requireRevision(app.pool, input.revision_id as StableId);
  if (revision.entityType === "entry") {
    // Folders have no publication lifecycle — an unsealable revision cannot
    // enter a publication, changeset, plan, preview or the search index.
    await forbidFolderEntry(app, revision.entityId as string, "sealed");
  }
  const entry =
    revision.entityType === "entry"
      ? await app.entries.findEntry(revision.entityId as never)
      : null;
  const seoDocument =
    revision.entityType === "entry" ? await app.seo.getDocument(revision.entityId as never) : null;
  // Publication safety (Theme Contract §12): the template assignment is
  // snapshotted into the sealed revision — a later reassignment cannot change
  // the live page until this sealed revision is actually published.
  const templateSnapshot = entry?.templateKey ?? null;
  const sidecar: Record<string, unknown> = {
    ...(seoDocument === null ? {} : { seo: seoDocument }),
    ...(templateSnapshot === null ? {} : { template_key: templateSnapshot }),
  };
  return app.revisions.sealRevision({
    revisionId: input.revision_id as StableId,
    ...(input.expected_edit_generation === undefined
      ? {}
      : { expectedEditGeneration: input.expected_edit_generation }),
    ...(Object.keys(sidecar).length === 0 ? {} : { sidecar }),
  });
}

export async function archiveEntry(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string },
): Promise<{ entry_id: string; archived_at: string | null }> {
  requirePermission(app, ctx, "content.archive");
  const existing = await app.entries.getEntry(input.entry_id as never);
  if (existing.entryKind === "folder") {
    // Safe archival policy: a folder with live children would orphan them
    // into misleading roots — move/archive the children first.
    const children = await app.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM entries WHERE parent_entry_id = $1 AND archived_at IS NULL",
      [input.entry_id],
    );
    if ((children.rows[0]?.n ?? 0) > 0) {
      throw new ApiError(
        "FOLDER_NOT_EMPTY",
        "move or archive the folder's children before archiving the folder",
        { status: 422, details: [{ entry_id: input.entry_id }] },
      );
    }
  }
  const record = await app.entries.archiveEntry(input.entry_id as never);
  return {
    entry_id: record.id,
    archived_at: record.archivedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Media (T014) — spec §35. SSRF policy stays inside M05: the transport never
// accepts bypass flags (owner instruction #42).
// ---------------------------------------------------------------------------

function requireMediaStorage(app: ApplicationServices) {
  if (app.mediaStorage === null || app.mediaQuarantine === null) {
    throw new ApiError("MEDIA_STORAGE_CONFIG", "media storage is not configured on this server", {
      status: 503,
    });
  }
  return {
    pool: app.pool,
    storage: app.mediaStorage,
    quarantine: app.mediaQuarantine,
    ...(app.mediaLimits === undefined ? {} : { limits: app.mediaLimits }),
  };
}

/**
 * Generates theme-preset derivatives for a freshly accepted/replaced image
 * (audit gap #2: `generateVariantsForAsset` had no runtime caller). The
 * preset set comes from the active theme via the composition; generation is
 * synchronous and idempotent (existing byte-identical variants are reused).
 */
// ponytail: inline generation suits the pilot volume (tens of images); move
// behind the job queue when upload latency or volume says so.
export async function generateVariantsAfterAccept(
  app: ApplicationServices,
  accepted: AcceptedMedia,
): Promise<void> {
  if (app.mediaStorage === null) return;
  if (app.mediaPresets.listPresets().length === 0) return;
  try {
    await generateVariantsForAsset(
      { pool: app.pool, storage: app.mediaStorage, maxSourceBytes: 128 * 1024 * 1024 },
      accepted.asset,
      app.mediaPresets,
    );
  } catch {
    // Derivative generation must never fail the upload itself: the asset is
    // committed, a later replace/re-upload regenerates naturally.
  }
}

export async function uploadMediaOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly bytes: Buffer;
    readonly filename: string;
    readonly declared_mime_type?: string;
    readonly folder_id?: string | null;
  },
): Promise<AcceptedMedia> {
  requirePermission(app, ctx, "media.write");
  assertTokenConstraints(ctx.actor, {
    siteKey: app.defaultSiteKey,
    environment: ctx.actor.environment,
  });
  const accepted = await uploadMedia(requireMediaStorage(app), {
    bytes: input.bytes,
    filename: input.filename,
    createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
    // `privileged` is a deployment-side ingest knob, never client-supplied.
    ...(input.declared_mime_type === undefined
      ? {}
      : { declaredMimeType: input.declared_mime_type }),
  });
  if (input.folder_id !== undefined && input.folder_id !== null) {
    // Logical placement right after accept — identity/URLs unchanged.
    await moveMediaAsset(app.pool, { assetId: accepted.asset.id, folderId: input.folder_id });
  }
  await generateVariantsAfterAccept(app, accepted);
  return accepted;
}

/** Remote import through the SSRF-safe M05 fetcher; no bypass parameters. */
export async function importMediaUrl(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly url: string },
): Promise<AcceptedMedia> {
  requirePermission(app, ctx, "media.import");
  const fetched = await fetchRemoteMedia(input.url);
  const accepted = await uploadMedia(requireMediaStorage(app), {
    bytes: fetched.body,
    filename: decodeURIComponent(fetched.finalUrl.split("/").pop() ?? "imported"),
    ...(fetched.contentType === null ? {} : { declaredMimeType: fetched.contentType }),
    createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
  });
  await generateVariantsAfterAccept(app, accepted);
  return accepted;
}

export async function updateMediaMetadataOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly media_id: string;
    readonly title?: string | null;
    readonly alt_default?: string | null;
    readonly caption_default?: string | null;
    readonly source_name?: string | null;
    readonly focal_x?: number | null;
    readonly focal_y?: number | null;
  },
): Promise<unknown> {
  requirePermission(app, ctx, "media.write");
  const focalProvided = input.focal_x !== undefined || input.focal_y !== undefined;
  const asset = (await updateAssetMetadata(app.pool, input.media_id as StableId, {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.alt_default === undefined ? {} : { altDefault: input.alt_default }),
    ...(input.caption_default === undefined ? {} : { captionDefault: input.caption_default }),
    ...(input.source_name === undefined ? {} : { sourceName: input.source_name }),
    ...(input.focal_x === undefined ? {} : { focalX: input.focal_x }),
    ...(input.focal_y === undefined ? {} : { focalY: input.focal_y }),
  })) as { id: string; kind: string; mimeType: string };
  // A focal point change re-crops every preset transform (§15). Core
  // derivatives (og-v1/favicon-v1) materialize immediately — assignment
  // semantics: the public renderer resolves EXISTING derivatives, so the
  // stale crop would otherwise keep serving until the next materialization
  // point. Theme presets regenerate through their own seams.
  if (focalProvided && asset.kind === "image" && asset.mimeType !== "image/svg+xml") {
    if (app.mediaStorage === null) {
      throw new ApiError("OG_DERIVATIVE_FAILED", "media storage is not configured", {
        status: 503,
      });
    }
    const fresh = await getAsset(app.pool, asset.id as never);
    if (fresh !== null) {
      for (const presetId of [OG_IMAGE_PRESET_ID, FAVICON_PRESET_ID] as const) {
        await ensureCoreDerivative(
          { pool: app.pool, storage: app.mediaStorage, maxSourceBytes: 128 * 1024 * 1024 },
          fresh,
          app.mediaPresets,
          presetId,
        );
      }
    }
  }
  return asset;
}

// --- Logical media folders (editorial organization only). ---
export async function listMediaFoldersOp(app: ApplicationServices, ctx: OperationContext) {
  requirePermission(app, ctx, "media.read");
  return { items: await listMediaFolders(app.pool) };
}

export async function createMediaFolderOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly name: string; readonly parent_id?: string | null },
) {
  requirePermission(app, ctx, "media.write");
  return createMediaFolder(app.pool, {
    name: input.name,
    createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
    ...(input.parent_id === undefined || input.parent_id === null
      ? {}
      : { parentId: input.parent_id }),
  });
}

export async function updateMediaFolderOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly folder_id: string;
    readonly name?: string;
    readonly parent_id?: string | null;
  },
) {
  requirePermission(app, ctx, "media.write");
  return updateMediaFolder(app.pool, {
    folderId: input.folder_id,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.parent_id === undefined ? {} : { parentId: input.parent_id }),
  });
}

export async function deleteMediaFolderOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly folder_id: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "media.write");
  await deleteMediaFolder(app.pool, input.folder_id);
  return { ok: true };
}

export async function moveMediaAssetOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly media_id: string; readonly folder_id: string | null },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "media.write");
  await moveMediaAsset(app.pool, {
    assetId: input.media_id,
    folderId: input.folder_id,
  });
  return { ok: true };
}

export async function replaceMediaVersionOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly media_id: string; readonly bytes: Buffer; readonly filename: string },
): Promise<unknown> {
  requirePermission(app, ctx, "media.replace");
  const storage = requireMediaStorage(app);
  const result = await replaceDocument(
    {
      pool: app.pool,
      storage: storage.storage,
      // Read bound for consistency checks: the largest configured upload cap
      // (the ingest kind-check applies the per-kind ceiling itself).
      maxSourceBytes: Math.max(
        storage.limits?.maxUploadBytes ?? 26_214_400,
        storage.limits?.maxVideoUploadBytes ?? 0,
        storage.limits?.maxAudioUploadBytes ?? 0,
      ),
    },
    {
      assetId: input.media_id,
      bytes: input.bytes,
      filename: input.filename,
      createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
    },
  );
  const accepted = (result as { asset?: unknown }).asset;
  if (accepted) {
    await generateVariantsAfterAccept(app, accepted as AcceptedMedia);
  }
  return result;
}

export async function archiveMediaOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly media_id: string },
): Promise<unknown> {
  requirePermission(app, ctx, "media.archive");
  return archiveAsset(app.pool, input.media_id as StableId);
}

// ---------------------------------------------------------------------------
// Publication (T015) — spec §41. apply/publish are publication.publish; the
// plan/schedule split mirrors the M08 permission keys (owner instruction #22).
// ---------------------------------------------------------------------------

export async function createChangeset(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly title: string },
): Promise<unknown> {
  requirePermission(app, ctx, "publication.plan");
  return app.changesets.createChangeset({ title: input.title, actor: revisionActorFrom(ctx) });
}

export async function addChangesetItem(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly changeset_id: string;
    readonly entity_type: string;
    readonly entity_id: string;
    readonly intent: "PUBLISH" | "UNPUBLISH";
    readonly target_revision_id?: string;
    readonly expected_generation: number;
    readonly route_operation?: unknown;
    /** Publication locale context ("default" sentinel or BCP-47 code). */
    readonly context?: string;
  },
): Promise<unknown> {
  requirePermission(app, ctx, "publication.plan");
  // Folder invariant (owner fix): structural folders are never publication
  // candidates — not in the pending list, not in changesets/plans.
  if (input.entity_type === "entry") {
    await forbidFolderEntry(app, input.entity_id, "scheduled as a publication candidate");
  }
  // Wire-format route operation (site_id/frees_path) → domain shape (siteId/
  // freesPath); everything else passes through unchanged.
  const rawRoute = input.route_operation as Record<string, unknown> | undefined;
  const routeOperation =
    rawRoute === undefined
      ? undefined
      : rawRoute["kind"] === "set"
        ? {
            kind: "set" as const,
            siteId: rawRoute["site_id"] as string,
            path: rawRoute["path"] as string,
            ...(rawRoute["locale"] === undefined ? {} : { locale: rawRoute["locale"] as string }),
            ...(rawRoute["frees_path"] === undefined
              ? {}
              : { freesPath: rawRoute["frees_path"] as string }),
          }
        : ({ kind: rawRoute["kind"] } as never);
  return app.changesets.addItem(input.changeset_id as StableId, {
    entityType: input.entity_type,
    entityId: input.entity_id as StableId,
    intent: input.intent,
    expectedGeneration: input.expected_generation,
    ...(input.target_revision_id === undefined
      ? {}
      : { targetRevisionId: input.target_revision_id as StableId }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(routeOperation === undefined ? {} : { routeOperation }),
  });
}

export async function preflightChangeset(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly changeset_id: string },
): Promise<unknown> {
  requirePermission(app, ctx, "publication.plan");
  return app.changesets.preflight(input.changeset_id as StableId);
}

/** Flips every candidate's public state in ONE transaction (M07 semantics). */
export async function applyChangeset(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly changeset_id: string },
): Promise<unknown> {
  requirePermission(app, ctx, "publication.publish");
  return app.changesets.apply(input.changeset_id as StableId, { actor: revisionActorFrom(ctx) });
}

export async function cancelChangeset(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly changeset_id: string },
): Promise<void> {
  requirePermission(app, ctx, "publication.plan");
  await app.changesets.cancel(input.changeset_id as StableId, revisionActorFrom(ctx));
}

export async function createPublicationPlan(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly changeset_id: string;
    readonly timezone: string;
    readonly failure_policy?: string;
  },
): Promise<unknown> {
  requirePermission(app, ctx, "publication.plan");
  return app.plans.createPlan({
    changesetId: input.changeset_id as StableId,
    timezone: input.timezone,
    actor: revisionActorFrom(ctx),
    ...(input.failure_policy === undefined ? {} : { failurePolicy: input.failure_policy as never }),
  });
}

function planInputObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicationError("PLAN_INVALID", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function planInstant(value: unknown, label: string): Date {
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) return value;
  } else if (typeof value === "string") {
    const match =
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    const dateOnly = match?.[1];
    const date = dateOnly === undefined ? null : new Date(`${dateOnly}T00:00:00.000Z`);
    const validDate =
      date !== null &&
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === dateOnly;
    const validTime =
      match !== null && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60;
    const parsed = new Date(value);
    if (validDate && validTime && Number.isFinite(parsed.getTime())) return parsed;
  }
  throw new PublicationError(
    "PLAN_INVALID",
    `${label} must be a valid ISO timestamp with a timezone`,
  );
}

function planScheduleSpec(value: unknown): BatchScheduleSpec {
  const input = planInputObject(value, "spec");
  const interval = planInputObject(input["interval"], "spec.interval");
  const startLocal = input["startLocal"];
  if (startLocal !== undefined) {
    const wall = planInputObject(startLocal, "spec.startLocal");
    if (typeof wall["date"] !== "string" || typeof wall["time"] !== "string") {
      throw new PublicationError("PLAN_INVALID", "startLocal must contain date and time strings");
    }
  }
  if (typeof input["batchSize"] !== "number") {
    throw new PublicationError("PLAN_INVALID", "batchSize must be an integer >= 1");
  }
  if (
    (interval["unit"] !== "minutes" &&
      interval["unit"] !== "hours" &&
      interval["unit"] !== "days") ||
    typeof interval["value"] !== "number"
  ) {
    throw new PublicationError(
      "PLAN_INVALID",
      "interval must contain a supported unit and numeric value",
    );
  }
  return {
    ...(input["startAt"] === undefined
      ? {}
      : { startAt: planInstant(input["startAt"], "startAt") }),
    ...(startLocal === undefined
      ? {}
      : {
          startLocal: {
            date: (startLocal as Record<string, unknown>)["date"] as string,
            time: (startLocal as Record<string, unknown>)["time"] as string,
          },
        }),
    batchSize: input["batchSize"],
    interval: { unit: interval["unit"], value: interval["value"] },
  } as BatchScheduleSpec;
}

function planScheduleOverrides(
  value: readonly unknown[] | undefined,
): readonly ItemScheduleOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new PublicationError("PLAN_INVALID", "overrides must be an array");
  return value.map((raw, index) => {
    const input = planInputObject(raw, `overrides[${index}]`);
    const aliased = (wire: string, camel: string): unknown => {
      const hasWire = Object.hasOwn(input, wire);
      const hasCamel = Object.hasOwn(input, camel);
      if (hasWire && hasCamel) {
        throw new PublicationError("PLAN_INVALID", `overrides[${index}] must not repeat ${wire}`);
      }
      return hasWire ? input[wire] : input[camel];
    };
    const changesetItemId = aliased("changeset_item_id", "changesetItemId");
    const publishAt = aliased("publish_at", "publishAt");
    const unpublishAt = aliased("unpublish_at", "unpublishAt");
    if (typeof changesetItemId !== "string" || changesetItemId.length === 0) {
      throw new PublicationError("PLAN_INVALID", `overrides[${index}] needs changeset_item_id`);
    }
    if (publishAt === undefined && unpublishAt === undefined) {
      throw new PublicationError(
        "PLAN_INVALID",
        `overrides[${index}] needs publish_at or unpublish_at`,
      );
    }
    return {
      changesetItemId: changesetItemId as never,
      ...(publishAt === undefined
        ? {}
        : { publishAt: planInstant(publishAt, `overrides[${index}].publish_at`) }),
      ...(unpublishAt === undefined
        ? {}
        : { unpublishAt: planInstant(unpublishAt, `overrides[${index}].unpublish_at`) }),
    };
  });
}

export async function previewPublicationPlan(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly plan_id: string;
    readonly spec: unknown;
    readonly overrides?: readonly unknown[];
  },
): Promise<readonly unknown[]> {
  requirePermission(app, ctx, "publication.plan");
  return app.plans.previewPlan(
    input.plan_id as StableId,
    planScheduleSpec(input.spec),
    planScheduleOverrides(input.overrides),
  );
}

export async function schedulePublicationPlan(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly plan_id: string;
    readonly spec: unknown;
    readonly overrides?: readonly unknown[];
  },
): Promise<readonly unknown[]> {
  requirePermission(app, ctx, "publication.schedule");
  return app.plans.compilePlan(
    input.plan_id as StableId,
    planScheduleSpec(input.spec),
    planScheduleOverrides(input.overrides),
  );
}

export async function reschedulePlanItem(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly plan_id: string; readonly item_id: string; readonly publish_at: string },
): Promise<unknown> {
  requirePermission(app, ctx, "publication.schedule");
  return app.plans.rescheduleItem(
    input.plan_id as StableId,
    input.item_id as StableId,
    new Date(input.publish_at),
  );
}

export async function cancelPlanItem(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly plan_id: string; readonly item_id: string },
): Promise<void> {
  requirePermission(app, ctx, "publication.schedule");
  await app.plans.cancelItem(
    input.plan_id as StableId,
    input.item_id as StableId,
    revisionActorFrom(ctx),
  );
}

export async function publishNowOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly plan_id: string; readonly item_id: string },
): Promise<void> {
  requirePermission(app, ctx, "publication.publish");
  await app.plans.publishNow(
    input.plan_id as StableId,
    input.item_id as StableId,
    revisionActorFrom(ctx),
  );
}

export interface DirectPublishInput {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly target_revision_id: string;
  readonly expected_generation: number;
  readonly context?: string;
  readonly reason?: string;
}

export async function publishRevision(
  app: ApplicationServices,
  ctx: OperationContext,
  input: DirectPublishInput,
): Promise<unknown> {
  requirePermission(app, ctx, "publication.publish");
  if (input.entity_type === "entry") {
    await forbidFolderEntry(app, input.entity_id as string, "published");
  }
  // OG contract (publish materialization point): the og-v1 derivative for
  // the entry's declared og image physically exists before publish succeeds.
  if (input.entity_type === "entry") {
    const document = await app.seo.getDocument(input.entity_id as never);
    const socialAssetId = (document?.social_image as { asset_id?: string } | null | undefined)
      ?.asset_id;
    if (typeof socialAssetId === "string" && socialAssetId.length > 0) {
      await materializeOgDerivative(app, socialAssetId);
    }
  }
  return app.publications.publish({
    entityType: input.entity_type,
    entityId: input.entity_id as StableId,
    targetRevisionId: input.target_revision_id as StableId,
    expectedGeneration: input.expected_generation,
    actor: publicationActorFrom(ctx),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

export async function rollbackPublication(
  app: ApplicationServices,
  ctx: OperationContext,
  input: DirectPublishInput,
): Promise<unknown> {
  requirePermission(app, ctx, "publication.rollback");
  if (input.entity_type === "entry") {
    await forbidFolderEntry(app, input.entity_id as string, "published");
  }
  return app.publications.rollback({
    entityType: input.entity_type,
    entityId: input.entity_id as StableId,
    targetRevisionId: input.target_revision_id as StableId,
    expectedGeneration: input.expected_generation,
    actor: publicationActorFrom(ctx),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

export async function unpublishPublication(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly entity_type: string;
    readonly entity_id: string;
    readonly expected_generation: number;
    readonly context?: string;
    readonly reason?: string;
  },
): Promise<unknown> {
  requirePermission(app, ctx, "publication.unpublish");
  return app.publications.unpublish({
    entityType: input.entity_type,
    entityId: input.entity_id as StableId,
    expectedGeneration: input.expected_generation,
    actor: publicationActorFrom(ctx),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

// ---------------------------------------------------------------------------
// Themes (T016) — spec §38. Validation/preview are real; activation has no
// v1 backing store, so it is honestly unavailable (no fake endpoint, owner
// instructions #95/#120/#124).
// ---------------------------------------------------------------------------

export async function validateThemeOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<unknown> {
  requirePermission(app, ctx, "theme.validate");
  if (app.themeDir === undefined) {
    throw new ApiError("API_NOT_FOUND", "no theme source is configured (themes.renderDir)", {
      status: 404,
    });
  }
  return validateThemeDir(app.themeDir, { cmsVersion: readCmsVersionFromRelease() });
}

export interface CreatePreviewInput {
  readonly scope:
    | {
        readonly kind: "revision";
        readonly entity_type: string;
        readonly entity_id: string;
        readonly revision_id: string;
        /** Draft preview: render the WORKING revision without sealing it.
         * Requires content.edit on top of preview.create. */
        readonly allow_draft?: boolean;
      }
    | { readonly kind: "changeset"; readonly changeset_id: string }
    | {
        readonly kind: "service";
        readonly template: "search" | "error-404";
        readonly locale?: string;
      };
  /** Candidate theme id for the /preview page render (2026-10-01 site
   * developer request). Must name an INSTALLED theme; the token signs it so
   * the render can never reach an arbitrary directory. */
  readonly theme?: string;
}

/** Signed preview reference (spec §47): URL + expiry, never a public route. */
export async function createThemePreview(
  app: ApplicationServices,
  ctx: OperationContext,
  input: CreatePreviewInput,
): Promise<{ preview_url: string | null; token: string }> {
  requirePermission(app, ctx, "preview.create");
  if (app.previewTokens === null) {
    throw new ApiError(
      "PREVIEW_SECRET_MISSING",
      "preview signing secret is not configured (publication.previewSecretRef)",
      { status: 503 },
    );
  }
  if (input.scope.kind === "revision") {
    await forbidFolderEntry(app, input.scope.entity_id as string, "previewed as a page");
  }
  if (input.scope.kind === "service") {
    if (input.scope.template !== "search" && input.scope.template !== "error-404") {
      throw new ApiError("PREVIEW_RENDER_UNSUPPORTED", "unknown service template", { status: 400 });
    }
    if (input.scope.locale !== undefined) await app.localization.contextFor(input.scope.locale);
  }
  const ref: PreviewRef =
    input.scope.kind === "revision"
      ? {
          kind: "revision",
          entityType: input.scope.entity_type,
          entityId: input.scope.entity_id as StableId,
          revisionId: input.scope.revision_id as StableId,
        }
      : input.scope.kind === "changeset"
        ? { kind: "changeset", changesetId: input.scope.changeset_id as StableId }
        : {
            kind: "service",
            template: input.scope.template,
            ...(input.scope.locale === undefined ? {} : { locale: input.scope.locale }),
          };
  const draft = input.scope.kind === "revision" && input.scope.allow_draft === true;
  if (draft) {
    // Draft payloads are unsealed editorial content — previewing one needs
    // the edit right, not just preview.create (theme developers).
    requirePermission(app, ctx, "content.edit");
    if (input.scope.kind === "revision") {
      const revision = await app.revisions.requireRevision(
        app.pool,
        input.scope.revision_id as StableId,
      );
      if (revision.entityType !== "entry" || revision.entityId !== input.scope.entity_id)
        throw new ApiError("PREVIEW_TARGET_MISSING", "Revision does not belong to the entry", {
          status: 404,
        });
      if (revision.state === "WORKING") {
        const ids = await app.revisionRegistry
          .get("entry")
          .extractMediaAssetIds?.(revision.payload, {
            entityType: "entry",
            entityId: revision.entityId,
            locale: revision.locale,
          });
        for (const id of ids ?? []) await app.prepareRichTextImage(id);
      }
    }
  }
  return {
    preview_url: null,
    token: app.previewTokens.issue(ref, {
      draft,
      ...(input.theme === undefined ? {} : { theme: input.theme }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Content queries (PCMS-ADMIN-T002/T003; Admin spec §4/§5) — read side of the
// Content Tree. One bounded query serves the whole tree; admin corpora are
// orders of magnitude below the bound (ponytail: add keyset pagination when a
// deployment says otherwise).
// ---------------------------------------------------------------------------

export interface ContentTreeItem {
  readonly entry_id: string;
  readonly parent_entry_id: string | null;
  /** Structural role: "content" is publishable, "folder" is tree-only. */
  readonly kind: "content" | "folder";
  readonly content_type: string;
  /** Current theme template assignment (null = compatible default). */
  readonly template_key: string | null;
  /** Latest known `title` field value (working or sealed), null before save. */
  readonly title: string | null;
  readonly created_at: string;
  readonly archived_at: string | null;
  readonly has_working: boolean;
  readonly working_revision_id: string | null;
  readonly has_publication: boolean;
  /** Canonical public path of the entry, null when not routed (2026-09-29). */
  readonly route_path: string | null;
}

export async function listContentTree(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly include_archived?: boolean; readonly limit?: string; readonly cursor?: string },
) {
  requirePermission(app, ctx, "content.read");
  const page =
    input.limit === undefined && input.cursor === undefined
      ? { limit: 5000, cursor: null }
      : parsePageRequest(input);
  const offset = page.cursor === null ? 0 : decodeOffsetCursor(page.cursor);
  const result = await app.pool.query<{
    id: string;
    content_type_id: string;
    entry_kind: string;
    template_key: string | null;
    parent_entry_id: string | null;
    created_at: Date;
    archived_at: Date | null;
    locale: string;
    title: string | null;
    working_revision_id: string | null;
    has_publication: boolean;
    route_path: string | null;
  }>(
    `SELECT e.id, e.content_type_id, e.entry_kind, e.template_key, e.parent_entry_id, e.created_at, e.archived_at, e.locale,
            rev.title,
            wr.id AS working_revision_id,
            pub.entity_id IS NOT NULL AS has_publication,
            rt.path AS route_path
     FROM entries e
     LEFT JOIN LATERAL (
       SELECT r.payload->'fields'->>'title' AS title
       FROM revisions r
       WHERE r.entity_type = 'entry' AND r.entity_id = e.id
       ORDER BY r.revision_no DESC LIMIT 1
     ) rev ON TRUE
     LEFT JOIN LATERAL (
       SELECT r.id FROM revisions r
       WHERE r.entity_type = 'entry' AND r.entity_id = e.id AND r.state = 'WORKING'
       ORDER BY r.revision_no DESC LIMIT 1
     ) wr ON TRUE
     LEFT JOIN LATERAL (
       SELECT p.entity_id FROM publications p
       WHERE p.entity_type = 'entry' AND p.entity_id = e.id AND p.state = 'PUBLISHED'
       LIMIT 1
     ) pub ON TRUE
     LEFT JOIN LATERAL (
       SELECT r2.path FROM routes r2
       WHERE r2.site_id = (SELECT id FROM sites ORDER BY id LIMIT 1)
         AND r2.target_type = 'entry' AND r2.target_id = e.id::text
         AND r2.retired_at IS NULL AND r2.is_canonical
       ORDER BY r2.created_at DESC LIMIT 1
     ) rt ON TRUE
     WHERE ($1::boolean OR e.archived_at IS NULL)
     ORDER BY e.created_at ASC, e.id ASC
     LIMIT $2 OFFSET $3`,
    [input.include_archived === true, page.limit + 1, offset],
  );
  const items = result.rows.slice(0, page.limit).map((row) => ({
    entry_id: row.id,
    parent_entry_id: row.parent_entry_id,
    kind: (row.entry_kind === "folder" ? "folder" : "content") as "folder" | "content",
    content_type: row.content_type_id,
    template_key: row.template_key,
    title: row.title,
    created_at: row.created_at.toISOString(),
    archived_at: row.archived_at?.toISOString() ?? null,
    locale: row.locale,
    has_working: row.working_revision_id !== null,
    working_revision_id: row.working_revision_id,
    has_publication: row.has_publication,
    // Canonical public path (2026-09-29 site-developer report: slugs were
    // unguessable — the tree now carries the live route, null when unrouted).
    route_path: row.route_path,
  }));
  const hasMore = result.rows.length > page.limit;
  return {
    items,
    has_more: hasMore,
    next_cursor: hasMore ? Buffer.from(String(offset + items.length)).toString("base64url") : null,
  };
}

/** Translation group members of an entry (opt-in multilingual). */
export async function listTranslationsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  entryId: string,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "content.read");
  const members = await app.entries.listTranslations(entryId as never);
  return {
    items: members.map((member) => ({
      entry_id: member.id,
      locale: member.locale,
      archived: member.archivedAt !== null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Content Tree operations (PCMS-ADMIN-T003; Admin spec §5). Tree movement is
// an independent content-model concern — it never rewrites URLs or navigation
// (M04 owns those); the Admin Route tab drives explicit route workflows.
// ---------------------------------------------------------------------------

export async function moveEntryOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string; readonly parent_entry_id: string | null },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "content.edit");
  await app.contentTree.moveEntry(input.entry_id as never, input.parent_entry_id as never);
  return { ok: true };
}

/**
 * Explicit per-entry template assignment (Theme Contract §12/§13). Validated
 * against the active theme; null clears back to the compatible default. The
 * live page is unaffected until the next seal+publish (sidecar snapshot).
 */
export async function setEntryTemplateOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string; readonly template_key: string | null },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "content.edit");
  await forbidFolderEntry(app, input.entry_id as string, "given a template");
  const entry = await app.entries.getEntry(input.entry_id as never);
  if (input.template_key !== null) {
    await requireCompatibleTemplate(app, input.template_key, {
      contentTypeId: entry.contentTypeId,
    });
  }
  await app.entries.updateTemplateKey(input.entry_id as never, input.template_key);
  return { ok: true };
}

/** Compatible templates for a content type (active theme only). */
export async function listCompatibleTemplatesOp(
  app: ApplicationServices,
  ctx: OperationContext,
  contentTypeKey: string,
): Promise<{
  items: readonly {
    id: string;
    accepts_content_types: readonly string[];
    editor_selectable: boolean;
  }[];
}> {
  requirePermission(app, ctx, "content.read");
  const items = (app.themeDiscovery?.listTemplates() ?? []).filter((t) =>
    t.accepts_content_types.some((accepted) => accepted.split("@")[0] === contentTypeKey),
  );
  return {
    items: items.map((t) => ({
      id: t.id,
      accepts_content_types: t.accepts_content_types,
      // Render-compatible is not editor-selectable: the Admin picker filters
      // on this flag; the renderer keeps accepting every compatible template.
      editor_selectable: t.editor_selectable,
    })),
  };
}

export async function restoreEntryOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "content.archive");
  await app.entries.restoreEntry(input.entry_id as never);
  return { ok: true };
}

export interface DuplicateEntryResult {
  readonly entry_id: string;
  readonly revision_id: string;
  readonly edit_generation: number;
}

/** Copies the latest revision payload into a new sibling draft (spec §5). */
export async function duplicateEntryOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string; readonly parent_entry_id?: string | null },
): Promise<DuplicateEntryResult> {
  requirePermission(app, ctx, "content.create");
  const source = await app.entries.getEntry(input.entry_id as never);
  // Folders duplicate nothing — use "create child" for new structure.
  if (source.entryKind === "folder") {
    throw new ApiError("ENTRY_KIND_FORBIDDEN", "a folder cannot be duplicated", {
      status: 422,
      details: [{ entry_id: input.entry_id }],
    });
  }
  const loaded = app.contentTypes.getLatestContentType(source.contentTypeId);
  if (loaded === null) {
    throw new ApiError(
      "CONTENT_TYPE_UNKNOWN",
      `content type "${source.contentTypeId}" is not registered`,
      {
        status: 422,
      },
    );
  }
  const latest = (
    await app.revisions.listRevisions(app.pool, "entry", source.id as never, { limit: 1 })
  )[0];
  if (latest === undefined || latest === null) {
    throw new ApiError("API_NOT_FOUND", "the entry has no revision to duplicate", { status: 404 });
  }
  const payload = latest.payload as { fields?: unknown; blocks?: unknown };
  const actor = revisionActorFrom(ctx);
  return app.pool.withTransaction(async (tx) => {
    const entry = await app.entries.createEntryWithinTx(tx, {
      contentTypeId: source.contentTypeId,
      createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
      parentEntryId:
        input.parent_entry_id === undefined
          ? source.parentEntryId
          : (input.parent_entry_id as never),
    });
    const revision = await app.revisions.createWorkingRevisionWithinTx(tx, {
      entityType: "entry",
      entityId: entry.id,
      payload: { fields: payload.fields ?? {}, blocks: payload.blocks ?? null },
      schemaVersion: String(loaded.version),
      actor,
    });
    return {
      entry_id: entry.id,
      revision_id: revision.id,
      edit_generation: revision.editGeneration,
      base_revision_id: revision.parentRevisionId,
    };
  });
}

/**
 * Opens (or creates) the working draft of an entry (PCMS-ADMIN-T003; Admin
 * spec §24 "create new draft from"). Idempotent: an existing WORKING revision
 * is returned unchanged; otherwise a fresh WORKING revision branches from
 * `from_revision_id` (must be the entry's SEALED revision) or from the latest
 * revision payload — or starts empty for a brand-new entry.
 */
export async function createWorkingDraft(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string; readonly from_revision_id?: string },
): Promise<{
  revision_id: string;
  edit_generation: number;
  created: boolean;
  base_revision_id: string | null;
}> {
  requirePermission(app, ctx, "content.edit");
  const entry = await app.entries.getEntry(input.entry_id as never);
  const loaded = app.contentTypes.getLatestContentType(entry.contentTypeId);
  if (loaded === null) {
    throw new ApiError(
      "CONTENT_TYPE_UNKNOWN",
      `content type "${entry.contentTypeId}" is not registered`,
      {
        status: 422,
      },
    );
  }
  // The working revision follows the ENTRY identity locale (not the
  // "default" sentinel): a locale-scoped entry must be edited and sealed in
  // its own locale, or seal fails with LOCALE_MISMATCH (privacy-page case,
  // 2026-10-06). The admin is otherwise locale-blind.
  const existing = await app.revisions.findWorkingRevision(
    app.pool,
    "entry",
    entry.id as never,
    entry.locale,
  );
  if (existing !== null) {
    return {
      revision_id: existing.id,
      edit_generation: existing.editGeneration,
      created: false,
      base_revision_id: existing.parentRevisionId,
    };
  }
  let payload: { fields?: unknown; blocks?: unknown } = {};
  if (input.from_revision_id !== undefined) {
    const source = await app.revisions.getRevision(app.pool, input.from_revision_id as never);
    if (source === null || source.entityId !== entry.id || source.entityType !== "entry") {
      throw new ApiError("API_NOT_FOUND", "source revision not found for this entry", {
        status: 404,
      });
    }
    payload = source.payload as { fields?: unknown; blocks?: unknown };
  } else {
    const latest = (
      await app.revisions.listRevisions(app.pool, "entry", entry.id as never, { limit: 1 })
    )[0];
    if (latest !== undefined && latest !== null) {
      payload = latest.payload as { fields?: unknown; blocks?: unknown };
    }
  }
  const actor = revisionActorFrom(ctx);
  const revision = await app.revisions.createWorkingRevision({
    entityType: "entry",
    entityId: entry.id as never,
    payload: { fields: payload.fields ?? {}, blocks: payload.blocks ?? null },
    schemaVersion: String(loaded.version),
    locale: entry.locale,
    actor,
  });
  return {
    revision_id: revision.id,
    edit_generation: revision.editGeneration,
    created: true,
    base_revision_id: revision.parentRevisionId,
  };
}

// ---------------------------------------------------------------------------
// Rich text conversion (PCMS-ADMIN-T005; Admin spec §19). The M02 Markdown
// adapter is the canonical converter — the Admin editor edits the Markdown
// projection and stores the AST; no conversion logic lives in the browser.
// ---------------------------------------------------------------------------

export type RichTextConvertDirection = "markdown_to_ast" | "ast_to_markdown";

export async function convertRichText(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly direction: RichTextConvertDirection; readonly value: unknown },
): Promise<{
  readonly ok: boolean;
  readonly value?: unknown;
  readonly issues?: readonly unknown[];
}> {
  requirePermission(app, ctx, "content.read");
  const { markdownToRichText, richTextToMarkdown } = await import("@pcms/content");
  if (input.direction === "markdown_to_ast") {
    if (typeof input.value !== "string") {
      throw new ApiError("API_REQUEST_INVALID", "value must be a markdown string", { status: 400 });
    }
    const result = markdownToRichText(input.value);
    return result.ok ? { ok: true, value: result.value } : { ok: false, issues: result.issues };
  }
  const result = richTextToMarkdown(input.value);
  return { ok: true, value: result };
}

// ---------------------------------------------------------------------------
// Block props validation (PCMS-ADMIN-T006/T007; Admin spec §21/§15). The
// Admin gets semantic block feedback (JSON-schema + validateProps + calculator
// preview) from the canonical server machinery — no editor-side duplication.
// ---------------------------------------------------------------------------

export interface ValidateBlockResult {
  readonly ok: boolean;
  readonly issues: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
  }[];
  /** Calculator preview: outputs evaluated from the declared inputs. */
  readonly computed?: readonly { readonly label: string; readonly value: string }[];
}

export async function validateBlockProps(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly type_id: string; readonly props: unknown; readonly sample_values?: unknown },
): Promise<ValidateBlockResult> {
  requirePermission(app, ctx, "content.read");
  const { validateBlockDocument } = await import("@pcms/blocks");
  const block = {
    id: "018f6d2c-5f31-7abc-8def-2a3b4c5d6e7f",
    type: input.type_id,
    schema_version: 1,
    variant: null,
    props: input.props ?? {},
    children: [],
  };
  const result = validateBlockDocument({ schema_version: 1, blocks: [block] }, app.blocks);
  const issues = (result.ok ? [] : result.issues)
    .filter((issue) => !issue.path.startsWith("/blocks/0"))
    .map((issue) => ({ code: issue.code, path: "props", message: issue.message }));
  const blockIssues = (result.ok ? [] : result.issues)
    .filter((issue) => issue.path.startsWith("/blocks/0"))
    .map((issue) => ({
      code: issue.code,
      path: issue.path.replace(/^\/blocks\/0\/props/, "props").replace(/^\/blocks\/0/, "props"),
      message: issue.message,
    }));

  let computed: { label: string; value: string }[] | undefined;
  if (
    input.type_id === "calculator" &&
    typeof (input.props as { formula?: unknown })?.formula === "string"
  ) {
    const { evaluateFormulaText } = await import("@pcms/blocks");
    const props = input.props as {
      formula: string;
      inputs?: readonly { key?: string; default?: unknown }[];
      outputs?: readonly { label?: string; digits?: number }[];
    };
    const variables: Record<string, number> = {};
    for (const inputDef of props.inputs ?? []) {
      if (typeof inputDef.key !== "string") continue;
      const sample = (input.sample_values as Record<string, unknown> | undefined)?.[inputDef.key];
      const fallback = typeof inputDef.default === "number" ? inputDef.default : 0;
      variables[inputDef.key] = typeof sample === "number" ? sample : fallback;
    }
    const evaluated = evaluateFormulaText(props.formula, variables);
    const digitCount = props.outputs?.[0]?.digits ?? 2;
    computed = evaluated.ok
      ? (props.outputs ?? []).map((output) => ({
          label: output.label ?? "Result",
          value: evaluated.value.toFixed(output.digits ?? digitCount),
        }))
      : [];
    if (!evaluated.ok) {
      blockIssues.push({
        code: evaluated.issue.code,
        path: "props.formula",
        message: evaluated.issue.message,
      });
    }
  }

  return {
    ok: result.ok && blockIssues.length === 0,
    issues: [...issues, ...blockIssues],
    ...(computed === undefined ? {} : { computed }),
  };
}

// ---------------------------------------------------------------------------
// Entry SEO document (PCMS-ADMIN-T010; Admin spec §26). The SEO document is
// the always-live working copy attached to the entry; the sealed snapshot
// rides the revision sidecar (M07/M09 bundle semantics).
// ---------------------------------------------------------------------------

export async function getEntrySeo(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string },
): Promise<{ document: unknown | null }> {
  requirePermission(app, ctx, "seo.read");
  const document = await app.seo.getDocument(input.entry_id as never);
  return { document };
}

export async function updateEntrySeo(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string; readonly document: unknown },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "seo.edit");
  await forbidFolderEntry(app, input.entry_id as never, "given an SEO document");
  const document = input.document as { canonical_override?: unknown } | null;
  if (
    document !== null &&
    document !== undefined &&
    document.canonical_override !== null &&
    document.canonical_override !== undefined
  ) {
    // Overriding canonical URLs is a distinct privilege (M08 registry).
    requirePermission(app, ctx, "seo.canonical_override");
  }
  await app.seo.saveDocument(input.entry_id as never, input.document as never);
  // OG contract (assignment materialization point): the og-v1 derivative
  // for the assigned source exists from this moment — publish/validate
  // require it, the public renderer never generates.
  const socialRef = (input.document as { social_image?: { asset_id?: string } } | null)
    ?.social_image?.asset_id;
  if (typeof socialRef === "string" && socialRef.length > 0) {
    await materializeOgDerivative(app, socialRef);
  }
  return { ok: true };
}

/** OG contract materialization (assignment/validate/publish points). Throws
 * ApiError OG_DERIVATIVE_FAILED when storage is unconfigured or generation
 * fails — publish must not succeed without the physical derivative. */
export async function materializeOgDerivative(
  app: ApplicationServices,
  assetId: string,
): Promise<void> {
  if (app.mediaStorage === null) {
    throw new ApiError("OG_DERIVATIVE_FAILED", "media storage is not configured", { status: 503 });
  }
  const asset = await getAsset(app.pool, assetId as never);
  if (asset === null || asset.kind !== "image") {
    throw new ApiError("OG_IMAGE_SOURCE_INVALID", `media asset ${assetId} is not an image`, {
      status: 422,
    });
  }
  await ensureCoreDerivative(
    { pool: app.pool, storage: app.mediaStorage, maxSourceBytes: 128 * 1024 * 1024 },
    asset,
    app.mediaPresets,
    OG_IMAGE_PRESET_ID,
  );
}

// ---------------------------------------------------------------------------
// Entry route view + explicit canonical change (PCMS-ADMIN-T011; Admin spec
// §27). URL math happens in the M04 routing domain — the Admin never computes
// paths in the browser; changing a canonical route is an explicit action that
// records a redirect.
// ---------------------------------------------------------------------------

export interface EntryRouteView {
  readonly site_id: string;
  readonly current: { readonly path: string; readonly is_home: boolean } | null;
  readonly proposal: string;
  readonly history: readonly {
    readonly old_path: string;
    readonly target_type: string | null;
    readonly status_code: number;
    readonly created_at: string;
    readonly retired_at: string | null;
  }[];
}

/** Active canonical route of an entry via the route table — no domain
 * binding required (Admin route tab works in domain-less deployments). */
async function findActiveEntryRoute(
  app: ApplicationServices,
  siteId: string,
  entryId: unknown,
): Promise<{ readonly path: string } | null> {
  const routes = await app.routes.listRoutes(siteId);
  const active = routes.find(
    (route) =>
      route.targetType === "entry" &&
      route.targetId === entryId &&
      route.retiredAt === null &&
      route.isCanonical,
  );
  return active === undefined ? null : { path: active.path };
}

/**
 * Homepage binding (Routing `sites.home_entry_id`) — the one Routing surface
 * that had no transport (bootstrap gap #3). Idempotent; validates the entry
 * exists through the routing service's own checks.
 */
export async function setHomeEntryOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string },
): Promise<unknown> {
  requirePermission(app, ctx, "navigation.edit");
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  return app.pool.withTransaction(async (tx) => {
    const result = await app.routes.setHomeEntryWithinTx(tx, site.id, input.entry_id as never);
    if (result.previousEntryId !== input.entry_id) {
      await writeOutboxEvent(tx, {
        aggregate: "routing",
        aggregateId: site.id,
        eventType: "EntryHomeBindingChanged",
        payload: {
          previousEntryId: result.previousEntryId,
          homeEntryId: input.entry_id,
        },
      });
    }
    return result.site;
  });
}

export async function getEntryRoute(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string },
): Promise<EntryRouteView> {
  requirePermission(app, ctx, "navigation.read");
  const entry = await app.entries.getEntry(input.entry_id as never);
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  const activeRoute = await findActiveEntryRoute(app, site.id, entry.id as never);
  // The entry's URL history = redirects whose target is (or leads to) any
  // path this entry has ever held. changeRoute records target_type='path',
  // so match against every path ever routed to the entry (M04 semantics).
  const historyResult = await app.pool.query<{
    old_path: string;
    target_type: string | null;
    status_code: number;
    created_at: Date;
    retired_at: string | null;
  }>(
    `SELECT rh.old_path, rh.target_type, rh.status_code, rh.created_at, rh.retired_at
     FROM route_history rh
     WHERE rh.site_id = $1 AND rh.retired_at IS NULL
       AND (
         (rh.target_type = 'entry' AND rh.target_id = $2)
         OR (rh.target_type = 'path' AND rh.target_id IN (
           SELECT r.path FROM routes r
           WHERE r.site_id = $1 AND r.target_type = 'entry' AND r.target_id = $2
         ))
       )
     ORDER BY rh.created_at DESC`,
    [site.id, entry.id],
  );
  const entryHistory = historyResult.rows.map((row) => ({
    oldPath: row.old_path,
    targetType: row.target_type,
    statusCode: row.status_code,
    createdAt: row.created_at,
    retiredAt: row.retired_at === null ? null : new Date(row.retired_at),
  }));
  // Proposal comes from the entry title through the site's slug policy — the
  // browser never computes paths itself (Admin spec §27).
  const latest = (
    await app.revisions.listRevisions(app.pool, "entry", entry.id as never, { limit: 1 })
  )[0];
  const latestTitle = (latest?.payload as { fields?: { title?: unknown } } | null)?.fields?.title;
  const segment =
    typeof latestTitle === "string" && latestTitle.trim() !== "" ? latestTitle.trim() : entry.id;
  const proposal = await app.routeProposals
    .proposeRoutePath({ siteId: site.id, segments: [segment] })
    .then((result) => result.path)
    .catch(() => `/${entry.id.slice(0, 8)}`);
  return {
    site_id: site.id,
    current:
      activeRoute === null
        ? null
        : {
            path: activeRoute.path,
            is_home:
              site.homeEntryId !== undefined &&
              site.homeEntryId !== null &&
              site.homeEntryId === entry.id,
          },
    proposal,
    history: entryHistory.map((record) => ({
      old_path: record.oldPath,
      target_type: record.targetType,
      status_code: record.statusCode,
      created_at: record.createdAt.toISOString(),
      retired_at: record.retiredAt?.toISOString() ?? null,
    })),
  };
}

export async function changeEntryRoute(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly entry_id: string; readonly to_path: string; readonly reason?: string },
): Promise<{ readonly old_path: string; readonly new_path: string }> {
  requirePermission(app, ctx, "navigation.edit");
  await forbidFolderEntry(app, input.entry_id as never, "given a canonical route");
  const entry = await app.entries.getEntry(input.entry_id as never);
  const site = await app.routes.ensureSite(app.defaultSiteKey);
  const activeRoute = await findActiveEntryRoute(app, site.id, entry.id as never);
  if (activeRoute === null) {
    // First publication assigns the route via the publication pipeline; a
    // direct canonical change only applies to routed entries.
    throw new ApiError("API_REQUEST_INVALID", "entry has no canonical route yet", { status: 422 });
  }
  const changed = await app.routeHistory.changeRoute({
    siteId: site.id,
    entryId: entry.id as never,
    fromPath: activeRoute.path,
    toPath: input.to_path,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
  return { old_path: changed.oldPath, new_path: changed.newPath };
}

// ---------------------------------------------------------------------------
// Navigation authoring (PCMS-ADMIN-T012/T013; Admin spec §29-§31). Thin
// delegations into the M04 navigation domain: the Content Tree and Navigation
// Tree remain independent models — nothing here touches routes or entries.
// ---------------------------------------------------------------------------

export async function createNavigationSet(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly key: string; readonly title: string; readonly derived_from_set_id?: string },
): Promise<{ set_id: string }> {
  requirePermission(app, ctx, "navigation.edit");
  const set = await app.navigation.createSet({
    key: input.key,
    title: input.title,
    ...(input.derived_from_set_id === undefined
      ? {}
      : { derivedFromSetId: input.derived_from_set_id as never }),
  });
  return { set_id: set.id };
}

export async function deleteNavigationSet(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly set_id: string },
): Promise<{ deleted: boolean }> {
  requirePermission(app, ctx, "navigation.edit");
  return { deleted: await app.navigation.deleteSet(input.set_id) };
}

export async function insertNavigationItem(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly set_id: string;
    readonly parent_item_id?: string | null;
    readonly type: string;
    readonly label?: string | null;
    readonly target?: unknown;
    readonly ui_intent?: string | null;
    readonly at?: number | null;
  },
): Promise<{ item_id: string }> {
  requirePermission(app, ctx, "navigation.edit");
  // Folders are editorial-only: no navigation item may target one (both the
  // internal_entry target and an anchored entry reference carry entry ids).
  if (input.target !== undefined && input.target !== null && typeof input.target === "object") {
    const target = input.target as { kind?: unknown; entry_id?: unknown };
    if (
      (target.kind === "internal_entry" || target.kind === "anchor") &&
      typeof target.entry_id === "string"
    ) {
      await forbidFolderEntry(app, target.entry_id, "used as a navigation target");
    }
  }
  const item = await app.navigation.insertItem({
    setId: input.set_id as never,
    type: input.type as never,
    ...(input.parent_item_id === undefined || input.parent_item_id === null
      ? {}
      : { parentItemId: input.parent_item_id as never }),
    ...(input.label === undefined || input.label === null ? {} : { label: input.label }),
    ...(input.target === undefined || input.target === null
      ? {}
      : { target: input.target as never }),
    ...(input.ui_intent === undefined || input.ui_intent === null
      ? {}
      : { uiIntent: input.ui_intent as never }),
    ...(input.at === undefined || input.at === null ? {} : { at: input.at }),
  });
  return { item_id: item.id };
}

export async function updateNavigationItem(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly set_id: string;
    readonly item_id: string;
    readonly type: string;
    readonly label?: string | null;
    readonly target?: unknown;
    readonly ui_intent?: string | null;
  },
): Promise<{ item_id: string }> {
  requirePermission(app, ctx, "navigation.edit");
  if (input.target !== undefined && input.target !== null && typeof input.target === "object") {
    const target = input.target as { kind?: unknown; entry_id?: unknown };
    if (
      (target.kind === "internal_entry" || target.kind === "anchor") &&
      typeof target.entry_id === "string"
    ) {
      await forbidFolderEntry(app, target.entry_id, "used as a navigation target");
    }
  }
  const item = await app.navigation.updateItem({
    setId: input.set_id as never,
    itemId: input.item_id as never,
    type: input.type as never,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.target === undefined || input.target === null
      ? {}
      : { target: input.target as never }),
    ...(input.ui_intent === undefined || input.ui_intent === null
      ? {}
      : { uiIntent: input.ui_intent as never }),
  });
  return { item_id: item.id };
}

export async function moveNavigationItem(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly set_id: string;
    readonly item_id: string;
    readonly parent_item_id: string | null;
    readonly at?: number | null;
  },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "navigation.edit");
  await app.navigation.moveItem({
    setId: input.set_id as never,
    itemId: input.item_id as never,
    parentItemId: input.parent_item_id as never,
    ...(input.at === undefined || input.at === null ? {} : { at: input.at }),
  });
  return { ok: true };
}

export async function deleteNavigationItem(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly set_id: string; readonly item_id: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "navigation.edit");
  await app.navigation.deleteItem({ setId: input.set_id as never, itemId: input.item_id as never });
  return { ok: true };
}

export async function addNavigationOverride(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly set_id: string;
    readonly target_item_id: string;
    readonly op: string;
    readonly payload: unknown;
  },
): Promise<{ override_id: string }> {
  requirePermission(app, ctx, "navigation.edit");
  const override = await app.navigation.addOverride({
    setId: input.set_id as never,
    targetItemId: input.target_item_id as never,
    op: input.op as never,
    payload: (input.payload ?? {}) as never,
  });
  return { override_id: override.id };
}

export async function removeNavigationOverride(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly set_id: string; readonly override_id: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "navigation.edit");
  await app.navigation.removeOverride({
    setId: input.set_id as never,
    overrideId: input.override_id as never,
  });
  return { ok: true };
}

export async function listNavigationOverrides(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly set_id: string },
): Promise<{
  overrides: readonly { id: string; target_item_id: string; op: string; order: number }[];
  stale: readonly { override_id: string; target_item_id: string; op: string }[];
}> {
  requirePermission(app, ctx, "navigation.read");
  const [overrides, stale] = await Promise.all([
    app.navigation.listOverrides(input.set_id as never),
    app.navigation.listStaleOverrides(input.set_id as never),
  ]);
  return {
    overrides: overrides.map((override) => ({
      id: override.id,
      target_item_id: override.targetItemId,
      op: override.op,
      order: override.order,
    })),
    stale,
  };
}

export async function sealNavigationSet(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly set_id: string },
): Promise<{ revision: number }> {
  requirePermission(app, ctx, "navigation.publish");
  const revision = await app.navigation.sealRevision(input.set_id as never);
  return { revision: revision.revision };
}

export async function bindPlacement(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly placement_key: string; readonly navigation_set_id: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "navigation.edit");
  await app.placements.bindPlacement({
    placementKey: input.placement_key,
    navigationSetId: input.navigation_set_id as never,
  });
  return { ok: true };
}

export async function unbindPlacement(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly placement_key: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "navigation.edit");
  await app.placements.unbindPlacement(input.placement_key);
  return { ok: true };
}

export interface NavigationValidationWire {
  readonly ok: boolean;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

export async function validateNavigationOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<NavigationValidationWire> {
  requirePermission(app, ctx, "navigation.read");
  const result = await app.navigationDiscovery.validateNavigation();
  return { ok: result.ok, issues: result.issues };
}

// ---------------------------------------------------------------------------
// Theme state (PCMS-ADMIN-T019; Admin spec §38-§40; M10 owner decision —
// the active-theme store M09 deferred lives here, migration 1000). Settings
// validation uses the canonical M03 resolver; publishing a settings snapshot
// rides the generic revisions machinery (entity_type "theme_settings").
// ---------------------------------------------------------------------------

export interface ThemeStateWire {
  readonly activation_available: boolean;
  readonly active: { readonly theme_key: string; readonly theme_version: string } | null;
  readonly settings: {
    readonly values: unknown;
    readonly generation: number;
    readonly applied_generation: number | null;
  } | null;
  readonly runtime: { readonly theme_key: string; readonly theme_version: string } | null;
  readonly manifest_settings: readonly unknown[];
  readonly theme: Record<string, unknown> | null;
  /** Human publication state (owner UX pass 0.1.28): a sealed theme_settings
   * revision newer than the published pointer means unpublished changes. */
  readonly publication: {
    readonly pending: boolean;
    readonly published: boolean;
  } | null;
}

/** Compares the latest theme_settings revision against the publication pointer. */
async function themePublicationState(
  app: ApplicationServices,
): Promise<{ pending: boolean; published: boolean } | null> {
  const result = await app.pool.query<{
    latest_revision_id: string | null;
    published_revision_id: string | null;
  }>(
    `SELECT
       (SELECT id FROM revisions
         WHERE entity_type = 'theme_settings' AND entity_id = $1
         ORDER BY revision_no DESC LIMIT 1) AS latest_revision_id,
       (SELECT current_revision_id FROM publications
         WHERE entity_type = 'theme_settings' AND entity_id = $1 AND state = 'PUBLISHED')
         AS published_revision_id`,
    [THEME_SETTINGS_ENTITY_ID],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    pending:
      row.latest_revision_id !== null && row.latest_revision_id !== row.published_revision_id,
    published: row.published_revision_id !== null,
  };
}

async function loadThemeStateRow(
  app: ApplicationServices,
  siteKey: string,
  db: Pick<ApplicationServices["pool"], "query"> = app.pool,
  lock = false,
): Promise<{
  theme_key: string | null;
  theme_version: string | null;
  settings: unknown;
  settings_generation: number;
} | null> {
  const result = await db.query<{
    theme_key: string | null;
    theme_version: string | null;
    settings: unknown;
    settings_generation: number;
  }>(
    "SELECT theme_key, theme_version, settings, settings_generation FROM admin_theme_state WHERE site_key = $1" +
      (lock ? " FOR UPDATE" : ""),
    [siteKey],
  );
  return result.rows[0] ?? null;
}

export async function getThemeState(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<ThemeStateWire> {
  requirePermission(app, ctx, "theme.read");
  const row = await loadThemeStateRow(app, app.defaultSiteKey);
  const manifest = app.themeDiscovery?.getManifest();
  const served = app.themeRuntime.served?.();
  return {
    activation_available: app.themeRuntime.prepareState !== null,
    runtime: served ? { theme_key: served.id, theme_version: served.version } : null,
    active:
      row?.theme_key === null || row?.theme_key === undefined
        ? null
        : {
            theme_key: row.theme_key,
            theme_version:
              served?.id === row.theme_key ? served.version : (row.theme_version ?? ""),
          },
    settings:
      row === null || row.settings === null || row.settings === undefined
        ? null
        : {
            values: row.settings,
            generation: row.settings_generation,
            applied_generation: served?.settings_generation ?? null,
          },
    manifest_settings: manifest?.settings_schema ?? [],
    theme: app.themeDiscovery === null ? null : app.themeDiscovery.describeTheme(),
    publication: await themePublicationState(app),
  };
}

export async function saveThemeSettings(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly values: unknown; readonly expected_generation: number },
): Promise<{ generation: number; applied: boolean }> {
  requirePermission(app, ctx, "theme.write");
  assertTokenConstraints(ctx.actor, {
    siteKey: app.defaultSiteKey,
    environment: ctx.actor.environment,
  });
  return changeTheme(app, ctx, {
    kind: "SETTINGS",
    values: input.values,
    expectedGeneration: input.expected_generation,
  });
}

export async function activateTheme(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly theme_key: string; readonly theme_version?: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "theme.activate");
  assertTokenConstraints(ctx.actor, {
    siteKey: app.defaultSiteKey,
    environment: ctx.actor.environment,
  });
  if (app.themeRuntime.prepareState === null)
    throw new ApiError("THEME_RUNTIME_UNAVAILABLE", "public theme renderer is not registered", {
      status: 409,
    });
  await changeTheme(app, ctx, {
    kind: "ACTIVATE",
    themeKey: input.theme_key,
    ...(input.theme_version === undefined ? {} : { themeVersion: input.theme_version }),
  });
  return { ok: true };
}

/** Seals the working settings as a theme_settings revision (spec §39). */
/**
 * theme_settings revisions are site-scoped; the revisions store requires a
 * StableId entity id, so the single-site v1 settings entity uses this fixed
 * identity (documented in the M10 handoff; multi-site supersedes it).
 */
export const THEME_SETTINGS_ENTITY_ID = "0190c0de-0000-7000-8000-517e775e7760";

export async function sealThemeSettings(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<{ revision_id: string }> {
  requirePermission(app, ctx, "theme.write");
  const discovery = app.themeDiscovery;
  if (discovery === null) {
    throw new ApiError("API_NOT_FOUND", "no theme source is configured (themes.renderDir)", {
      status: 404,
    });
  }
  const existing = await app.revisions.findWorkingRevision(
    app.pool,
    "theme_settings",
    THEME_SETTINGS_ENTITY_ID as never,
  );
  if (existing !== null) {
    throw new ApiError(
      "REVISION_ALREADY_WORKING",
      "theme settings already have a working revision",
      {
        status: 409,
      },
    );
  }
  const row = await loadThemeStateRow(app, app.defaultSiteKey);
  const values = row?.settings ?? {};
  const revision = await app.revisions.createWorkingRevision({
    entityType: "theme_settings",
    entityId: THEME_SETTINGS_ENTITY_ID as never,
    payload: { values },
    schemaVersion: "1",
    actor: revisionActorFrom(ctx),
  });
  const sealed = await app.revisions.sealRevision({ revisionId: revision.id });
  return { revision_id: sealed.id };
}

// ---------------------------------------------------------------------------
// Users, roles, service accounts, audit (PCMS-ADMIN-T020..T022; Admin spec
// §43-§47). Every op delegates to the M08 services; last-OWNER and custom
// role invariants stay server-side. Token secrets are returned exactly once.
// ---------------------------------------------------------------------------

export async function listUsersOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly limit?: number; readonly offset?: number },
): Promise<{ items: readonly Record<string, unknown>[] }> {
  requirePermission(app, ctx, "users.read");
  const { listUsers, createRoleService } = await import("@pcms/auth");
  const users = await listUsers(app.pool, input.limit ?? 100, input.offset ?? 0);
  const roles = createRoleService(app.pool);
  const items = await Promise.all(
    users.map(async (user) => ({
      user_id: user.id,
      display_name: user.displayName,
      status: user.status,
      created_at: user.createdAt.toISOString(),
      disabled_at: user.disabledAt?.toISOString() ?? null,
      primary_email: user.primaryEmail,
      roles: await roles.userRoleKeys(user.id as never),
      has_confirmed_mfa: await app.totp.hasConfirmedTotp(user.id as never),
    })),
  );
  return { items };
}

export async function createUserOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly display_name: string; readonly email: string; readonly role_key: string },
): Promise<{ user_id: string; invite_token: string; expires_at: string }> {
  requirePermission(app, ctx, "users.manage");
  const { createProvisioningService, createRoleService } = await import("@pcms/auth");
  const provisioning = createProvisioningService(app.pool, {
    users: app.users,
    passwords: app.passwords,
    policy: app.passwordPolicy,
    roles: createRoleService(app.pool),
    onPasswordChanged: async (userId) => {
      await app.sessions.revokeAllForUser(userId as never, "password changed");
    },
  });
  const created = await provisioning.createUserWithRole({
    displayName: input.display_name,
    email: input.email,
    roleKey: input.role_key,
  });
  return {
    user_id: created.user.id,
    invite_token: created.inviteToken,
    expires_at: created.expiresAt.toISOString(),
  };
}

export async function createUserWithPasswordOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly display_name: string;
    readonly email: string;
    readonly role_key: string;
    readonly password: string;
  },
): Promise<{ user_id: string }> {
  requirePermission(app, ctx, "users.manage");
  const { createProvisioningService, createRoleService } = await import("@pcms/auth");
  const provisioning = createProvisioningService(app.pool, {
    users: app.users,
    passwords: app.passwords,
    policy: app.passwordPolicy,
    roles: createRoleService(app.pool),
  });
  const user = await provisioning.createUserWithPassword({
    displayName: input.display_name,
    email: input.email,
    roleKey: input.role_key,
    password: input.password,
    creator: {
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      transport: ctx.transport === "rest" ? "api" : ctx.transport,
    },
  });
  return { user_id: user.id };
}

export async function disableEnableUserOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly user_id: string; readonly disable: boolean; readonly reason?: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "users.manage");
  if (input.disable) {
    await app.users.disableUser(input.user_id as never);
  } else {
    await app.users.enableUser(input.user_id as never);
  }
  await app.sessions.revokeAllForUser(
    input.user_id as never,
    input.reason ?? (input.disable ? "disabled via Admin" : "enabled via Admin"),
  );
  return { ok: true };
}

/**
 * Permissions no non-OWNER built-in role carries (spec §40–§44: integrations
 * secrets, refunds, lead PII, …). Computed from the registry so future keys
 * default to owner-only until deliberately bundled into a staff role.
 */
const OWNER_ONLY_PERMISSIONS: ReadonlySet<string> = (() => {
  const bundled = new Set<string>();
  for (const [role, keys] of Object.entries(BUILTIN_ROLE_BUNDLES)) {
    if (role === "OWNER" || keys === "ALL") continue;
    for (const key of keys) bundled.add(key);
  }
  return new Set(
    PERMISSION_REGISTRY.map((permission) => permission.key).filter((key) => !bundled.has(key)),
  );
})();

/**
 * Owner-only elevation gate (spec §44: "elevation is always a separate,
 * explicit decision"): roles.manage / tokens.manage alone must not grant the
 * OWNER role or mint owner-only authority — the acting principal must hold
 * OWNER itself.
 */
async function requireOwnerActor(app: ApplicationServices, ctx: OperationContext): Promise<void> {
  const { createRoleService } = await import("@pcms/auth");
  const roleKeys = await createRoleService(app.pool).userRoleKeys(ctx.actor.id);
  if (roleKeys.includes("OWNER")) return;
  throw new ApiError("AUTH_PERMISSION_DENIED", "OWNER role is required for this change", {
    status: 403,
  });
}

/**
 * Password/profile/delete changes on an OWNER account are the escalation
 * surface (a non-owner admin could otherwise take over the owner login) —
 * they require the acting principal to hold OWNER itself.
 */
async function guardOwnerTarget(
  app: ApplicationServices,
  ctx: OperationContext,
  user_id: string,
): Promise<void> {
  const { createRoleService } = await import("@pcms/auth");
  const targetRoles = await createRoleService(app.pool).userRoleKeys(user_id as never);
  if (targetRoles.includes("OWNER")) await requireOwnerActor(app, ctx);
}

export async function assignRoleOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly user_id: string; readonly role_key: string; readonly remove?: boolean },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "roles.manage");
  // Granting OWNER is the escalation path; revocation stays with
  // roles.manage (the last-active-OWNER invariant still protects below).
  if (input.remove !== true && input.role_key === "OWNER") {
    await requireOwnerActor(app, ctx);
  }
  const { createRoleService } = await import("@pcms/auth");
  const roles = createRoleService(app.pool);
  if (input.remove === true) {
    await roles.removeRole(
      input.user_id as never,
      input.role_key as never,
      `${ctx.actor.type}:${ctx.actor.id}`,
    );
  } else {
    await roles.assignRole(
      input.user_id as never,
      input.role_key as never,
      `${ctx.actor.type}:${ctx.actor.id}`,
    );
  }
  return { ok: true };
}

export async function revokeUserSessionsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly user_id: string },
): Promise<{ revoked: number }> {
  requirePermission(app, ctx, "users.manage");
  const revoked = await app.sessions.revokeAllForUser(input.user_id as never, "revoked via Admin");
  return { revoked };
}

export async function resetUserMfaOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly user_id: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "users.manage");
  try {
    await app.totp.disableTotp(input.user_id as never, "reset via Admin");
  } catch (error) {
    // Idempotent: resetting a user without an enrollment is a no-op.
    if ((error as { code?: string }).code !== "AUTH_VALIDATION") throw error;
  }
  return { ok: true };
}

export async function updateUserOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly user_id: string;
    readonly display_name?: string;
    readonly email?: string;
  },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "users.manage");
  await guardOwnerTarget(app, ctx, input.user_id);
  await app.users.updateUser(input.user_id as never, {
    ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
    ...(input.email === undefined ? {} : { primaryEmail: input.email }),
  });
  return { ok: true };
}

export async function setUserPasswordOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly user_id: string; readonly new_password: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "users.manage");
  await guardOwnerTarget(app, ctx, input.user_id);
  await app.passwordPolicy.validate(input.new_password);
  const target = await app.users.findUserById(input.user_id as never);
  if (target === null) {
    throw new ApiError("API_REQUEST_INVALID", "user not found", { status: 404 });
  }
  const verifier = await app.passwords.hashPassword(input.new_password);
  await app.passwords.setPassword(input.user_id as never, verifier);
  // Changing someone's password kicks them out everywhere. For a self change
  // the current session must survive — the admin would otherwise be logged
  // out mid-action (their other sessions are revoked via the sessions
  // button, which stays available on the same row).
  if (input.user_id !== ctx.actor.id) {
    await app.sessions.revokeAllForUser(input.user_id as never, "password changed via Admin");
  }
  return { ok: true };
}

export async function deleteUserOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly user_id: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "users.manage");
  if (input.user_id === ctx.actor.id) {
    throw new ApiError("AUTH_VALIDATION", "deleting your own account is not allowed", {
      status: 400,
    });
  }
  await guardOwnerTarget(app, ctx, input.user_id);
  await app.users.deleteUser(input.user_id as never);
  return { ok: true };
}

export async function listRolesOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<{
  roles: readonly Record<string, unknown>[];
  permissions: readonly { key: string; summary: string }[];
  presets: Record<string, readonly string[]>;
}> {
  requirePermission(app, ctx, "roles.read");
  const { createRoleService, AGENT_SCOPE_PRESETS } = await import("@pcms/auth");
  const { PERMISSION_REGISTRY } = await import("@pcms/auth");
  const roles = await createRoleService(app.pool).listRoles();
  return {
    roles: roles.map((role) => ({
      key: role.key,
      name: role.name,
      builtin: role.builtin,
      immutable: role.immutable,
      permissions: [...role.permissions].sort(),
    })),
    permissions: PERMISSION_REGISTRY.map((definition) => ({
      key: definition.key,
      summary: definition.summary,
    })),
    presets: AGENT_SCOPE_PRESETS,
  };
}

export async function createUpdateDeleteRoleOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly action: "create" | "update" | "delete";
    readonly role_key?: string;
    readonly name?: string;
    readonly permissions?: readonly string[];
  },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "roles.manage");
  const { createRoleService, assertAllRegistered } = await import("@pcms/auth");
  const roles = createRoleService(app.pool);
  if (input.action === "create") {
    if (
      input.role_key === undefined ||
      input.name === undefined ||
      input.permissions === undefined
    ) {
      throw new ApiError("API_REQUEST_INVALID", "role_key, name and permissions are required", {
        status: 400,
      });
    }
    assertAllRegistered(input.permissions);
    if (input.permissions.some((key) => OWNER_ONLY_PERMISSIONS.has(key))) {
      await requireOwnerActor(app, ctx);
    }
    await roles.createCustomRole(
      { key: input.role_key, name: input.name, permissions: input.permissions },
      `${ctx.actor.type}:${ctx.actor.id}`,
    );
  } else if (input.action === "update") {
    if (input.role_key === undefined) {
      throw new ApiError("API_REQUEST_INVALID", "role_key is required", { status: 400 });
    }
    if (input.permissions !== undefined) {
      assertAllRegistered(input.permissions);
      if (input.permissions.some((key) => OWNER_ONLY_PERMISSIONS.has(key))) {
        await requireOwnerActor(app, ctx);
      }
    }
    await roles.updateCustomRole(
      input.role_key as never,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
      },
      `${ctx.actor.type}:${ctx.actor.id}`,
    );
  } else {
    if (input.role_key === undefined) {
      throw new ApiError("API_REQUEST_INVALID", "role_key is required", { status: 400 });
    }
    await roles.deleteCustomRole(input.role_key as never, `${ctx.actor.type}:${ctx.actor.id}`);
  }
  return { ok: true };
}

export async function listServiceAccountsOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<{ items: readonly Record<string, unknown>[] }> {
  requirePermission(app, ctx, "tokens.manage");
  const accounts = await app.machineIdentity.listServiceAccounts();
  return {
    items: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      purpose: account.purpose,
      status: account.status,
      allowed_scopes: account.allowedScopes === null ? null : [...account.allowedScopes],
      created_at: account.createdAt.toISOString(),
      disabled_at: account.disabledAt?.toISOString() ?? null,
    })),
  };
}

export async function createServiceAccountOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly name: string;
    readonly purpose: string;
    readonly allowed_scopes?: readonly string[];
  },
): Promise<{ id: string }> {
  requirePermission(app, ctx, "tokens.manage");
  const account = await app.machineIdentity.createServiceAccount({
    name: input.name,
    purpose: input.purpose,
    ...(input.allowed_scopes === undefined ? {} : { allowedScopes: input.allowed_scopes }),
    createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
  });
  return { id: account.id };
}

export async function disableServiceAccountOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly account_id: string; readonly reason: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "tokens.manage");
  await app.machineIdentity.disableServiceAccount(input.account_id as never, input.reason);
  return { ok: true };
}

export async function deleteServiceAccountOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly account_id: string; readonly reason: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "tokens.manage");
  await app.machineIdentity.deleteServiceAccount(input.account_id as never, input.reason);
  return { ok: true };
}

export async function createAccessTokenOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly account_id: string;
    readonly scopes: readonly string[];
    readonly description?: string;
    readonly ttl_hours?: number | null;
    /** Explicit §53 policy decision for a token without expiry. */
    readonly allow_permanent?: boolean;
    readonly site_key?: string;
    readonly environment?: string;
  },
): Promise<{ token_id: string; prefix: string; raw_secret: string; expires_at: string | null }> {
  requirePermission(app, ctx, "tokens.manage");
  if (input.scopes.some((scope) => OWNER_ONLY_PERMISSIONS.has(scope))) {
    await requireOwnerActor(app, ctx);
  }
  const ttl =
    input.ttl_hours === undefined || input.ttl_hours === null
      ? undefined
      : input.ttl_hours * 3_600_000;
  const created = await app.machineIdentity.createAccessToken({
    serviceAccountId: input.account_id as never,
    scopes: input.scopes,
    description: input.description ?? null,
    ...(ttl === undefined ? {} : { ttlMilliseconds: ttl }),
    allowPermanent: input.allow_permanent === true,
    ...(input.site_key === undefined ? {} : { siteKey: input.site_key }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
  });
  return {
    token_id: created.token.id,
    prefix: created.token.prefix,
    raw_secret: created.rawSecret,
    expires_at: created.token.expiresAt?.toISOString() ?? null,
  };
}

export async function listAccessTokensOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly account_id: string },
): Promise<{ items: readonly Record<string, unknown>[] }> {
  requirePermission(app, ctx, "tokens.manage");
  const tokens = await app.machineIdentity.listAccessTokens(input.account_id as never);
  return {
    items: tokens.map((token) => ({
      id: token.id,
      prefix: token.prefix,
      scopes: [...token.scopes],
      site_key: token.siteKey,
      environment: token.environment,
      description: token.description,
      created_at: token.createdAt.toISOString(),
      expires_at: token.expiresAt?.toISOString() ?? null,
      last_used_at: token.lastUsedAt?.toISOString() ?? null,
      revoked_at: token.revokedAt?.toISOString() ?? null,
      revoked_reason: token.revokedReason ?? null,
    })),
  };
}

export async function revokeAccessTokenOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly token_id: string; readonly reason: string },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "tokens.manage");
  await app.machineIdentity.revokeAccessToken(input.token_id as never, input.reason);
  return { ok: true };
}

export async function listAuditOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: {
    readonly event_type?: string;
    readonly actor_type?: string;
    readonly actor_id?: string;
    readonly transport?: string;
    readonly limit?: number;
    readonly offset?: number;
  },
): Promise<{ items: readonly Record<string, unknown>[] }> {
  requirePermission(app, ctx, "audit.read");
  const { listSecurityEvents } = await import("@pcms/auth");
  const events = await listSecurityEvents(app.pool, {
    event_type: input.event_type ?? null,
    actor_type: input.actor_type ?? null,
    actor_id: input.actor_id ?? null,
    transport: input.transport ?? null,
    limit: input.limit ?? 50,
    offset: input.offset ?? 0,
  });
  return {
    items: events.map((event) => ({
      id: event.id,
      event_type: event.event_type,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      subject_type: event.subject_type,
      subject_id: event.subject_id,
      transport: event.transport,
      metadata: event.metadata,
      created_at: event.created_at.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Site identity (PCMS-ADMIN-T025; Admin spec §48/§49): typed SEO site
// identity used by Theme + SEO; no arbitrary env editor.
// ---------------------------------------------------------------------------

export async function getSiteIdentityOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<{ identity: unknown | null }> {
  requirePermission(app, ctx, "seo.read");
  const site = await app.routes.findSiteByKey(app.defaultSiteKey);
  const identity = site === null ? null : await app.seo.getSiteSettings(site.id as never);
  return { identity };
}

export async function updateSiteIdentityOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly identity: unknown },
): Promise<{ ok: true }> {
  requirePermission(app, ctx, "seo.site_settings");
  const site = await app.routes.findSiteByKey(app.defaultSiteKey);
  if (site === null) {
    throw new ApiError("SITE_NOT_FOUND", `site "${app.defaultSiteKey}" does not exist`, {
      status: 404,
    });
  }
  // Ownership-verification root files must never shadow an existing content,
  // system or extension route (2026-10-18 task B): the conflict is rejected
  // at save time, loudly, instead of silently winning at request time.
  const verificationFiles = ((): { provider: string; filename: string }[] => {
    const identity = input.identity as {
      verification?:
        | readonly {
            provider?: unknown;
            method?: unknown;
            file?: { filename?: unknown } | null;
          }[]
        | null;
    };
    if (!Array.isArray(identity?.verification)) return [];
    const files: { provider: string; filename: string }[] = [];
    for (const entry of identity.verification) {
      if (entry?.method !== "file" || typeof entry?.file?.filename !== "string") continue;
      if (entry.provider !== "google" && entry.provider !== "yandex") continue;
      files.push({ provider: entry.provider, filename: entry.file.filename });
    }
    return files;
  })();
  for (const proof of verificationFiles) {
    const proofPath = `/${proof.filename}`;
    const resolution = await app.requestResolver.resolve({ path: proofPath }).catch(() => null);
    if (resolution !== null && resolution.kind !== "not_found" && resolution.kind !== "invalid") {
      throw new ApiError(
        "VERIFICATION_ROUTE_CONFLICT",
        `path "${proofPath}" already resolves to ${resolution.kind}; remove or rename it before adding the ${proof.provider} verification file`,
        { status: 422 },
      );
    }
    const mounts = await app.extensionRouteMounts.listActive().catch(() => []);
    const prefixHit = mounts.find(
      (mount) => proofPath === mount.mountPath || proofPath.startsWith(`${mount.mountPath}/`),
    );
    if (prefixHit !== undefined) {
      throw new ApiError(
        "VERIFICATION_ROUTE_CONFLICT",
        `path "${proofPath}" overlaps extension mount "${prefixHit.mountPath}"`,
        { status: 422 },
      );
    }
  }
  await app.seo.saveSiteSettings(site.id as never, input.identity as never);
  // Branding contract materialization: favicon family + site social default
  // og-v1 generate at assignment (site/branding permission scope, separate
  // from page SEO).
  const brandingIdentity = input.identity as {
    favicon?: { asset_id?: string } | null;
    default_social_image?: { asset_id?: string } | null;
    logo?: { asset_id?: string } | null;
  };
  const faviconAsset = brandingIdentity.favicon?.asset_id;
  if (typeof faviconAsset === "string" && faviconAsset.length > 0) {
    if (app.mediaStorage === null) {
      throw new ApiError("FAVICON_DERIVATIVE_FAILED", "media storage is not configured", {
        status: 503,
      });
    }
    const faviconRecord = await getAsset(app.pool, faviconAsset as never);
    if (faviconRecord === null || faviconRecord.kind !== "image") {
      throw new ApiError("FAVICON_SOURCE_INVALID", `media asset ${faviconAsset} is not an image`, {
        status: 422,
      });
    }
    await ensureCoreDerivative(
      { pool: app.pool, storage: app.mediaStorage, maxSourceBytes: 128 * 1024 * 1024 },
      faviconRecord,
      app.mediaPresets,
      FAVICON_PRESET_ID,
    );
  }
  const logoAsset = brandingIdentity.logo?.asset_id;
  if (typeof logoAsset === "string" && logoAsset.length > 0) {
    // Organization structured data (§33) resolves only this generated
    // representation — the original /current/ transport stays closed.
    if (app.mediaStorage === null) {
      throw new ApiError("LOGO_DERIVATIVE_FAILED", "media storage is not configured", {
        status: 503,
      });
    }
    const logoRecord = await getAsset(app.pool, logoAsset as never);
    if (logoRecord === null || logoRecord.kind !== "image") {
      throw new ApiError("LOGO_SOURCE_INVALID", `media asset ${logoAsset} is not an image`, {
        status: 422,
      });
    }
    await ensureCoreDerivative(
      { pool: app.pool, storage: app.mediaStorage, maxSourceBytes: 128 * 1024 * 1024 },
      logoRecord,
      app.mediaPresets,
      LOGO_PRESET_ID,
    );
  }
  const socialAsset = brandingIdentity.default_social_image?.asset_id;
  if (typeof socialAsset === "string" && socialAsset.length > 0) {
    await materializeOgDerivative(app, socialAsset);
  }
  return { ok: true };
}

/** System/doctor snapshot for the Admin (spec §50): no secrets. */
export async function getSystemStatusOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "site.validate");
  const site = await app.routes.findSiteByKey(app.defaultSiteKey);
  const migrations = await app.pool.query<{ name: string; applied_at: string }>(
    "SELECT name, applied_at::text AS applied_at FROM pcms_schema_migrations ORDER BY name DESC LIMIT 1",
  );
  const queue = await app.pool
    .query<{ pending: string; dead: string }>(
      `SELECT count(*) FILTER (WHERE state = 'RUNNING' OR state = 'PENDING')::text AS pending,
              count(*) FILTER (WHERE state = 'DEAD')::text AS dead
       FROM jobs`,
    )
    .catch(() => ({ rows: [] as { pending: string; dead: string }[] }));
  const storage = app.mediaStorage !== null;
  const queueRow = queue.rows[0];
  // Durable worker heartbeat (PCMS-OPS-T109): absent row/table reads as
  // null — the response states facts, not assumptions.
  const heartbeat = await readWorkerHeartbeat(app.pool).catch(() => null);
  // Operational dashboard extensions (owner UX pass 0.1.28). Every block is
  // best-effort and states facts: a failed read is null, never a fake green.
  const dbStarted = Date.now();
  const dbOk = await app.pool
    .query("SELECT 1")
    .then(() => true)
    .catch(() => false);
  const dbLatencyMs = dbOk ? Date.now() - dbStarted : null;
  const runtime = await readRuntimeResourceSample().catch(() => null);
  const mediaSize = await app.pool
    .query<{ bytes: string }>(`SELECT COALESCE(sum(size_bytes), 0)::text AS bytes FROM media_blobs`)
    .then((result) => Number(result.rows[0]?.bytes ?? 0))
    .catch(() => null);
  const searchHealth = await app.searchProvider.health().catch(() => null);
  const lastUpdate = await app.pool
    .query<{ to_version: string; status: string; completed_at: string | null }>(
      `SELECT to_version, status, completed_at::text AS completed_at
       FROM pcms_update_history ORDER BY started_at DESC LIMIT 1`,
    )
    .then((result) => result.rows[0] ?? null)
    .catch(() => null);
  const stats = await app.pool
    .query<Record<string, string>>(`SELECT
       (SELECT count(*) FROM entries WHERE archived_at IS NULL)::text AS entries,
       (SELECT count(*) FROM publications WHERE entity_type = 'entry' AND state = 'PUBLISHED')::text AS entries_published,
       (SELECT count(*) FROM entries e WHERE e.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM revisions r WHERE r.entity_type = 'entry' AND r.entity_id = e.id AND r.state = 'WORKING'))::text AS entries_drafts,
       (SELECT count(*) FROM media_assets WHERE archived_at IS NULL)::text AS media_assets,
       (SELECT count(*) FROM forms_form_definitions WHERE status = 'ACTIVE')::text AS forms,
       (SELECT count(*) FROM forms_submissions WHERE submitted_at > now() - interval '24 hours')::text AS submissions_24h,
       (SELECT count(*) FROM forms_submissions WHERE submitted_at > now() - interval '7 days')::text AS submissions_7d,
       (SELECT count(*) FROM forms_leads WHERE status = 'NEW')::text AS leads_new,
       (SELECT count(*) FROM forms_quiz_runs)::text AS quiz_runs`)
    .then((result) => result.rows[0] ?? ({} as Record<string, string>))
    .catch(() => ({}) as Record<string, string>);
  const num = (key: string): number | null =>
    stats[key] === undefined ? null : Number(stats[key]);
  return {
    runtime,
    db_ok: dbOk,
    db_latency_ms: dbLatencyMs,
    media_storage_bytes: mediaSize,
    search:
      searchHealth === null
        ? null
        : {
            available: searchHealth.available,
            document_count: searchHealth.document_count,
            reindex_required: searchHealth.reindex_required,
            last_reindex_at: searchHealth.last_reindex_at,
          },
    last_update:
      lastUpdate === null
        ? null
        : {
            to_version: lastUpdate.to_version,
            status: lastUpdate.status,
            completed_at: lastUpdate.completed_at,
          },
    stats: {
      entries: num("entries"),
      entries_published: num("entries_published"),
      entries_drafts: num("entries_drafts"),
      media_assets: num("media_assets"),
      forms: num("forms"),
      submissions_24h: num("submissions_24h"),
      submissions_7d: num("submissions_7d"),
      leads_new: num("leads_new"),
      quiz_runs: num("quiz_runs"),
    },
    site: site === null ? null : { key: site.key, title: site.title },
    db_migration_head: migrations.rows[0]?.name ?? null,
    worker_queue:
      queueRow === undefined
        ? null
        : { pending: Number(queueRow.pending), dead: Number(queueRow.dead) },
    worker_heartbeat:
      heartbeat === null
        ? null
        : {
            boot_id: heartbeat.bootId,
            started_at: heartbeat.startedAt,
            last_beat_at: heartbeat.lastBeatAt,
            loop_count: heartbeat.loopCount,
            age_seconds: Math.max(
              0,
              Math.round(heartbeatAgeMilliseconds(heartbeat, systemClock) / 1000),
            ),
            fresh: heartbeatIsFresh(heartbeat, systemClock),
          },
    media_storage: storage,
    theme:
      app.themeDiscovery === null
        ? null
        : {
            id: app.themeDiscovery.getThemeId(),
            contract: app.themeDiscovery.getThemeContractVersion(),
            validation_ok:
              (app.themeDiscovery.describeTheme() as { validation?: { ok?: boolean } }).validation
                ?.ok ?? null,
          },
  };
}

/** Metric sample window for the System dashboard charts (site.validate). */
export async function getSystemMetricsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly hours?: number },
): Promise<{
  samples: readonly {
    ts: string;
    cpu_percent: number | null;
    memory_used_bytes: number | null;
    memory_limit_bytes: number | null;
    queue_pending: number | null;
    queue_dead: number | null;
  }[];
}> {
  requirePermission(app, ctx, "site.validate");
  const hours = Math.max(1, Math.min(input.hours ?? 24, 72));
  const result = await app.pool.query<{
    ts: Date;
    cpu_percent: number | null;
    memory_used_bytes: string | null;
    memory_limit_bytes: string | null;
    queue_pending: number | null;
    queue_dead: number | null;
  }>(
    `SELECT ts, cpu_percent, memory_used_bytes::text AS memory_used_bytes,
            memory_limit_bytes::text AS memory_limit_bytes, queue_pending, queue_dead
     FROM pcms_metric_samples
     WHERE ts > now() - ($1 || ' hours')::interval
     ORDER BY ts ASC
     LIMIT 5000`,
    [String(hours)],
  );
  return {
    samples: result.rows.map((row) => ({
      ts: row.ts.toISOString(),
      cpu_percent: row.cpu_percent,
      memory_used_bytes: row.memory_used_bytes === null ? null : Number(row.memory_used_bytes),
      memory_limit_bytes: row.memory_limit_bytes === null ? null : Number(row.memory_limit_bytes),
      queue_pending: row.queue_pending,
      queue_dead: row.queue_dead,
    })),
  };
}

export async function searchMediaOp(
  app: ApplicationServices,
  ctx: OperationContext,
  query: Record<string, unknown>,
) {
  app.authorize(ctx.actor, "media.read");
  const page = parsePageRequest(query);
  const offset = page.cursor === null ? 0 : decodeOffsetCursor(page.cursor);
  const result = await app.mediaDiscovery.searchAssets({
    ...(typeof query.text === "string" ? { text: query.text } : {}),
    ...(typeof query.kind === "string" ? { kind: query.kind as never } : {}),
    ...(typeof query.mime_type === "string" ? { mimeType: query.mime_type } : {}),
    ...(typeof query.folder_id === "string" && query.folder_id !== ""
      ? { folderId: query.folder_id === "none" ? ("none" as const) : query.folder_id }
      : {}),
    ...(typeof query.origin === "string" ? { origin: query.origin as "generated" } : {}),
    ...(query.include_archived === "true" ? { includeArchived: true } : {}),
    limit: page.limit,
    offset,
  });
  // has-more from the service's own count — an overfetch row cannot
  // survive the service-side MAX_SEARCH_LIMIT cap (R18 observation:
  // limit=100 reported has_more=false with more pages behind it).
  const hasMore = offset + result.items.length < result.total;
  const items = hasMore ? result.items.slice(0, page.limit) : result.items;
  // Studio history (Image Generation v2, plan T2.4): generated assets
  // carry their provenance preview so the UI can restore prompt and
  // parameters for regeneration without extra round-trips.
  const bodyItems =
    query.origin !== "generated"
      ? (items as unknown[])
      : await Promise.all(
          (items as unknown[]).map(async (item) => {
            const id = (item as { id?: string }).id;
            if (id === undefined) return item;
            const extra = await app.pool.query(
              `SELECT provider_id, provenance FROM media_assets WHERE id = $1`,
              [id],
            );
            const row = extra.rows[0];
            if (row === undefined) return item;
            return {
              ...(item as Record<string, unknown>),
              provider_id: row["provider_id"] ?? null,
              provenance: row["provenance"] ?? null,
            };
          }),
        );
  return {
    items: bodyItems,
    next_cursor: hasMore ? Buffer.from(String(offset + page.limit)).toString("base64url") : null,
    has_more: hasMore,
  };
}

export async function getMediaUsageOp(
  app: ApplicationServices,
  ctx: OperationContext,
  mediaId: string,
) {
  app.authorize(ctx.actor, "media.read");
  const report = await app.mediaUsage.getUsage(mediaId);
  // Human source titles (owner UX §2): only entry references resolve through
  // revisions; theme and extension source IDs are opaque to the entry store.
  const entryIds = [
    ...new Set(
      report.references
        .filter((reference) => reference.origin !== "extension")
        .map((reference) => reference.sourceEntryId)
        .filter((id) => !id.startsWith("theme:")),
    ),
  ];
  const titles: Record<string, string> = {};
  if (entryIds.length > 0) {
    const rows = await app.pool.query<{ id: string; title: string | null }>(
      `SELECT DISTINCT ON (r.entity_id) r.entity_id::text AS id,
                    r.payload->'fields'->>'title' AS title
             FROM revisions r
             WHERE r.entity_type = 'entry' AND r.entity_id = ANY($1::uuid[])
             ORDER BY r.entity_id, r.revision_no DESC`,
      [entryIds],
    );
    for (const row of rows.rows) {
      if (row.title !== null) titles[row.id] = row.title;
    }
  }
  return { ...report, titles };
}

export async function validateEntrySeoOp(
  app: ApplicationServices,
  ctx: OperationContext,
  entryId: string,
) {
  app.authorize(ctx.actor, "seo.validate");
  const report = await app.seoDiscovery.validateSeoFor(entryId);
  if (report === null) {
    const entry = await app.entries.findEntry(entryId as never);
    if (entry === null)
      throw new ApiError("API_NOT_FOUND", "entry does not exist", { status: 404 });
    throw new ApiError(
      "SEO_FACTS_UNAVAILABLE",
      "entry exists but has no eligible revision for SEO validation",
      { status: 422, details: [{ entry_id: entryId, locale: entry.locale }] },
    );
  }
  return report;
}
