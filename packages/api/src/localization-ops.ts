// Site localization (multilingual) operations. Transport-free: REST, MCP and
// CLI call these functions. Reads/writes gate on site.configure (the Settings
// screen permission); enabling is audited into the security-event stream and
// validates that the ACTIVE theme declares the multilingual capability —
// enabling with an incompatible theme fails closed instead of shipping a
// half-working multilingual site.
import { recordSecurityEvent } from "@pcms/auth";
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission, revisionActorFrom } from "./context.js";
import { ApiError } from "./errors.js";

function auditBase(ctx: OperationContext) {
  return {
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    transport: (ctx.transport === "rest" ? "api" : ctx.transport) as "api" | "mcp" | "cli",
  };
}

function localizationWire(record: {
  enabled: boolean;
  defaultLocale: string;
  locales: readonly string[];
  routingStrategy: string;
  updatedAt: Date;
  updatedBy: string;
}): Record<string, unknown> {
  return {
    enabled: record.enabled,
    default_locale: record.defaultLocale,
    locales: [...record.locales],
    routing_strategy: record.routingStrategy,
    updated_at: record.updatedAt.toISOString(),
    updated_by: record.updatedBy,
  };
}

/** Theme capability a theme must declare to serve multilingual sites. */
export const MULTILINGUAL_THEME_CAPABILITY = "multilingual";

async function assertThemeSupportsMultilingual(app: ApplicationServices): Promise<void> {
  const manifest = app.themeDiscovery?.getManifest();
  if (manifest === undefined || manifest === null) {
    throw new ApiError(
      "THEME_MULTILINGUAL_UNSUPPORTED",
      "no active theme; the active theme must declare the multilingual capability",
      { status: 422 },
    );
  }
  if (!(manifest.capabilities ?? []).includes(MULTILINGUAL_THEME_CAPABILITY)) {
    throw new ApiError(
      "THEME_MULTILINGUAL_UNSUPPORTED",
      `theme "${manifest.id}" does not declare the multilingual capability`,
      { status: 422, details: [{ theme: manifest.id }] },
    );
  }
}

export async function getSiteLocalizationOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "site.configure");
  return localizationWire(await app.localization.get());
}

export interface SiteLocalizationInput {
  readonly enabled: boolean;
  readonly default_locale: string;
  readonly locales: readonly string[];
}

/** Owner 2026-10-06 (privacy-page case): a site agent created ru-RU entry
 * identities on a single-locale site, making the Admin's locale-blind drafts
 * unsealable. Entry identity locales must follow the declared policy:
 * multilingual disabled → the "default" sentinel only; enabled → the
 * declared list (the sentinel stays the baseline). */
export function entryLocaleAllowed(
  policy: { readonly enabled: boolean; readonly locales: readonly string[] },
  locale: string,
): boolean {
  return policy.enabled
    ? locale === "default" || policy.locales.includes(locale)
    : locale === "default";
}

export async function updateSiteLocalizationOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: SiteLocalizationInput,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "site.configure");
  const before = await app.localization.get();
  if (input.enabled && !before.enabled) {
    await assertThemeSupportsMultilingual(app);
  }
  const after = await app.localization.update({
    enabled: input.enabled,
    defaultLocale: input.default_locale,
    locales: input.locales,
    updatedBy: `user:${ctx.actor.id}`,
  });
  await recordSecurityEvent(app.pool, null, {
    type: "LOCALIZATION_UPDATED",
    ...auditBase(ctx),
    subjectType: "site",
    subjectId: "localization",
    metadata: {
      enabled: after.enabled,
      previous_enabled: before.enabled,
      default_locale: after.defaultLocale,
      locales: [...after.locales],
    },
  });
  return localizationWire(after);
}

export interface AddTranslationInput {
  readonly locale: string;
  /** Copy the source's latest payload as the working draft (default true). */
  readonly copy_from_source?: boolean;
}

/**
 * Creates the translation of an entry in a target locale: a new entry in the
 * same translation group plus its first working revision. The route is NOT
 * created here — secondary routes attach at publication exactly like every
 * other entry (changeset route_operation with locale + prefixed path).
 */
export async function addTranslationOp(
  app: ApplicationServices,
  ctx: OperationContext,
  entryId: string,
  input: AddTranslationInput,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "content.create");
  const record = await app.localization.get();
  if (!record.enabled) {
    throw new ApiError("LOCALE_NOT_ENABLED", "site localization is disabled", { status: 422 });
  }
  if (!record.locales.includes(input.locale)) {
    throw new ApiError("LOCALE_NOT_ENABLED", `locale ${input.locale} is not enabled`, {
      status: 422,
    });
  }
  const source = await app.entries.getEntry(entryId as never);
  if (source.entryKind === "folder") {
    // Folder titles are editorial/site data, not public translations —
    // localizing the editorial tree is a separate (future) feature.
    throw new ApiError("ENTRY_KIND_FORBIDDEN", "a folder cannot be translated", {
      status: 422,
      details: [{ entry_id: entryId }],
    });
  }
  if (source.locale === input.locale) {
    throw new ApiError("TRANSLATION_ALREADY_EXISTS", "the source entry is in that locale", {
      status: 409,
    });
  }
  const existing = await app.entries.listTranslations(entryId as never);
  if (existing.some((translation) => translation.locale === input.locale)) {
    throw new ApiError("TRANSLATION_ALREADY_EXISTS", `locale ${input.locale} already exists`, {
      status: 409,
    });
  }
  const contentType = app.contentTypes.getLatestContentType(source.contentTypeId);
  if (contentType === null) {
    throw new ApiError("CONTENT_TYPE_UNKNOWN", `content type is not registered`, { status: 422 });
  }
  const copy = input.copy_from_source ?? true;
  const groupId = source.translationGroupId ?? source.id;
  const created = await app.pool.withTransaction(async (tx) => {
    const entry = await app.entries.createEntryWithinTx(tx, {
      contentTypeId: source.contentTypeId,
      createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
      parentEntryId: source.parentEntryId,
      locale: input.locale,
      translationGroupId: groupId,
    });
    // Copy source: the source's latest revision payload becomes the working
    // draft structure. A copy is a working draft, never a published
    // translation — publication follows the normal per-entry flow.
    const payload = copy
      ? await latestPayloadWithinTx(app, tx, source.id)
      : { fields: {}, blocks: [] };
    const revision = await app.revisions.createWorkingRevisionWithinTx(tx, {
      entityType: "entry",
      entityId: entry.id,
      payload,
      schemaVersion: String(contentType.version),
      locale: input.locale,
      actor: revisionActorFrom(ctx),
    });
    return { entry_id: entry.id, revision_id: revision.id };
  });
  await recordSecurityEvent(app.pool, null, {
    type: "TRANSLATION_CREATED",
    ...auditBase(ctx),
    subjectType: "entry",
    subjectId: created.entry_id,
    metadata: {
      source_entry_id: source.id,
      locale: input.locale,
      copied: copy,
    },
  });
  return created;
}

async function latestPayloadWithinTx(
  app: ApplicationServices,
  tx: unknown,
  entryId: string,
): Promise<{ fields?: unknown; blocks?: unknown }> {
  // Latest revision payload of any state: the closest working structure to
  // translate from. Falls back to empty fields when no revision exists yet.
  const result = await (
    tx as {
      query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ payload: unknown }> }>;
    }
  ).query(
    `SELECT payload FROM revisions
     WHERE entity_type = 'entry' AND entity_id = $1
     ORDER BY revision_no DESC LIMIT 1`,
    [entryId],
  );
  const payload = result.rows[0]?.payload;
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return { fields: {}, blocks: [] };
  }
  const record = payload as { fields?: unknown; blocks?: unknown };
  return { fields: record.fields ?? {}, blocks: record.blocks ?? [] };
}
