// Entry external identity + human-edit reconciliation (M16; task brief
// §38–§44). The agent sync surfaces that make re-sync safe coexistence with
// human editors: bind an external source item to an Entry, persist the
// agent's last-applied publication generation + source hash + run id, and
// resolve with a machine-readable HUMAN_EDIT_CONFLICT verdict when the live
// generation has moved past the baseline (do NOT auto-overwrite).
//
// Surfaces: REST /external-identities/* and MCP cms_resolve_external_identity
// / cms_bind_external_identity — both call these ops; no direct DB for the
// agent. Eval harnesses treat direct DB access as a violation (§60).
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";
import { ApiError } from "./errors.js";

export interface ExternalIdentityBaseline {
  readonly last_agent_generation: number | null;
  readonly source_hash: string | null;
  readonly last_agent_run_id: string | null;
  readonly updated_at: string;
}

interface DbRow extends Record<string, unknown> {
  site_key: string;
  source_namespace: string;
  external_id: string;
  entry_id: string;
  last_agent_generation: number | null;
  source_hash: string | null;
  last_agent_run_id: string | null;
  updated_at: Date;
}

export async function resolveExternalIdentityOp(
  app: ApplicationServices,
  ctx: OperationContext,
  namespace: string,
  externalId: string,
  options: { sourceHash?: string } = {},
): Promise<unknown> {
  await requirePermission(app, ctx, "content.read");
  const row = await app.pool.query<DbRow>(
    `SELECT site_key, source_namespace, external_id, entry_id,
            last_agent_generation, source_hash, last_agent_run_id, updated_at
       FROM entry_external_identities
      WHERE site_key = $1 AND source_namespace = $2 AND external_id = $3`,
    [app.defaultSiteKey, namespace, externalId],
  );
  const identity = row.rows[0];
  if (identity === undefined) {
    throw new ApiError("EXTERNAL_IDENTITY_NOT_FOUND", "external identity is not bound", {
      status: 404,
      details: [{ source_namespace: namespace, external_id: externalId }],
    });
  }

  const publication = await app.publications.getPublication(
    app.pool,
    "entry",
    identity.entry_id as never,
  );
  const currentGeneration = publication === null ? 0 : publication.generation;
  const baselineGeneration = identity.last_agent_generation;

  // Reconciliation verdict (§41): equal generations → the agent may compare
  // and apply; anything else (a human published, or the entry went
  // unpublished) → stop, never overwrite silently. No baseline yet → the
  // binding exists but the agent has not published through it.
  const state =
    baselineGeneration === null
      ? "BASELINE_UNSET"
      : baselineGeneration === currentGeneration
        ? "IN_SYNC"
        : "HUMAN_EDIT_CONFLICT";

  const sourceChanged =
    options.sourceHash !== undefined && identity.source_hash !== null
      ? options.sourceHash !== identity.source_hash
      : null;

  return {
    found: true,
    site_key: identity.site_key,
    source_namespace: identity.source_namespace,
    external_id: identity.external_id,
    entry_id: identity.entry_id,
    baseline: {
      last_agent_generation: baselineGeneration,
      source_hash: identity.source_hash,
      last_agent_run_id: identity.last_agent_run_id,
      updated_at: identity.updated_at.toISOString(),
    } satisfies ExternalIdentityBaseline,
    reconciliation: {
      state,
      baseline_generation: baselineGeneration,
      current_generation: currentGeneration,
      source_changed: sourceChanged,
    },
  };
}

export interface BindExternalIdentityInput {
  readonly entry_id: string;
  readonly source_hash?: string;
  readonly last_agent_generation?: number;
  readonly run_id?: string;
}

/**
 * Bind an external identity to an entry, or update its sync baseline
 * (idempotent re-submission: same entry → baseline refresh, never a second
 * row). Re-binding to a DIFFERENT entry is a conflict a human must resolve.
 */
export async function bindExternalIdentityOp(
  app: ApplicationServices,
  ctx: OperationContext,
  namespace: string,
  externalId: string,
  input: BindExternalIdentityInput,
): Promise<unknown> {
  await requirePermission(app, ctx, "content.edit");
  const entry = await app.pool.query<{ id: string; archived_at: Date | null }>(
    "SELECT id, archived_at FROM entries WHERE id = $1",
    [input.entry_id],
  );
  if (entry.rows.length === 0) {
    throw new ApiError("ENTRY_NOT_FOUND", "entry does not exist", {
      status: 404,
      details: [{ entry_id: input.entry_id }],
    });
  }
  const existingEntry = entry.rows[0];
  if (existingEntry === undefined || existingEntry.archived_at !== null) {
    throw new ApiError("ENTRY_ARCHIVED", "entry is archived", {
      status: 409,
      details: [{ entry_id: input.entry_id }],
    });
  }

  const existing = await app.pool.query<{ entry_id: string }>(
    `SELECT entry_id FROM entry_external_identities
      WHERE site_key = $1 AND source_namespace = $2 AND external_id = $3`,
    [app.defaultSiteKey, namespace, externalId],
  );
  if (existing.rows[0] !== undefined && existing.rows[0].entry_id !== input.entry_id) {
    throw new ApiError(
      "EXTERNAL_IDENTITY_CONFLICT",
      "external identity is already bound to a different entry",
      {
        status: 409,
        details: [{ bound_entry_id: existing.rows[0]?.entry_id ?? "" }],
      },
    );
  }

  const upsert = await app.pool.query<
    { updated_at: Date } extends never ? never : { updated_at: Date }
  >(
    `INSERT INTO entry_external_identities
       (site_key, source_namespace, external_id, entry_id,
        last_agent_generation, source_hash, last_agent_run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (site_key, source_namespace, external_id)
     DO UPDATE SET last_agent_generation = EXCLUDED.last_agent_generation,
                   source_hash = EXCLUDED.source_hash,
                   last_agent_run_id = EXCLUDED.last_agent_run_id,
                   updated_at = now()
     RETURNING updated_at`,
    [
      app.defaultSiteKey,
      namespace,
      externalId,
      input.entry_id,
      input.last_agent_generation ?? null,
      input.source_hash ?? null,
      input.run_id ?? null,
    ],
  );

  return {
    bound: true,
    site_key: app.defaultSiteKey,
    source_namespace: namespace,
    external_id: externalId,
    entry_id: input.entry_id,
    last_agent_generation: input.last_agent_generation ?? null,
    updated_at: upsert.rows[0]?.updated_at.toISOString() ?? new Date(0).toISOString(),
  };
}
