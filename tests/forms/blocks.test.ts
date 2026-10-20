// PCMS-FORM-T014 — `form`/`quiz` block registration through the M02 registry
// extension point (Content spec §35, Forms spec §25): structured definition
// references, strict prop schemas, document validation integration.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBlockRegistry, validateBlockDocument } from "@pcms/blocks";
import { type BlockRegistrar, definitionIdOfProps, registerInteractionBlocks } from "@pcms/forms";

const FORM_ID = "01970000-0000-7000-8000-0000000000f1";
const QUIZ_ID = "01970000-0000-7000-8000-0000000000f2";

function registryWithInteractionBlocks() {
  const registry = createBlockRegistry();
  registerInteractionBlocks(registry as unknown as BlockRegistrar);
  return registry;
}

test("form@1 and quiz@1 register through the real M02 registry", () => {
  const registry = registryWithInteractionBlocks();
  assert.equal(registry.getLatestBlockType("form")?.schemaVersion, 1);
  assert.equal(registry.getLatestBlockType("quiz")?.schemaVersion, 1);
});

test("double registration is rejected loudly (append-only registry discipline)", () => {
  const registry = registryWithInteractionBlocks();
  assert.throws(() => registerInteractionBlocks(registry as unknown as BlockRegistrar));
});

test("block documents with form/quiz blocks validate; unknown props and bad ids are rejected", () => {
  const registry = registryWithInteractionBlocks();
  const ok = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        {
          id: FORM_ID,
          type: "form",
          schema_version: 1,
          variant: null,
          props: { form_definition_id: FORM_ID },
          children: [],
        },
        {
          id: QUIZ_ID,
          type: "quiz",
          schema_version: 1,
          variant: null,
          props: { quiz_definition_id: QUIZ_ID, presentation_hint: "compact" },
          children: [],
        },
      ],
    },
    registry,
  );
  assert.equal(ok.ok, true);

  const smuggled = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        {
          id: FORM_ID,
          type: "form",
          schema_version: 1,
          variant: null,
          props: { form_definition_id: FORM_ID, action: "https://evil.example" },
          children: [],
        },
      ],
    },
    registry,
  );
  assert.equal(smuggled.ok, false, "no opaque handlers or extra props can be smuggled in");

  const badId = validateBlockDocument(
    {
      schema_version: 1,
      blocks: [
        {
          id: FORM_ID,
          type: "form",
          schema_version: 1,
          variant: null,
          props: { form_definition_id: "<script>alert(1)</script>" },
          children: [],
        },
      ],
    },
    registry,
  );
  assert.equal(badId.ok, false, "injection payloads cannot masquerade as definition refs");
});

test("definitionIdOfProps extracts the referenced definition id safely", () => {
  assert.equal(definitionIdOfProps("form", { form_definition_id: FORM_ID }), FORM_ID);
  assert.equal(definitionIdOfProps("quiz", { quiz_definition_id: QUIZ_ID }), QUIZ_ID);
  assert.equal(definitionIdOfProps("form", { form_definition_id: "javascript:void(0)" }), null);
  assert.equal(definitionIdOfProps("text", {}), null);
});
