// PCMS-OPS-T106 — security headers baseline (Operations spec §22): every
// API/HTTP response carries nosniff + referrer + permissions policy through
// the shared Fastify factory, and public HTML pages get a CSP built from the
// theme's validated declaration (never raw strings).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFastify } from "@pcms/api";
import { publicSecurityHeaders } from "../../apps/web/src/public-headers.js";

test("baseline security headers are present on every API response", async () => {
  const app = createApiFastify(() => "req-1");
  app.get("/probe", async () => ({ ok: true }));
  const reply = await app.inject({ method: "GET", url: "/probe" });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers["x-content-type-options"], "nosniff");
  assert.equal(reply.headers["referrer-policy"], "strict-origin-when-cross-origin");
  assert.ok(String(reply.headers["permissions-policy"]).includes("camera=()"));
  await app.close();
});

test("surfaces can tighten the baseline (referrer-policy no-referrer)", async () => {
  const app = createApiFastify(() => "req-1");
  app.get("/probe", async (_request, reply) => {
    void reply.header("referrer-policy", "no-referrer");
    return { ok: true };
  });
  const reply = await app.inject({ method: "GET", url: "/probe" });
  assert.equal(reply.headers["referrer-policy"], "no-referrer");
  await app.close();
});

test("public CSP: theme declaration extends the controlled policy", () => {
  const headers = publicSecurityHeaders({
    img_src: ["https://media.example.ru"],
    frame_src: ["https://www.youtube-nocookie.com"],
  });
  const csp = headers["content-security-policy"] ?? "";
  assert.ok(csp.includes("default-src 'self'"), csp);
  assert.ok(csp.includes("img-src 'self' https://media.example.ru"), csp);
  assert.ok(csp.includes("frame-src 'self' https://www.youtube-nocookie.com"), csp);
  // Baseline headers always accompany the CSP.
  assert.equal(headers["x-content-type-options"], "nosniff");
});

test("public CSP: empty declaration yields the closed default policy", () => {
  const headers = publicSecurityHeaders(undefined);
  // Full deterministic check (aliases in buildCspPolicy order).
  assert.equal(
    headers["content-security-policy"] ?? "",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-src 'self'",
      "media-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
  );
});

test("public CSP: inline style hashes extend style-src after 'self'", () => {
  // The Theme Contract's `<style>{{ tokens_css }}</style>` injection point is
  // allowed by content hash (M17 regression: the strict baseline blocked the
  // tokens block and every var()-driven style collapsed to browser defaults).
  const headers = publicSecurityHeaders(undefined, [
    "'sha256-6/KwGREmn7PPX8IEYbP97eVOOfcKyRIR90qZas//gMc='",
  ]);
  assert.ok(
    headers["content-security-policy"]?.includes(
      "style-src 'self' 'sha256-6/KwGREmn7PPX8IEYbP97eVOOfcKyRIR90qZas//gMc='",
    ),
    headers["content-security-policy"],
  );
  // A declared style_src merges with the hashes; script-src stays untouched.
  const merged = publicSecurityHeaders({ style_src: ["https://fonts.example.ru"] }, [
    "'sha256-abc='",
  ]);
  assert.ok(
    merged["content-security-policy"]?.includes(
      "style-src 'self' https://fonts.example.ru 'sha256-abc='",
    ),
    merged["content-security-policy"],
  );
  assert.ok(merged["content-security-policy"]?.includes("script-src 'self'"));
});
