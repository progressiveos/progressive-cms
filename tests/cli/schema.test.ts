// PCMS-CONT-T027 (P1) — CLI diagnostics: schema list/show/validate.
// Acceptance: deterministic machine-readable output (Content spec §73).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "@pcms/cli";

const REFERENCE = "fixtures/content/reference-content-types.json";

test("cms schema list emits deterministic output, human and JSON", async () => {
  const human = await runCli(["schema", "list", "--file", REFERENCE]);
  assert.equal(human.exitCode, 0);
  assert.ok(human.stdout.includes("service@1"));
  assert.ok(human.stdout.includes("article@1"));

  const json = await runCli(["schema", "list", "--file", REFERENCE, "--json"]);
  assert.equal(json.exitCode, 0);
  const parsed = JSON.parse(json.stdout) as Array<{ key: string; version: number }>;
  assert.deepEqual(
    parsed.map((entry) => `${entry.key}@${entry.version}`),
    ["article@1", "case@1", "news@1", "page@1", "service@1"],
  );
  // Deterministic: same command → byte-identical output.
  const jsonAgain = await runCli(["schema", "list", "--file", REFERENCE, "--json"]);
  assert.equal(jsonAgain.stdout, json.stdout);
});

test("cms schema show returns the field descriptor map (latest or explicit version)", async () => {
  const shown = await runCli(["schema", "show", "service", "--file", REFERENCE, "--json"]);
  assert.equal(shown.exitCode, 0);
  const descriptor = JSON.parse(shown.stdout) as {
    key: string;
    version: number;
    fields: Record<string, { type: string }>;
  };
  assert.equal(descriptor.key, "service");
  assert.equal(descriptor.fields.price?.type, "money");

  const missing = await runCli(["schema", "show", "nope", "--file", REFERENCE]);
  assert.equal(missing.exitCode, 1);
  assert.ok(missing.stderr.includes("not found"));
});

test("cms schema validate checks a payload file with stable exit codes and JSON report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcms-schema-validate-"));
  const payloadPath = join(dir, "payload.json");
  try {
    writeFileSync(
      payloadPath,
      JSON.stringify({
        title: "Аудит",
        price: { amount: "125000.00", currency: "RUB" },
      }),
    );
    const valid = await runCli([
      "schema",
      "validate",
      "service",
      "--payload",
      payloadPath,
      "--level",
      "publish",
      "--file",
      REFERENCE,
      "--json",
    ]);
    assert.equal(valid.exitCode, 0);
    const report = JSON.parse(valid.stdout) as { ok: boolean; schema: string; level: string };
    assert.equal(report.ok, true);
    assert.equal(report.schema, "service@1");
    assert.equal(report.level, "publish");

    writeFileSync(payloadPath, JSON.stringify({ price: 42 }));
    const invalid = await runCli([
      "schema",
      "validate",
      "service",
      "--payload",
      payloadPath,
      "--level",
      "publish",
      "--file",
      REFERENCE,
      "--json",
    ]);
    assert.equal(invalid.exitCode, 1);
    const invalidReport = JSON.parse(invalid.stdout) as {
      ok: boolean;
      errors: Array<{ code: string; path: string }>;
    };
    assert.equal(invalidReport.ok, false);
    assert.ok(invalidReport.errors.some((error) => error.code === "FIELD_REQUIRED"));
    assert.ok(invalidReport.errors.some((error) => error.code === "TYPE_MISMATCH"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown subcommands exit with usage errors", async () => {
  assert.equal((await runCli(["schema"])).exitCode, 2);
  assert.equal((await runCli(["schema", "frobnicate", "--file", REFERENCE])).exitCode, 2);
});
