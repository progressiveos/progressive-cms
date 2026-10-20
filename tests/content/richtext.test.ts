// PCMS-CONT-T009 — RichText AST v2 schema + validator (v2-only).
//
// Acceptance: raw HTML rejected; `schema_version: 2` mandatory everywhere;
// canonical fixtures pass (Content spec §15/§16; owner decision
// CORE-RICHTEXT-V2-ONLY).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RICHTEXT_AST_VERSIONS,
  RICHTEXT_MAX_NODES,
  type RichTextValidationResult,
  validateRichText,
} from "@pcms/content";

function codes(result: RichTextValidationResult): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

const CANONICAL_ARTICLE = {
  schema_version: 2,
  type: "document",
  content: [
    { type: "heading", level: 2, content: [{ type: "text", text: "Услуги", marks: ["strong"] }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Мы проводим " },
        { type: "text", text: "аудит", marks: ["emphasis"] },
        { type: "text", text: " и " },
        { type: "text", text: "внедрение", marks: ["code"] },
        {
          type: "link",
          href: "https://example.com/audit",
          content: [{ type: "text", text: "подробнее" }],
        },
        { type: "text", text: "второй строкой", marks: ["strong", "emphasis"] },
        { type: "hard_break" },
        { type: "text", text: "…" },
      ],
    },
    {
      type: "bullet_list",
      content: [
        {
          type: "list_item",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Аудит" }] }],
        },
        {
          type: "list_item",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Внедрение" }] }],
        },
      ],
    },
    {
      type: "ordered_list",
      content: [
        {
          type: "list_item",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Шаг 1" }] }],
        },
      ],
    },
    {
      type: "blockquote",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Отзыв клиента" }] }],
    },
  ],
};

test("v2 is the only supported document version", () => {
  assert.deepEqual([...RICHTEXT_AST_VERSIONS], [2]);
});

test("canonical AST fixtures pass validation and round-trip unchanged", () => {
  const result = validateRichText(CANONICAL_ARTICLE);
  assert.deepEqual(codes(result), []);
  assert.deepEqual(result.ok ? result.value : null, CANONICAL_ARTICLE);
  const round = validateRichText(JSON.parse(JSON.stringify(CANONICAL_ARTICLE)));
  assert.deepEqual(round, { ok: true, value: CANONICAL_ARTICLE });
});

test("schema_version is mandatory: an unversioned v1 document is rejected", () => {
  const { schema_version: _drop, ...v1 } = CANONICAL_ARTICLE;
  const result = validateRichText(v1);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["RICHTEXT_VERSION_REQUIRED"]);
  assert.match(
    result.ok ? "" : (result.issues[0]?.message ?? ""),
    /schema_version.*2/,
    "the error must name the required version",
  );
});

test("schema_version must be exactly 2: 1, 3 and string forms are rejected", () => {
  for (const bad of [1, 3, "2", null, 2.5]) {
    const result = validateRichText({ ...CANONICAL_ARTICLE, schema_version: bad });
    assert.equal(result.ok, false, `schema_version ${JSON.stringify(bad)} must be rejected`);
    assert.deepEqual(codes(result), ["RICHTEXT_VERSION_UNSUPPORTED"]);
  }
});

test("raw HTML is not representable: strings and html blobs are rejected", () => {
  assert.deepEqual(codes(validateRichText("<p>Привет</p>")), ["RICHTEXT_DOCUMENT_REQUIRED"]);
  assert.deepEqual(codes(validateRichText("<script>alert(1)</script>")), [
    "RICHTEXT_DOCUMENT_REQUIRED",
  ]);
  assert.deepEqual(codes(validateRichText(null)), ["RICHTEXT_DOCUMENT_REQUIRED"]);
  assert.deepEqual(codes(validateRichText(42)), ["RICHTEXT_DOCUMENT_REQUIRED"]);
});

test("unknown nodes, marks and properties are rejected (no style/CSS escape hatch)", () => {
  const htmlNode = {
    schema_version: 2,
    type: "document",
    content: [{ type: "html", html: "<b>x</b>" }],
  };
  assert.deepEqual(codes(validateRichText(htmlNode)), ["RICHTEXT_NODE_UNKNOWN"]);

  const styled = {
    schema_version: 2,
    type: "document",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "x", style: "color: red" }],
      },
    ],
  };
  assert.deepEqual(codes(validateRichText(styled)), ["RICHTEXT_PROPERTY_UNKNOWN"]);

  const badMark = {
    schema_version: 2,
    type: "document",
    content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: ["underline"] }] }],
  };
  assert.deepEqual(codes(validateRichText(badMark)), ["RICHTEXT_MARK_UNKNOWN"]);

  const misplaced = {
    schema_version: 2,
    type: "document",
    content: [{ type: "text", text: "top-level text is not a block" }],
  };
  assert.deepEqual(codes(validateRichText(misplaced)), ["RICHTEXT_NODE_MISPLACED"]);

  const emptyText = {
    schema_version: 2,
    type: "document",
    content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
  };
  assert.deepEqual(codes(validateRichText(emptyText)), ["RICHTEXT_TEXT_EMPTY"]);
});

test("an empty text node with marks is rejected (marks cannot float without text)", () => {
  // Tiptap can emit `{text: "", marks: [...]}` transiently; it must never be
  // stored, because an empty leaf carries no content and would render as a
  // bare tag.
  for (const marks of [["strong"], ["emphasis"], ["code"], ["strong", "emphasis"]]) {
    const result = validateRichText({
      schema_version: 2,
      type: "document",
      content: [{ type: "paragraph", content: [{ type: "text", text: "", marks }] }],
    });
    assert.equal(result.ok, false, `empty text with ${marks.join("+")} must be rejected`);
    assert.ok(
      codes(result).includes("RICHTEXT_TEXT_EMPTY"),
      `expected RICHTEXT_TEXT_EMPTY for ${marks.join("+")}`,
    );
  }
});

test("link href policy: safe schemes only — no javascript:/data:", () => {
  const doc = (href: string): unknown => ({
    schema_version: 2,
    type: "document",
    content: [
      {
        type: "paragraph",
        content: [{ type: "link", href, content: [{ type: "text", text: "x" }] }],
      },
    ],
  });
  assert.deepEqual(validateRichText(doc("https://example.com")).ok, true);
  assert.deepEqual(validateRichText(doc("http://example.com/a")).ok, true);
  assert.deepEqual(validateRichText(doc("mailto:hi@example.com")).ok, true);
  assert.deepEqual(validateRichText(doc("/services/audit/")).ok, true);
  assert.deepEqual(validateRichText(doc("#anchor")).ok, true);

  for (const evil of ["javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "ftp://x"]) {
    const result = validateRichText(doc(evil));
    assert.equal(result.ok, false, `"${evil}" must be rejected`);
    assert.ok(codes(result).includes("RICHTEXT_HREF_REJECTED"));
  }
});

test("structure rules: list items need blocks, paragraphs take inline content", () => {
  const listWithText = {
    schema_version: 2,
    type: "document",
    content: [{ type: "bullet_list", content: [{ type: "text", text: "loose text" }] }],
  };
  assert.ok(codes(validateRichText(listWithText)).includes("RICHTEXT_NODE_MISPLACED"));

  const paragraphWithBlock = {
    schema_version: 2,
    type: "document",
    content: [{ type: "paragraph", content: [{ type: "paragraph", content: [] }] }],
  };
  assert.ok(codes(validateRichText(paragraphWithBlock)).includes("RICHTEXT_NODE_MISPLACED"));

  const badHeading = {
    schema_version: 2,
    type: "document",
    content: [{ type: "heading", level: 9, content: [{ type: "text", text: "x" }] }],
  };
  assert.ok(codes(validateRichText(badHeading)).includes("RICHTEXT_LEVEL_INVALID"));
});

test("bounded AST: depth and node limits reject pathological payloads", () => {
  // Depth bomb: nested blockquotes.
  let deep: Record<string, unknown> = {
    type: "paragraph",
    content: [{ type: "text", text: "core" }],
  };
  for (let i = 0; i < 64; i++) deep = { type: "blockquote", content: [deep] };
  const deepDoc = { schema_version: 2, type: "document", content: [deep] };
  assert.ok(codes(validateRichText(deepDoc)).includes("RICHTEXT_TOO_DEEP"));

  // Node bomb: many list items.
  const items = Array.from({ length: RICHTEXT_MAX_NODES + 1 }, () => ({
    type: "list_item",
    content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
  }));
  const bomb = {
    schema_version: 2,
    type: "document",
    content: [{ type: "bullet_list", content: items }],
  };
  assert.ok(codes(validateRichText(bomb)).includes("RICHTEXT_TOO_LARGE"));
});

test("v2-only nodes are valid: table, code block, separator", () => {
  const document = {
    schema_version: 2,
    type: "document",
    content: [
      { type: "horizontal_rule" },
      { type: "code_block", code: "const x = 1;", language: "ts" },
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [
              {
                type: "table_cell",
                header: "column",
                content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }],
              },
            ],
          },
          {
            type: "table_row",
            content: [
              {
                type: "table_cell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "v" }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(codes(validateRichText(document)), []);
});

test("image identity: media_id or src, exactly one; empty alt allowed in v2", () => {
  const doc = (image: Record<string, unknown>): unknown => ({
    schema_version: 2,
    type: "document",
    content: [{ type: "image", ...image }],
  });
  const media = "01900000-0000-7000-8000-000000000001";

  assert.deepEqual(codes(validateRichText(doc({ media_id: media, alt: "x" }))), []);
  assert.deepEqual(codes(validateRichText(doc({ src: "https://e.org/a.png", alt: "x" }))), []);
  // Decorative image: deliberate empty alt is part of the v2 contract.
  assert.deepEqual(codes(validateRichText(doc({ media_id: media, alt: "" }))), []);
  // Both sources at once is ambiguous.
  assert.ok(
    codes(
      validateRichText(doc({ media_id: media, src: "https://e.org/a.png", alt: "x" })),
    ).includes("RICHTEXT_IMAGE_SOURCE_CONFLICT"),
  );
  assert.ok(
    codes(validateRichText(doc({ media_id: "not-a-uuid", alt: "x" }))).includes(
      "RICHTEXT_MEDIA_INVALID",
    ),
  );
  assert.ok(codes(validateRichText(doc({ media_id: media }))).includes("RICHTEXT_ALT_REQUIRED"));
});
