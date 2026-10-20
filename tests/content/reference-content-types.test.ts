// PCMS-CONT-T025 — reference Content Types + fixtures.
// Acceptance: all edge fixtures load/validate (Content spec §74).
// Types: page/service/case/news/article with minimum/full/long-title/
// empty-optionals/invalid edge payloads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateContentPayload } from "@pcms/content";
import { loadReferenceCorpus } from "../helpers/reference-corpus.js";

const corpus = loadReferenceCorpus();

test("all five reference Content Types register and are discoverable", () => {
  assert.deepEqual(
    corpus.registry.listContentTypes().map((schema) => schema.key),
    ["article", "case", "news", "page", "service"],
  );
});

test("every fixture loads and validates according to its expectation", () => {
  const outcomes: Array<{ name: string; ok: boolean; codes: string[] }> = [];
  for (const fixture of corpus.fixtures) {
    const schema = corpus.schemas.get(fixture.contentType);
    assert.ok(schema !== undefined, `fixture references unknown type ${fixture.contentType}`);
    const result = validateContentPayload(schema, fixture.fields, fixture.level);
    const ok = result.ok;
    outcomes.push({
      name: fixture.name,
      ok,
      codes: ok ? [] : result.errors.map((error) => error.code),
    });
    assert.equal(
      ok,
      fixture.expect === "valid",
      `fixture ${fixture.name}: expected ${fixture.expect}, got ${
        ok ? "valid" : JSON.stringify(result.errors.map((error) => [error.path, error.code]))
      }`,
    );
    if (fixture.expect === "invalid" && fixture.expectedCode !== undefined) {
      assert.ok(
        result.errors.some((error) => error.code === fixture.expectedCode),
        `fixture ${fixture.name}: expected code ${fixture.expectedCode}`,
      );
    }
  }
  // Edge-case coverage actually present (Content spec §74).
  const names = outcomes.map((outcome) => outcome.name);
  assert.ok(names.includes("page.minimum-valid"));
  assert.ok(names.includes("page.full"));
  assert.ok(names.includes("page.long-title"));
  assert.ok(names.includes("case.empty-optionals"));
  assert.ok(names.includes("service.float-money-invalid"));
  assert.ok(outcomes.length >= 10, `expected a substantial corpus, got ${outcomes.length}`);
});
