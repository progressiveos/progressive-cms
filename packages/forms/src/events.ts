// Canonical M12→M13 domain-event contract (PCMS-FORM-T016; Forms spec §27/
// §28, ADR-0005, owner decision §5). Events are written through the M07
// outbox envelope (packages/publication writeOutboxEvent, adapted via the
// FormsOutboxPort) INSIDE the transaction that persists the state — never
// before persistence, never as a second envelope.
//
// Payloads are routing-safe metadata ONLY: consumers (Integration Hub, M13)
// resolve authorized interaction data through the application/read boundary,
// never from the event. No form payload, no email/phone/name, no PII of any
// kind may enter these payloads (Forms spec §20/§27).

import type { LeadSourceType } from "./leads.js";
import type { FormsOutboxEventInput } from "./ports.js";

export const FORM_EVENT_TYPES = [
  "FormSubmitted",
  "QuizCompleted",
  "LeadCreated",
  "LeadStatusChanged",
] as const;

export type FormEventType = (typeof FORM_EVENT_TYPES)[number];

export interface FormSubmittedEventPayload {
  readonly submission_id: string;
  readonly form_definition_id: string;
  readonly form_schema_version: number;
  readonly source_entry_id?: string;
}

export interface QuizCompletedEventPayload {
  readonly quiz_run_id: string;
  readonly quiz_definition_id: string;
  readonly quiz_schema_version: number;
  readonly outcome_id?: string;
  readonly score?: number;
}

export interface LeadCreatedEventPayload {
  readonly lead_id: string;
  readonly source_type: LeadSourceType;
  readonly source_id: string;
  readonly classification?: string;
}

export interface LeadStatusChangedEventPayload {
  readonly lead_id: string;
  readonly previous_status: string;
  readonly status: string;
}

export function formSubmittedEvent(payload: FormSubmittedEventPayload): FormsOutboxEventInput {
  return {
    aggregate: "form_submission",
    aggregateId: payload.submission_id,
    eventType: "FormSubmitted",
    payload: {
      submission_id: payload.submission_id,
      form_definition_id: payload.form_definition_id,
      form_schema_version: payload.form_schema_version,
      ...(payload.source_entry_id === undefined
        ? {}
        : { source_entry_id: payload.source_entry_id }),
    },
  };
}

export function quizCompletedEvent(payload: QuizCompletedEventPayload): FormsOutboxEventInput {
  return {
    aggregate: "quiz_run",
    aggregateId: payload.quiz_run_id,
    eventType: "QuizCompleted",
    payload: {
      quiz_run_id: payload.quiz_run_id,
      quiz_definition_id: payload.quiz_definition_id,
      quiz_schema_version: payload.quiz_schema_version,
      ...(payload.outcome_id === undefined ? {} : { outcome_id: payload.outcome_id }),
      ...(payload.score === undefined ? {} : { score: payload.score }),
    },
  };
}

export function leadCreatedEvent(payload: LeadCreatedEventPayload): FormsOutboxEventInput {
  return {
    aggregate: "lead",
    aggregateId: payload.lead_id,
    eventType: "LeadCreated",
    payload: {
      lead_id: payload.lead_id,
      source_type: payload.source_type,
      source_id: payload.source_id,
      ...(payload.classification === undefined ? {} : { classification: payload.classification }),
    },
  };
}

export function leadStatusChangedEvent(
  payload: LeadStatusChangedEventPayload,
): FormsOutboxEventInput {
  return {
    aggregate: "lead",
    aggregateId: payload.lead_id,
    eventType: "LeadStatusChanged",
    payload: {
      lead_id: payload.lead_id,
      previous_status: payload.previous_status,
      status: payload.status,
    },
  };
}
