// PCMS-SEO-T004 — typed robots policy → engine meta mapping. Deterministic,
// injection-proof by construction (raw directive strings are unrepresentable).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isNoindex, parseSeoRobotsPolicy, renderRobotsMeta, robotsConflicts } from "@pcms/seo";

test("baseline policy renders no tag; restrictive policies render deterministic directives", () => {
  assert.equal(renderRobotsMeta(null), null);
  assert.equal(renderRobotsMeta({ index: true, follow: true }), null);
  assert.equal(renderRobotsMeta({ index: false, follow: false }), "noindex, nofollow");
  assert.equal(
    renderRobotsMeta({
      index: false,
      follow: true,
      noarchive: true,
      nosnippet: true,
      max_snippet: 0,
      max_image_preview: "none",
      max_video_preview: -1,
    }),
    "noindex, noarchive, nosnippet, max-snippet:0, max-image-preview:none, max-video-preview:-1",
  );
});

test("rendering is stable regardless of stored key order (deterministic output)", () => {
  const a = parseSeoRobotsPolicy({ follow: false, index: false }, "/", []);
  const b = parseSeoRobotsPolicy({ index: false, follow: false }, "/", []);
  assert.equal(renderRobotsMeta(a), renderRobotsMeta(b));
});

test("hostile input cannot become directives — the model only admits typed fields", () => {
  // A raw-directive injection attempt makes the whole policy invalid, so
  // nothing hostile can survive into meta content (fail-secure: no policy).
  const issues: { code: string; path: string; message: string }[] = [];
  const policy = parseSeoRobotsPolicy(
    { index: false, follow: true, "max-snippet:9999</script>": true } as never,
    "/robots_policy",
    issues,
  );
  assert.equal(policy, null);
  assert.ok(issues.length > 0);
  assert.equal(renderRobotsMeta(policy), null);
});

test("noindex detection drives indexability decisions (§15)", () => {
  assert.equal(isNoindex(null), false);
  assert.equal(isNoindex({ index: true, follow: true }), false);
  assert.equal(isNoindex({ index: false, follow: true }), true);
});

test("semantic conflicts inside one policy are advisory diagnostics", () => {
  assert.deepEqual(robotsConflicts({ index: true, follow: true }), []);
  const issues = robotsConflicts({ index: true, follow: true, nosnippet: true, max_snippet: 50 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "SEO_ROBOTS_CONFLICT");
  assert.equal(issues[0]?.severity, "warning");
});
