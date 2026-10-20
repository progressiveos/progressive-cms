// Content schema validate/apply operations (2026-09-29, "schemas via API").
// Closes the platform gap where content_schema.propose/apply permissions
// existed with no mechanism: the only way to change schemas was editing the
// deployment's content-types.json over SSH and restarting web by hand.
//
// Surfaces (transport-free; REST/CLI/MCP call these):
//  - validate: full registration probe + additive-change report, no effects.
//  - apply:    persists additive-only overrides (DB, audited); the typesFile
//              stays the base and is overlaid wholesale per key@version at
//              boot by web AND worker. Report states affected entries and
//              that a restart is required (registries are in-memory,
//              fail-secure — no hot reload by design).
//  - overrides: what is currently persisted on top of the typesFile.

import { recordSecurityEvent } from "@pcms/auth";
import {
  ContentError,
  type ContentTypeDefinition,
  type ContentTypeDiff,
  createContentTypeRegistry,
  diffContentTypeDefinitions,
  type LoadedContentType,
  parseDefinitionsInput,
} from "@pcms/content";
import type { ApplicationServices, OperationContext } from "./context.js";
import { auditBase, requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

interface SchemaIssue {
  readonly code: string;
  readonly message: string;
}

export interface SchemaReport {
  readonly ok: boolean;
  readonly issues: readonly SchemaIssue[];
  readonly diff: ContentTypeDiff;
  readonly affected_entries?: Record<string, number>;
  readonly migration_needed: false;
  readonly restart_required: boolean;
}

async function affectedEntryCounts(
  pool: ApplicationServices["pool"],
  typeKeys: readonly string[],
): Promise<Record<string, number>> {
  if (typeKeys.length === 0) return {};
  const result = await pool.query<{ content_type_id: string; count: string }>(
    "SELECT content_type_id, count(*) FROM entries WHERE content_type_id = ANY($1::text[]) AND archived_at IS NULL GROUP BY content_type_id",
    [typeKeys],
  );
  return Object.fromEntries(result.rows.map((row) => [row.content_type_id, Number(row.count)]));
}

/** Registration probe of the proposed set in an isolated scratch registry. */
function probeRegister(definitions: readonly ContentTypeDefinition[]): {
  loaded: LoadedContentType[];
  issues: SchemaIssue[];
} {
  const scratch = createContentTypeRegistry();
  const loaded: LoadedContentType[] = [];
  const issues: SchemaIssue[] = [];
  for (const definition of definitions) {
    try {
      loaded.push(scratch.registerContentType(definition));
    } catch (error) {
      issues.push({
        code: error instanceof ContentError ? error.code : "SCHEMA_INVALID",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { loaded, issues };
}

function currentAndProposed(
  app: ApplicationServices,
  input: unknown,
): { proposed: ContentTypeDefinition[]; diff: ContentTypeDiff; issues: SchemaIssue[] } {
  const proposed = parseDefinitionsInput(input);
  const current = app.contentTypes.listContentTypes();
  const { loaded, issues } = probeRegister(proposed);
  const diff = diffContentTypeDefinitions(current, loaded);
  return { proposed, diff, issues };
}

export async function validateContentSchemaOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly definitions: unknown },
): Promise<SchemaReport> {
  requirePermission(app, ctx, "content_schema.propose");
  const { diff, issues } = currentAndProposed(app, input.definitions);
  return {
    ok: issues.length === 0 && diff.violations.length === 0,
    issues,
    diff,
    migration_needed: false,
    restart_required: diff.added_types.length > 0 || Object.keys(diff.added_fields).length > 0,
  };
}

export async function applyContentSchemaOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly definitions: unknown },
): Promise<SchemaReport> {
  requirePermission(app, ctx, "content_schema.apply");
  const { proposed, diff, issues } = currentAndProposed(app, input.definitions);
  if (issues.length > 0 || diff.violations.length > 0) {
    throw new ApiError(
      "SCHEMA_CHANGE_NOT_ADDITIVE",
      "definition set rejected — validate first; violations block apply",
      { status: 422, details: [...issues, ...diff.violations] },
    );
  }
  const touchedKeys = new Set([
    ...diff.added_types,
    ...Object.keys(diff.added_fields),
    ...diff.changed_meta,
  ]);

  for (const definition of proposed) {
    if (!touchedKeys.has(`${definition.key}@${definition.version}`)) continue;
    await app.pool.query(
      `INSERT INTO pcms_content_type_overrides (content_type_id, version, definition, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (content_type_id, version)
       DO UPDATE SET definition = EXCLUDED.definition, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [
        definition.key,
        definition.version,
        JSON.stringify(definition),
        `${ctx.actor.type}:${ctx.actor.id}`,
      ],
    );
  }

  const touchedTypeKeys = [
    ...new Set([...touchedKeys].map((mapKey) => mapKey.split("@")[0] ?? mapKey)),
  ];
  const affected_entries = await affectedEntryCounts(app.pool, touchedTypeKeys);
  const restart_required = touchedKeys.size > 0;
  await recordSecurityEvent(app.pool, null, {
    type: "CONTENT_SCHEMA_APPLIED",
    ...auditBase(ctx),
    subjectType: "content_schema",
    subjectId: touchedTypeKeys.join(",") || "none",
    metadata: {
      added_types: diff.added_types,
      added_fields: diff.added_fields,
      restart_required,
    },
  });
  return {
    ok: true,
    issues: [],
    diff,
    affected_entries,
    migration_needed: false,
    restart_required,
  };
}

export async function listContentTypeOverridesOp(
  app: ApplicationServices,
  ctx: OperationContext,
): Promise<Record<string, unknown>> {
  requirePermission(app, ctx, "content_schema.read");
  const rows = await app.pool.query<{
    content_type_id: string;
    version: number;
    updated_at: Date;
    updated_by: string;
  }>(
    "SELECT content_type_id, version, updated_at, updated_by FROM pcms_content_type_overrides ORDER BY content_type_id, version",
  );
  return {
    items: rows.rows.map((row) => ({
      key: row.content_type_id,
      version: row.version,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    })),
  };
}
