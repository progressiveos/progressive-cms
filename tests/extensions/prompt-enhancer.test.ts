// Prompt Enhancer extension (PCMS-PRE-RESEARCH A4): OpenAI-compatible chat
// adapter with first-class reasoning control. Reasoning `off` must map to a
// REAL provider-specific disable — not one universal parameter — and the
// operation must never silently rewrite a prompt (caller previews).

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  applyReasoning,
  enhancePrompt,
  parseEnhancerResponse,
  readEnhanceConfig,
  resolveReasoningStyle,
} from "../../extensions/progressive-prompt-enhancer/src/index.js";

describe("reasoning wire mappings", () => {
  test("openai style: off maps to reasoning_effort none, levels pass through", () => {
    const body: Record<string, unknown> = {};
    applyReasoning(body, "off", "openai");
    assert.equal(body["reasoning_effort"], "none");
    applyReasoning(body, "low", "openai");
    assert.equal(body["reasoning_effort"], "low");
  });

  test("openrouter style: off maps to reasoning{enabled:false}", () => {
    const body: Record<string, unknown> = {};
    applyReasoning(body, "off", "openrouter");
    assert.deepEqual(body["reasoning"], { enabled: false });
    applyReasoning(body, "high", "openrouter");
    assert.deepEqual(body["reasoning"], { effort: "high" });
  });

  test("ollama style: off maps to reasoning_effort none (OpenAI-compat layer)", () => {
    const body: Record<string, unknown> = {};
    applyReasoning(body, "off", "ollama");
    assert.equal(body["reasoning_effort"], "none");
    assert.equal("reasoning" in body, false);
  });

  test("provider_default and style none send no reasoning fields", () => {
    for (const [level, style] of [
      ["provider_default", "openai"],
      ["provider_default", "openrouter"],
      ["off", "none"],
      ["high", "none"],
    ] as const) {
      const body: Record<string, unknown> = {};
      applyReasoning(body, level, style);
      assert.equal("reasoning" in body, false);
      assert.equal("reasoning_effort" in body, false);
    }
  });

  test("auto style guesses from base_url", () => {
    const base = (url: string) =>
      resolveReasoningStyle(readEnhanceConfig({ base_url: url, model: "m", api_key: "k" }));
    assert.equal(base("https://openrouter.ai/api/v1"), "openrouter");
    assert.equal(base("http://127.0.0.1:11434/v1"), "ollama");
    assert.equal(base("https://api.openai.com/v1"), "openai");
  });
});

describe("enhancePrompt operation", () => {
  let server: Server;
  let baseUrl = "";
  const seenBodies: unknown[] = [];

  before(async () => {
    server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        seenBodies.push(JSON.parse(raw));
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "Improved prompt: dramatic side light" } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("not configured → typed PROVIDER_NOT_CONFIGURED", async () => {
    await assert.rejects(
      enhancePrompt({
        input: { prompt: "x" },
        extension: { id: "progressive.prompt-enhancer", config: null },
      }),
      (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "PROVIDER_NOT_CONFIGURED",
    );
  });

  test("reasoning off reaches the wire as a real disable (auto→openai)", async () => {
    const result = await enhancePrompt({
      input: { prompt: "warehouse at dusk", context: "hero image for a construction site" },
      extension: {
        id: "progressive.prompt-enhancer",
        config: {
          base_url: baseUrl,
          model: "test-model",
          api_key: "sk-test",
          reasoning_level: "off",
          temperature: 0.5,
          max_output_tokens: 300,
        },
      },
    });
    assert.match(result.prompt, /Improved prompt/);
    assert.equal(result.model, "test-model");
    const body = seenBodies.at(-1) as Record<string, unknown>;
    assert.equal(body["reasoning_effort"], "none");
    assert.equal(body["temperature"], 0.5);
    assert.equal(body["max_tokens"], 300);
    const messages = body["messages"] as { role: string; content: string }[];
    assert.equal(messages[0]?.role, "system");
    assert.match(messages[1]?.content ?? "", /warehouse at dusk/);
    assert.match(messages[1]?.content ?? "", /construction site/);
  });

  test("openrouter-style endpoint gets reasoning{enabled:false}", async () => {
    await enhancePrompt({
      input: { prompt: "x" },
      extension: {
        id: "progressive.prompt-enhancer",
        config: {
          base_url: baseUrl,
          model: "m",
          api_key: "k",
          reasoning_level: "off",
          reasoning_style: "openrouter",
        },
      },
    });
    const body = seenBodies.at(-1) as Record<string, unknown>;
    assert.deepEqual(body["reasoning"], { enabled: false });
    assert.equal("reasoning_effort" in body, false);
  });
});

// ---- v2 (Image Generation v2 plan Ф5) --------------------------------------

test("bilingual response parser: strict JSON, JSON framed by prose, plain fallback", () => {
  const strict = parseEnhancerResponse(
    '{"prompt_en":"a cat in the rain","prompt_ru":"кот под дождём"}',
  );
  assert.equal(strict.prompt, "a cat in the rain");
  assert.equal(strict.promptRu, "кот под дождём");

  const framed = parseEnhancerResponse(
    'Sure! Here is the result:\n{"prompt_en":"a cat","prompt_ru":null}\nHope that helps.',
  );
  assert.equal(framed.prompt, "a cat");
  assert.equal(framed.promptRu, null);

  const plain = parseEnhancerResponse("a rainy cat, cinematic lighting");
  assert.equal(plain.prompt, "a rainy cat, cinematic lighting");
  assert.equal(plain.promptRu, null);

  // Broken JSON inside braces falls back to the raw text, not an error.
  const broken = parseEnhancerResponse('{"prompt_en": "unterminated');
  assert.equal(broken.prompt, '{"prompt_en": "unterminated');
});
