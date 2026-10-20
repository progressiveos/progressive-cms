// PCMS-NAV-T021 — encoded-path/security normalization tests (Navigation
// spec §46/§69). No double decoding, no path confusion: encodings, dot
// segments, backslashes and control characters are rejected or redirected,
// never silently merged with distinct canonical paths.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ROUTE_POLICY,
  decideRequestPath,
  LEGACY_HTML_ROUTE_POLICY,
  normalizeHostname,
  normalizeStoredPath,
  type RequestPathDecision,
  RoutingError,
} from "@pcms/routing";

function assertInvalid(path: string, policy = DEFAULT_ROUTE_POLICY): void {
  const decision = decideRequestPath(path, policy);
  assert.equal(decision.kind, "invalid", path);
}

test("%2F (encoded slash) never splits or merges path segments", () => {
  assertInvalid("/files%2Fsecret");
  assertInvalid("/files%2fsecret"); // lowercase variant
  // Stored routes cannot contain it either.
  assert.throws(() => normalizeStoredPath("/files%2Fsecret/", DEFAULT_ROUTE_POLICY), RoutingError);
});

test("%5C (encoded backslash) is not a path separator", () => {
  assertInvalid("/windows%5Csystem32");
  assertInvalid("/windows%5csystem32");
  assertInvalid("/windows\\system32");
});

test("dot segments are rejected outright — no traversal normalization", () => {
  assertInvalid("/a/../b/");
  assertInvalid("/a/./b/");
  assertInvalid("/..");
  assertInvalid("/.");
  // Encoded dot segments: still rejected (single decode contract leaves
  // them as literal dots, which are invalid in stored paths).
  assertInvalid("/a%2F..%2Fb");
});

test("double encoding is never decoded a second time", () => {
  // %252F decodes once to %2F at the server; the resolver receives the
  // literal string "%2F", refuses to decode again, and rejects it.
  assertInvalid("/a%252Fb");
  assertInvalid("%252e%252e%252f");
  // Double-encoded traversal does not normalize into a valid path either.
  assertInvalid("/%252e%252e/");
});

test("null-like and control encodings / raw controls are rejected", () => {
  assertInvalid("/a%00b");
  assertInvalid("/a%0Ab"); // LF
  assertInvalid("/a%0Db"); // CR
  assertInvalid("/a%09b"); // TAB
  assertInvalid("/a\u0000b");
  assertInvalid("/a\nb");
  assertInvalid("/a\rb");
});

test("CRLF can never enter a redirect Location", () => {
  // The only redirect source is normalizeStoredPath output, which rejects
  // control characters — so a hostile path yields "invalid", not a redirect
  // with an injectable Location header.
  const decision = decideRequestPath(
    "/foo\r\nLocation: http://attacker.example/",
    DEFAULT_ROUTE_POLICY,
  );
  assert.equal(decision.kind, "invalid");
  const decision2 = decideRequestPath("/foo%0d%0aX", DEFAULT_ROUTE_POLICY);
  assert.equal(decision2.kind, "invalid");
  // Legitimate redirect targets are exactly the normalized canonical path.
  const ok = decideRequestPath("/foo", DEFAULT_ROUTE_POLICY);
  assert.deepEqual(ok, { kind: "redirect", statusCode: 301, location: "/foo/" });
});

test("case variants redirect to canonical; they never alias distinct paths", () => {
  const upper: RequestPathDecision = decideRequestPath("/Services", DEFAULT_ROUTE_POLICY);
  assert.deepEqual(upper, { kind: "redirect", statusCode: 301, location: "/services/" });
  // A mixed-case stored path is not possible: normalization lowercases it.
  assert.equal(normalizeStoredPath("/Mixed/Case/", DEFAULT_ROUTE_POLICY), "/mixed/case/");
});

test("malformed percent sequences are invalid on stored and request paths", () => {
  for (const path of ["/a%", "/a%1", "/a%zz", "/a%A", "%2F"]) {
    assertInvalid(path);
  }
});

test("legacy policy follows the same safety rules for its own forms", () => {
  // Allowed extension canonicalizes and redirects the slash variant...
  assert.deepEqual(decideRequestPath("/about.html/", LEGACY_HTML_ROUTE_POLICY), {
    kind: "redirect",
    statusCode: 301,
    location: "/about.html",
  });
  // ...but does not open encoding or traversal holes.
  assertInvalid("/..%2Fabout.html", LEGACY_HTML_ROUTE_POLICY);
  assertInvalid("/about.html%2F", LEGACY_HTML_ROUTE_POLICY);
  assertInvalid("/%252e/about.html", LEGACY_HTML_ROUTE_POLICY);
});

test("host normalization refuses poisoned Host headers", () => {
  for (const hostile of [
    "attacker.example\r\nX-Evil: 1",
    "attacker.example:8080:extra",
    "attacker.example..",
    " JavaScript:alert(1) ",
  ]) {
    assert.throws(
      () => normalizeHostname(hostile),
      (err: RoutingError) => err.code === "DOMAIN_NOT_ALLOWED",
      hostile,
    );
  }
  // Punycode labels are plain ASCII hostnames — accepted as configured.
  assert.equal(normalizeHostname("xn--e1afmkfd.xn--p1ai"), "xn--e1afmkfd.xn--p1ai");
});

test("path length is bounded (abuse guard)", () => {
  assertInvalid(`/${"a".repeat(3000)}/`);
});
