// Figma design pipeline (packages/themes/src/figma.ts): URL parsing, token
// extraction from a file payload, CSS draft, frame inventory.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractDesignTokens,
  type FigmaFile,
  figmaTokensToCss,
  frameIdsOf,
  parseFigmaUrl,
} from "../../packages/themes/src/figma.js";

test("figma url parsing: design/file links, node-id dash form", () => {
  assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/AbCdEf123456/Name?node-id=12-345"), {
    fileKey: "AbCdEf123456",
    nodeId: "12:345",
  });
  assert.equal(parseFigmaUrl("https://www.figma.com/file/AbCdEf123456/Old").nodeId, null);
  assert.throws(() => parseFigmaUrl("https://example.com/design/AbCdEf123456/x"));
  assert.throws(() => parseFigmaUrl("https://www.figma.com/proto/short/x"));
});

const FILE: FigmaFile = {
  name: "Spangar redesign",
  lastModified: "2026-09-29T00:00:00Z",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "1:2",
        name: "Page 1",
        type: "CANVAS",
        children: [
          {
            id: "3:4",
            name: "Home",
            type: "FRAME",
            fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }],
            children: [
              {
                id: "5:6",
                name: "Title",
                type: "TEXT",
                fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
                style: { fontFamily: "Inter", fontSize: 32, fontWeight: 700 },
                styles: { text: "S:1" },
              },
              {
                id: "7:8",
                name: "Card",
                type: "FRAME",
                fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }],
              },
            ],
          },
        ],
      },
    ],
  },
  styles: { "S:1": { key: "t1", name: "H1/Inter 32", styleType: "TEXT" } },
  components: { "C:1": { name: "Button/Primary" } },
};

test("token extraction: palette frequency, typography, named styles used", () => {
  const tokens = extractDesignTokens(FILE, "3:4");
  assert.deepEqual(tokens.palette[0], { hex: "#1a334d", count: 2 });
  assert.deepEqual(tokens.palette[1], { hex: "#ffffff", count: 1 });
  assert.deepEqual(tokens.typography[0], {
    fontFamily: "Inter",
    fontSize: 32,
    fontWeight: 700,
    count: 1,
  });
  assert.deepEqual(tokens.namedStyles, [
    { name: "H1/Inter 32", kind: "TEXT", css: "/* text style: H1/Inter 32 */" },
  ]);
  assert.deepEqual(tokens.components, ["Button/Primary"]);
  assert.deepEqual(
    frameIdsOf(FILE).map((frame) => frame.id),
    ["3:4"],
  );
});

test("css draft: custom properties with usage counts", () => {
  const css = figmaTokensToCss(extractDesignTokens(FILE, "3:4"));
  assert.match(css, /--figma-color-1: #1a334d; \/\* used 2× \*\//);
  assert.match(css, /--figma-color-2: #ffffff;/);
  assert.match(css, /--figma-font-1: 700 32px "Inter";/);
  assert.match(css, /H1\/Inter 32/);
});
