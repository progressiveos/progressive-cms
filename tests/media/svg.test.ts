// PCMS-MEDIA-T013 — SVG privileged/sanitize policy: every dangerous construct
// is rejected with MEDIA_SVG_NOT_ALLOWED; clean graphics pass through.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaError, validateSvg } from "@pcms/media";

const SAFE = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?>
   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" role="img">
     <title>Logo</title>
     <defs>
       <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#07c"/>
         <stop offset="1" stop-color="#c07"/>
       </linearGradient>
     </defs>
     <rect x="2" y="2" width="96" height="56" rx="8" fill="url(#g)"/>
     <path d="M10 50 L40 20 L60 40 L90 10" fill="none" stroke="#fff" stroke-width="3"/>
     <circle cx="50" cy="30" r="6" fill="#fff"/>
     <use href="#g"/>
     <text x="10" y="55" font-family="sans-serif" font-size="8">logo</text>
   </svg>`,
);

function expectRejected(svg: string, why: string): void {
  assert.throws(
    () => validateSvg(Buffer.from(svg)),
    (error: unknown) => error instanceof MediaError && error.code === "MEDIA_SVG_NOT_ALLOWED",
    why,
  );
}

test("clean graphic SVG is accepted unchanged", () => {
  const result = validateSvg(SAFE);
  assert.equal(result.bytes, SAFE);
  assert.ok(result.elements > 8);
});

test("script and event handlers are rejected", () => {
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    "script element",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" onload="alert(1)"/></svg>`,
    "onload handler",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" onmouseover="steal()"/></svg>`,
    "onmouseover handler",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="10" height="10"/></a></svg>`,
    "javascript: link (also: <a> not allowlisted)",
  );
});

test("external references and non-local URLs are rejected", () => {
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/pixel.svg"/></svg>`,
    "external image fetch",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/x.svg#y"/></svg>`,
    "external use reference",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>`,
    "data: URL",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/f)"/></svg>`,
    "external paint server (url() needs a filter element but is never safe here)",
  );
});

test("active embedding and entity expansion are rejected", () => {
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body><img src=x onerror=alert(1)></body></foreignObject></svg>`,
    "foreignObject",
  );
  expectRejected(
    `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>`,
    "DOCTYPE entity expansion",
  );
  expectRejected(
    `<?xml-stylesheet type="text/css" href="https://evil.example/x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>`,
    "xml-stylesheet",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://evil.example");</style></svg>`,
    "style element with import (style is attribute-only; element not in allowlist)",
  );
});

test("non-allowlisted elements and malformed structure are rejected", () => {
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><iframe src="https://evil.example"></iframe></svg>`,
    "iframe element",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" unknownattr="1"/></svg>`,
    "unknown attribute",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="10" height="10"/></g>`,
    "unclosed element",
  );
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg"></svg><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
    "unbalanced root",
  );
});

test("oversized SVG input is bounded before parsing", () => {
  const huge = Buffer.concat([
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">`),
    Buffer.alloc(2 * 1024 * 1024, 0x20),
    Buffer.from(`</svg>`),
  ]);
  expectRejected(huge.toString("utf8"), "size bound");
});
