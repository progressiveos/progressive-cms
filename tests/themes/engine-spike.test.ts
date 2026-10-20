// Liquid-compatible renderer spike (PCMS-THEME-T004).
//
// Proves the declarative template baseline on LiquidJS 10.x: autoescape,
// trusted SafeHtml passthrough, variables/conditionals/loops, includes,
// bounded extension model (filters via controlled registration only) and
// hardening against arbitrary Node execution / oversized templates.
// The decision is recorded in docs/adr/0006-liquid-template-engine.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createThemeEngine, isSafeHtml, safeHtml } from "@pcms/themes";

const SNAPSHOT = {
  "page.liquid": [
    "<h1>{{ title }}</h1>",
    "{% if show_intro %}<p class=intro>{{ intro }}</p>{% endif %}",
    "<ul>{% for item in items %}<li>{{ item.name }} / {{ item.price }}</li>{% endfor %}</ul>",
    "{% include 'card.liquid' %}",
  ].join("\n"),
  "card.liquid": "<div class=card>{{ card_title }}</div>",
};

test("autoescape: hostile strings render inert", async () => {
  const engine = createThemeEngine({ templates: { "t.liquid": "{{ user }}" } });
  const html = await engine.renderFile("t.liquid", {
    user: "<script>alert(1)</script> & \"quotes\" 'apostrophe'",
  });
  assert.equal(
    html,
    "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &#39;apostrophe&#39;",
  );
});

test("trusted SafeHtml bypasses escaping; everything else does not", async () => {
  const engine = createThemeEngine({
    templates: { "t.liquid": "{{ safe }}|{{ unsafe }}" },
  });
  const html = await engine.renderFile("t.liquid", {
    safe: safeHtml("<strong>trust</strong>"),
    unsafe: "<em>never</em>",
  });
  assert.equal(html, "<strong>trust</strong>|&lt;em&gt;never&lt;/em&gt;");
});

test("the builtin raw filter is removed: autoescape has no template-level bypass", async () => {
  const engine = createThemeEngine({ templates: { "t.liquid": "{{ v | raw }}" } });
  await assert.rejects(() => engine.renderFile("t.liquid", { v: "x" }), /raw|filter/i);
});

test("variables, conditionals and loops compose", async () => {
  const engine = createThemeEngine({ templates: SNAPSHOT });
  const html = await engine.renderFile("page.liquid", {
    title: "Услуга <A>",
    show_intro: true,
    intro: "intro & text",
    items: [
      { name: "alpha", price: 10 },
      { name: "beta", price: 20 },
    ],
    card_title: "card",
  });
  assert.match(html, /<h1>Услуга &lt;A&gt;<\/h1>/);
  assert.match(html, /<p class=intro>intro &amp; text<\/p>/);
  assert.match(html, /<li>alpha \/ 10<\/li>/);
  assert.match(html, /<div class=card>card<\/div>/);

  const noIntro = await engine.renderFile("page.liquid", {
    title: "t",
    show_intro: false,
    items: [],
    card_title: "c",
  });
  assert.doesNotMatch(noIntro, /<p class=intro>/);
  assert.match(noIntro, /<ul><\/ul>/);
});

test("include/render resolve against the in-memory snapshot only", async () => {
  const engine = createThemeEngine({ templates: SNAPSHOT });
  const html = await engine.renderFile("page.liquid", {
    title: "t",
    show_intro: false,
    items: [],
    card_title: "from partial",
  });
  assert.match(html, /from partial/);
  // A template cannot reach arbitrary files: unknown names are errors.
  const engine2 = createThemeEngine({ templates: { "t.liquid": "{% include 'nope.liquid' %}" } });
  await assert.rejects(() => engine2.renderFile("t.liquid", {}), /nope|failed|not found/i);
});

test("extension model is bounded: registered filters work, undefined filters fail", async () => {
  const engine = createThemeEngine({ templates: { "t.liquid": "{{ name | shout }}" } });
  engine.registerFilter("shout", (v: unknown) => String(v ?? "").toUpperCase());
  assert.equal(await engine.renderFile("t.liquid", { name: "acme" }), "ACME");

  const strict = createThemeEngine({ templates: { "t.liquid": "{{ name | nosuchfilter }}" } });
  await assert.rejects(() => strict.renderFile("t.liquid", { name: "x" }), /nosuchfilter|filter/i);
});

test("prototype-chain escapes are blocked (ownPropertyOnly)", async () => {
  const engine = createThemeEngine({
    templates: {
      "t.liquid": "[{{ x.constructor }}][{{ x.__proto__ }}][{{ constructor }}]",
    },
  });
  const html = await engine.renderFile("t.liquid", { x: { a: 1 } });
  assert.equal(html, "[][][]");
});

test("oversized templates are rejected (parseLimit)", async () => {
  const big = "a".repeat(1_100_000);
  const engine = createThemeEngine({ templates: { "t.liquid": big } });
  await assert.rejects(() => engine.renderFile("t.liquid", {}), /limit|exceed/i);
});

test("safeHtml accepts only strings; isSafeHtml discriminates", () => {
  const value = safeHtml("<b>x</b>");
  assert.equal(isSafeHtml(value), true);
  assert.equal(isSafeHtml({ html: "<b>x</b>" }), false);
  assert.equal(isSafeHtml("<b>x</b>"), false);
  assert.throws(
    () => safeHtml(42 as unknown as string),
    (err: unknown) =>
      err instanceof Error && "code" in err && err.code === "THEME_SAFEHTML_INVALID",
  );
});
