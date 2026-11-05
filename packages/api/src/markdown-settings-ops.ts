import { recordSecurityEvent } from "@pcms/auth";
import { newStableId } from "@pcms/core";
import type { ApplicationServices, OperationContext } from "./context.js";
import { auditBase, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

interface SettingRow extends Record<string, unknown> {
  readonly enabled: boolean;
  readonly settings_generation: number;
}

export interface AgentMarkdownSettingsWire {
  readonly enabled: boolean;
  readonly generation: number;
}

export interface EntryMarkdownSettingsWire extends AgentMarkdownSettingsWire {
  readonly globalEnabled: boolean;
  readonly globalGeneration: number;
}

async function loadSetting(
  app: ApplicationServices,
  entryId: string | null,
): Promise<AgentMarkdownSettingsWire> {
  const result = await app.pool.query<SettingRow>(
    "SELECT enabled, settings_generation FROM agent_markdown_settings WHERE site_key = $1 AND entry_id IS NOT DISTINCT FROM $2::uuid",
    [app.defaultSiteKey, entryId],
  );
  const row = result.rows[0];
  return row === undefined
    ? { enabled: true, generation: 0 }
    : { enabled: row.enabled, generation: row.settings_generation };
}

export async function getAgentMarkdownSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<AgentMarkdownSettingsWire> {
  requirePermission(app, ctx, "seo.read");
  return loadSetting(app, null);
}

export async function saveAgentMarkdownSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly enabled: boolean; readonly expected_generation: number },
): Promise<{ readonly generation: number }> {
  requirePermission(app, ctx, "seo.site_settings");
  return saveSetting(app, ctx, null, input);
}

export async function getEntryMarkdownSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  entryId: string,
): Promise<EntryMarkdownSettingsWire> {
  requirePermission(app, ctx, "content.read");
  if (!(await app.entries.findEntry(entryId as never)))
    throw new ApiError("ENTRY_NOT_FOUND", "entry was not found", { status: 404 });
  const [global, entry] = await Promise.all([loadSetting(app, null), loadSetting(app, entryId)]);
  return {
    enabled: entry.enabled,
    generation: entry.generation,
    globalEnabled: global.enabled,
    globalGeneration: global.generation,
  };
}

export async function saveEntryMarkdownSettingsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  entryId: string | null,
  input: { readonly enabled: boolean; readonly expected_generation: number },
): Promise<{ readonly generation: number }> {
  requirePermission(app, ctx, "content.edit");
  if (!(await app.entries.findEntry(entryId as never)))
    throw new ApiError("ENTRY_NOT_FOUND", "entry was not found", { status: 404 });
  return saveSetting(app, ctx, entryId, input);
}

async function saveSetting(
  app: ApplicationServices,
  ctx: OperationContext,
  entryId: string | null,
  input: { readonly enabled: boolean; readonly expected_generation: number },
): Promise<{ readonly generation: number }> {
  const subjectType = entryId === null ? "agent_markdown_site" : "agent_markdown_entry";
  const subjectId = entryId ?? app.defaultSiteKey;
  const conflictTarget =
    entryId === null
      ? "ON CONFLICT (site_key) WHERE entry_id IS NULL"
      : "ON CONFLICT (site_key, entry_id) WHERE entry_id IS NOT NULL";
  const generation = await app.pool.withTransaction(async (tx) => {
    const result = await tx.query<SettingRow>(
      `INSERT INTO agent_markdown_settings (id, site_key, entry_id, enabled, settings_generation)
       SELECT $1, $2, $3::uuid, $4, 1
       WHERE $5 = 0 OR EXISTS (
         SELECT 1 FROM agent_markdown_settings
         WHERE site_key = $2 AND entry_id IS NOT DISTINCT FROM $3::uuid
       )
       ${conflictTarget} DO UPDATE
         SET enabled = EXCLUDED.enabled,
             settings_generation = agent_markdown_settings.settings_generation + 1,
             updated_at = now()
       WHERE agent_markdown_settings.settings_generation = $5
       RETURNING enabled, settings_generation`,
      [newStableId(), app.defaultSiteKey, entryId, input.enabled, input.expected_generation],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new ApiError("AGENT_MARKDOWN_SETTINGS_STALE", "settings changed concurrently", {
        status: 409,
      });
    await recordSecurityEvent(tx, null, {
      type: "AGENT_MARKDOWN_SETTINGS_UPDATED",
      ...auditBase(ctx),
      subjectType,
      subjectId,
      metadata: { enabled: input.enabled, ...(entryId === null ? {} : { entry_id: entryId }) },
    });
    return row.settings_generation;
  });
  return { generation };
}

/** Request-path reader shared by public HTML negotiation and discovery. */
export async function getPublicAgentMarkdownSettings(
  app: ApplicationServices,
  entryId: string | null,
): Promise<{ readonly globalEnabled: boolean; readonly entryEnabled: boolean }> {
  const { rows } = await app.pool.query<{
    readonly entry_id: string | null;
    readonly enabled: boolean;
  }>(
    "SELECT entry_id::text AS entry_id, enabled FROM agent_markdown_settings WHERE site_key = $1 AND (entry_id IS NULL OR entry_id = $2::uuid)",
    [app.defaultSiteKey, entryId],
  );
  const global = rows.find((row) => row.entry_id === null);
  const entry =
    entryId === null ? undefined : rows.find((row) => row.entry_id === entryId.toLowerCase());
  return { globalEnabled: global?.enabled ?? true, entryEnabled: entry?.enabled ?? true };
}
