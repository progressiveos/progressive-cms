// Incident 152fz.p-os.ru (2026-10-09): the operator saw only "cross-site
// origin rejected" while the server envelope carried expected/got origins and
// a hint. describeApiError must render the ORIGIN_EXPECTED detail verbatim
// (React escapes the interpolated values — no HTML injection path).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, describeApiError } from "../../apps/admin/src/api/client.js";

test("ORIGIN_EXPECTED renders expected/got origins and the server hint", () => {
  const error = new ApiError({
    code: "API_ORIGIN_MISMATCH",
    status: 403,
    message: "cross-site origin rejected",
    details: [
      {
        code: "ORIGIN_EXPECTED",
        message: "request origin does not match the request authority",
        expected_origin: "https://152fz.p-os.ru",
        got_origin: "http://152fz.p-os.ru",
        hint: "if the site is served through a reverse proxy, its actual peer address ... http.trustedProxies ... restart the web service",
      },
    ],
  });
  const text = describeApiError(error);
  assert.match(text, /expected origin: https:\/\/152fz\.p-os\.ru/);
  assert.match(text, /request origin: http:\/\/152fz\.p-os\.ru/);
  assert.match(text, /http\.trustedProxies/);
});

test("plain validation details keep the code: message shape", () => {
  const error = new ApiError({
    code: "SEAL_INVALID",
    status: 400,
    message: "failed seal validation with 1 error(s)",
    details: [{ code: "TITLE_REQUIRED", message: "title is empty" }],
  });
  assert.equal(
    describeApiError(error),
    "failed seal validation with 1 error(s)\nTITLE_REQUIRED: title is empty",
  );
});

test("details without a message are skipped; non-ApiError falls back", () => {
  const error = new ApiError({ code: "X", status: 400, message: "m", details: [{ noise: 1 }] });
  assert.equal(describeApiError(error), "m");
  assert.equal(describeApiError(new Error("boom")), "boom");
});
