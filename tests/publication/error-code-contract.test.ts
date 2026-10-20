// PCMS-PUB-T030 — error-code registry contract (Publication spec §72,
// owner instruction #61): the stable machine-code registries are frozen by
// fixture; minor releases append, never rename or reinterpret.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JOBS_ERROR_CODES } from "@pcms/jobs";
import { PUBLICATION_ERROR_CODES } from "@pcms/publication";
import { REVISION_ERROR_CODES } from "@pcms/revisions";

function loadFixture(path: string): { domain: string; rule: string; codes: string[] } {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("error-code registries match their frozen fixtures (append-only)", () => {
  const revisions = loadFixture("fixtures/revisions/error-code-contract.json");
  const publication = loadFixture("fixtures/publication/error-code-contract.json");
  const jobs = loadFixture("fixtures/jobs/error-code-contract.json");

  assert.deepEqual([...REVISION_ERROR_CODES].sort(), revisions.codes);
  assert.deepEqual([...PUBLICATION_ERROR_CODES].sort(), publication.codes);
  assert.deepEqual([...JOBS_ERROR_CODES].sort(), jobs.codes);
});

test("normative §72 codes are present verbatim in the publication registry", () => {
  const publication = loadFixture("fixtures/publication/error-code-contract.json");
  const revisions = loadFixture("fixtures/revisions/error-code-contract.json");
  for (const code of [
    "PUBLICATION_CONFLICT",
    "CHANGESET_STALE",
    "CHANGESET_INVALID",
    "ROUTE_CONFLICT",
    "SCHEDULE_CONFLICT",
    "SCHEDULE_IN_PAST",
    "JOB_ALREADY_COMPLETED",
  ]) {
    assert.ok(publication.codes.includes(code), `${code} in publication registry`);
  }
  for (const code of ["REVISION_NOT_WORKING", "REVISION_NOT_SEALED", "REVISION_STALE"]) {
    assert.ok(revisions.codes.includes(code), `${code} in revisions registry`);
  }
  assert.ok(revisions.codes.includes("MEDIA_NOT_READY"));
  assert.ok(publication.codes.includes("MEDIA_NOT_READY"));
});
