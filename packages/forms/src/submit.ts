// Public form submission orchestration (PCMS-FORM-T011; Forms spec §3/§8/§22/
// §23/§27/§28). Reliability invariant: validate → persist PostgreSQL domain
// state (submission + lead) → persist Outbox events → COMMIT. External
// delivery is NOT part of this transaction; an Integration Hub outage can
// never lose an accepted interaction. The generic Outbox payload carries
// routing-safe metadata only — no form payload, no PII (spec §27).
import { createHash } from "node:crypto";
import type { Clock, DbClient, DbPool } from "@pcms/core";
import { isStableId } from "@pcms/core";
import { parseAttribution } from "./attribution.js";
import { buildConsentSnapshot } from "./consent.js";
import { FormsError } from "./errors.js";
import { formSubmittedEvent, leadCreatedEvent } from "./events.js";
import { validateFormValues } from "./fields.js";
import {
  createFormDefinitionService,
  type FormDefinition,
  type FormDefinitionService,
  type FormSuccessBehavior,
} from "./form-definitions.js";
import { type CreateLeadInput, createLeadService, type LeadService } from "./leads.js";
import type { FormsOutboxPort } from "./ports.js";
import { renderLeadPresentation } from "./presentation.js";
import { createQuizDefinitionService, type QuizDefinitionService } from "./quiz-definitions.js";
import { createQuizRunService, type QuizRunService } from "./quiz-runs.js";
import {
  createFormSubmissionService,
  type FormSubmissionRecord,
  type FormSubmissionService,
} from "./submissions.js";

export interface PublicFormSubmitInput {
  readonly form_definition_id: string;
  /** Raw public values bag; unknown keys (incl. honeypot) never reach payload. */
  readonly values: unknown;
  /** Public duplicate-submit token (client-generated random). Optional but
   * recommended; bounded, stored hashed. */
  readonly submission_token?: string;
  readonly source_entry_id?: string;
  readonly source_url?: string;
  /** Anti-spam metadata — hashed before storage, never stored raw. */
  readonly submitter?: { readonly ip?: string | null; readonly user_agent?: string | null };
  /** MKT-010 client-declared attribution snapshot (allowlisted, server-
   * validated, never a proof of the ad source). Optional; absent on old
   * clients → the stored snapshot carries null attribution fields. */
  readonly attribution?: unknown;
}

export interface FormSubmissionResult {
  readonly submission_id: string;
  readonly status: "ACCEPTED" | "SPAM";
  readonly duplicate: boolean;
  readonly lead_id: string | null;
  /** Authoritative success behavior from the definition (spec §24). */
  readonly success: FormSuccessBehavior;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const MAX_TOKEN_LENGTH = 128;
const MAX_SOURCE_URL_LENGTH = 500;
const SUCCESS_MESSAGE_DEFAULT = "Thank you! Your message has been sent.";

function sourcePath(sourceUrl: string | null): string | null {
  if (sourceUrl === null) return null;
  try {
    const url = new URL(sourceUrl, "https://pcms.invalid");
    return url.protocol === "http:" || url.protocol === "https:" ? url.pathname : null;
  } catch {
    return null;
  }
}

function normalizeToken(token: string | undefined): string | null {
  if (token === undefined || token === "") return null;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new FormsError(
      "FORM_TOO_LARGE",
      `submission_token must be at most ${MAX_TOKEN_LENGTH} characters`,
    );
  }
  return sha256(token);
}

function resolvedSuccess(definition: FormDefinition): FormSuccessBehavior {
  return (
    definition.settings.success_behavior ?? { type: "message", message: SUCCESS_MESSAGE_DEFAULT }
  );
}

export interface FormsPublicService {
  submit(input: PublicFormSubmitInput): Promise<FormSubmissionResult>;
}

export interface FormsDomainServices {
  readonly definitions: FormDefinitionService;
  readonly submissions: FormSubmissionService;
  readonly quizzes: QuizDefinitionService;
  readonly runs: QuizRunService;
  readonly leads: LeadService;
}

export function createFormsDomainServices(pool: DbPool): FormsDomainServices {
  return {
    definitions: createFormDefinitionService(pool),
    submissions: createFormSubmissionService(pool),
    quizzes: createQuizDefinitionService(pool),
    runs: createQuizRunService(pool),
    leads: createLeadService(pool),
  };
}

export function createPublicFormService(
  pool: DbPool,
  deps: {
    readonly clock: Clock;
    readonly outbox: FormsOutboxPort;
    readonly domain: FormsDomainServices;
  },
): FormsPublicService {
  return {
    async submit(input) {
      const now = deps.clock.now();
      const definition = await deps.domain.definitions.getDefinition(input.form_definition_id);
      if (definition.status !== "ACTIVE") {
        throw new FormsError(
          "FORM_DEFINITION_NOT_FOUND",
          `form definition ${input.form_definition_id} is not available`,
        );
      }
      if (input.source_entry_id !== undefined && !isStableId(input.source_entry_id)) {
        throw new FormsError("FORM_VALUES_INVALID", "source_entry_id is malformed");
      }
      const attribution = parseAttribution(input.attribution, "form", definition.id);
      const bag =
        typeof input.values === "object" && input.values !== null && !Array.isArray(input.values)
          ? ({ ...(input.values as Record<string, unknown>) } as Record<string, unknown>)
          : undefined;
      if (bag === undefined) {
        throw new FormsError("FORM_VALUES_INVALID", "values must be an object");
      }

      // Layered anti-spam starts here: honeypot first (cheap, silent).
      const honeypotField = definition.settings.spam_policy?.honeypot_field;
      const honeypotValue = honeypotField === undefined ? undefined : bag[honeypotField];
      const spamReasons: string[] = [];
      if (honeypotField !== undefined) {
        delete bag[honeypotField];
        const filled =
          honeypotValue !== undefined &&
          honeypotValue !== null &&
          honeypotValue !== "" &&
          honeypotValue !== false &&
          !(Array.isArray(honeypotValue) && honeypotValue.length === 0);
        if (filled) spamReasons.push("honeypot");
      }

      // Server-side validation is authoritative; unknown fields rejected.
      const { values, consent_fields } =
        spamReasons.length > 0
          ? { values: {} as Record<string, unknown>, consent_fields: [] }
          : validateFormValues(definition.fields, bag);

      const consent_snapshot = buildConsentSnapshot(consent_fields, values, {
        acceptedAt: now,
        schemaVersion: definition.schema_version,
      });

      const tokenHash = normalizeToken(input.submission_token);
      const sourceUrl =
        input.source_url === undefined
          ? null
          : input.source_url.slice(0, MAX_SOURCE_URL_LENGTH) || null;

      // Replay before doing any work: the retry gets the original result.
      if (tokenHash !== null) {
        const existing = await deps.domain.submissions.findByToken(definition.id, tokenHash);
        if (existing) return replayResult(existing);
      }

      const outcome = await pool.withTransaction(async (tx) => {
        const { submission, duplicate } = await deps.domain.submissions.insertSubmission(
          {
            form_definition_id: definition.id,
            form_schema_version: definition.schema_version,
            status: spamReasons.length > 0 ? "SPAM" : "ACCEPTED",
            payload: values,
            consent_snapshot,
            source_entry_id: input.source_entry_id ?? null,
            source_url_snapshot: sourceUrl,
            submission_token_hash: tokenHash,
            submit_ip_hash: input.submitter?.ip ? sha256(input.submitter.ip) : null,
            user_agent: input.submitter?.user_agent
              ? input.submitter.user_agent.slice(0, 300)
              : null,
            spam_reasons: spamReasons,
            attribution,
          },
          { executor: tx, submittedAt: now },
        );
        if (duplicate) return replayResult(submission);
        if (submission.status === "SPAM") {
          // Accepted-as-spam: persisted for moderation, but NO business event,
          // NO lead — harvesters get nothing and Integration Hub sees nothing.
          return {
            submission_id: submission.id,
            status: "SPAM" as const,
            duplicate: false,
            lead_id: null,
            success: resolvedSuccess(definition),
          };
        }

        // Persist domain state first; events go into the SAME transaction.
        await deps.outbox.write(
          tx,
          formSubmittedEvent({
            submission_id: submission.id,
            form_definition_id: definition.id,
            form_schema_version: definition.schema_version,
            ...(input.source_entry_id !== undefined
              ? { source_entry_id: input.source_entry_id }
              : {}),
          }),
        );

        const lead = await createLeadFromSubmission(
          deps.domain.leads,
          definition,
          submission,
          tx,
          deps.outbox,
          sourcePath(sourceUrl),
          attribution,
        );
        return {
          submission_id: submission.id,
          status: "ACCEPTED" as const,
          duplicate: false,
          lead_id: lead?.lead_id ?? null,
          success: resolvedSuccess(definition),
        };
      });
      return outcome;
    },
  };
}

function replayResult(submission: FormSubmissionRecord): FormSubmissionResult {
  return {
    submission_id: submission.id,
    status: submission.status === "SPAM" ? "SPAM" : "ACCEPTED",
    duplicate: true,
    lead_id: null,
    success: { type: "message", message: SUCCESS_MESSAGE_DEFAULT },
  };
}

async function createLeadFromSubmission(
  leads: LeadService,
  definition: FormDefinition,
  submission: FormSubmissionRecord,
  tx: DbClient,
  outbox: FormsOutboxPort,
  sourceUrl: string | null,
  attribution: ReturnType<typeof parseAttribution>,
): Promise<{ lead_id: string } | null> {
  const policy = definition.settings.lead_policy;
  if (policy?.create_lead !== true) return null;
  const pick = (key: string | undefined): string | undefined => {
    if (key === undefined) return undefined;
    const value = submission.payload[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  // Readable representation of THIS submission (owner refinement): fixed
  // answers + definition labels, built once and stored immutably on the
  // lead. hidden_controlled stays excluded (service field); consent fields
  // surface the FACT of consent — a checked consent renders "yes", an
  // unchecked one is absent from the payload and skips its line. The source
  // page closes the presentation when the client sent one.
  const presentation = renderLeadPresentation({
    title: `Form "${definition.title}"`,
    entries: [
      ...definition.fields
        .filter((field) => field.type !== "hidden_controlled")
        .map((field) => ({ label: field.label, value: submission.payload[field.key] })),
      ...(sourceUrl ? [{ label: "Source", value: sourceUrl }] : []),
    ],
  });
  const input: CreateLeadInput = {
    source_type: "FORM_SUBMISSION",
    source_id: submission.id,
    attribution,
    name: pick(policy.name_from) ?? null,
    email: pick(policy.email_from) ?? null,
    phone: pick(policy.phone_from) ?? null,
    summary: pick(policy.summary_from) ?? `Form "${definition.title}"`,
    classification: policy.classification ?? null,
    presentation,
  };
  const { lead, created } = await leads.createLead(input, { executor: tx });
  if (created) {
    await outbox.write(
      tx,
      leadCreatedEvent({
        lead_id: lead.id,
        source_type: "FORM_SUBMISSION",
        source_id: submission.id,
        ...(policy.classification !== undefined ? { classification: policy.classification } : {}),
      }),
    );
  }
  return { lead_id: lead.id };
}
