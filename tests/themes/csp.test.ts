// JS/CSP declaration validation tests (PCMS-THEME-T018).
// Generated config fixtures with privileged tokens must be impossible.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCspPolicy, validateCspDeclaration, validatePublicJs } from "@pcms/themes";

test("safe CSP declarations pass", () => {
  const issues = validateCspDeclaration({
    frame_src: ["https://www.youtube-nocookie.com"],
    img_src: ["'self'", "https://cdn.acme.example"],
  });
  assert.deepEqual(issues, []);
});

test("unsafe origins are impossible in valid fixtures", () => {
  const issues = validateCspDeclaration({
    script_src: [
      "*",
      "'unsafe-eval'",
      "'unsafe-inline'",
      "data:",
      "http://insecure.example",
      "https://ok.example",
    ],
  });
  assert.deepEqual(
    issues.map((i) => [i.code, i.message.includes("https://ok.example")]),
    [
      ["THEME_CSP_ORIGIN_FORBIDDEN", false],
      ["THEME_CSP_ORIGIN_FORBIDDEN", false],
      ["THEME_CSP_ORIGIN_FORBIDDEN", false],
      ["THEME_CSP_ORIGIN_FORBIDDEN", false],
      ["THEME_CSP_SCHEME_INSECURE", false],
    ],
  );
});

test("public JS with privileged tokens fails validation", () => {
  const issues = validatePublicJs({
    "assets/js/clean.js": "document.querySelector('.nav')?.classList.toggle('open');",
    "assets/js/leaky.js": "fetch('/api', { headers: { authorization: 'Bearer ' + token } });",
    "assets/js/secret.js": "const cfg = { PCMS_SECRET_DB_PASSWORD: 'x' };",
    "assets/js/apikey.js": "const apiKey = 'sk-123';",
  });
  assert.deepEqual(
    issues.map((i) => [i.code, i.path]),
    [
      ["THEME_JS_PRIVILEGED_TOKEN", "assets/js/apikey.js"],
      ["THEME_JS_PRIVILEGED_TOKEN", "assets/js/leaky.js"],
      ["THEME_JS_PRIVILEGED_TOKEN", "assets/js/secret.js"],
    ],
  );
});

test("dynamic execution in public JS fails validation", () => {
  const issues = validatePublicJs({
    "assets/js/evil.js": "eval(userInput);",
    "assets/js/evil2.js": "const f = new Function('return 1');",
    "assets/js/fine.js": "setTimeout(() => toggle(), 100);",
  });
  assert.deepEqual(
    issues.map((i) => [i.code, i.path]),
    [
      ["THEME_JS_DYNAMIC_EXECUTION", "assets/js/evil.js"],
      ["THEME_JS_DYNAMIC_EXECUTION", "assets/js/evil2.js"],
    ],
  );
});

test("the policy layer builds a deterministic, locked-down CSP header", () => {
  const header = buildCspPolicy({
    script_src: ["https://cdn.acme.example"],
    frame_src: ["https://www.youtube-nocookie.com"],
  });
  assert.equal(
    header,
    [
      "default-src 'self'",
      "script-src 'self' https://cdn.acme.example",
      "style-src 'self'",
      "img-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-src 'self' https://www.youtube-nocookie.com",
      "media-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
  );
  assert.equal(header.includes("unsafe"), false);
  // Deterministic for identical input.
  assert.equal(
    header,
    buildCspPolicy({
      frame_src: ["https://www.youtube-nocookie.com"],
      script_src: ["https://cdn.acme.example"],
    }),
  );
});
