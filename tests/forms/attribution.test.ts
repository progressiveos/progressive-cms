// MKT-010 attribution snapshot parser (owner task): allowlisted capture,
// server-validated, never fatal to the contact acceptance. Rules proven here:
// trim → empty→null; over-limit values are DROPPED (never truncated, never
// turned into PII); landing_path is path-only; referrer_host is bare;
// interaction_kind + form_key are server-set; unknown keys are ignored.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAttribution, UTM_KEYS } from "@pcms/forms";

const FORM_ID = "01a0c5f7-3e52-71ee-ac69-7b26552be909";

test("full snapshot: utm kept with case, landing path and referrer host stored", () => {
  const snapshot = parseAttribution(
    {
      utm_source: "Test",
      utm_medium: "cpc",
      utm_campaign: " autumn-2026 ",
      utm_content: "banner-1",
      utm_term: " ангары ",
      landing_path: "/uslugi/angary",
      referrer_host: "vk.com",
      utm_email: "ignore-me@example.com",
      gclid: "should-not-leak",
    },
    "form",
    FORM_ID,
  );
  assert.equal(snapshot.interaction_kind, "form");
  assert.equal(snapshot.form_key, FORM_ID);
  assert.equal(snapshot.utm_source, "Test", "case preserved (HQ matching is case-sensitive)");
  assert.equal(snapshot.utm_medium, "cpc");
  assert.equal(snapshot.utm_campaign, "autumn-2026");
  assert.equal(snapshot.utm_content, "banner-1");
  assert.equal(snapshot.utm_term, "ангары");
  assert.equal(snapshot.landing_path, "/uslugi/angary");
  assert.equal(snapshot.referrer_host, "vk.com");
  // allowlist: client-sent noise never reaches the snapshot
  assert.ok(!JSON.stringify(snapshot).includes("ignore-me@example.com"));
  assert.ok(!JSON.stringify(snapshot).includes("gclid"));
});

test("nothing declared → server still freezes kind/key with null fields", () => {
  for (const interactionKind of ["form", "quiz"] as const) {
    for (const raw of [undefined, null, "junk", 42, [], {}]) {
      const snapshot = parseAttribution(raw, interactionKind, `${interactionKind}_key`);
      assert.equal(snapshot.interaction_kind, interactionKind);
      assert.equal(snapshot.form_key, `${interactionKind}_key`);
      for (const key of UTM_KEYS) assert.equal(snapshot[key as keyof typeof snapshot], null);
      assert.equal(snapshot.landing_path, null);
      assert.equal(snapshot.referrer_host, null);
    }
  }
});

test("policy violations drop the value instead of truncating or failing", () => {
  const snapshot = parseAttribution(
    {
      utm_source: "x".repeat(121),
      utm_medium: "   ",
      utm_campaign: 123,
      landing_path: "/page?utm_source=lost",
      referrer_host: "https://evil.example.com/path@user",
    },
    "form",
    FORM_ID,
  );
  assert.equal(snapshot.utm_source, null, ">120 chars dropped, not truncated");
  assert.equal(snapshot.utm_medium, null, "empty after trim → null");
  assert.equal(snapshot.utm_campaign, null, "non-string dropped");
  assert.equal(snapshot.landing_path, null, "query strings are not a landing path");
  assert.equal(snapshot.referrer_host, null, "URL/credentials are not a host");
});

test("control characters are dropped before HQ can reject the contact envelope", () => {
  const snapshot = parseAttribution(
    {
      utm_source: "vk\nsource",
      landing_path: "/safe\u0000path",
      referrer_host: "example.com\u0085",
    },
    "form",
    FORM_ID,
  );
  assert.equal(snapshot.utm_source, null);
  assert.equal(snapshot.landing_path, null);
  assert.equal(snapshot.referrer_host, null);
});

test("exactly-at-limit values and fragment-free paths survive", () => {
  const snapshot = parseAttribution(
    {
      utm_source: "y".repeat(120),
      landing_path: "/ab",
      referrer_host: "a".repeat(255),
    },
    "form",
    FORM_ID,
  );
  assert.equal(snapshot.utm_source, "y".repeat(120));
  assert.equal(snapshot.landing_path, "/ab");
  assert.equal(snapshot.referrer_host, "a".repeat(255));
});

test("control characters and protocol-relative paths are dropped before delivery", () => {
  const snapshot = parseAttribution(
    {
      utm_source: "vk\u0001x",
      utm_medium: "cpc\n",
      utm_campaign: "\u0081",
      landing_path: "//evil.example.com/path",
      referrer_host: "ok.host",
    },
    "form",
    FORM_ID,
  );
  assert.equal(snapshot.utm_source, null, "embedded Cc char drops the value (HQ would 422)");
  assert.equal(snapshot.utm_medium, null, "trailing newline is Cc, not just whitespace");
  assert.equal(snapshot.utm_campaign, null, "Cc range extends past DEL");
  assert.equal(snapshot.landing_path, null, "leading // is not a path");
  assert.equal(snapshot.referrer_host, "ok.host");
});
