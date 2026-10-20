// M17-T007 — public theme asset serving from the application. The
// external-RP profile has no in-container nginx, so /themes/* must be safe
// and correct at the app edge: right content types, HEAD support, conditional
// caching, and every traversal/escape class rejected (task brief §19/§23).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fastify from "fastify";
import { registerThemeFilesRoute } from "../../apps/web/src/theme-files.js";

function withTheme(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pcms-theme-"));
  // Theme directory name is the URL's theme segment (renderDir basename).
  const theme = join(root, "demo-v1");
  mkdirSync(join(theme, "assets/css"), { recursive: true });
  mkdirSync(join(theme, "assets/img"), { recursive: true });
  mkdirSync(join(theme, "templates"), { recursive: true });
  writeFileSync(join(theme, "assets/css/theme.css"), "body{color:#123}");
  writeFileSync(join(theme, "assets/img/favicon.svg"), "<svg/>");
  writeFileSync(join(theme, "assets/fonts.x.txt"), "ok");
  writeFileSync(join(theme, "assets/.secret"), "nope");
  writeFileSync(join(theme, "templates/home.liquid"), "{{ title }}");
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function app(renderDir: string) {
  const instance = fastify();
  registerThemeFilesRoute(instance, { renderDir });
  return instance;
}

test("legacy asset is served with content type and revalidated cache headers", async () => {
  const { root, cleanup } = withTheme();
  try {
    const instance = app(join(root, "demo-v1"));
    const response = await instance.inject({
      method: "GET",
      url: "/themes/demo-v1/assets/css/theme.css",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/css; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-cache");
    assert.equal(response.body, "body{color:#123}");
    await instance.close();
  } finally {
    cleanup();
  }
});

test("HEAD works without a body and ETag drives a 304", async () => {
  const { root, cleanup } = withTheme();
  try {
    const instance = app(join(root, "demo-v1"));
    const head = await instance.inject({
      method: "GET",
      url: "/themes/demo-v1/assets/img/favicon.svg",
      headers: { "if-none-match": "x" },
    });
    const etag = head.headers.etag;
    assert.ok(typeof etag === "string");
    const conditional = await instance.inject({
      method: "GET",
      url: "/themes/demo-v1/assets/img/favicon.svg",
      headers: { "if-none-match": etag },
    });
    assert.equal(conditional.statusCode, 304);
    assert.equal(conditional.body, "");
    await instance.close();
  } finally {
    cleanup();
  }
});

test("missing asset, wrong theme, templates and directories are 404", async () => {
  const { root, cleanup } = withTheme();
  try {
    const instance = app(join(root, "demo-v1"));
    for (const url of [
      "/themes/demo-v1/assets/css/nope.css",
      "/themes/other-v1/assets/css/theme.css", // not the active theme
      "/themes/demo-v1/templates/home.liquid", // templates are not public
      "/themes/demo-v1/assets/css", // no directory listing
      "/themes/demo-v1", // bare theme prefix
      "/themes/demo-v1/assets/.secret", // dotfiles
    ]) {
      const response = await instance.inject({ method: "GET", url });
      assert.equal(response.statusCode, 404, url);
    }
    await instance.close();
  } finally {
    cleanup();
  }
});

test("traversal, encoded traversal, absolute paths and backslashes are rejected", async () => {
  const { root, cleanup } = withTheme();
  try {
    const instance = app(join(root, "demo-v1"));
    for (const url of [
      "/themes/demo-v1/assets/../../templates/home.liquid",
      "/themes/demo-v1/assets/%2e%2e/%2e%2e/templates/home.liquid",
      "/themes/demo-v1/assets/..%2f..%2ftemplates/home.liquid",
      "/themes/demo-v1/assets//etc/passwd",
      "/themes/demo-v1/assets/%2fetc%2fpasswd",
      "/themes/demo-v1/assets/..\\..\\templates\\home.liquid",
      "/themes/demo-v1/assets/....//css/theme.css",
    ]) {
      const response = await instance.inject({ method: "GET", url });
      assert.equal(response.statusCode, 404, url);
    }
    await instance.close();
  } finally {
    cleanup();
  }
});

test("symlink escape from the assets subtree is rejected", async () => {
  const { root, cleanup } = withTheme();
  try {
    const theme = join(root, "demo-v1");
    symlinkSync(join(theme, "templates"), join(theme, "assets", "linked"));
    const instance = app(theme);
    const response = await instance.inject({
      method: "GET",
      url: "/themes/demo-v1/assets/linked/home.liquid",
    });
    assert.equal(response.statusCode, 404);
    await instance.close();
  } finally {
    cleanup();
  }
});

test("without renderDir nothing is registered (API-only deployment)", async () => {
  const instance = fastify();
  registerThemeFilesRoute(instance, { renderDir: undefined });
  const response = await instance.inject({ method: "GET", url: "/themes/x/assets/a.css" });
  assert.equal(response.statusCode, 404);
  await instance.close();
});
