// Head boundary tests (PCMS-THEME-T016) — themes cannot suppress or fake
// core metadata; extension slots render after the core section.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assembleHeadHtml,
  filterThemeHeadSlots,
  type HeadViewModel,
  headViolations,
} from "@pcms/themes";

function coreHead(themeSlots: HeadViewModel["theme_slots"] = []): HeadViewModel {
  return {
    title: "Ремонт квартир — Акме",
    core_meta: [{ name: "description", content: "Корпоративные услуги" }],
    canonical: "https://acme.example/services",
    robots: "index, follow",
    json_ld: ['{"@type":"Organization","name":"Акме</script>alert(1)"}'],
    theme_slots: themeSlots,
  };
}

test("core section renders first and is deterministic", () => {
  const html = assembleHeadHtml(coreHead());
  const expected = [
    "<title>Ремонт квартир — Акме</title>",
    '<meta name="description" content="Корпоративные услуги">',
    '<link rel="canonical" href="https://acme.example/services">',
    '<meta name="robots" content="index, follow">',
  ].join("\n");
  assert.ok(html.startsWith(expected), html);
  assert.match(html, /<script type="application\/ld\+json">/);
  // JSON-LD cannot break out of its script element.
  assert.doesNotMatch(html, /<\/script>alert/);
  assert.match(html, /<\\\/script>alert\(1\)/);
});

test("theme slots render after the core section", () => {
  const html = assembleHeadHtml(
    coreHead([
      { kind: "stylesheet", attributes: { href: "/themes/acme/assets/theme.css" } },
      { kind: "meta", attributes: { name: "theme-color", content: "#0f62fe" } },
      { kind: "script", attributes: { src: "https://cdn.example/widget.js" } },
      { kind: "link", attributes: { rel: "preconnect", href: "https://fonts.example" } },
    ]),
  );
  assert.match(html, /<link href="\/themes\/acme\/assets\/theme\.css" rel="stylesheet">/);
  assert.match(html, /<meta name="theme-color" content="#0f62fe">/);
  assert.match(html, /<script src="https:\/\/cdn\.example\/widget\.js" defer><\/script>/);
  assert.match(html, /<link rel="preconnect" href="https:\/\/fonts\.example">/);
  const lastCore = html.indexOf('<meta name="robots"');
  const firstSlot = html.indexOf("theme-color");
  assert.ok(lastCore !== -1 && lastCore < firstSlot);
});

test("theme cannot suppress or imitate canonical/robots/social metadata", () => {
  const slots: HeadViewModel["theme_slots"] = [
    { kind: "link", attributes: { rel: "canonical", href: "https://evil.example" } },
    { kind: "meta", attributes: { name: "robots", content: "noindex" } },
    { kind: "meta", attributes: { name: "description", content: "hacked" } },
    { kind: "meta", attributes: { property: "og:title", content: "hacked" } },
    { kind: "meta", attributes: { name: "twitter:card", content: "x" } },
  ];
  const { accepted, violations } = filterThemeHeadSlots(slots);
  assert.deepEqual(accepted, []);
  assert.equal(violations.length, slots.length);
  assert.ok(violations.every((v) => v.code === "THEME_HEAD_PROTECTED_METADATA"));
  assert.equal(headViolations(coreHead(slots)).length, slots.length);
  const html = assembleHeadHtml(coreHead(slots));
  assert.doesNotMatch(html, /evil\.example|hacked/);
});

test("hostile slots are rejected: inline scripts, javascript URLs, unknown attributes", () => {
  const slots: HeadViewModel["theme_slots"] = [
    { kind: "script", attributes: {} },
    { kind: "script", attributes: { src: "javascript:alert(1)" } },
    { kind: "meta", attributes: { name: "theme-color", content: "#fff", onclick: "evil()" } },
  ];
  const { accepted, violations } = filterThemeHeadSlots(slots);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0]?.attributes, { name: "theme-color", content: "#fff" });
  // inline script + javascript: URL + dropped onclick attribute
  assert.equal(violations.length, 3);
  assert.ok(violations.every((v) => v.code === "THEME_HEAD_SLOT_INVALID"));
});
