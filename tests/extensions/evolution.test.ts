// PCMS-EXT-T015 — Expand → migrate → contract helpers.
// Acceptance (Master Plan M14): expand in a minor passes, migrate passes,
// a contract-phase removal in an unsupported minor FAILS the compatibility
// gate, and removal in the promised major passes. The corpus fixture
// (fixtures/extensions/evolution-corpus.json) is clearly marked synthetic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertEvolutionPhaseAllowed,
  classifyEvolutionPhase,
  type EvolutionMetadata,
  ExtensionError,
} from "@pcms/extensions/internal";

interface CorpusFile {
  readonly description: string;
  readonly items: readonly (EvolutionMetadata & {
    readonly phases: Record<string, string>;
    readonly gates: Record<string, string>;
  })[];
}

const corpus = JSON.parse(
  readFileSync("fixtures/extensions/evolution-corpus.json", "utf8"),
) as CorpusFile;

const summaryField = corpus.items[0] as EvolutionMetadata;

test("corpus fixture is marked synthetic and carries the full phase map", () => {
  assert.match(corpus.description, /SYNTHETIC/);
  assert.equal(summaryField.item, "entry.field.summary");
  assert.equal(corpus.items[0]?.phases.at_1_1_0, "expand");
  assert.equal(corpus.items[0]?.phases.at_1_2_0, "migrate");
  assert.equal(corpus.items[0]?.phases.at_2_0_0, "contract");
});

test("phase classification is deterministic across the lifecycle", () => {
  assert.equal(classifyEvolutionPhase(summaryField, "1.1.0"), "expand");
  assert.equal(classifyEvolutionPhase(summaryField, "1.1.9"), "expand");
  assert.equal(classifyEvolutionPhase(summaryField, "1.2.0"), "migrate");
  assert.equal(classifyEvolutionPhase(summaryField, "1.5.3"), "migrate");
  assert.equal(classifyEvolutionPhase(summaryField, "2.0.0"), "contract");
});

test("expand and migrate phases pass the minor compatibility gate", () => {
  assert.doesNotThrow(() =>
    assertEvolutionPhaseAllowed(summaryField, {
      phase: "expand",
      targetVersion: "1.1.0",
      isMajorRelease: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertEvolutionPhaseAllowed(summaryField, {
      phase: "migrate",
      targetVersion: "1.2.0",
      isMajorRelease: false,
    }),
  );
});

test("contract removal in an unsupported minor FAILS the compatibility gate", () => {
  assert.throws(
    () =>
      assertEvolutionPhaseAllowed(summaryField, {
        phase: "contract",
        targetVersion: "1.5.0",
        isMajorRelease: false,
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "UPDATE_COMPATIBILITY_BLOCKED",
  );
});

test("contract removal in the promised major passes; earlier majors fail", () => {
  assert.doesNotThrow(() =>
    assertEvolutionPhaseAllowed(summaryField, {
      phase: "contract",
      targetVersion: "2.0.0",
      isMajorRelease: true,
    }),
  );
  assert.throws(
    () =>
      assertEvolutionPhaseAllowed(summaryField, {
        phase: "contract",
        targetVersion: "1.9.9",
        isMajorRelease: true,
      }),
    (error: unknown) =>
      error instanceof ExtensionError && error.code === "UPDATE_COMPATIBILITY_BLOCKED",
  );
});

test("contract phase without promised major metadata is rejected outright", () => {
  assert.throws(
    () =>
      assertEvolutionPhaseAllowed(
        { ...summaryField, contract_in_major: undefined },
        { phase: "contract", targetVersion: "2.0.0", isMajorRelease: true },
      ),
    (error: unknown) => error instanceof ExtensionError,
  );
});

test("corpus-declared gate expectations match the executable gates", () => {
  // The fixture's declared expectations must never drift from the gates.
  assert.equal(corpus.items[0]?.gates.expand_in_minor_1_1_0, "pass");
  assert.equal(corpus.items[0]?.gates.migrate_in_minor_1_2_0, "pass");
  assert.equal(corpus.items[0]?.gates.contract_in_minor_1_5_0, "fail");
  assert.equal(corpus.items[0]?.gates.contract_in_promised_major_2_0_0, "pass");
});
