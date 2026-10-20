// Lead/submission delivery projection (owner task §62/§63): a READ
// projection over the EXISTING IntegrationDelivery records — no second
// delivery subsystem. Correlation is exact, not heuristic: deliveries point
// at the outbox event, and the outbox row carries (aggregate, aggregate_id)
// plus the LeadCreated payload's source_id — all persisted in the same
// transaction as the business event.
import type { DbPool } from "@pcms/core";

export interface LeadDeliveryItem {
  readonly id: string;
  readonly event_type: string;
  readonly connector_type: string | null;
  readonly instance_name: string | null;
  readonly status: string;
  readonly external_id: string | null;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly next_attempt_at: string | null;
  readonly last_error_code: string | null;
  readonly created_at: string;
}

interface DeliveryRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_type: string;
  readonly connector_type: string | null;
  readonly instance_name: string | null;
  readonly status: string;
  readonly external_id: string | null;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly next_attempt_at: Date | null;
  readonly last_error_code: string | null;
  readonly created_at: Date;
}

const SELECT = `
  SELECT d.id, d.event_type, d.status, d.external_id, d.attempt_count, d.max_attempts,
         d.next_attempt_at, d.last_error_code, d.created_at,
         i.connector_type, i.name AS instance_name
  FROM integration_delivery d
  JOIN publication_outbox o ON o.id = d.outbox_event_id
  LEFT JOIN integration_instance i ON i.id = d.instance_id`;

function toItems(rows: readonly DeliveryRow[]): readonly LeadDeliveryItem[] {
  return rows.map((row) => ({
    id: row.id,
    event_type: row.event_type,
    connector_type: row.connector_type,
    instance_name: row.instance_name,
    status: row.status,
    external_id: row.external_id,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at === null ? null : row.next_attempt_at.toISOString(),
    last_error_code: row.last_error_code,
    created_at: row.created_at.toISOString(),
  }));
}

/** Everything delivered on behalf of one lead: its own LeadCreated /
 * LeadStatusChanged events plus the events of the originating submission or
 * quiz run (exact aggregate correlation). */
export async function leadDeliveryProjection(
  pool: DbPool,
  leadId: string,
): Promise<readonly LeadDeliveryItem[]> {
  const result = await pool.query<DeliveryRow>(
    `${SELECT}
     WHERE o.aggregate = 'lead' AND o.aggregate_id = $1
        OR o.aggregate = 'form_submission'
           AND o.aggregate_id = (SELECT source_id::text FROM forms_leads WHERE id = $1::uuid)
        OR o.aggregate = 'quiz_run'
           AND o.aggregate_id = (SELECT source_id::text FROM forms_leads WHERE id = $1::uuid)
     ORDER BY d.created_at, d.id`,
    [leadId],
  );
  return toItems(result.rows);
}

/** Downstream deliveries of one form submission: the FormSubmitted event
 * itself plus LeadCreated events spawned by it (payload.source_id is the
 * submission id, persisted transactionally). */
export async function submissionDeliveryProjection(
  pool: DbPool,
  submissionId: string,
): Promise<readonly LeadDeliveryItem[]> {
  const result = await pool.query<DeliveryRow>(
    `${SELECT}
     WHERE (o.aggregate = 'form_submission' AND o.aggregate_id = $1)
        OR (o.aggregate = 'lead' AND o.payload->>'source_id' = $1)
     ORDER BY d.created_at, d.id`,
    [submissionId],
  );
  return toItems(result.rows);
}
