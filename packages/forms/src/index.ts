// @pcms/forms — Forms, Quizzes & Leads bounded context (M12).
//
// L1 rules (ADR-0005, tests/architecture.test.ts): this package imports
// @pcms/core only. PII-holding interaction state is persisted in PostgreSQL
// first; external delivery belongs to Integrations (M13) and happens
// asynchronously via the Outbox port. Deep imports ("@pcms/forms/src/…") are
// boundary violations (tests/architecture.test.ts).

export {
  type AbuseGuard,
  assertOriginAllowed,
  createAbuseGuard,
} from "./abuse.js";
export {
  type AttributionSnapshot,
  parseAttribution,
  UTM_KEYS,
  type UtmKey,
} from "./attribution.js";
export {
  type BlockRegistrar,
  definitionIdOfProps,
  INTERACTION_BLOCK_TYPES_V1,
  registerInteractionBlocks,
} from "./blocks.js";
export {
  type AnswerLookup,
  type BranchingDecision,
  evaluateCondition,
  type QuizAnswerValue,
  resolveNextStep,
} from "./branching.js";
export {
  buildConsentSnapshot,
  type ConsentDrift,
  type ConsentSnapshotEntry,
  verifyConsentSnapshot,
} from "./consent.js";
export { FORMS_ERROR_CODES, FormsError, type FormsErrorCode } from "./errors.js";
export {
  FORM_EVENT_TYPES,
  type FormEventType,
  type FormSubmittedEventPayload,
  formSubmittedEvent,
  type LeadCreatedEventPayload,
  type LeadStatusChangedEventPayload,
  leadCreatedEvent,
  leadStatusChangedEvent,
  type QuizCompletedEventPayload,
  quizCompletedEvent,
} from "./events.js";
export {
  createInteractionExportService,
  type ExportEntity,
  type ExportFormat,
  type ExportInput,
  type ExportResult,
  type FormsAuditEvent,
  type FormsAuditPort,
  type InteractionExportService,
} from "./export.js";
export {
  type FieldViolation,
  type ValidateFormValuesResult,
  validateFormValues,
} from "./fields.js";
export {
  type AddFormDefinitionVersionInput,
  type CreateFormDefinitionInput,
  createFormDefinitionService,
  FORM_FIELD_TYPE_INFO_V1,
  FORM_FIELD_TYPES_V1,
  type FormDefinition,
  type FormDefinitionService,
  type FormDefinitionSettings,
  type FormDefinitionVersionRecord,
  type FormFieldDefinition,
  type FormFieldPropertyKey,
  type FormFieldType,
  type FormFieldTypeDescriptor,
  type FormLeadPolicy,
  type FormRetentionPolicy,
  type FormSpamPolicy,
  type FormSuccessBehavior,
  validateFieldDefinition,
  validateSettings,
} from "./form-definitions.js";
export {
  type CreateLeadInput,
  createLeadService,
  LEAD_STATUSES,
  type LeadListFilter,
  type LeadRecord,
  type LeadService,
  type LeadSourceType,
  type LeadStatus,
} from "./leads.js";
export { PACKAGE_NAME } from "./package-name.js";
export type {
  FormsOutboxEventInput,
  FormsOutboxPort,
} from "./ports.js";
export { type PresentationEntry, renderLeadPresentation } from "./presentation.js";
export {
  createQuizDefinitionService,
  QUIZ_OPERATORS_V1,
  QUIZ_QUESTION_TYPES_V1,
  type QuizBranchCondition,
  type QuizBranchRule,
  type QuizDefinition,
  type QuizDefinitionService,
  type QuizDefinitionSettings,
  type QuizDefinitionVersionRecord,
  type QuizLeadPolicy,
  type QuizOperator,
  type QuizOutcome,
  type QuizQuestion,
  type QuizQuestionType,
  type QuizRetentionPolicy,
  type QuizScoringRule,
  type QuizStep,
  validateBranchingRules,
  validateOutcomes,
  validateQuizSteps,
  validateScoringRules,
} from "./quiz-definitions.js";
export {
  createPublicQuizService,
  type PublicQuizQuestion,
  type PublicQuizStep,
  type QuizAnswerInput,
  type QuizAnswerResult,
  type QuizCompleteResult,
  type QuizPublicService,
  type QuizStartInput,
  type QuizStartResult,
  type QuizTokenInput,
  validateAnswerValue,
} from "./quiz-flow.js";
export {
  createQuizRunService,
  type InsertQuizRunInput,
  QUIZ_RUN_STATES,
  type QuizAnswerRecord,
  type QuizRunRecord,
  type QuizRunService,
  type QuizRunState,
  type RunListFilter,
} from "./quiz-runs.js";
export {
  createRetentionService,
  type RetentionService,
  type RetentionSweepStats,
} from "./retention.js";
export { computeScore, resolveOutcome } from "./scoring.js";
export {
  createFormSubmissionService,
  FORM_SUBMISSION_STATUSES,
  type FormSubmissionRecord,
  type FormSubmissionService,
  type FormSubmissionStatus,
  type FormsExecutor,
  type InsertSubmissionInput,
  type SubmissionListFilter,
} from "./submissions.js";
export {
  createFormsDomainServices,
  createPublicFormService,
  type FormSubmissionResult,
  type FormsDomainServices,
  type FormsPublicService,
  type PublicFormSubmitInput,
} from "./submit.js";
