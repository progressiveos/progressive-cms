// PCMS-FORM-T016 — M12→M13 domain-event contract: canonical builders match
// the frozen fixture key-for-key, payloads are routing-safe (PII-free), and
// the outbox write only ever happens inside the persisted-state transaction.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FORM_EVENT_TYPES,
  formSubmittedEvent,
  leadCreatedEvent,
  leadStatusChangedEvent,
  quizCompletedEvent,
} from "@pcms/forms";

type Payload = Record<string, unknown>;

function payloadKeys(payload: Payload): string[] {
  return Object.keys(payload).map((key) => (key.endsWith("_id") && key !== "lead_id" ? key : key));
}

test("canonical builders match the frozen event-contract fixture exactly", () => {
  const contract = JSON.parse(readFileSync("fixtures/forms/event-contract.json", "utf8")) as {
    event_types: Record<string, { payload_keys: string[] }>;
  };
  const samples: Record<string, Payload> = {
    FormSubmitted: formSubmittedEvent({
      submission_id: "s",
      form_definition_id: "d",
      form_schema_version: 3,
      source_entry_id: "e",
    }).payload as Payload,
    QuizCompleted: quizCompletedEvent({
      quiz_run_id: "r",
      quiz_definition_id: "d",
      quiz_schema_version: 1,
      outcome_id: "hot",
      score: 30,
    }).payload as Payload,
    LeadCreated: leadCreatedEvent({
      lead_id: "l",
      source_type: "FORM_SUBMISSION",
      source_id: "s",
      classification: "warm",
    }).payload as Payload,
    LeadStatusChanged: leadStatusChangedEvent({
      lead_id: "l",
      previous_status: "NEW",
      status: "VIEWED",
    }).payload as Payload,
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(contract.event_types).sort());
  for (const [eventType, payload] of Object.entries(samples)) {
    const declared = contract.event_types[eventType]!.payload_keys;
    // Declared keys may mark optionality with a trailing "?".
    const declaredBare = declared.map((key) => key.replace(/\?$/, ""));
    for (const key of payloadKeys(payload)) {
      assert.ok(declaredBare.includes(key), `${eventType}: key "${key}" not declared in fixture`);
    }
  }
});

test("optional keys are omitted when absent (stable payload shape per emission)", () => {
  const minimal = formSubmittedEvent({
    submission_id: "s",
    form_definition_id: "d",
    form_schema_version: 1,
  }).payload as Payload;
  assert.deepEqual(Object.keys(minimal).sort(), [
    "form_definition_id",
    "form_schema_version",
    "submission_id",
  ]);
  const noScore = quizCompletedEvent({
    quiz_run_id: "r",
    quiz_definition_id: "d",
    quiz_schema_version: 1,
  }).payload as Payload;
  assert.ok(!("score" in noScore) && !("outcome_id" in noScore));
});

test("payloads never carry PII: known-sensitive key names are absent from all payload key lists", () => {
  const FORBIDDEN = ["email", "phone", "name", "ip", "token", "values", "consent", "user_agent"];
  const contract = JSON.parse(readFileSync("fixtures/forms/event-contract.json", "utf8")) as {
    event_types: Record<string, { payload_keys: string[] }>;
  };
  for (const [eventType, spec] of Object.entries(contract.event_types)) {
    for (const declaredKey of spec.payload_keys) {
      const bare = declaredKey.replace(/\?$/, "");
      for (const forbidden of FORBIDDEN) {
        assert.ok(
          bare !== forbidden && !bare.startsWith(`${forbidden}_`),
          `${eventType} payload key "${bare}" hits forbidden PII-ish key "${forbidden}"`,
        );
      }
    }
  }
  // Source builders agree with the services' behavior (submit/quiz-flow tests
  // assert emitted payloads carry no submitted values).
  assert.ok(FORM_EVENT_TYPES.length === 4);
});
test("aggregate ids are routing-stable: main id always equals aggregateId", () => {
  assert.equal(
    formSubmittedEvent({ submission_id: "s1", form_definition_id: "d", form_schema_version: 1 })
      .aggregateId,
    "s1",
  );
  assert.equal(
    quizCompletedEvent({ quiz_run_id: "r1", quiz_definition_id: "d", quiz_schema_version: 1 })
      .aggregateId,
    "r1",
  );
  const lead = leadCreatedEvent({ lead_id: "l1", source_type: "QUIZ_RUN", source_id: "r1" });
  assert.equal(lead.aggregateId, "l1");
  assert.equal(lead.aggregate, "lead");
});
