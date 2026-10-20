// PCMS-SEO-T017 — JSON-LD security/escaping layer (spec §70/§22).
// Structured data is data serialization, never an HTML injection surface:
// hostile strings survive as data, `</script>` breakouts are impossible,
// unicode separators and polyglots stay escaped, and the composed graph
// round-trips through JSON.parse byte-for-byte.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeStructuredData, type StructuredDataPageInput, serializeJsonLd } from "@pcms/seo";
import { assembleHeadHtml, type HeadViewModel } from "@pcms/themes";

const HOSTILE = [
  "</script><script>alert(1)</script>",
  "<!-- <script> -->",
  '"><img src=x onerror=alert(1)>',
  "line\u2028sep\u2029par",
  'quote " backslash \\ end',
  "\u0000 null \u0001 control",
  "mixed </SCRIPT> case",
  "backtick `${payload}` brace {7} polyglot",
];

const ORIGIN = "https://example.ru";

test("hostile strings in any fact field stay escaped data in the serialized graph", () => {
  for (const payload of HOSTILE) {
    const input: StructuredDataPageInput = {
      website: { id: `${ORIGIN}/#website`, name: payload, url: ORIGIN },
      organization: { id: `${ORIGIN}/#organization`, name: payload, url: ORIGIN },
      webpage: { id: `${ORIGIN}/x/#webpage`, name: payload, url: `${ORIGIN}/x/` },
      breadcrumbs: { id: `${ORIGIN}/x/#breadcrumb`, items: [{ name: payload, url: `${ORIGIN}/` }] },
      article: {
        id: `${ORIGIN}/x/#article`,
        type: "article",
        headline: payload,
        url: `${ORIGIN}/x/`,
        date_published: null,
        date_modified: null,
        author: { name: payload },
        publisher: null,
      },
      video: {
        id: `${ORIGIN}/x/#video`,
        name: payload,
        description: payload,
      },
    };
    const composed = composeStructuredData(input);
    assert.equal(composed.json_ld.length, 1);
    const json = composed.json_ld[0] as string;
    // No breakout sequences in the raw serialized text.
    assert.ok(!json.includes("</script"), `unescaped </script for ${JSON.stringify(payload)}`);
    assert.ok(!json.includes("<script"), `raw <script for ${JSON.stringify(payload)}`);
    assert.ok(!json.includes("<!--"), `raw comment opener for ${JSON.stringify(payload)}`);
    for (const ch of ["\u2028", "\u2029"]) {
      assert.ok(!json.includes(ch), "raw unicode separator leaked");
    }
    // The data itself survives exactly: parse-back equality.
    const parsed = JSON.parse(json) as { "@graph": { name?: string }[] };
    const names = parsed["@graph"].map((n) => n.name ?? undefined);
    assert.ok(names.includes(payload), `payload lost for ${JSON.stringify(payload)}`);
  }
});

test("serialization round-trips values exactly, including separators and control chars", () => {
  for (const payload of HOSTILE) {
    assert.equal((JSON.parse(serializeJsonLd({ v: payload })) as { v: string }).v, payload);
  }
});

test("the themes assembler adds defense in depth; script tags stay balanced", () => {
  const composed = composeStructuredData({
    website: { id: `${ORIGIN}/#website`, name: "</script><script>alert(1)</script>", url: ORIGIN },
    organization: null,
    webpage: null,
    article: null,
    breadcrumbs: null,
    video: null,
  });
  const viewModel: HeadViewModel = {
    title: null,
    core_meta: [],
    canonical: null,
    robots: null,
    json_ld: composed.json_ld,
    theme_slots: [],
  };
  const html = assembleHeadHtml(viewModel);
  const scripts = html.split("<script").length - 1;
  assert.equal(scripts, 1, "exactly one JSON-LD script tag");
  assert.ok(!html.includes("</script><script>alert"), "no breakout");
  assert.ok(html.includes("\\u003c/script>"), "escape layer applied");
});

test("serialization is deterministic for hostile input (stable cache identity)", () => {
  const input: StructuredDataPageInput = {
    website: { id: `${ORIGIN}/#website`, name: HOSTILE[0] ?? "", url: ORIGIN },
    organization: null,
    webpage: null,
    article: null,
    breadcrumbs: null,
    video: null,
  };
  assert.equal(composeStructuredData(input).json_ld[0], composeStructuredData(input).json_ld[0]);
});
