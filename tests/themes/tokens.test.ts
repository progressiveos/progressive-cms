// Design Token contract tests (PCMS-THEME-T013).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTokensSource, tokenCssName, tokensToCss } from "@pcms/themes";

const SOURCE = JSON.stringify({
  "color.primary": { value: "#0f62fe", type: "color" },
  "color.accent": { value: "#ff7ab6", type: "color" },
  "font.heading": { value: "'Inter', sans-serif", type: "text" },
  "space.md": { value: "1rem", type: "length" },
  "layout.container-max": { value: "1200px", type: "length" },
  "z.overlay": { value: "90", type: "number" },
  "debug.grid-overlay": { value: "none", type: "text", public: false },
});

test("token source parses into a typed map with semantic names", () => {
  const result = parseTokensSource(SOURCE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.tokens["color.primary"]?.value, "#0f62fe");
  assert.equal(result.tokens["color.primary"]?.public, true);
  assert.equal(result.tokens["debug.grid-overlay"]?.public, false);
});

test("runtime output is deterministic, sorted CSS custom properties", () => {
  const a = parseTokensSource(SOURCE);
  const b = parseTokensSource(SOURCE);
  assert.ok(a.ok && b.ok);
  const cssA = tokensToCss(a.tokens);
  assert.equal(cssA, tokensToCss(b.tokens));
  // Public section is itself globally sorted; the implementation token lives
  // in its own clearly marked section (§70).
  const sectionOf = (name: string): "public" | "impl" =>
    cssA.indexOf(name) > cssA.indexOf("/* implementation tokens") ? "impl" : "public";
  const pubLines = cssA
    .split("/* implementation tokens")[0]
    ?.split("\n")
    .filter((l) => l.trim().startsWith("--"))
    .map((l) => l.trim().split(":")[0] ?? "");
  assert.deepEqual(
    pubLines,
    [...(pubLines ?? [])].sort((x, y) => x.localeCompare(y)),
  );
  assert.equal(sectionOf("--debug-grid-overlay"), "impl");
  assert.match(cssA, /--color-primary: #0f62fe;/);
  assert.match(cssA, /--layout-container-max: 1200px;/);
  assert.match(cssA, /\/\* public tokens/);
  assert.match(cssA, /\/\* implementation tokens/);
  assert.match(cssA, /--debug-grid-overlay: none;/);
});

test("tokenCssName maps dotted keys to custom property names", () => {
  assert.equal(tokenCssName("color.primary"), "--color-primary");
  assert.equal(tokenCssName("layout.container-max"), "--layout-container-max");
});

test("invalid names, types and injection-shaped values are rejected", () => {
  const badName = parseTokensSource(
    JSON.stringify({ "Color.Primary": { value: "#fff", type: "color" } }),
  );
  assert.equal(badName.ok, false);
  assert.deepEqual(
    (badName.issues ?? []).map((i) => i.code),
    ["TOKEN_NAME_INVALID"],
  );

  const badColor = parseTokensSource(
    JSON.stringify({ "color.x": { value: "blue;", type: "color" } }),
  );
  assert.equal(badColor.ok, false);

  const injection = parseTokensSource(
    JSON.stringify({ "x.y": { value: "none} body { background: red", type: "text" } }),
  );
  assert.equal(injection.ok, false);
  assert.deepEqual(
    (injection.issues ?? []).map((i) => i.code),
    ["TOKEN_VALUE_INVALID"],
  );

  const badType = parseTokensSource(JSON.stringify({ "x.y": { value: "1", type: "em" } }));
  assert.equal(badType.ok, false);
  assert.deepEqual(
    (badType.issues ?? []).map((i) => i.code),
    ["TOKEN_TYPE_INVALID"],
  );

  const notJson = parseTokensSource("{nope");
  assert.equal(notJson.ok, false);
  if (!notJson.ok) {
    assert.deepEqual(
      notJson.issues.map((i) => i.code),
      ["TOKEN_SOURCE_INVALID"],
    );
  }
});

test("valid token families from the spec categories all pass", () => {
  const result = parseTokensSource(
    JSON.stringify({
      "color.primary": { value: "#000000", type: "color" },
      "font.body-size": { value: "16px", type: "length" },
      "space.l": { value: "2rem", type: "length" },
      "radius.card": { value: "8px", type: "length" },
      "shadow.card": { value: "0 1px 2px rgba(0, 0, 0, .2)", type: "text" },
      "bp.md": { value: "768px", type: "length" },
      "button.radius": { value: "4px", type: "length" },
    }),
  );
  if (result.ok) assert.ok(result.tokens["color.primary"]);
  else assert.fail(JSON.stringify(result.issues));
});
