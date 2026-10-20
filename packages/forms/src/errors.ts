// Stable forms/quizzes/interactions/leads error codes (Forms spec §37;
// append-only like every other subsystem registry — codes are contract,
// messages are not). Transport mapping is central: *_NOT_FOUND → 404,
// *_CONFLICT → 409, *_TOO_LARGE → 413, *_RATE_LIMITED → 429,
// *_INVALID/_UNSUPPORTED/… → 422, *_DENIED → 403 (packages/api errors.ts).
export class FormsError extends Error {
  /** Machine-stable error code, e.g. "FORM_VALUES_INVALID". */
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    options?: {
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "FormsError";
    this.code = code;
    this.details = options?.details;
  }
}

export const FORMS_ERROR_CODES = [
  // Form definitions.
  "FORM_DEFINITION_INVALID",
  "FORM_DEFINITION_NOT_FOUND",
  "FORM_DEFINITION_VERSION_EXISTS",
  "FORM_KEY_TAKEN",
  "FORM_FIELD_UNSUPPORTED",
  // Public form submission.
  "FORM_VALUES_INVALID",
  "FORM_CONSENT_REQUIRED",
  "FORM_TOO_LARGE",
  "FORM_RATE_LIMITED",
  "FORM_ORIGIN_DENIED",
  "FORM_SUBMISSION_NOT_FOUND",
  // Quiz definitions.
  "QUIZ_KEY_TAKEN",
  "QUIZ_DEFINITION_INVALID",
  "QUIZ_DEFINITION_NOT_FOUND",
  "QUIZ_DEFINITION_VERSION_EXISTS",
  "QUIZ_QUESTION_UNSUPPORTED",
  "QUIZ_BRANCHING_INVALID",
  "QUIZ_SCORING_INVALID",
  // Quiz runs.
  "QUIZ_RUN_NOT_FOUND",
  "QUIZ_RUN_EXPIRED",
  "QUIZ_RUN_STATE_INVALID",
  "PRIVACY_BLOCKED_CONFLICT",
  "QUIZ_ANSWER_INVALID",
  "QUIZ_TOO_LARGE",
  "QUIZ_RATE_LIMITED",
  // Leads.
  "LEAD_NOT_FOUND",
  "LEAD_STATUS_INVALID",
  // Export.
  "INTERACTION_EXPORT_INVALID",
] as const;

export type FormsErrorCode = (typeof FORMS_ERROR_CODES)[number];
