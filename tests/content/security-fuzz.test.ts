// PCMS-CONT-T029 — security/fuzz/property tests for parsers, limits and
// formula/URL validation.
// Acceptance: bounded invalid input cannot panic or escape policy
// (Content spec §72; Master Plan security gates).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBlockRegistry,
  evaluateFormulaText,
  newBlockId,
  parseFormula,
  registerFirstPartyBlocksV1,
  validateBlockDocument,
} from "@pcms/blocks";
import {
  createContentTypeRegistry,
  defineObjectSchema,
  type LoadedContentType,
  MAX_SCHEMA_DEPTH,
  markdownToRichText,
  validateContentPayload,
  validateRichText,
  validateStructuredValue,
} from "@pcms/content";
import { renderRichText } from "@pcms/themes";

/** Deterministic LCG so failures reproduce exactly. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

const FUZZ_ALPHABET = "0123456789abcXYZ+-*/%^().,;'\"!?<>{}[]&|$#@~` \t\n\\_:éüпривет";

function fuzzString(random: () => number, maxLength: number): string {
  const length = Math.floor(random() * maxLength);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)];
  }
  return out;
}

test("formula parser fuzz: arbitrary input never throws, only returns issues", () => {
  const random = makeRandom(42);
  for (let round = 0; round < 500; round++) {
    const input = fuzzString(random, 120);
    const parsed = parseFormula(input);
    if (parsed.ok) {
      // A parsed formula must evaluate to a finite number or a clean issue.
      const evaluated = evaluateFormulaText(input, {});
      assert.ok(
        evaluated.ok || "issue" in evaluated,
        `parsed formula "${input}" must evaluate without throwing`,
      );
      if (evaluated.ok) {
        assert.ok(
          Number.isFinite(evaluated.value),
          `formula "${input}" produced a non-finite value`,
        );
      }
    }
  }
});

test("formula bombs stay bounded: deep nesting and long inputs rejected, not crashed", () => {
  for (const bomb of [
    "(".repeat(5_000) + "1" + ")".repeat(5_000),
    "1+".repeat(20_000) + "1",
    "-".repeat(50_000) + "1",
    "1 ^ ".repeat(10_000) + "1",
  ]) {
    const result = evaluateFormulaText(bomb, {});
    assert.equal(result.ok, false, "a bomb must be rejected");
    assert.match(result.ok ? "" : result.issue.code, /^CALC_/);
  }
});

test("schema depth bomb is bounded (SCHEMA_TOO_DEEP)", () => {
  let schema: Parameters<typeof defineObjectSchema>[0][string] = { id: "leaf", type: "string" };
  for (let i = 0; i < MAX_SCHEMA_DEPTH + 10; i++) {
    schema = { id: `obj_${i}`, type: "object", fields: { inner: schema } };
  }
  assert.throws(
    () => defineObjectSchema({ deep: schema }),
    (error: unknown) => (error as { code?: string }).code === "SCHEMA_TOO_DEEP",
  );
});

test("rich text fuzz: random structures never throw; HTML/JS injection rejected", () => {
  const random = makeRandom(7);
  for (let round = 0; round < 300; round++) {
    const junk: unknown =
      fuzzString(random, 80) === ""
        ? null
        : {
            type: fuzzString(random, 10),
            content: fuzzString(random, 40),
            href: fuzzString(random, 20),
          };
    assert.doesNotThrow(() => validateRichText(junk));
  }
  for (const hostile of [
    "javascript:alert(document.cookie)",
    "jAvAsCrIpT:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
  ]) {
    const doc = {
      schema_version: 2,
      type: "document",
      content: [
        {
          type: "paragraph",
          content: [{ type: "link", href: hostile, content: [{ type: "text", text: "x" }] }],
        },
      ],
    };
    const result = validateRichText(doc);
    assert.equal(result.ok, false, `"${hostile}" must be rejected`);
  }
});

test("action URLs: javascript: scheme cannot enter typed actions", () => {
  const registry = createBlockRegistry();
  registerFirstPartyBlocksV1(registry);
  const block = (props: Record<string, unknown>): unknown => ({
    schema_version: 1,
    blocks: [
      { id: newBlockId(), type: "cta", schema_version: 1, variant: null, props, children: [] },
    ],
  });
  for (const evil of ["javascript:alert(1)", "data:text/html,x", "  javascript:alert(1)"]) {
    const result = validateBlockDocument(
      block({ title: "x", primary_action: { type: "external_url", url: evil } }),
      registry,
    );
    assert.equal(result.ok, false, `"${evil}" must be rejected`);
  }
});

test("markdown import fuzz: raw HTML never parses into the AST", () => {
  const random = makeRandom(11);
  for (let round = 0; round < 300; round++) {
    const input = fuzzString(random, 100);
    assert.doesNotThrow(() => markdownToRichText(input));
  }
  for (const injection of [
    "<img src=x onerror=alert(1)>",
    "<svg onload=alert(1)>",
    "</p><script>alert(1)</script>",
  ]) {
    const result = markdownToRichText(injection);
    assert.equal(result.ok, false, `"${injection}" must not import`);
    assert.ok(result.issues.some((issue) => issue.code === "RICHTEXT_HTML_REJECTED"));
  }
  const literal = markdownToRichText("text with <iframe src=//evil> embedded");
  assert.equal(literal.ok, true);
  if (literal.ok) {
    const html = renderRichText(literal.value).html;
    assert.match(html, /&lt;iframe src=\/\/evil&gt;/);
    assert.doesNotMatch(html, /<iframe/);
  }
});

test("payload validation fuzz: junk payloads cannot crash the validator", () => {
  const registry = createContentTypeRegistry();
  const service: LoadedContentType = registry.registerContentType({
    key: "service",
    version: 1,
    title: "Услуга",
    fields: {
      title: { id: "title", type: "string", required: true },
      price: { id: "price", type: "money" },
      features: {
        id: "features",
        type: "repeater",
        item: { fields: { name: { id: "name", type: "string" } } },
      },
    },
  });
  const random = makeRandom(99);
  for (let round = 0; round < 300; round++) {
    const junk: unknown = {
      title: random() > 0.5 ? fuzzString(random, 30) : random(),
      price:
        random() > 0.5
          ? fuzzString(random, 10)
          : { amount: fuzzString(random, 5), currency: "RUB" },
      features: Array.from({ length: Math.floor(random() * 5) }, () => ({
        itemId: fuzzString(random, 8),
        name: fuzzString(random, 10),
        rogue: random(),
      })),
      extensions: random() > 0.7 ? fuzzString(random, 10) : { "ok.ns": 1 },
    };
    assert.doesNotThrow(() => validateContentPayload(service, junk, "publish"));
  }
});

test("repeater item flood is capped; determinism property holds across runs", () => {
  const registry = createContentTypeRegistry();
  const service: LoadedContentType = registry.registerContentType({
    key: "flood",
    version: 1,
    title: "Поток",
    fields: {
      rows: {
        id: "rows",
        type: "repeater",
        item: { fields: { name: { id: "name", type: "string" } } },
      },
    },
  });
  const flood = Array.from({ length: 5000 }, () => ({ itemId: newBlockId(), name: "x" }));
  const rowsSchema = service.fieldSchema.fields.rows;
  assert.ok(rowsSchema !== undefined);
  const result = validateStructuredValue(rowsSchema, flood);
  assert.equal(result.ok, false);

  // Property: evaluating the same formula 100 times yields the identical value.
  const first = evaluateFormulaText("round(area * 2.5 + max(1, 2, 3), 2)", { area: 7.77 });
  assert.ok(first.ok);
  for (let run = 0; run < 100; run++) {
    const again = evaluateFormulaText("round(area * 2.5 + max(1, 2, 3), 2)", { area: 7.77 });
    assert.deepEqual(again, first);
  }
});
