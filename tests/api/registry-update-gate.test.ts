import assert from "node:assert/strict";
import { test } from "node:test";
import { __isVersionNewer } from "../../packages/api/src/http/routes/registry.js";

test("update gate: only strictly newer X.Y.Z passes", () => {
  assert.equal(__isVersionNewer("0.1.178", "0.1.177"), true);
  assert.equal(__isVersionNewer("0.2.0", "0.1.177"), true);
  assert.equal(__isVersionNewer("1.0.0", "0.99.99"), true);
  assert.equal(__isVersionNewer("0.1.177", "0.1.177"), false);
  assert.equal(__isVersionNewer("0.1.176", "0.1.177"), false);
  assert.equal(__isVersionNewer("0.1.9", "0.1.177"), false); // numeric, not lexical
  assert.equal(__isVersionNewer("garbage", "0.1.177"), false);
});

test("update gate: RC precedence and build metadata follow SemVer", () => {
  for (const [candidate, current, newer] of [
    ["1.0.0-rc.24", "1.0.0-rc.23", true],
    ["1.0.0-rc.10", "1.0.0-rc.9", true],
    ["1.0.0-rc.23", "1.0.0-rc.24", false],
    ["1.0.0-rc.24", "1.0.0-rc.24", false],
    ["1.0.0", "1.0.0-rc.24", true],
    ["1.0.0-rc.24", "1.0.0", false],
    ["1.0.0+next", "1.0.0+previous", false],
    ["1.0.0-rc.24+next", "1.0.0-rc.24+previous", false],
    ["1.0.0-rc.24", "unknown", false],
    ["unknown", "1.0.0-rc.24", false],
  ] as const) {
    assert.equal(__isVersionNewer(candidate, current), newer, `${current} -> ${candidate}`);
  }
});
