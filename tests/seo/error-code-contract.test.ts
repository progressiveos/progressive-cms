// PCMS-SEO-T001 — machine-readable validation codes (SEO spec §70).
// The stable code surface is frozen so transports (M09) and agents can match
// on `code` forever: minor releases may append, never rename or reinterpret.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SEO_ERROR_CODES, type SeoErrorCode } from "@pcms/seo";

interface ErrorCodeContract {
  readonly contract: string;
  readonly spec: string;
  readonly rule: string;
  readonly seoCodes: readonly SeoErrorCode[];
}

const CONTRACT: ErrorCodeContract = JSON.parse(
  readFileSync("fixtures/seo/error-code-contract.json", "utf8"),
);

test("the shipped code registry matches the frozen contract fixture exactly", () => {
  assert.deepEqual([...SEO_ERROR_CODES].sort(), [...CONTRACT.seoCodes].sort());
});

test("every code follows the SEO_<CONDITION> shape", () => {
  for (const code of SEO_ERROR_CODES) {
    assert.match(code, /^SEO_[A-Z0-9_]+$/, code);
  }
});
