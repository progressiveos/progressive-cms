import assert from "node:assert/strict";
import { test } from "node:test";
import { setLocale } from "../../apps/admin/src/i18n/locale.js";
import { summaryOf } from "../../apps/admin/src/screens/content/blocks/summary.js";

const block = (props: Record<string, unknown>) => ({
  id: "summary",
  type: "text",
  schema_version: 1,
  variant: null,
  props,
  children: [],
});
test("block summaries read rich text and distinguish genuinely empty content in RU/EN without mutation", () => {
  const filled = block({
    rich_text: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Полный текст" }] }],
    },
  });
  const original = JSON.stringify(filled);
  for (const locale of ["ru", "en"] as const) {
    setLocale(locale);
    assert.equal(summaryOf(filled), "Полный текст");
    assert.equal(
      summaryOf(block({ rich_text: { type: "doc", content: [] } })),
      locale === "ru" ? "(пусто)" : "(empty)",
    );
    assert.equal(summaryOf(block({ title: "Заголовок" })), "Заголовок");
    assert.equal(summaryOf(block({ ...filled.props, title: "Заголовок" })), "Заголовок");
    assert.equal(summaryOf(block({ media_id: "image" })), locale === "ru" ? "Медиа" : "Media");
    assert.equal(
      summaryOf(block({ items: [{ title: "Item" }] })),
      locale === "ru" ? "Элементов: 1" : "Items: 1",
    );
  }
  assert.equal(JSON.stringify(filled), original);
  setLocale("ru");
});
