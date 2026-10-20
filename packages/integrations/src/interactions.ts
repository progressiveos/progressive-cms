// M13-owned contract for the M12 interaction domain events (owner brief
// §5). M12 is a parallel milestone: M13 consumes these events through the
// existing M07 Outbox envelope and knows ONLY this semantic contract.
// Payloads carry routing-safe metadata — never PII (submissions store PII
// in Forms; projected fields are requested explicitly through the
// IntegrationProjectionSource boundary, owner brief §6).
export const INTERACTION_EVENT_TYPES = [
  "FormSubmitted",
  "QuizCompleted",
  "QuizStarted",
  "QuizAbandoned",
  "LeadCreated",
  "LeadStatusChanged",
] as const;

export type InteractionEventType = (typeof INTERACTION_EVENT_TYPES)[number];

/** Aggregate names as written by the M12 producer into the outbox. */
export const INTERACTION_AGGREGATES = {
  FormSubmitted: "form_submission",
  QuizCompleted: "quiz_run",
  QuizStarted: "quiz_run",
  QuizAbandoned: "quiz_run",
  LeadCreated: "lead",
  LeadStatusChanged: "lead",
} as const satisfies Record<InteractionEventType, string>;

export interface FormSubmittedPayload {
  readonly submission_id: string;
  readonly form_definition_id: string;
  readonly form_schema_version: string;
  readonly source_entry_id?: string;
}

export interface QuizCompletedPayload {
  readonly quiz_run_id: string;
  readonly quiz_definition_id: string;
  readonly quiz_schema_version: string;
  readonly outcome_id?: string;
  readonly score?: number;
}

export interface QuizRunLifecyclePayload {
  readonly quiz_run_id: string;
  readonly quiz_definition_id: string;
  readonly quiz_schema_version: string;
}

export interface LeadCreatedPayload {
  readonly lead_id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly classification?: string;
}

export interface LeadStatusChangedPayload {
  readonly lead_id: string;
  readonly previous_status: string;
  readonly status: string;
}
