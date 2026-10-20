// PCMS-EXT-T009 — Explicit validator extension points.
// Acceptance (Master Plan M14): typed registry, deterministic order, no
// generic hook, disabled extension contribution absent. The point adapts to
// the existing M07 structural PublicationValidator pipeline via composition
// (validators stay plain data + functions; no monkey patching).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createValidatorExtensionPoint,
  ExtensionError,
  type ValidatorPointContribution,
} from "@pcms/extensions/internal";

interface PublicationIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

test("point runs enabled contributions in deterministic order (no generic hook)", () => {
  // Only ENABLED extensions' contributions are composed in — a disabled one
  // is never registered, so it cannot contribute issues.
  const point = createValidatorExtensionPoint<{ readonly title: string }, PublicationIssue>({
    name: "publication",
    contractVersion: "1.0.0",
  });
  point.register({
    extensionId: "com.example.zeta",
    validatorId: "title-length",
    validate: (input) =>
      input.title.length > 10
        ? [{ code: "TITLE_TOO_LONG", severity: "error", message: "title too long" }]
        : [],
  });
  point.register({
    extensionId: "com.example.alpha",
    validatorId: "banner-required",
    validate: (input) =>
      input.title === ""
        ? [{ code: "TITLE_EMPTY", severity: "warning", message: "empty title" }]
        : [],
  });
  const contributions = point
    .contributions()
    .map((entry) => `${entry.extensionId}/${entry.validatorId}`);
  assert.deepEqual(contributions, [
    "com.example.alpha/banner-required",
    "com.example.zeta/title-length",
  ]);

  assert.deepEqual(point.run({ title: "ok" }), []);
  const issues = point.run({ title: "a-very-long-title-indeed" });
  assert.deepEqual(issues, [
    { code: "TITLE_TOO_LONG", severity: "error", message: "title too long" },
  ]);
});

test("duplicate contribution identity collides instead of overriding", () => {
  const point = createValidatorExtensionPoint<{ title: string }, PublicationIssue>({
    name: "publication",
    contractVersion: "1.0.0",
  });
  const contribution: ValidatorPointContribution<{ title: string }, PublicationIssue> = {
    extensionId: "com.example.dup",
    validatorId: "same",
    validate: () => [],
  };
  point.register(contribution);
  assert.throws(
    () =>
      point.register({
        ...contribution,
        validate: () => [{ code: "X", severity: "error", message: "replaced" }],
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_REGISTRATION_CONFLICT",
  );
});

test("contributions must be plain functions — no paths, no dynamic handlers", () => {
  const point = createValidatorExtensionPoint<{ title: string }, PublicationIssue>({
    name: "theme",
    contractVersion: "1.0.0",
  });
  assert.throws(
    () =>
      point.register({
        extensionId: "com.example.broken",
        validatorId: "no-fn",
        validate: "not-a-function" as unknown as () => [],
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "EXTENSION_HANDLER_UNRESOLVED",
  );
});

test("disabled extension contributes nothing to the point", () => {
  const point = createValidatorExtensionPoint<{ title: string }, PublicationIssue>({
    name: "publication",
    contractVersion: "1.0.0",
  });
  // Composition registers ONLY enabled extensions' handlers; the disabled
  // extension's validate function is never passed in.
  point.register({
    extensionId: "com.example.enabled-only",
    validatorId: "v1",
    validate: () => [],
  });
  assert.deepEqual(
    point.contributions().map((entry) => entry.extensionId),
    ["com.example.enabled-only"],
  );
});

test("point name and contract version are part of the typed identity", () => {
  const point = createValidatorExtensionPoint<{ title: string }, PublicationIssue>({
    name: "publication",
    contractVersion: "1.0.0",
  });
  assert.equal(point.name, "publication");
  assert.equal(point.contractVersion, "1.0.0");
});
