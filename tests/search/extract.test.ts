// PCMS-SEARCH-T002 — semantic extraction: RichText AST, BlockDocument and
// schema-hinted fields must produce weighted plain text; code/formulas/
// internal ids/presentation metadata must never enter the corpus (Search
// spec §5/§6). Pure tests — no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockDocumentToText,
  extractSearchText,
  richtextImageAltText,
  richtextToPlainText,
  type SearchExtractionInput,
} from "@pcms/search";

const doc = (content: unknown[]): unknown => ({ type: "document", content });

test("richtext walker collects text leaves across nesting", () => {
  const ast = doc([
    {
      type: "heading",
      level: 2,
      content: [
        { type: "text", text: "Заголовок" },
        { type: "text", text: "раздела", marks: ["strong"] },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Обычный " },
        {
          type: "link",
          href: "https://example.com",
          content: [{ type: "text", text: "текст ссылки" }],
        },
      ],
    },
    {
      type: "bullet_list",
      content: [{ type: "list_item", content: [{ type: "text", text: "пункт" }] }],
    },
  ]);
  assert.equal(richtextToPlainText(ast), "Заголовок раздела Обычный текст ссылки пункт");
});

test("richtext walker is bounded against pathological nesting", () => {
  let deep: unknown = { type: "text", text: "inner" };
  for (let i = 0; i < 100; i += 1) deep = { type: "paragraph", content: [deep] };
  assert.equal(richtextToPlainText(deep), "");
  assert.equal(richtextToPlainText(null), "");
});

test("RichText v2 tables and captions are searchable; code stays excluded and image alt is auxiliary", () => {
  const tableDocument = {
    type: "document",
    schema_version: 2,
    content: [
      {
        type: "table",
        caption: [{ type: "text", text: "Quarterly summary" }],
        content: [
          {
            type: "table_row",
            content: [
              {
                type: "table_cell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Product" }] }],
              },
              {
                type: "table_cell",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Cellular manufacturing" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { type: "code_block", code: "private API key" },
      { type: "image", media_id: "00000000-0000-7000-8000-000000000001", alt: "Factory floor" },
    ],
  };
  const extracted = extractSearchText({
    fields: { title: "Search test", body: tableDocument },
    fieldSchema: { fields: { title: { type: "string" }, body: { type: "rich_text" } } },
    bodyPolicy: "none",
  });
  assert.match(extracted.bodyText, /Quarterly summary/);
  assert.match(extracted.bodyText, /Cellular manufacturing/);
  assert.match(extracted.auxText, /Factory floor/);
  assert.ok(!JSON.stringify(extracted).includes("private API key"));
  assert.ok(!JSON.stringify(extracted).includes("00000000-0000-7000"));
  assert.equal(richtextImageAltText(tableDocument), "Factory floor");
});

function blocksOf(...blocks: unknown[]): unknown {
  return { schemaVersion: 1, blocks };
}
const rt = (text: string): unknown => ({
  type: "document",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

test("block walker includes FAQ, timeline, documents as body; CTA/gallery/alt as aux", () => {
  const result = blockDocumentToText(
    blocksOf(
      {
        id: "b1",
        type: "text",
        schemaVersion: 1,
        variant: null,
        props: { rich_text: rt("Первый абзац") },
        children: [],
      },
      {
        id: "b2",
        type: "faq",
        schemaVersion: 1,
        variant: null,
        props: { items: [{ id: "q1", question: "Как оплатить?", answer: rt("По счёту") }] },
        children: [],
      },
      {
        id: "b3",
        type: "timeline",
        schemaVersion: 1,
        variant: null,
        props: {
          title: "История компании",
          items: [{ id: "t1", date_text: "2010", title: "Основание", text: rt("Первый офис") }],
        },
        children: [],
      },
      {
        id: "b4",
        type: "documents",
        schemaVersion: 1,
        variant: null,
        props: {
          title: "Документы",
          items: [{ id: "d1", media_id: "m1", display_title: "Коммерческое предложение" }],
        },
        children: [],
      },
      {
        id: "b5",
        type: "cta",
        schemaVersion: 1,
        variant: null,
        props: { title: "Оставить заявку", text: rt("Заполните форму") },
        children: [],
      },
      {
        id: "b6",
        type: "image",
        schemaVersion: 1,
        variant: null,
        props: { media_id: "m2", alt_override: "чертёж станка", caption: null },
        children: [],
      },
    ),
  );
  assert.match(result.body, /Первый абзац/);
  assert.match(result.body, /Как оплатить\?/);
  assert.match(result.body, /По счёту/);
  assert.match(result.body, /История компании/);
  assert.match(result.body, /Коммерческое предложение/);
  assert.match(result.aux, /Оставить заявку/);
  assert.match(result.aux, /чертёж станка/);
});

test("block walker never indexes code payloads, calculator formulas or media/reference ids", () => {
  const result = blockDocumentToText(
    blocksOf(
      {
        id: "c1",
        type: "code",
        schemaVersion: 1,
        variant: null,
        props: { language: "ts", code: "process.env.SECRET = 'x'; DROP TABLE users;" },
        children: [],
      },
      {
        id: "c2",
        type: "calculator",
        schemaVersion: 1,
        variant: null,
        props: { formula: "price*1.2" },
        children: [],
      },
      {
        id: "c3",
        type: "map",
        schemaVersion: 1,
        variant: null,
        props: { markers: [{ id: "mk", title: "Офис", lat: 55.7, lon: 37.6 }] },
        children: [],
      },
      {
        id: "c4",
        type: "related_content",
        schemaVersion: 1,
        variant: null,
        props: { mode: "manual", entry_ids: ["e1", "e2"] },
        children: [],
      },
    ),
  );
  assert.equal(result.body, "");
  assert.ok(!`${result.body} ${result.aux}`.includes("DROP TABLE"));
  assert.ok(!`${result.body} ${result.aux}`.includes("SECRET"));
  assert.ok(!`${result.body} ${result.aux}`.includes("1.2"));
  assert.ok(!`${result.body} ${result.aux}`.includes("e1"));
  assert.match(result.aux, /Офис/); // marker titles are aux-visible
});

test("field extraction follows searchable hints, semantic defaults and weights", () => {
  const input: SearchExtractionInput = {
    fields: {
      title: "Внедрение ERP",
      intro: "Автоматизация учёта на производстве",
      body: rt("Подробное описание этапов внедрения"),
      sku: "ERP-2026-PRO",
      price: { amount: "1200000.00", currency: "RUB" },
      tags: ["ERP", "автоматизация"],
      internal_note: "внутренняя заметка менеджера",
      hero_image: { asset_id: "m3" },
    },
    fieldSchema: {
      fields: {
        title: { type: "string", required: true },
        intro: { type: "text" },
        body: { type: "rich_text" },
        sku: { type: "string", searchable: true, search_weight: "D" },
        price: { type: "money" },
        tags: { type: "list", item: { type: "string" } },
        internal_note: { type: "text" },
        hero_image: { type: "media" },
      },
    },
    bodyPolicy: "none",
    blocks: null,
  };
  const extracted = extractSearchText(input);
  assert.equal(extracted.title, "Внедрение ERP");
  assert.equal(extracted.summary, "Автоматизация учёта на производстве");
  assert.match(extracted.bodyText, /Подробное описание этапов внедрения/);
  assert.match(extracted.auxText, /ERP-2026-PRO/);
  assert.match(extracted.auxText, /ERP[\s\S]+автоматизация/); // tags → aux corpus
  // Unhinted private fields and non-text types never leak into the corpus.
  assert.ok(!JSON.stringify(extracted).includes("внутренняя заметка"));
  assert.ok(!JSON.stringify(extracted).includes("m3"));
  assert.ok(!JSON.stringify(extracted).includes("1200000"));
});

test("extraction bounds oversized text and strips snippet marker code points", () => {
  const extracted = extractSearchText({
    fields: { title: "T".repeat(5000), body: rt("\u0001evil\u0002") },
    fieldSchema: { fields: { title: { type: "string" }, body: { type: "rich_text" } } },
    bodyPolicy: "none",
  });
  assert.ok(extracted.title.length <= 500);
  assert.ok(!extracted.bodyText.includes("\u0001"));
  assert.ok(!extracted.bodyText.includes("\u0002"));
});
