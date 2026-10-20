// Publication UX operations (owner productization pass 0.1.28):
// human-facing projections over the publication subsystem. The changeset /
// revision machinery stays authoritative — these read-only ops aggregate the
// same tables into the two questions a normal editor actually asks:
// "what is waiting for publication" and "what was published, by whom, when".
import type { ApplicationServices, OperationContext } from "./context.js";
import { requirePermission } from "./context.js";

interface PendingRow extends Record<string, unknown> {
  readonly entry_id: string;
  readonly content_type_id: string | null;
  readonly title: string | null;
  readonly revision_id: string;
  readonly revision_state: "WORKING" | "SEALED";
  readonly edit_generation: number;
  readonly payload_hash: string | null;
  readonly published_revision_id: string | null;
  readonly changed_at: Date;
  readonly changed_by_type: string;
  readonly changed_by: string | null;
  readonly actor_name: string | null;
  readonly generation: number | null;
  readonly route_path: string | null;
  readonly scheduled_at: Date | null;
}

export interface PendingPublicationItem {
  readonly entry_id: string;
  readonly content_type: string | null;
  readonly title: string;
  readonly status: "draft" | "working_changes" | "ready";
  readonly revision_id: string;
  readonly revision_state: "WORKING" | "SEALED";
  readonly payload_hash: string | null;
  /** Published pointer's revision (null = never published). */
  readonly published_revision_id: string | null;
  readonly edit_generation: number;
  readonly changed_at: string;
  readonly changed_by: string | null;
  readonly route_path: string | null;
  readonly published: boolean;
  /** Earliest pending schedule for this entry, if one is planned. */
  readonly scheduled_at: string | null;
  /** Publication CAS baseline for POST /publications/publish (0 = never). */
  readonly expected_generation: number;
}

/** Entries whose current state is not what the public site shows. */
export async function listPendingPublicationsOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly limit?: number },
): Promise<{ items: readonly PendingPublicationItem[] }> {
  requirePermission(app, ctx, "publication.read");
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const result = await app.pool.query<PendingRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (r.entity_id)
              r.entity_id, r.id AS revision_id, r.state, r.edit_generation,
              r.created_at, r.created_by_type, r.created_by, r.payload,
              r.payload_hash
       FROM revisions r
       WHERE r.entity_type = 'entry'
       ORDER BY r.entity_id, r.revision_no DESC
     ),
     pub AS (
       -- The canonical read (getPublication) is context-scoped with the
       -- "default" sentinel; without this filter stale non-default context
       -- rows fan the join out and feed wrong generations into the view
       -- (spangar 2026-10-06: expected_generation 1 vs live 6-8).
       SELECT DISTINCT ON (p.entity_id)
              p.entity_id, p.current_revision_id, p.generation
       FROM publications p
       WHERE p.entity_type = 'entry' AND p.state = 'PUBLISHED' AND p.context = 'default'
       ORDER BY p.entity_id, p.generation DESC
     ),
     pubrev AS (
       SELECT r.id, r.payload_hash
       FROM revisions r
       WHERE r.entity_type = 'entry'
     )
     SELECT e.id AS entry_id, e.content_type_id,
            latest.payload->'fields'->>'title' AS title,
            latest.revision_id, latest.state AS revision_state,
            latest.created_at AS changed_at,
            latest.created_by_type AS changed_by_type,
            latest.created_by AS changed_by,
            COALESCE(u.display_name, sa.name) AS actor_name,
            pub.current_revision_id AS published_revision_id,
            pub.generation,
            latest.payload_hash AS payload_hash,
            rt.path AS route_path,
            sched.next_publish_at AS scheduled_at
     FROM entries e
     JOIN latest ON latest.entity_id = e.id
     LEFT JOIN pub ON pub.entity_id = e.id
     LEFT JOIN pubrev ON pubrev.id = pub.current_revision_id
     LEFT JOIN users u
       ON latest.created_by_type = 'human' AND u.id::text = latest.created_by
     LEFT JOIN service_accounts sa
       ON latest.created_by_type = 'service_account' AND sa.id::text = latest.created_by
     LEFT JOIN LATERAL (
       SELECT path FROM routes
       WHERE target_type = 'entry' AND target_id = e.id::text
         AND retired_at IS NULL AND is_canonical
       ORDER BY path LIMIT 1
     ) rt ON true
     LEFT JOIN LATERAL (
       SELECT MIN(i.publish_at) AS next_publish_at
       FROM publication_plan_items i
       JOIN changeset_items ci ON ci.id = i.changeset_item_id
       WHERE ci.entity_type = 'entry' AND ci.entity_id = e.id
         AND i.state = 'SCHEDULED'
     ) sched ON true
     WHERE e.archived_at IS NULL
       AND e.entry_kind = 'content'
       AND (latest.state = 'WORKING'
            OR pub.current_revision_id IS NULL
            OR (pub.current_revision_id <> latest.revision_id
                AND latest.payload_hash IS DISTINCT FROM pubrev.payload_hash))
     ORDER BY latest.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return {
    items: result.rows.map((row) => ({
      entry_id: row.entry_id,
      content_type: row.content_type_id,
      title: row.title ?? "",
      // draft: never published, still working; working_changes: a working
      // revision sits on top of a published pointer; ready: sealed revision
      // not yet applied.
      status:
        row.revision_state === "WORKING"
          ? row.published_revision_id === null
            ? "draft"
            : "working_changes"
          : "ready",
      revision_id: row.revision_id,
      revision_state: row.revision_state,
      payload_hash: row.payload_hash,
      published_revision_id: row.published_revision_id,
      edit_generation: row.edit_generation,
      changed_at: row.changed_at.toISOString(),
      changed_by: row.actor_name ?? row.changed_by,
      route_path: row.route_path,
      published: row.published_revision_id !== null,
      scheduled_at: row.scheduled_at === null ? null : row.scheduled_at.toISOString(),
      // Live CAS baseline for POST /publications/publish (0 = never
      // published in the "default" context). The pub CTE is context-scoped
      // and highest-generation, so this IS the live generation.
      expected_generation: row.generation ?? 0,
    })),
  };
}

interface EventRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_type: string;
  readonly entity_id: string;
  readonly title: string | null;
  readonly actor_name: string | null;
  readonly actor_id: string;
  readonly changeset_id: string | null;
  readonly changeset_title: string | null;
  readonly created_at: Date;
}

export interface PublicationHistoryItem {
  /** Operation title: the changeset name, or the entry title for singles. */
  readonly title: string;
  readonly kind: "package" | "single";
  readonly event_types: readonly string[];
  readonly actor: string | null;
  readonly occurred_at: string;
  readonly entry_count: number;
  readonly entries: readonly { readonly entry_id: string; readonly title: string }[];
  readonly changeset_id: string | null;
}

/** Human publication history: named operations, not revision UUIDs. */
export async function listPublicationHistoryOp(
  app: ApplicationServices,
  ctx: OperationContext,
  input: { readonly limit?: number },
): Promise<{ items: readonly PublicationHistoryItem[] }> {
  requirePermission(app, ctx, "publication.read");
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const result = await app.pool.query<EventRow>(
    `SELECT ev.id, ev.event_type, ev.entity_id,
            COALESCE(
              to_rev.payload->'fields'->>'title',
              from_rev.payload->'fields'->>'title'
            ) AS title,
            COALESCE(u.display_name, sa.name, ev.actor_id) AS actor_name,
            ev.actor_id, ev.changeset_id, cs.title AS changeset_title,
            ev.created_at
     FROM publication_events ev
     LEFT JOIN revisions to_rev ON to_rev.id = ev.to_revision_id
     LEFT JOIN revisions from_rev ON from_rev.id = ev.from_revision_id
     LEFT JOIN changesets cs ON cs.id = ev.changeset_id
     LEFT JOIN users u ON ev.actor_class = 'human' AND u.id::text = ev.actor_id
     LEFT JOIN service_accounts sa
       ON ev.actor_class = 'service_account' AND sa.id::text = ev.actor_id
     WHERE ev.entity_type = 'entry'
     ORDER BY ev.created_at DESC
     LIMIT $1`,
    [limit * 10],
  );

  // Group events into human operations: all events of one changeset collapse
  // into a single row; ungrouped events stay individual.
  const packages = new Map<string, EventRow[]>();
  const singles: EventRow[] = [];
  for (const row of result.rows) {
    if (row.changeset_id !== null) {
      const bucket = packages.get(row.changeset_id);
      if (bucket === undefined) packages.set(row.changeset_id, [row]);
      else bucket.push(row);
    } else {
      singles.push(row);
    }
  }

  const merged = [
    ...[...packages.values()].map((rows) => ({ kind: "package" as const, rows })),
    ...singles.map((row) => ({ kind: "single" as const, rows: [row] })),
  ].sort((a, b) => (b.rows[0]?.created_at.getTime() ?? 0) - (a.rows[0]?.created_at.getTime() ?? 0));

  return {
    items: merged.slice(0, limit).map(({ kind, rows }) => {
      const first = rows[0];
      if (first === undefined) {
        throw new Error("publication history group cannot be empty");
      }
      const entries = rows.map((row) => ({
        entry_id: row.entity_id,
        title: row.title ?? "",
      }));
      return {
        title:
          kind === "package"
            ? (first.changeset_title ?? "")
            : historyEventTitle(first.event_type, first.title),
        kind,
        event_types: [...new Set(rows.map((row) => row.event_type))],
        actor: first.actor_name,
        occurred_at: first.created_at.toISOString(),
        entry_count: entries.length,
        entries,
        changeset_id: first.changeset_id,
      };
    }),
  };
}

function historyEventTitle(eventType: string, entryTitle: string | null): string {
  const subject = entryTitle === null || entryTitle === "" ? "" : ` «${entryTitle}»`;
  switch (eventType) {
    case "PUBLISH_FIRST":
      return `Entry publication${subject}`;
    case "PUBLISH_UPDATE":
      return `Publication update${subject}`;
    case "UNPUBLISH":
      return `Unpublish${subject}`;
    case "ROLLBACK":
      return `Publication rollback${subject}`;
    default:
      return `${eventType}${subject}`;
  }
}
