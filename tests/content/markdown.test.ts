// PCMS-CONT-T010 — Markdown import/export adapter for the RichText subset.
// Acceptance: semantic round-trip tests; raw HTML rejected by default
// (Content spec §16).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  containsRawHtml,
  markdownToRichText,
  type RichTextValidationResult,
  richTextToMarkdown,
  validateRichText,
} from "@pcms/content";

function ast(markdown: string): Record<string, unknown> {
  const result = markdownToRichText(markdown);
  assert.equal(result.ok, true, `fixture must parse: ${markdown}`);
  return result.ok ? (result.value as Record<string, unknown>) : {};
}

function codes(result: RichTextValidationResult): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

test("import: headings, lists, quotes, inline marks and links parse to canonical AST", () => {
  const markdown = [
    "## Услуги",
    "",
    "Мы делаем **аудит** и *внедрение*, см. [подробнее](https://example.com/audit).",
    "",
    "- Первый пункт",
    "- Второй пункт",
    "",
    "1. Шаг один",
    "2. Шаг два",
    "",
    "> Цитата клиента",
  ].join("\n");

  const document = ast(markdown);
  assert.deepEqual(codes(validateRichText(document)), []);
  const content = document.content as Array<Record<string, unknown>>;
  assert.equal(content[0]?.type, "heading");
  assert.equal(content[0]?.level, 2);
  const bulletList = content[2];
  assert.equal(bulletList?.type, "bullet_list");
  assert.equal((bulletList?.content as unknown[] | undefined)?.length, 2);
  assert.equal(content[3]?.type, "ordered_list");
  assert.equal(content[4]?.type, "blockquote");
});

test("raw HTML is rejected on import by default", () => {
  assert.deepEqual(codes(markdownToRichText("Hello <script>alert(1)</script>")), [
    "RICHTEXT_HTML_REJECTED",
  ]);
  assert.deepEqual(codes(markdownToRichText('<p style="color:red">x</p>')), [
    "RICHTEXT_HTML_REJECTED",
  ]);
  assert.deepEqual(codes(markdownToRichText("<img src=x onerror=alert(1)>")), [
    "RICHTEXT_HTML_REJECTED",
  ]);
  // A bare "<" followed by space is math text, not a tag.
  assert.equal(markdownToRichText("2 < 3 and 5 > 4").ok, true);
  assert.equal(containsRawHtml("2 < 3"), false);
  assert.equal(containsRawHtml("a<br/>"), true);
});

test("inline escapes survive: literal markers round-trip", () => {
  const document = ast("Цена \\*от\\* 100 `код` и \\[скобки\\]");
  const paragraph = (document.content as Array<Record<string, unknown>>)[0];
  const text = JSON.stringify(paragraph);
  assert.ok(text.includes("*от*"), "escaped asterisks become literal text");
  assert.ok(JSON.stringify(document).includes("code"), "backtick becomes code mark");
  assert.ok(text.includes("[скобки]"), "escaped brackets become literal text");
});

test("semantic round-trip: markdown → AST → markdown → AST is stable", () => {
  const markdown = [
    "# Заголовок",
    "",
    "Абзац с **жирным**, *курсивом*, `кодом` и [ссылкой](https://example.com/a).",
    "",
    "- один",
    "- два",
    "",
    "> Заметка",
  ].join("\n");

  const first = ast(markdown);
  const exported = richTextToMarkdown(first);
  const second = ast(exported);
  assert.deepEqual(second, first, "AST must be a fixed point of the round-trip");
  assert.equal(richTextToMarkdown(second), exported, "export is deterministic");
});

test("export rejects unsupported structural combinations explicitly", () => {
  // Valid AST shape but outside the v1 Markdown subset → explicit error, never
  // silent corruption.
  try {
    richTextToMarkdown({
      type: "document",
      content: [{ type: "table", content: [] }],
    });
    assert.fail("table export must throw");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "RICHTEXT_INVALID");
  }
});

test("empty and whitespace-only input produce a valid empty document", () => {
  const result = markdownToRichText("\n\n  \n");
  assert.deepEqual(codes(result), []);
  assert.deepEqual(result.ok ? result.value : null, {
    type: "document",
    schema_version: 2,
    content: [],
  });
});
