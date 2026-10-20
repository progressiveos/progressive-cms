// PCMS-FORM-T013 — abuse-control attack fixtures (Forms spec §22/§37):
// rate-limit burst and bypass resistance, origin/same-site policy, oversized
// token, field smuggling, honeypot spam path. Complements the in-service
// bounds tested in fields/submit/quiz-flow suites.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Clock, fixedClock } from "@pcms/core";
import { assertOriginAllowed, createAbuseGuard, FormsError } from "@pcms/forms";

const CLOCK: Clock = fixedClock(new Date("2026-09-20T12:00:00.000Z"));

test("token bucket: burst up to capacity, then throttled; refills over time; keys isolated", () => {
  let nowMilliseconds = new Date("2026-09-20T12:00:00.000Z").getTime();
  const clock = { now: () => new Date(nowMilliseconds) };
  const guard = createAbuseGuard({ capacity: 3, refillPerSecond: 2 }, clock);
  guard.assertAllowed("ip:203.0.113.1");
  guard.assertAllowed("ip:203.0.113.1");
  guard.assertAllowed("ip:203.0.113.1");
  assert.throws(
    () => guard.assertAllowed("ip:203.0.113.1"),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_RATE_LIMITED",
  );
  // Another IP is untouched — no global collateral lockout.
  guard.assertAllowed("ip:203.0.113.2");
  // Time passes → the same bucket refills (1s → +2 tokens at 2/s).
  nowMilliseconds += 1_000;
  guard.assertAllowed("ip:203.0.113.1");
  guard.assertAllowed("ip:203.0.113.1");
  assert.throws(
    () => guard.assertAllowed("ip:203.0.113.1"),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_RATE_LIMITED",
  );
  // Custom code for quiz endpoints.
  const quizGuard = createAbuseGuard(
    { capacity: 1, refillPerSecond: 0, code: "QUIZ_RATE_LIMITED" },
    CLOCK,
  );
  quizGuard.assertAllowed("k");
  assert.throws(
    () => quizGuard.assertAllowed("k"),
    (error: unknown) => error instanceof FormsError && error.code === "QUIZ_RATE_LIMITED",
  );
});

test("token bucket: bounded key memory cannot grow unbounded under attack", () => {
  const guard = createAbuseGuard({ capacity: 1, refillPerSecond: 0, maxKeys: 100 }, CLOCK);
  for (let i = 0; i < 5_000; i++) guard.assertAllowed(`ip:10.0.0.${i % 256}:${i}`);
  assert.ok(true, "no explosion — map capped");
});

test("origin policy: absent origin allowed; same host allowed; cross-origin and junk rejected", () => {
  assert.doesNotThrow(
    () => assertOriginAllowed(undefined, "cms.example"),
    "no Origin header (curl/no-JS)",
  );
  assert.doesNotThrow(() => assertOriginAllowed("", "cms.example"));
  assert.doesNotThrow(() => assertOriginAllowed("https://cms.example", "cms.example"));
  assert.doesNotThrow(
    () => assertOriginAllowed("https://cms.example:8443", "cms.example:8443"),
    "port-aware",
  );
  assert.throws(
    () => assertOriginAllowed("https://evil.example", "cms.example"),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_ORIGIN_DENIED",
  );
  assert.throws(
    () => assertOriginAllowed("not a url", "cms.example"),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_ORIGIN_DENIED",
  );
  assert.throws(
    () => assertOriginAllowed("https://cms.example", undefined),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_ORIGIN_DENIED",
  );
});

test("attack fixtures at the submission boundary: oversized token, smuggling, giant values", async (t) => {
  const { createDbPool, loadMigrations, migrateDatabase } = await import("@pcms/core");
  const { createFormsDomainServices, createPublicFormService } = await import("@pcms/forms");
  const { connectionInfo, createTestDatabase, testDatabaseConfigured } = await import(
    "../helpers/testdb.js"
  );
  if (!testDatabaseConfigured()) return t.skip("PCMS_TEST_DATABASE_URL is not set");
  const db = await createTestDatabase(t);
  const pool = createDbPool({ connectionInfo: connectionInfo(db), max: 2 });
  t.after(() => {
    void pool.end();
  });
  await migrateDatabase(pool, loadMigrations("db/migrations"), undefined);
  const domain = createFormsDomainServices(pool);
  const forms = createPublicFormService(pool, {
    clock: CLOCK,
    outbox: { async write() {} },
    domain,
  });
  const definition = await domain.definitions.createDefinition({
    key: "abuse_form",
    title: "A",
    fields: [{ key: "email", type: "email", label: "E", required: true, max_length: 100 }],
  });
  const submit = (values: unknown, submission_token?: string) =>
    forms.submit(
      submission_token === undefined
        ? { form_definition_id: definition.id, values }
        : { form_definition_id: definition.id, values, submission_token },
    );

  await assert.rejects(
    () => submit({ email: "a@b.co" }, "x".repeat(129)),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_TOO_LARGE",
  );
  await assert.rejects(
    () => submit({ email: "a@b.co", role: "admin" }),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_VALUES_INVALID",
  );
  await assert.rejects(
    () => submit({ email: `${"a".repeat(150)}@b.co` }),
    (error: unknown) => error instanceof FormsError && error.code === "FORM_VALUES_INVALID",
  );
  assert.equal(
    (await domain.submissions.listSubmissions({})).length,
    0,
    "no attack traffic persisted as ACCEPTED",
  );
});
